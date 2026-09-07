#!/usr/bin/env python3
"""Respect platforms.sms.enabled: false when TWILIO_* creds are present.

Joshu boxes route inbound SMS through twilioSmsGateway.ts → Hermes api_server
(same platform_toolsets as jChat). Hermes' native SMS platform is a separate Twilio
webhook listener and requires SMS_WEBHOOK_URL — enabling it alongside Joshu
shows a scary admin warning and would duplicate ingress if misconfigured.

Idempotent. Target: $HERMES_DIR/gateway/config.py
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

MARKER = "joshu-disable-native-sms-platform-v1"
HERMES_DIR = Path(os.environ.get("HERMES_DIR", "/opt/hermes-agent")).resolve()
TARGET = HERMES_DIR / "gateway/config.py"

OLD = """    # SMS (Twilio)
    twilio_sid = getenv("TWILIO_ACCOUNT_SID")
    if twilio_sid:
        if Platform.SMS not in config.platforms:
            config.platforms[Platform.SMS] = PlatformConfig()
        config.platforms[Platform.SMS].enabled = True
        config.platforms[Platform.SMS].api_key = getenv("TWILIO_AUTH_TOKEN", "")
"""

NEW = f"""    # SMS (Twilio)
    twilio_sid = getenv("TWILIO_ACCOUNT_SID")
    if twilio_sid:
        if Platform.SMS not in config.platforms:
            config.platforms[Platform.SMS] = PlatformConfig()
        sms_cfg = config.platforms[Platform.SMS]
        # Joshu twilioSmsGateway owns inbound SMS; honor explicit enabled: false ({MARKER}).
        if not (
            sms_cfg.enabled is False
            and bool((sms_cfg.extra or {{}}).get("_enabled_explicit", False))
        ):
            sms_cfg.enabled = True
        sms_cfg.api_key = getenv("TWILIO_AUTH_TOKEN", "")
"""


def main() -> int:
    if not TARGET.is_file():
        print(f"[disable-native-sms-platform] skip: missing {TARGET}", file=sys.stderr)
        return 0

    text = TARGET.read_text(encoding="utf-8")
    if MARKER in text:
        print(f"[disable-native-sms-platform] already applied ({TARGET})")
        return 0

    if OLD not in text:
        print("[disable-native-sms-platform] error: SMS auto-enable block not found", file=sys.stderr)
        return 1

    TARGET.write_text(text.replace(OLD, NEW, 1), encoding="utf-8")
    print(f"[disable-native-sms-platform] patched {TARGET}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
