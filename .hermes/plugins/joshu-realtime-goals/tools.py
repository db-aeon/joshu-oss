"""Realtime owner-message admission for Hermes Slack/Telegram plus defer fallback."""

from __future__ import annotations

import asyncio
import json
import os
import sys
import urllib.error
import urllib.request

JOSHU_API_BASE = os.environ.get(
    "JOSHU_API_BASE_URL", "http://127.0.0.1:8788/joshu"
).rstrip("/")

DEFER_SCHEMA = {
    "name": "realtime_goal_defer",
    "description": (
        "Queue this owner request as a durable background goal when the current "
        "turn discovers it cannot finish in about one minute."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "objective": {
                "type": "string",
                "description": "Self-contained objective, including accepted clarifications",
            },
            "title": {"type": "string", "description": "Short task title"},
        },
        "required": ["objective"],
    },
}


def _post(path: str, payload: dict, timeout: float = 10.0) -> dict:
    api_key = os.environ.get("HERMES_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("HERMES_API_KEY is required for realtime goal broker calls")
    req = urllib.request.Request(
        f"{JOSHU_API_BASE}{path}",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as response:
        body = response.read().decode("utf-8")
    parsed = json.loads(body)
    return parsed if isinstance(parsed, dict) else {}


def _origin_from_session(session_key: str, message_id: str = "") -> dict | None:
    key = session_key.strip()
    original_key = key
    channel = ""
    reply_address = ""
    thread_id = ""
    if ":slack:" in key:
        channel = "slack"
    elif ":telegram:" in key:
        channel = "telegram"
    elif key.startswith("joshu-app:"):
        channel = "agui"
    elif key.startswith("joshu-hermes-chat:"):
        raw_session_id = key.split(":", 1)[1]
        if raw_session_id.startswith("CA") and len(raw_session_id) >= 20:
            channel = "pstn_voice"
            key = "pstn:owner"
        else:
            channel = "jchat"
    elif key.startswith("sms:"):
        channel = "sms"
    if not channel:
        return None
    if channel in ("jchat", "agui"):
        return None

    pieces = key.split(":")
    if channel == "sms" and len(pieces) >= 2:
        reply_address = pieces[1]
        key = f"sms:{reply_address}"
    if channel in ("slack", "telegram"):
        for marker in ("dm", "group", "channel"):
            if marker in pieces:
                index = pieces.index(marker)
                if index + 1 < len(pieces):
                    reply_address = pieces[index + 1]
                if index + 2 < len(pieces):
                    thread_id = pieces[index + 2]
                break
    return {
        "channel": channel,
        "sessionKey": key,
        "sessionId": original_key,
        **({"messageId": message_id} if message_id else {}),
        **({"replyAddress": reply_address} if reply_address else {}),
        **({"threadId": thread_id} if thread_id else {}),
    }


def realtime_goal_defer(args: dict, **kwargs) -> str:
    objective = str(args.get("objective") or "").strip()
    if not objective:
        return json.dumps({"ok": False, "error": "objective is required"})
    if os.environ.get("HERMES_KANBAN_TASK", "").strip():
        return json.dumps(
            {"ok": False, "error": "realtime_goal_defer is unavailable in Kanban workers"}
        )
    session_key = str(
        kwargs.get("gateway_session_key")
        or kwargs.get("session_key")
        or kwargs.get("session_id")
        or ""
    ).strip()
    if not session_key:
        return json.dumps({"ok": False, "error": "session identity unavailable"})
    origin = _origin_from_session(session_key)
    if origin is None:
        return json.dumps(
            {
                "ok": False,
                "error": "realtime_goal_defer requires an explicit owner realtime channel",
            }
        )
    try:
        result = _post(
            "/api/realtime-goals/defer",
            {
                "origin": origin,
                "text": objective,
                "title": str(args.get("title") or "").strip(),
            },
            timeout=15.0,
        )
        return json.dumps(result)
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError) as error:
        return json.dumps({"ok": False, "error": str(error)})


async def _send_ack_with_retry(adapter, chat_id: str, text: str, metadata) -> None:
    for attempt in range(3):
        try:
            result = await adapter.send(chat_id, text, metadata=metadata)
            if result is None or bool(getattr(result, "success", False)):
                return
            error = getattr(result, "error", "send returned unsuccessful result")
        except Exception as exc:
            error = str(exc)
        if attempt < 2:
            await asyncio.sleep(1 + attempt * 2)
    print(
        f"[joshu-realtime-goals] queue acknowledgment delivery failed: {error}",
        file=sys.stderr,
    )


def pre_gateway_dispatch(event, gateway, **_kwargs):
    """Conservatively admit authenticated Slack/Telegram owner messages."""
    source = getattr(event, "source", None)
    platform = getattr(getattr(source, "platform", None), "value", "")
    if platform not in ("slack", "telegram"):
        return {"action": "allow"}
    event_text = str(getattr(event, "text", "") or "")
    if event_text.lstrip().startswith(("/", "!")):
        return {"action": "allow"}
    try:
        # The upstream hook runs before auth. Reuse the gateway's canonical
        # authorization decision before sending owner content to Joshu.
        if not gateway._is_user_authorized(source):
            return {"action": "allow"}
        adapter = gateway.adapters.get(source.platform)
        if adapter is None:
            return {"action": "allow"}
        session_key = gateway._session_key_for_source(source)
        origin = {
            "channel": platform,
            "sessionKey": session_key,
            "sessionId": session_key,
            "messageId": str(getattr(event, "message_id", "") or ""),
            "replyAddress": str(getattr(source, "chat_id", "") or ""),
            "threadId": str(getattr(source, "thread_id", "") or ""),
        }
        result = _post(
            "/api/realtime-goals/route",
            {"origin": origin, "text": event_text},
        )
        if result.get("action") != "reply" or not result.get("text"):
            return {"action": "allow"}

        metadata = {"thread_id": source.thread_id} if source.thread_id else None
        loop = asyncio.get_running_loop()
        loop.create_task(
            _send_ack_with_retry(adapter, source.chat_id, result["text"], metadata)
        )
        return {"action": "skip", "reason": "joshu-realtime-goal"}
    except Exception as error:
        # Admission is fail-open: never strand a normal owner chat because the
        # local broker is warming or a future Hermes hook shape changes.
        print(
            f"[joshu-realtime-goals] pre-dispatch failed open: {error}",
            file=sys.stderr,
        )
        return {"action": "allow"}


def pre_llm_call(session_id: str = "", platform: str = "", **_kwargs):
    """Give Slack/Telegram owner turns the owner's background-work snapshot.

    SMS and voice already pass it to Hermes; without it a chat turn can deny a
    job the owner started by phone ("nothing's running on Cancun").
    """
    if platform not in ("slack", "telegram"):
        return None
    origin = _origin_from_session(session_id or "") or {
        "channel": platform,
        "sessionKey": session_id or platform,
        **({"sessionId": session_id} if session_id else {}),
    }
    try:
        # The turn answers the owner: the context can carry the setup mention (change owner-setup-board).
        result = _post(
            "/api/realtime-goals/context",
            {"origin": origin, "setupMention": True},
            timeout=3.0,
        )
    except Exception as error:
        print(f"[joshu-realtime-goals] context fetch failed: {error}", file=sys.stderr)
        return None
    context = result.get("context")
    if isinstance(context, str) and context.strip():
        return {"context": context}
    return None


def register(ctx) -> None:
    ctx.register_tool(
        name="realtime_goal_defer",
        toolset="joshu-realtime-goals",
        schema=DEFER_SCHEMA,
        handler=realtime_goal_defer,
        emoji="⏳",
    )
    ctx.register_hook("pre_gateway_dispatch", pre_gateway_dispatch)
    ctx.register_hook("pre_llm_call", pre_llm_call)
