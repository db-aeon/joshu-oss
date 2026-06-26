"""desktop_open handler — validate and enqueue for the Joshu browser shell."""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request

from .schemas import DESKTOP_OPEN_SCHEMA
from .validate import normalize_desktop_action

JOSHU_API_BASE = os.environ.get("JOSHU_API_BASE_URL", "http://127.0.0.1:8788/joshu").rstrip("/")


def _joshu_session_key(kwargs: dict) -> str:
    """Map Hermes tool kwargs to the Joshu session key used by jChat / voice drain."""
    gateway = kwargs.get("gateway_session_key")
    if gateway:
        return str(gateway)
    sid = str(kwargs.get("session_id") or kwargs.get("session_key") or "").strip()
    if not sid:
        return ""
    if sid.startswith("joshu-hermes-chat:") or sid.startswith("voice-think:"):
        return sid
    return f"joshu-hermes-chat:{sid}"


def _enqueue_action(session_key: str, action: dict) -> None:
    if not session_key:
        return
    payload = json.dumps({"sessionKey": session_key, "action": action}).encode("utf-8")
    req = urllib.request.Request(
        f"{JOSHU_API_BASE}/api/desktop-actions/enqueue",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=3) as resp:
            resp.read()
    except (urllib.error.URLError, TimeoutError, OSError) as err:
        # Tool still returns success — client may poll; don't fail the agent turn.
        import sys
        print(f"[joshu-desktop] enqueue failed: {err}", file=sys.stderr)


def desktop_open(args: dict, **kwargs) -> str:
    action, error = normalize_desktop_action(args)
    if error or not action:
        return json.dumps({"ok": False, "error": error or "invalid action"})
    # Enqueue happens in post_tool_call — Hermes passes session_id to hooks, not tool handlers.
    return json.dumps({"ok": True, "action": action, "message": "Opening on desktop."})


def post_tool_call(tool_name: str, args: dict, result: str, session_id: str = "", **kwargs) -> None:
    if tool_name != "desktop_open":
        return
    action, error = normalize_desktop_action(args)
    if error or not action:
        return
    session_key = _joshu_session_key({"session_id": session_id, **kwargs})
    _enqueue_action(session_key, action)


def register(ctx) -> None:
    ctx.register_tool(
        name="desktop_open",
        toolset="joshu-desktop",
        schema=DESKTOP_OPEN_SCHEMA,
        handler=desktop_open,
        emoji="🖥️",
    )
    ctx.register_hook("post_tool_call", post_tool_call)
