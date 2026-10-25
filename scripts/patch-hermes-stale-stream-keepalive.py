#!/usr/bin/env python3
"""Patch Hermes chat_completion_helpers for keepalive-aware stale-stream detection.

Root cause (Slack hang on a fleet box, 2026-08-24): every SSE frame — including empty
keepalives — refreshed ``last_chunk_time``, so a provider that pinged forever
never tripped ``HERMES_STREAM_STALE_TIMEOUT``. Combined with deepseek-v4-flash's
600s reasoning TTFB floor, the only backstop was ``gateway_timeout`` (1800s).

This patch:
1. Only refreshes ``last_chunk_time`` on chunks/events with real progress.
2. Splits mid-stream timeout from TTFB (reasoning floor applies to TTFB only).

Idempotent. Target: $HERMES_DIR/agent/chat_completion_helpers.py
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

MARKER = "joshu-stale-stream-keepalive-v1"

HELPER = '''
def _openai_chunk_has_progress(chunk) -> bool:
    """True when a chat-completions chunk advances the stream (not keepalive)."""
    choices = getattr(chunk, "choices", None) or []
    if not choices:
        return bool(getattr(chunk, "usage", None))
    choice0 = choices[0]
    if getattr(choice0, "finish_reason", None):
        return True
    delta = getattr(choice0, "delta", None)
    if delta is None:
        return False
    if getattr(delta, "content", None):
        return True
    if getattr(delta, "reasoning_content", None) or getattr(delta, "reasoning", None):
        return True
    if getattr(delta, "tool_calls", None) or getattr(delta, "function_call", None):
        return True
    return False
'''.strip()


def _patch_openai_loop(text: str) -> str:
    old = """        for chunk in stream:
            last_chunk_time["t"] = time.time()
            agent._touch_activity("receiving stream response")
"""
    new = f"""        for chunk in stream:
            # {MARKER}: empty SSE keepalives must not refresh last_chunk_time
            if _openai_chunk_has_progress(chunk):
                last_chunk_time["t"] = time.time()
                agent._touch_activity("receiving stream response")
                _stream_saw_progress["yes"] = True
"""
    if old not in text:
        raise RuntimeError("openai for-chunk loop not found")
    return text.replace(old, new, 1)


def _patch_anthropic_loop(text: str) -> str:
    old = """            for event in stream:
                saw_stream_event = True
                last_chunk_time["t"] = time.time()
                agent._touch_activity("receiving stream response")
                try:
                    _diag["chunks"] = int(_diag.get("chunks", 0)) + 1
                    if _diag.get("first_chunk_at") is None:
                        _diag["first_chunk_at"] = last_chunk_time["t"]
                    _diag["bytes"] = int(_diag.get("bytes", 0)) + _estimate_chunk_bytes(event)
                except Exception:
                    pass
                if agent._interrupt_requested:
                    break

                event_type = getattr(event, "type", None)
"""
    new = f"""            for event in stream:
                saw_stream_event = True
                event_type = getattr(event, "type", None)
                # {MARKER}: ignore ping/keepalive frames for stale timer
                if event_type in (
                    "message_start",
                    "content_block_start",
                    "content_block_delta",
                    "content_block_stop",
                    "message_delta",
                    "message_stop",
                ):
                    last_chunk_time["t"] = time.time()
                    agent._touch_activity("receiving stream response")
                    _stream_saw_progress["yes"] = True
                try:
                    _diag["chunks"] = int(_diag.get("chunks", 0)) + 1
                    if _diag.get("first_chunk_at") is None:
                        _diag["first_chunk_at"] = last_chunk_time["t"]
                    _diag["bytes"] = int(_diag.get("bytes", 0)) + _estimate_chunk_bytes(event)
                except Exception:
                    pass
                if agent._interrupt_requested:
                    break

"""
    if old not in text:
        print("[stale-stream-keepalive] WARN: anthropic loop not found", file=sys.stderr)
        return text
    return text.replace(old, new, 1)


def _patch_progress_flag(text: str) -> str:
    old = "    last_chunk_time = {\"t\": time.time()}\n"
    new = (
        "    last_chunk_time = {\"t\": time.time()}\n"
        f"    _stream_saw_progress = {{\"yes\": False}}  # {MARKER}\n"
        f"    _stream_stale_timeout_mid = None  # {MARKER}: mid-stream (no reasoning floor)\n"
    )
    if "_stream_saw_progress" in text and MARKER in text:
        return text
    if old not in text:
        raise RuntimeError("last_chunk_time init not found")
    # Only replace the first occurrence in call_chat_completion / stream path
    return text.replace(old, new, 1)


def _patch_mid_timeout(text: str) -> str:
    """Split TTFB (reasoning floor) from mid-stream silence budget."""
    old = """        else:
            _stream_stale_timeout = _stream_stale_timeout_base
        # Reasoning-model floor: known reasoning models (Nemotron 3 Ultra,
        # OpenAI o1/o3, Anthropic Opus 4.x thinking, DeepSeek R1, Qwen QwQ,
        # xAI Grok reasoning, etc.) routinely exceed the default 180s chat-
        # model threshold during their thinking phase.  The cloud gateway
        # upstream kills the socket first, surfacing as BrokenPipeError.
        # Raises the floor only — never overrides explicit user config
        # (handled by get_provider_stale_timeout above).
        from agent.reasoning_timeouts import get_reasoning_stale_timeout_floor
        _reasoning_floor = get_reasoning_stale_timeout_floor(api_kwargs.get("model"))
        if _reasoning_floor is not None:
            _stream_stale_timeout = max(_stream_stale_timeout, _reasoning_floor)
"""
    new = f"""        else:
            _stream_stale_timeout = _stream_stale_timeout_base
        # {MARKER}: mid-stream silence uses the context-scaled base only.
        # Reasoning floors apply to TTFB (waiting for first progress token).
        _stream_stale_timeout_mid = _stream_stale_timeout
        # Reasoning-model floor: known reasoning models (Nemotron 3 Ultra,
        # OpenAI o1/o3, Anthropic Opus 4.x thinking, DeepSeek R1, Qwen QwQ,
        # xAI Grok reasoning, etc.) routinely exceed the default 180s chat-
        # model threshold during their thinking phase.  The cloud gateway
        # upstream kills the socket first, surfacing as BrokenPipeError.
        # Raises the floor only — never overrides explicit user config
        # (handled by get_provider_stale_timeout above).
        from agent.reasoning_timeouts import get_reasoning_stale_timeout_floor
        _reasoning_floor = get_reasoning_stale_timeout_floor(api_kwargs.get("model"))
        if _reasoning_floor is not None:
            _stream_stale_timeout = max(_stream_stale_timeout, _reasoning_floor)
"""
    if old not in text:
        print("[stale-stream-keepalive] WARN: mid-timeout split point not found", file=sys.stderr)
        return text
    return text.replace(old, new, 1)


def _patch_stale_detector(text: str) -> str:
    old = """        # Detect stale streams: connections kept alive by SSE pings
        # but delivering no real chunks.  Kill the client so the
        # inner retry loop can start a fresh connection.
        _stale_elapsed = time.time() - last_chunk_time["t"]
        if _stale_elapsed > _stream_stale_timeout:
"""
    new = f"""        # Detect stale streams: connections kept alive by SSE pings
        # but delivering no real chunks.  Kill the client so the
        # inner retry loop can start a fresh connection.
        # {MARKER}: after first progress, use mid timeout (no reasoning floor).
        _stale_elapsed = time.time() - last_chunk_time["t"]
        _active_stale_timeout = (
            _stream_stale_timeout_mid
            if _stream_saw_progress["yes"] and _stream_stale_timeout_mid is not None
            else _stream_stale_timeout
        )
        if _stale_elapsed > _active_stale_timeout:
"""
    if old not in text:
        print("[stale-stream-keepalive] WARN: stale detector not found", file=sys.stderr)
        return text
    text = text.replace(old, new, 1)
    # Fix log line that still references _stream_stale_timeout for threshold
    old_log = (
        '                "Stream stale for %.0fs (threshold %.0fs) — no chunks received. "'
    )
    # Leave log as-is if it uses _stream_stale_timeout — optionally update nearby
    old_warn_args = None  # keep simple; threshold in log may still show TTFB value
    _ = old_log, old_warn_args
    # Update the threshold printed in the warning if present
    text2 = text.replace(
        "threshold %.0fs) — no chunks received. \"\n"
        "                % (_stale_elapsed, _stream_stale_timeout,",
        "threshold %.0fs) — no chunks received. \"\n"
        "                % (_stale_elapsed, _active_stale_timeout,",
        1,
    )
    return text2


def _inject_helper(text: str) -> str:
    if "_openai_chunk_has_progress" in text:
        return text
    needle = "    def _discard_stale_stream_chunk(stream_attempt_id: int, chunk) -> None:"
    if needle not in text:
        # Fallback: module-level inject before first `def call_` or after imports
        alt = "\ndef _derive_stream_stale_timeout("
        if alt not in text:
            raise RuntimeError("helper inject point not found")
        return text.replace(alt, "\n" + HELPER + "\n\n" + alt.lstrip("\n"), 1)
    indented = "\n".join(("    " + line if line else line) for line in HELPER.splitlines())
    # Prefer module-level function (not nested inside another def)
    # Insert before _discard which may be nested — check indentation of needle
    # On a fleet box, _discard is nested inside a method. Use module-level before _derive.
    alt = "\ndef _derive_stream_stale_timeout("
    if alt in text:
        return text.replace(alt, "\n" + HELPER + "\n\n" + alt.lstrip("\n"), 1)
    return text.replace(needle, indented + "\n\n    " + needle.lstrip(), 1)


def patch(path: Path) -> bool:
    text = path.read_text(encoding="utf-8")
    if MARKER in text and "_openai_chunk_has_progress" in text and "_stream_stale_timeout_mid" in text:
        print(f"[stale-stream-keepalive] already patched: {path}")
        return False

    text = _inject_helper(text)
    text = _patch_progress_flag(text)
    text = _patch_openai_loop(text)
    text = _patch_anthropic_loop(text)
    text = _patch_mid_timeout(text)
    text = _patch_stale_detector(text)

    path.write_text(text, encoding="utf-8")
    print(f"[stale-stream-keepalive] patched {path}")
    return True


def main() -> int:
    hermes_dir = Path(os.environ.get("HERMES_DIR", "/opt/hermes-agent"))
    target = hermes_dir / "agent" / "chat_completion_helpers.py"
    if not target.is_file():
        print(f"[stale-stream-keepalive] skip: missing {target}")
        return 0
    try:
        patch(target)
    except RuntimeError as err:
        print(f"[stale-stream-keepalive] ERROR: {err}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
