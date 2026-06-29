"""Validate app_gui_action payloads."""

from __future__ import annotations


def normalize_app_gui_action(args: dict) -> tuple[dict | None, str | None]:
    if not isinstance(args, dict):
        return None, "args must be an object"

    app_id = str(args.get("appId") or args.get("app_id") or "").strip()
    action = str(args.get("action") or "").strip()
    if not app_id:
        return None, "appId is required"
    if not action:
        return None, "action is required"

    raw_args = args.get("args")
    if raw_args is None:
        normalized_args = {}
    elif isinstance(raw_args, dict):
        normalized_args = raw_args
    else:
        return None, "args must be an object when provided"

    return {"appId": app_id, "action": action, "args": normalized_args}, None
