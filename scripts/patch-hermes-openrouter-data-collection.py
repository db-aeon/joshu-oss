#!/usr/bin/env python3
"""No-training routing for every OpenRouter request of Hermes >= v0.20.

Hermes sends ``provider_routing`` of config.yaml on main turns, Hermes cron jobs,
workers, and subagents that inherit the setting. Hermes does not apply
``provider_routing`` to auxiliary tasks (session_search, compression,
title_generation, vision, ...), and clears it for a subagent when
``delegation.provider`` is set. This patch adds ``provider_routing.data_collection``
of config.yaml to each OpenRouter request that has no ``data_collection`` value:

  - writes module agent/joshu_openrouter_privacy.py;
  - OpenRouterProfile.build_extra_body (all requests that use the OpenRouter
    provider profile, which includes every auxiliary task);
  - the OpenRouter branch of ChatCompletionsTransport (used when the provider
    profile does not load);
  - _build_call_kwargs of the auxiliary client passes the provider preferences
    of auxiliary.<task>.extra_body to the profile, so the profile merges them
    and does not replace them.

Spec: openspec model-provider-privacy (change openrouter-data-collection-deny).
Idempotent. Stops with an error when an anchor is missing, so a Hermes upgrade
that moves the code fails the image build.

Usage:
  HERMES_DIR=/path/to/hermes-agent python3 scripts/patch-hermes-openrouter-data-collection.py
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

HERMES_DIR = Path(os.environ.get("HERMES_DIR", "/opt/hermes-agent"))
MODULE = HERMES_DIR / "agent" / "joshu_openrouter_privacy.py"
OPENROUTER = HERMES_DIR / "plugins" / "model-providers" / "openrouter" / "__init__.py"
CHAT_COMPLETIONS = HERMES_DIR / "agent" / "transports" / "chat_completions.py"
AUXILIARY = HERMES_DIR / "agent" / "auxiliary_client.py"
MARKER = "joshu_openrouter_privacy"

MODULE_TEXT = '''"""Joshu: no-training routing for OpenRouter requests.

Written by joshu scripts/patch-hermes-openrouter-data-collection.py. Do not edit.
"""
from __future__ import annotations

from typing import Any, Dict


def with_config_data_collection(prefs: Any) -> Dict[str, Any]:
    """Return OpenRouter provider preferences with data_collection from config.yaml.

    A value in ``prefs`` wins. When config.yaml cannot be read, the value is
    "deny" (fail closed).
    """
    merged: Dict[str, Any] = dict(prefs) if isinstance(prefs, dict) else {}
    if merged.get("data_collection"):
        return merged
    try:
        from hermes_cli.config import read_raw_config_readonly

        routing = read_raw_config_readonly().get("provider_routing") or {}
        value = str(routing.get("data_collection") or "").strip().lower() if isinstance(routing, dict) else ""
    except Exception:
        value = "deny"
    if value in ("allow", "deny"):
        merged["data_collection"] = value
    return merged
'''

PROFILE_OLD = """        prefs = context.get("provider_preferences")
        if prefs:
            body["provider"] = prefs
"""
PROFILE_NEW = """        # Joshu: provider_routing.data_collection also for auxiliary tasks.
        from agent.joshu_openrouter_privacy import with_config_data_collection

        prefs = with_config_data_collection(context.get("provider_preferences"))
        if prefs:
            body["provider"] = prefs
"""

TRANSPORT_OLD = """        provider_prefs = params.get("provider_preferences")
        if provider_prefs and is_openrouter:
            extra_body["provider"] = provider_prefs
"""
TRANSPORT_NEW = """        provider_prefs = params.get("provider_preferences")
        if is_openrouter:
            # Joshu: provider_routing.data_collection on every OpenRouter request.
            from agent.joshu_openrouter_privacy import with_config_data_collection

            provider_prefs = with_config_data_collection(provider_prefs)
        if provider_prefs and is_openrouter:
            extra_body["provider"] = provider_prefs
"""

AUXILIARY_OLD = """            profile_body = profile.build_extra_body(
                model=model,
                base_url=effective_base,
                reasoning_config=reasoning_config,
            ) or {}
"""
AUXILIARY_NEW = """            profile_body = profile.build_extra_body(
                model=model,
                base_url=effective_base,
                reasoning_config=reasoning_config,
                # Joshu: merge the provider preferences of auxiliary.<task>.extra_body
                # with provider_routing.data_collection (joshu_openrouter_privacy).
                provider_preferences=(extra_body or {}).get("provider"),
            ) or {}
"""


def log(msg: str) -> None:
    print(f"[hermes-openrouter-data-collection] {msg}")


def patch_text(text: str, old: str, new: str, label: str) -> str:
    if MARKER in text:
        return text
    if old not in text:
        raise SystemExit(f"[hermes-openrouter-data-collection] {label}: anchor not found")
    return text.replace(old, new, 1)


def patch_file(path: Path, old: str, new: str, label: str) -> None:
    text = path.read_text(encoding="utf-8")
    patched = patch_text(text, old, new, label)
    if patched == text:
        log(f"already patched {label}")
        return
    path.write_text(patched, encoding="utf-8")
    log(f"patched {label}")


def main() -> int:
    if not all(path.is_file() for path in (OPENROUTER, CHAT_COMPLETIONS, AUXILIARY)):
        print(f"[hermes-openrouter-data-collection] missing Hermes files under {HERMES_DIR}", file=sys.stderr)
        return 1
    if not MODULE.is_file() or MODULE.read_text(encoding="utf-8") != MODULE_TEXT:
        MODULE.write_text(MODULE_TEXT, encoding="utf-8")
        log(f"wrote {MODULE.relative_to(HERMES_DIR)}")
    patch_file(OPENROUTER, PROFILE_OLD, PROFILE_NEW, "OpenRouterProfile.build_extra_body")
    patch_file(CHAT_COMPLETIONS, TRANSPORT_OLD, TRANSPORT_NEW, "ChatCompletionsTransport OpenRouter branch")
    patch_file(AUXILIARY, AUXILIARY_OLD, AUXILIARY_NEW, "auxiliary _build_call_kwargs")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
