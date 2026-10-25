"""Block Hermes `cronjob` calls whose delivery target cannot reach anyone.

On a box the Hermes gateway pushes only to Telegram and Slack. Joshu turns off the
Hermes SMS platform, and an api_server session (SMS, jChat, proactive resolve)
cannot receive a message that the Hermes gateway starts. A job made there with the
default ``deliver`` (origin) runs, and its output goes nowhere.

Same rules as ``undeliverableReason`` in ``src/cronDelivery.ts``; keep both in step.
Spec: openspec change owner-reminder-delivery, requirement "Hermes cronjob calls with
an undeliverable target are blocked".
"""

from __future__ import annotations

import os
import sys

PUSH_PLATFORMS = frozenset({"telegram", "slack"})

BLOCK_HINT = (
    "For a reminder to the owner, call mcp_joshu_connectors_owner_reminder_create "
    "(Joshu texts the owner by SMS, else email, and the owner can reply DONE). "
    "For a job that sends its own messages (for example with nylas_send_message), "
    "set deliver='local'."
)


def _session_platform() -> str:
    try:
        from gateway.session_context import get_session_env  # type: ignore

        return (get_session_env("HERMES_SESSION_PLATFORM", "") or "").strip().lower()
    except Exception:
        return (os.environ.get("HERMES_SESSION_PLATFORM") or "").strip().lower()


def _deliver_parts(deliver) -> list[str]:
    if deliver is None or deliver == "":
        return ["origin"]
    if isinstance(deliver, (list, tuple)):
        parts = [str(p).strip() for p in deliver if str(p).strip()]
        return parts or ["origin"]
    return [p.strip() for p in str(deliver).split(",") if p.strip()] or ["origin"]


def undeliverable_reason(deliver, session_platform: str) -> str | None:
    """Why a cronjob deliver value cannot reach anyone from this session, or None."""
    for raw in _deliver_parts(deliver):
        part = raw.lower()
        if part in ("local", "all"):
            continue
        if part == "origin":
            if session_platform == "api_server":
                return (
                    "this session runs on api_server (SMS, jChat, or a proactive reply), "
                    "which cannot receive cron output"
                )
            continue
        platform = part.split(":", 1)[0]
        if platform not in PUSH_PLATFORMS:
            return f'deliver={raw} names platform "{platform}", which the Hermes gateway does not run on this box'
    return None


def pre_tool_call(tool_name: str = "", args=None, **_kwargs):
    if tool_name != "cronjob" or not isinstance(args, dict):
        return None
    action = str(args.get("action") or "").strip().lower()
    if action == "create":
        deliver = args.get("deliver")
    elif action == "update" and args.get("deliver") not in (None, ""):
        deliver = args.get("deliver")
    else:
        return None
    reason = undeliverable_reason(deliver, _session_platform())
    if not reason:
        return None
    print(f"[joshu-realtime-goals] blocked cronjob {action}: {reason}", file=sys.stderr)
    return {
        "action": "block",
        "message": f"Blocked: this cron job would not reach anyone — {reason}. {BLOCK_HINT}",
    }


def register(ctx) -> None:
    ctx.register_hook("pre_tool_call", pre_tool_call)
