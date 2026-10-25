"""browser_handoff_request / browser_handoff_status — Joshu localhost API."""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request

from .schemas import (
    BROWSER_HANDOFF_COMPLETE_SCHEMA,
    BROWSER_HANDOFF_REQUEST_SCHEMA,
    BROWSER_HANDOFF_STATUS_SCHEMA,
)

JOSHU_API_BASE = os.environ.get("JOSHU_API_BASE_URL", "http://127.0.0.1:8788/joshu").rstrip("/")


def _post_json(path: str, body: dict) -> tuple[int, dict]:
    payload = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        f"{JOSHU_API_BASE}{path}",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode("utf-8")
            return resp.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as err:
        detail = err.read().decode("utf-8", errors="replace")
        try:
            parsed = json.loads(detail) if detail else {}
        except json.JSONDecodeError:
            parsed = {"error": detail or f"HTTP {err.code}"}
        return err.code, parsed


def _get_json(path: str) -> tuple[int, dict]:
    req = urllib.request.Request(f"{JOSHU_API_BASE}{path}", method="GET")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            raw = resp.read().decode("utf-8")
            return resp.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as err:
        detail = err.read().decode("utf-8", errors="replace")
        try:
            parsed = json.loads(detail) if detail else {}
        except json.JSONDecodeError:
            parsed = {"error": detail or f"HTTP {err.code}"}
        return err.code, parsed


def _hermes_session_key(kwargs: dict) -> str:
    for key in ("gateway_session_key", "session_id", "session_key"):
        value = kwargs.get(key)
        if value:
            return str(value).strip()
    return ""


def browser_handoff_request(args: dict, **kwargs) -> str:
    instructions = str(args.get("instructions") or "").strip()
    if not instructions:
        return json.dumps({"ok": False, "error": "instructions is required"})
    body: dict = {"instructions": instructions}
    # A Kanban worker has its task id in the environment. The SMS continuation reads
    # the request from that task after the owner finishes the handoff.
    kanban_task_id = str(
        args.get("kanban_task_id") or os.environ.get("HERMES_KANBAN_TASK") or ""
    ).strip()
    if kanban_task_id:
        body["kanbanTaskId"] = kanban_task_id
    session_key = _hermes_session_key(kwargs)
    if session_key:
        body["hermesSessionKey"] = session_key
    status, data = _post_json("/api/browser-handoff/request", body)
    if status >= 400:
        return json.dumps({"ok": False, **data})
    return json.dumps({"ok": True, **data})


def browser_handoff_status(args: dict, **kwargs) -> str:
    handoff_id = str(args.get("handoff_id") or "").strip()
    if not handoff_id:
        return json.dumps({"ok": False, "error": "handoff_id is required"})
    status, data = _get_json(f"/api/browser-handoff/status/{urllib.parse.quote(handoff_id, safe='')}")
    if status >= 400:
        return json.dumps({"ok": False, **data})
    return json.dumps({"ok": True, **data})


def browser_handoff_complete(args: dict, **kwargs) -> str:
    handoff_id = str(args.get("handoff_id") or "").strip()
    owner_message = str(args.get("owner_message") or "").strip()
    session_key = _hermes_session_key(kwargs)

    if not handoff_id:
        body: dict = {}
        if session_key:
            body["hermesSessionKey"] = session_key
        if owner_message:
            body["owner_message"] = owner_message
        if not body:
            return json.dumps({"ok": False, "error": "handoff_id or hermes session is required"})
        status, data = _post_json("/api/browser-handoff/complete-pending-confirmed", body)
        if status >= 400:
            return json.dumps({"ok": False, **data})
        return json.dumps({"ok": True, **data})

    status, data = _post_json(
        f"/api/browser-handoff/{urllib.parse.quote(handoff_id, safe='')}/complete-confirmed",
        {},
    )
    if status >= 400:
        return json.dumps({"ok": False, **data})
    return json.dumps({"ok": True, **data})


def register(ctx) -> None:
    ctx.register_tool(
        name="browser_handoff_request",
        toolset="joshu-browser-handoff",
        schema=BROWSER_HANDOFF_REQUEST_SCHEMA,
        handler=browser_handoff_request,
        emoji="📱",
    )
    ctx.register_tool(
        name="browser_handoff_status",
        toolset="joshu-browser-handoff",
        schema=BROWSER_HANDOFF_STATUS_SCHEMA,
        handler=browser_handoff_status,
        emoji="📱",
    )
    ctx.register_tool(
        name="browser_handoff_complete",
        toolset="joshu-browser-handoff",
        schema=BROWSER_HANDOFF_COMPLETE_SCHEMA,
        handler=browser_handoff_complete,
        emoji="✅",
    )
