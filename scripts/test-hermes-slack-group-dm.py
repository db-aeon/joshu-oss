#!/usr/bin/env python3
"""Test patch-hermes-slack-group-dm.py against the Slack adapter of a real Hermes tree.

Needs a hermes-agent checkout at the pinned HERMES_AGENT_REF (deploy/Dockerfile)
and a Python that has the Hermes dependencies (HERMES_PYTHON, as in CI):
  HERMES_DIR=~/dev/hermes-agent HERMES_PYTHON=~/dev/hermes-agent/venv/bin/python \
    python3 scripts/test-hermes-slack-group-dm.py
Without HERMES_DIR (and without /opt/hermes-agent), the test is skipped.
CI installs Hermes without the Slack packages, and the test mocks them then.
JOSHU_TEST_HIDE_MODULES=aiohttp,slack_bolt,slack_sdk runs the same way locally.

Checks (issue #170, box clara 2026-10-21):
  - a fresh apply writes the marker, and a second apply changes nothing;
  - an owner message in a group DM that starts with the companion name reaches
    the gateway; the same words from another member, a sentence to another
    member that names the companion, and the same words in a channel do not;
  - a bare @mention in a group DM carries the earlier group DM messages,
    including the request that named the companion;
  - an owner message in a group DM that the mention rule drops is logged at INFO.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PATCHER = ROOT / "scripts" / "patch-hermes-slack-group-dm.py"
PYTHON = os.environ.get("HERMES_PYTHON", "").strip() or sys.executable
ADAPTER = Path("plugins/platforms/slack/adapter.py")

RUNTIME = r'''
import asyncio, logging, os, sys
tree, hermes_dir = sys.argv[1:3]
sys.path[:0] = [tree, hermes_dir]
os.environ["SLACK_ALLOWED_USERS"] = "U_OWNER"
from unittest.mock import AsyncMock, MagicMock

# CI installs Hermes without its Slack extras. Mock the missing packages the
# way the Slack tests of Hermes do (tests/gateway/test_slack.py).
def available(name):
    try:
        __import__(name)
        return True
    except ImportError:
        return False

if not available("slack_bolt"):
    bolt = MagicMock()
    bolt.async_app.AsyncApp = MagicMock
    bolt.adapter.socket_mode.async_handler.AsyncSocketModeHandler = MagicMock
    for name, module in [
        ("slack_bolt", bolt),
        ("slack_bolt.async_app", bolt.async_app),
        ("slack_bolt.adapter", bolt.adapter),
        ("slack_bolt.adapter.socket_mode", bolt.adapter.socket_mode),
        ("slack_bolt.adapter.socket_mode.async_handler", bolt.adapter.socket_mode.async_handler),
    ]:
        sys.modules[name] = module
if not available("slack_sdk"):
    sdk = MagicMock()
    sdk.web.async_client.AsyncWebClient = MagicMock
    for name, module in [
        ("slack_sdk", sdk),
        ("slack_sdk.web", sdk.web),
        ("slack_sdk.web.async_client", sdk.web.async_client),
    ]:
        sys.modules[name] = module
if not available("aiohttp"):
    sys.modules["aiohttp"] = MagicMock()

import plugins.platforms.slack.adapter as mod
assert mod.__file__.startswith(tree), mod.__file__
mod.SLACK_AVAILABLE = True
from gateway.config import PlatformConfig

# Pure name rule.
names = ["clara", "Clara"]
yes = [
    "Clara, please book a 30 minute Zoom with Mai on Tuesday at 3 PM",
    "clara please book it",
    "Hi Clara: can you find a slot?",
    "Clara can you check Tuesday?",
    "Can you set this up, Clara?",
    "ok @clara book it",
    "Clara",
]
no = [
    "Mai, Clara will send you the invite",
    "<@U_MAI> Clara, please do it",
    "Clara's calendar is full",
    "Clarabelle, please book it",
    "I asked Clara yesterday",
]
for text in yes:
    assert mod._joshu_text_addresses_companion(text, names), text
for text in no:
    assert not mod._joshu_text_addresses_companion(text, names), text
# A handle like mary_ann matches "Mary Ann" and the first name "Mary".
assert mod._joshu_text_addresses_companion("Mary Ann, please", ["mary_ann"])
assert mod._joshu_text_addresses_companion("Mary, please", ["mary_ann"])
assert not mod._joshu_text_addresses_companion("Mar, please", ["mary_ann"])

def make_adapter(history=None):
    adapter = mod.SlackAdapter(PlatformConfig(enabled=True, token="***"))
    adapter._app = MagicMock()
    adapter._app.client = AsyncMock()
    people = {"U_OWNER": "JT", "U_MAI": "Mai", "U_BOT": "Clara"}
    async def users_info(user):
        return {"user": {"is_bot": user == "U_BOT", "profile": {"display_name": people.get(user, user)}}}
    adapter._app.client.users_info = AsyncMock(side_effect=users_info)
    adapter._app.client.conversations_history = AsyncMock(
        return_value={"ok": True, "messages": list(history or [])}
    )
    adapter._bot_user_id = "U_BOT"
    adapter._team_bot_user_ids = {"T1": "U_BOT"}
    adapter._team_bot_names = {"T1": "clara"}
    adapter._running = True
    adapter.handle_message = AsyncMock()
    return adapter

def event(text, user="U_OWNER", channel_type="mpim", ts="1761092100.000100", **extra):
    return {
        "text": text, "user": user, "channel": "C0GROUP", "channel_type": channel_type,
        "team": "T1", "ts": ts, "client_msg_id": "m-" + ts, **extra,
    }

async def handled(adapter, ev):
    adapter.handle_message.reset_mock()
    await adapter._handle_slack_message(ev)
    return adapter.handle_message.call_args[0][0] if adapter.handle_message.called else None

class Capture(logging.Handler):
    def __init__(self):
        super().__init__(logging.INFO)
        self.lines = []
    def emit(self, record):
        self.lines.append(record.getMessage())

async def main():
    capture = Capture()
    mod.logger.addHandler(capture)
    mod.logger.setLevel(logging.INFO)

    request = "Clara, please book a 30 minute Zoom with Mai on Tuesday at 3 PM PT"
    adapter = make_adapter()
    got = await handled(adapter, event(request))
    assert got is not None, "owner request that names the companion was dropped"
    assert "Tuesday at 3 PM" in got.text
    assert any("owner addressed the companion by name" in line for line in capture.lines)

    # Another member of the group DM: the mention rule stays.
    assert await handled(make_adapter(), event(request, user="U_MAI", ts="1761092101.000100")) is None
    # The owner talks to the colleague about the companion.
    capture.lines.clear()
    assert await handled(make_adapter(), event("Mai, Clara will send the invite", ts="1761092102.000100")) is None
    assert any("owner message not addressed to the companion" in line for line in capture.lines)
    # A channel keeps the mention rule, also for the owner.
    assert await handled(make_adapter(), event(request, channel_type="channel", ts="1761092103.000100")) is None

    # A bare @mention later gets the group DM above it (newest first, as Slack sends it).
    history = [
        {"ts": "1761092150.000100", "user": "U_MAI", "text": "Works for me"},
        {"ts": "1761092100.000100", "user": "U_OWNER", "text": request},
    ]
    adapter = make_adapter(history)
    got = await handled(adapter, event("<@U_BOT> please book this meeting", ts="1761102300.000100"))
    assert got is not None
    assert got.text == "please book this meeting"
    context = got.channel_context or ""
    assert context.startswith("[Group DM context"), context
    assert "Tuesday at 3 PM" in context, context
    assert context.index("Tuesday at 3 PM") < context.index("Works for me"), context
    call = adapter._app.client.conversations_history.call_args.kwargs
    assert call["channel"] == "C0GROUP" and call["latest"] == "1761102300.000100"
    assert call["inclusive"] is False and call["limit"] == 10
    assert float(call["oldest"]) == 1761102300.0001 - 6 * 3600

    # A thread reply keeps the thread context of Hermes; a 1:1 DM gets no history.
    adapter = make_adapter(history)
    await handled(adapter, event("hello", channel_type="im", ts="1761102400.000100"))
    adapter._app.client.conversations_history.assert_not_called()

    # A failed history call does not drop the message.
    adapter = make_adapter()
    adapter._app.client.conversations_history = AsyncMock(side_effect=RuntimeError("missing_scope"))
    got = await handled(adapter, event("<@U_BOT> please book this meeting", ts="1761102500.000100"))
    assert got is not None and not got.channel_context

asyncio.run(main())
print("runtime ok")
'''


def run_patcher(tree: Path) -> str:
    result = subprocess.run(
        [sys.executable, str(PATCHER)],
        env={**os.environ, "HERMES_DIR": str(tree)},
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, f"patcher failed:\n{result.stdout}\n{result.stderr}"
    return result.stdout


def main() -> int:
    hermes = Path(os.environ.get("HERMES_DIR", "/opt/hermes-agent")).expanduser()
    if not (hermes / ADAPTER).is_file():
        print(f"test-hermes-slack-group-dm: skipped (no Slack adapter under {hermes})")
        return 0

    with tempfile.TemporaryDirectory() as tmp:
        tree = Path(tmp)
        (tree / "plugins").mkdir()
        shutil.copy2(hermes / "plugins" / "__init__.py", tree / "plugins" / "__init__.py")
        shutil.copytree(
            hermes / ADAPTER.parent,
            tree / ADAPTER.parent,
            ignore=shutil.ignore_patterns("__pycache__"),
        )
        assert "patched" in run_patcher(tree)
        patched = (tree / ADAPTER).read_text(encoding="utf-8")
        assert patched.count("joshu-slack-group-dm-v1") >= 1
        assert "already applied" in run_patcher(tree)
        assert (tree / ADAPTER).read_text(encoding="utf-8") == patched

        hide = os.environ.get("JOSHU_TEST_HIDE_MODULES", "")
        prelude = "".join(
            f"import sys; sys.modules[{name!r}] = None\n" for name in hide.split(",") if name
        )
        result = subprocess.run(
            [PYTHON, "-c", prelude + RUNTIME, str(tree), str(hermes)],
            capture_output=True,
            text=True,
            cwd=tmp,
        )
        if result.returncode != 0:
            print(result.stdout)
            print(result.stderr, file=sys.stderr)
            return 1
        assert "runtime ok" in result.stdout, result.stdout

    print("test-hermes-slack-group-dm: ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
