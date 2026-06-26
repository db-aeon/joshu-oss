#!/usr/bin/env python3
"""
JSON bridge for jChat → Hermes SessionDB (no dashboard HTTP required).

Reads one JSON object from stdin, writes one JSON object to stdout.
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path
from typing import Any, Dict, List

HERMES_AGENT_ROOT = Path(__file__).resolve().parent.parent
if str(HERMES_AGENT_ROOT) not in sys.path:
    env_root = os.environ.get("HERMES_AGENT_ROOT", "").strip()
    if env_root:
        candidate = Path(env_root).resolve()
        if candidate.is_dir():
            sys.path.insert(0, str(candidate))
    else:
        sibling = HERMES_AGENT_ROOT.parent / "hermes-agent"
        if sibling.is_dir():
            sys.path.insert(0, str(sibling))

JCHAT_SESSION_PREFIX = "hermes-chat-"
JCHAT_SESSION_SOURCE = "api_server"


def _respond(payload: Dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload))
    sys.stdout.flush()


def _fail(message: str, **extra: Any) -> None:
    body: Dict[str, Any] = {"ok": False, "error": message}
    body.update(extra)
    _respond(body)


def _plain_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: List[str] = []
        for part in content:
            if isinstance(part, dict) and part.get("text"):
                parts.append(str(part["text"]))
        return "\n".join(parts)
    return ""


def _import_db():
    from hermes_state import SessionDB

    return SessionDB()


def _is_jchat_session(row: Dict[str, Any]) -> bool:
    sid = str(row.get("id") or "").strip()
    return sid.startswith(JCHAT_SESSION_PREFIX) and row.get("source") == JCHAT_SESSION_SOURCE


def _map_session(row: Dict[str, Any]) -> Dict[str, Any]:
    title = str(row.get("title") or "").strip()
    preview = str(row.get("preview") or "").strip()
    last_active = row.get("last_active") or row.get("started_at") or 0
    ended_at = row.get("ended_at")
    now = time.time()
    is_active = ended_at is None and (now - float(last_active or 0)) < 300
    return {
        "id": str(row.get("id") or ""),
        "title": title or preview or "Untitled chat",
        "preview": preview or None,
        "lastActive": float(last_active or 0),
        "messageCount": int(row.get("message_count") or 0),
        "isActive": is_active,
    }


def _action_list(body: Dict[str, Any]) -> None:
    limit = int(body.get("limit") or 40)
    limit = max(1, min(limit, 80))
    fetch_limit = min(max(limit * 4, 40), 200)

    db = _import_db()
    try:
        rows = db.list_sessions_rich(
            source=JCHAT_SESSION_SOURCE,
            limit=fetch_limit,
            order_by_last_active=True,
        )
        sessions = [_map_session(row) for row in rows if _is_jchat_session(row)]
        sessions.sort(key=lambda s: s["lastActive"], reverse=True)
        _respond({"ok": True, "sessions": sessions[:limit]})
    finally:
        db.close()


def _action_messages(body: Dict[str, Any]) -> None:
    session_id = str(body.get("sessionId") or body.get("session_id") or "").strip()
    if not session_id:
        _fail("sessionId is required")
        return

    db = _import_db()
    try:
        resolved = db.resolve_session_id(session_id)
        if not resolved:
            _fail("session not found", sessionId=session_id)
            return
        raw_messages = db.get_messages(resolved)
        messages: List[Dict[str, str]] = []
        for msg in raw_messages:
            role = msg.get("role")
            if role not in ("user", "assistant"):
                continue
            text = _plain_text(msg.get("content")).strip()
            if not text:
                continue
            messages.append({"role": role, "content": text})
        _respond({"ok": True, "sessionId": resolved, "messages": messages})
    finally:
        db.close()


def main() -> None:
    try:
        raw = sys.stdin.read()
        body = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError as exc:
        _fail(f"invalid JSON: {exc}")
        return

    action = str(body.get("action") or "").strip().lower()
    if action == "list":
        _action_list(body)
    elif action == "messages":
        _action_messages(body)
    else:
        _fail(f"unknown action: {action or '(missing)'}")


if __name__ == "__main__":
    main()
