#!/usr/bin/env python3
"""Pairing reply that points the owner to the Safety app.

Hermes answers a DM from an unknown user with a pairing code and tells the
user to run `hermes pairing approve <platform> <code>`. An owner of a Joshu box
has no shell. The owner enters the pairing code in the Safety app instead
(openspec change slack-connect, design decision 5).

Idempotent. Target: $HERMES_DIR/gateway/run.py
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

MARKER = "joshu-pairing-reply-v1"
HERMES_DIR = Path(os.environ.get("HERMES_DIR", "/opt/hermes-agent")).resolve()
TARGET = HERMES_DIR / "gateway/run.py"

OLD = """                        await adapter.send(
                            source.chat_id,
                            f"Hi~ I don't recognize you yet!\\n\\n"
                            f"Here's your pairing code: `{code}`\\n\\n"
                            f"Ask the bot owner to run:\\n"
                            f"`hermes {profile_arg}pairing approve "
                            f"{platform_name} {code}`"
                        )
"""

NEW = f"""                        # Joshu: the owner approves in the Safety app ({MARKER}).
                        await adapter.send(
                            source.chat_id,
                            f"Hi! I don't know you yet.\\n\\n"
                            f"Your pairing code is `{{code}}`.\\n\\n"
                            f"If you own this Joshu box, open the Safety app on your "
                            f"Joshu desktop and enter this code under Pairing code."
                        )
"""


def main() -> int:
    if not TARGET.is_file():
        print(f"[pairing-reply] skip: missing {TARGET}", file=sys.stderr)
        return 0

    text = TARGET.read_text(encoding="utf-8")
    if MARKER in text:
        print(f"[pairing-reply] already applied ({TARGET})")
        return 0

    if OLD not in text:
        print("[pairing-reply] error: pairing reply block not found", file=sys.stderr)
        return 1

    TARGET.write_text(text.replace(OLD, NEW, 1), encoding="utf-8")
    print(f"[pairing-reply] patched {TARGET}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
