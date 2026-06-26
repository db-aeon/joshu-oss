"""Validate desktop_open targets (allowlisted modules, safe file paths)."""

from __future__ import annotations

import re

MODULE_NAMES = {
    "jWeb",
    "jChat",
    "jWhiteboard",
    "Memory",
    "File Brain",
    "jMovie",
    "jMail",
    "Connectors",
    "Schedules",
    "Welcome",
    "File Manager",
    "System Setting",
    "Trash Bin",
}

MODULE_ALIASES = {
    "browser": "jWeb",
    "web": "jWeb",
    "jweb": "jWeb",
    "chat": "jChat",
    "jchat": "jChat",
    "hermes": "jChat",
    "whiteboard": "jWhiteboard",
    "excalidraw": "jWhiteboard",
    "jwhiteboard": "jWhiteboard",
    "memory": "Memory",
    "hindsight": "Memory",
    "file brain": "File Brain",
    "filebrain": "File Brain",
    "movie": "jMovie",
    "jmovie": "jMovie",
    "mail": "jMail",
    "email": "jMail",
    "jmail": "jMail",
    "inbox": "jMail",
    "mail app": "jMail",
    "email app": "jMail",
    "connectors": "Connectors",
    "connections": "Connectors",
    "oauth": "Connectors",
    "schedules": "Schedules",
    "cron": "Schedules",
    "welcome": "Welcome",
    "onboarding": "Welcome",
    "files": "File Manager",
    "file manager": "File Manager",
    "filemanager": "File Manager",
    "settings": "System Setting",
    "system setting": "System Setting",
    "trash": "Trash Bin",
    "trash bin": "Trash Bin",
}


def resolve_module(name: str) -> str | None:
    trimmed = (name or "").strip()
    if not trimmed:
        return None
    trimmed = re.sub(r"\s+app$", "", trimmed, flags=re.IGNORECASE).strip()
    if trimmed in MODULE_NAMES:
        return trimmed
    key = trimmed.lower()
    if key in MODULE_ALIASES:
        return MODULE_ALIASES[key]
    for module in MODULE_NAMES:
        if module.lower() == key:
            return module
    return None


def validate_file_path(path: str) -> str | None:
    clean = (path or "").strip().replace("\\", "/").lstrip("/")
    if not clean or ".." in clean.split("/"):
        return None
    return clean


def normalize_desktop_action(args: dict) -> tuple[dict | None, str | None]:
    kind = (args.get("kind") or "").strip().lower()
    target = (args.get("target") or "").strip()
    if kind not in ("module", "file"):
        return None, "kind must be module or file"
    if not target:
        return None, "target is required"

    if kind == "module":
        resolved = resolve_module(target)
        if not resolved:
            return None, f"unknown desktop module: {target}"
        return {"kind": "module", "target": resolved}, None

    resolved_path = validate_file_path(target)
    if not resolved_path:
        return None, "invalid file path"
    return {"kind": "file", "target": resolved_path}, None
