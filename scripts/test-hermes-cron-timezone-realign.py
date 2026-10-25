#!/usr/bin/env python3
"""
Bridge test: action realign_timezone moves cron next_run_at to the new Hermes timezone.

Needs a Hermes checkout: HERMES_AGENT_ROOT=<hermes-agent> and HERMES_PYTHON=<its venv python3>.
Without HERMES_AGENT_ROOT the test prints SKIP and exits 0.

Scenario (fleet box, 2026-10-05): Hermes created "EA morning" (0 9 * * 1-5)
while the box was on UTC, so next_run_at is 09:00+00:00 (17:00 for a UTC+8 owner).
After the owner timezone changes to Asia/Singapore, realign must move it to 09:00+08:00
and leave interval and paused jobs alone.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path

BRIDGE = Path(__file__).resolve().parent / "hermes-cron-bridge.py"


def fail(message: str) -> None:
    print(f"FAIL: {message}")
    sys.exit(1)


def set_timezone(home: Path, tz: str) -> None:
    (home / "config.yaml").write_text(f"timezone: {tz}\n", encoding="utf-8")
    (home / ".env").write_text(f"HERMES_TIMEZONE={tz}\n", encoding="utf-8")


def bridge(python: str, root: str, home: Path, tz: str, payload: dict) -> dict:
    env = {
        **os.environ,
        "HERMES_AGENT_ROOT": root,
        "HERMES_HOME": str(home),
        "HERMES_TIMEZONE": tz,
    }
    proc = subprocess.run(
        [python, str(BRIDGE)],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        cwd=root,
        env=env,
        timeout=120,
    )
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError:
        fail(f"bridge output is not JSON for {payload['action']}: {proc.stdout!r} {proc.stderr[-2000:]!r}")
    return {}


def jobs_by_name(home: Path) -> dict:
    raw = json.loads((home / "cron" / "jobs.json").read_text(encoding="utf-8"))
    jobs = raw["jobs"] if isinstance(raw, dict) else raw
    return {job["name"]: job for job in jobs}


def main() -> int:
    root = os.environ.get("HERMES_AGENT_ROOT", "").strip()
    if not root:
        print("SKIP: set HERMES_AGENT_ROOT (and HERMES_PYTHON) to a hermes-agent checkout")
        return 0
    python = os.environ.get("HERMES_PYTHON", "").strip() or sys.executable

    with tempfile.TemporaryDirectory(prefix="joshu-cron-tz-") as tmp:
        home = Path(tmp)
        set_timezone(home, "UTC")
        for name, schedule in (
            ("EA morning", "0 9 * * 1-5"),
            ("Interval check", "every 30m"),
            ("Paused cron", "0 18 * * *"),
        ):
            created = bridge(python, root, home, "UTC", {
                "action": "create",
                "name": name,
                "schedule": schedule,
                "prompt": "test",
                "deliver": "local",
            })
            if not created.get("success"):
                fail(f"create {name}: {created}")
            if name == "Paused cron":
                paused = bridge(python, root, home, "UTC", {"action": "pause", "job_id": created["job_id"]})
                if not paused.get("success"):
                    fail(f"pause {name}: {paused}")

        before = jobs_by_name(home)
        morning_utc = datetime.fromisoformat(before["EA morning"]["next_run_at"])
        if morning_utc.utcoffset().total_seconds() != 0 or morning_utc.hour != 9:
            fail(f"EA morning should start at 09:00+00:00, got {morning_utc.isoformat()}")

        set_timezone(home, "Asia/Singapore")
        result = bridge(python, root, home, "Asia/Singapore", {"action": "realign_timezone"})
        if not result.get("success"):
            fail(f"realign_timezone: {result}")
        names = [item.get("name") for item in result.get("realigned", [])]
        if names != ["EA morning"]:
            fail(f"expected only EA morning to be realigned, got {names}")

        after = jobs_by_name(home)
        morning = datetime.fromisoformat(after["EA morning"]["next_run_at"])
        if morning.utcoffset().total_seconds() != 8 * 3600 or (morning.hour, morning.minute) != (9, 0):
            fail(f"EA morning should be 09:00+08:00, got {morning.isoformat()}")
        for name in ("Interval check", "Paused cron"):
            if after[name].get("next_run_at") != before[name].get("next_run_at"):
                fail(f"{name} next_run_at changed: {before[name].get('next_run_at')} -> {after[name].get('next_run_at')}")

        again = bridge(python, root, home, "Asia/Singapore", {"action": "realign_timezone"})
        if not again.get("success") or again.get("realigned"):
            fail(f"second realign should change nothing: {again}")

    print("OK: Hermes cron realign to owner timezone")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
