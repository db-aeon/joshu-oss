#!/usr/bin/env python3
"""No permanent approvals in Hermes approval prompts on a box.

A Hermes approval prompt offers once, session, always, and deny. Always adds
the pattern key (for example `execute_code`) to `command_allowlist` in
config.yaml, and Hermes then runs each later command with that pattern key with
no question. On box finn, one tap of the owner on Always let the companion run
scripts with no question, and the companion changed its own runtime (issues #88
and #89, openspec change companion-runtime-guard, design decisions 1 and 2).

Patches in tools/approval.py:
  1) approve_permanent does nothing. Each caller calls approve_session first,
     so the answer "always" gives a session approval.
  2) load_permanent keeps no entry, so old command_allowlist entries stop working.
  3) save_permanent_allowlist does nothing. Joshu manages config.yaml.
  4) _await_gateway_decision sets allow_permanent to False, so Telegram, Slack,
     the text fallback, and the jChat events show no Always choice.

The patch checks all four places before it writes, and fails when one is
missing, so a Hermes update that moves the code fails the image build.

Idempotent. Marker: joshu-approval-no-permanent-v1
Target: $HERMES_DIR/tools/approval.py
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

MARKER = "joshu-approval-no-permanent-v1"
HERMES_DIR = Path(os.environ.get("HERMES_DIR", "/opt/hermes-agent")).resolve()
TARGET = HERMES_DIR / "tools/approval.py"

REPLACEMENTS = [
    (
        "approve_permanent",
        '''def approve_permanent(pattern_key: str):
    """Add a pattern to the permanent allowlist."""
    with _lock:
        _permanent_approved.add(pattern_key)
''',
        f'''def approve_permanent(pattern_key: str):
    """Joshu: no permanent approvals ({MARKER}).

    Each caller calls approve_session first, so "always" lasts for the session.
    """
    return None
''',
    ),
    (
        "load_permanent",
        '''def load_permanent(patterns: set):
    """Bulk-load permanent allowlist entries from config."""
    with _lock:
        _permanent_approved.update(patterns)
''',
        f'''def load_permanent(patterns: set):
    """Joshu: ignore command_allowlist entries ({MARKER})."""
    if patterns:
        logger.warning("Joshu ignores %d command_allowlist entries", len(patterns))
''',
    ),
    (
        "save_permanent_allowlist",
        '''def save_permanent_allowlist(patterns: set):
    """Save permanently allowed command patterns to config."""
''',
        f'''def save_permanent_allowlist(patterns: set):
    """Save permanently allowed command patterns to config."""
    return  # Joshu: config.yaml is managed by Joshu ({MARKER})
''',
    ),
    (
        "_await_gateway_decision",
        '''    command = approval_data.get("command", "")
    description = approval_data.get("description", "")
    primary_key = approval_data.get("pattern_key", "")
''',
        f'''    approval_data["allow_permanent"] = False  # Joshu: no Always choice ({MARKER})
    command = approval_data.get("command", "")
    description = approval_data.get("description", "")
    primary_key = approval_data.get("pattern_key", "")
''',
    ),
]


def main() -> int:
    if not TARGET.is_file():
        print(f"[approval-no-permanent] skip: missing {TARGET}", file=sys.stderr)
        return 0

    text = TARGET.read_text(encoding="utf-8")
    if MARKER in text:
        print(f"[approval-no-permanent] already applied ({TARGET})")
        return 0

    missing = [name for name, old, _ in REPLACEMENTS if text.count(old) != 1]
    if missing:
        print(
            f"[approval-no-permanent] error: code not found once in {TARGET}: {', '.join(missing)}",
            file=sys.stderr,
        )
        return 1

    for _, old, new in REPLACEMENTS:
        text = text.replace(old, new, 1)
    TARGET.write_text(text, encoding="utf-8")
    print(f"[approval-no-permanent] patched {TARGET}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
