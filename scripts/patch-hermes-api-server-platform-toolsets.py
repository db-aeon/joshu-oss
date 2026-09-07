#!/usr/bin/env python3
"""Honor X-Hermes-Platform-Toolsets on POST /v1/chat/completions.

Joshu SMS uses platform_toolsets.sms (hermes-api-server + MCP + memory/search/skills;
no kanban worker prompt) via header X-Hermes-Platform-Toolsets: sms while still hitting
api_server :8642.

Works across Hermes api_server layouts (pre/post v0.14 gateway session-key work).

Idempotent. Target: $HERMES_DIR/gateway/platforms/api_server.py
"""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path

MARKER = "joshu-api-server-platform-toolsets-v1"
HERMES_DIR = Path(os.environ.get("HERMES_DIR", "/opt/hermes-agent")).resolve()
TARGET = HERMES_DIR / "gateway/platforms/api_server.py"

RESOLVE_METHOD = f'''
    def _resolve_platform_toolsets(
        self,
        user_config: dict,
        platform_toolsets_key: Optional[str] = None,
    ) -> List[str]:
        """Resolve enabled toolsets; optional override for api_server callers ({MARKER})."""
        from hermes_cli.tools_config import _get_platform_tools

        key = (platform_toolsets_key or "api_server").strip()
        if not re.fullmatch(r"[a-z0-9_-]+", key):
            logger.warning("Invalid X-Hermes-Platform-Toolsets %r; using api_server", key)
            key = "api_server"
        platform_toolsets = user_config.get("platform_toolsets") or {{}}
        if key != "api_server" and key not in platform_toolsets:
            logger.warning(
                "platform_toolsets.%s not configured; falling back to api_server", key
            )
            key = "api_server"
        return sorted(_get_platform_tools(user_config, key))
'''.rstrip("\n")


def main() -> int:
    if not TARGET.is_file():
        print(f"[api-server-platform-toolsets] skip: missing {TARGET}", file=sys.stderr)
        return 0

    text = TARGET.read_text(encoding="utf-8")
    repair = False
    if MARKER in text:
        create_agent_sig = text.split("    def _create_agent(", 1)[1].split(") -> Any:", 1)[0]
        if "platform_toolsets_key" in create_agent_sig:
            print(f"[api-server-platform-toolsets] already applied ({TARGET})")
            return 0
        print(f"[api-server-platform-toolsets] repairing incomplete patch ({TARGET})")
        repair = True

    anchor = "    def _create_agent("
    if anchor not in text:
        print("[api-server-platform-toolsets] error: _create_agent anchor missing", file=sys.stderr)
        return 1

    if not repair and "_resolve_platform_toolsets(" not in text:
        text = text.replace(anchor, RESOLVE_METHOD + "\n\n" + anchor, 1)

    # _resolve_platform_toolsets also declares platform_toolsets_key — scope to _create_agent only.
    create_agent_sig = text.split("    def _create_agent(", 1)[1].split(") -> Any:", 1)[0]
    if "platform_toolsets_key" not in create_agent_sig:
        text, n = re.subn(
            r"(    def _create_agent\([\s\S]*?\n        session_model: Optional\[str\] = None,\n        confirmed_runtime_lock: bool = False,\n    \) -> Any:)",
            lambda m: m.group(1).replace(
                "        session_model: Optional[str] = None,\n        confirmed_runtime_lock: bool = False,\n    ) -> Any:",
                "        session_model: Optional[str] = None,\n        platform_toolsets_key: Optional[str] = None,\n        confirmed_runtime_lock: bool = False,\n    ) -> Any:",
                1,
            ),
            text,
            count=1,
        )
        if n != 1:
            text, n = re.subn(
                r"\n        confirmed_runtime_lock: bool = False,\n    \) -> Any:",
                "\n        platform_toolsets_key: Optional[str] = None,\n        confirmed_runtime_lock: bool = False,\n    ) -> Any:",
                text,
                count=1,
            )
            if n != 1:
                print("[api-server-platform-toolsets] error: _create_agent signature patch failed", file=sys.stderr)
                return 1

    old_toolsets = "enabled_toolsets = sorted(_get_platform_tools(user_config, \"api_server\"))"
    new_toolsets = f"enabled_toolsets = self._resolve_platform_toolsets(user_config, platform_toolsets_key)  # {MARKER}"
    if old_toolsets in text:
        text = text.replace(old_toolsets, new_toolsets, 1)
    elif new_toolsets not in text and not repair:
        print("[api-server-platform-toolsets] error: enabled_toolsets line not found", file=sys.stderr)
        return 1

    if "platform_toolsets_key: Optional[str] = None," not in text.split("async def _run_agent", 1)[-1][:2500]:
        text, n = re.subn(
            r"(async def _run_agent\([\s\S]*?\n        confirmed_runtime_lock: bool = False,\n    \) -> tuple:)",
            lambda m: m.group(1).replace(
                "        confirmed_runtime_lock: bool = False,\n    ) -> tuple:",
                "        platform_toolsets_key: Optional[str] = None,\n        confirmed_runtime_lock: bool = False,\n    ) -> tuple:",
                1,
            ),
            text,
            count=1,
        )
        if n != 1:
            print("[api-server-platform-toolsets] error: _run_agent signature patch failed", file=sys.stderr)
            return 1

    if "platform_toolsets_key=platform_toolsets_key," not in text:
        text, n = re.subn(
            r"(\n                        confirmed_runtime_lock=confirmed_runtime_lock,\n                    \))",
            r"\n                        platform_toolsets_key=platform_toolsets_key,\1",
            text,
            count=1,
        )
        if n != 1:
            print("[api-server-platform-toolsets] error: _create_agent call patch failed", file=sys.stderr)
            return 1

    header_line = f'        platform_toolsets_key = request.headers.get("X-Hermes-Platform-Toolsets", "").strip() or None  # {MARKER}\n'
    if header_line.strip() not in text:
        text, n = re.subn(
            r"(\n        # Parse request body\n        try:\n            body = await request\.json\(\))",
            "\n" + header_line + r"        try:\n            body = await request.json()",
            text,
            count=1,
        )
        if n != 1:
            print("[api-server-platform-toolsets] error: chat completions header patch failed", file=sys.stderr)
            return 1

    # Streaming chat completion _run_agent(...) call (Patrick uses **agent_overrides).
    stream_old = "                **agent_overrides,\n                route=route,\n            ))"
    stream_new = (
        "                **agent_overrides,\n"
        "                route=route,\n"
        "                platform_toolsets_key=platform_toolsets_key,\n"
        "            ))"
    )
    if stream_old in text and "agent_task = asyncio.ensure_future(self._run_agent(" in text:
        if text.replace(stream_old, stream_new, 1).count("platform_toolsets_key=platform_toolsets_key,") >= 2:
            text = text.replace(stream_old, stream_new, 1)

    def add_run_kw(m: re.Match) -> str:
        block = m.group(0)
        if "platform_toolsets_key=platform_toolsets_key" in block:
            return block
        return block.replace(
            "route=route,\n            ))",
            "route=route,\n                platform_toolsets_key=platform_toolsets_key,\n            ))",
            1,
        )

    # Streaming + non-streaming chat completion _run_agent(...) calls.
    text, n = re.subn(
        r"agent_task = asyncio\.ensure_future\(self\._run_agent\([\s\S]*?route=route,\n            \)\)\)",
        add_run_kw,
        text,
        count=1,
    )
    if n != 1:
        print("[api-server-platform-toolsets] warn: streaming _run_agent call not patched", file=sys.stderr)

    text, n2 = re.subn(
        r"return await self\._run_agent\(\n                user_message=user_message,[\s\S]*?route=route,\n            \)",
        lambda m: m.group(0).replace(
            "route=route,\n            )",
            "route=route,\n                platform_toolsets_key=platform_toolsets_key,\n            )",
            1,
        ),
        text,
        count=1,
    )
    if text.count("platform_toolsets_key=platform_toolsets_key,") < 2:
        print("[api-server-platform-toolsets] warn: non-streaming _run_agent call may be unpatched", file=sys.stderr)

    TARGET.write_text(text, encoding="utf-8")
    print(f"[api-server-platform-toolsets] patched {TARGET}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
