#!/usr/bin/env python3
"""
Bridge test: action unpin_models removes the model pin of cron jobs pinned to an old
control plane model, so they follow the Hermes model of the release (change release-hermes-model).

Needs a Hermes checkout: HERMES_AGENT_ROOT=<hermes-agent> and HERMES_PYTHON=<its venv python3>.
Without HERMES_AGENT_ROOT the test prints SKIP and exits 0.

Scenario (fleet, 2026-10-03): 30 cron jobs were pinned by hand to deepseek/deepseek-v4.1-flash.
A job pinned to another model, or to the same model on another provider, keeps its pin.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

BRIDGE = Path(__file__).resolve().parent / "hermes-cron-bridge.py"
OLD_MODELS = ["deepseek/deepseek-v4-flash-0731", "deepseek/deepseek-v4.1-flash"]


def fail(message: str) -> None:
    print(f"FAIL: {message}")
    sys.exit(1)


def bridge(python: str, root: str, home: Path, payload: dict) -> dict:
    env = {**os.environ, "HERMES_AGENT_ROOT": root, "HERMES_HOME": str(home)}
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


def jobs_file(home: Path) -> Path:
    return home / "cron" / "jobs.json"


def load(home: Path):
    raw = json.loads(jobs_file(home).read_text(encoding="utf-8"))
    return raw, (raw["jobs"] if isinstance(raw, dict) else raw)


def main() -> int:
    root = os.environ.get("HERMES_AGENT_ROOT", "").strip()
    if not root:
        print("SKIP: set HERMES_AGENT_ROOT (and HERMES_PYTHON) to a hermes-agent checkout")
        return 0
    python = os.environ.get("HERMES_PYTHON", "").strip() or sys.executable

    with tempfile.TemporaryDirectory(prefix="joshu-cron-unpin-") as tmp:
        home = Path(tmp)
        (home / "config.yaml").write_text("timezone: UTC\n", encoding="utf-8")
        for name, model in (
            ("EA morning", "deepseek/deepseek-v4.1-flash"),
            ("Old 0731 job", "deepseek/deepseek-v4-flash-0731"),
            ("Owner chose Claude", "~anthropic/claude-sonnet-latest"),
            ("Unpinned", None),
            ("Other provider", "deepseek/deepseek-v4.1-flash"),
        ):
            payload = {"action": "create", "name": name, "schedule": "0 9 * * *", "prompt": "test", "deliver": "local"}
            if model:
                payload["model"] = model
            created = bridge(python, root, home, payload)
            if not created.get("success"):
                fail(f"create {name}: {created}")

        raw, jobs = load(home)
        for job in jobs:
            if job["name"] != "Unpinned":
                job["provider"] = "nous" if job["name"] == "Other provider" else "openrouter"
        jobs_file(home).write_text(json.dumps(raw), encoding="utf-8")

        result = bridge(python, root, home, {"action": "unpin_models", "models": OLD_MODELS})
        if not result.get("success"):
            fail(f"unpin_models: {result}")
        names = sorted(item.get("name") for item in result.get("unpinned", []))
        if names != ["EA morning", "Old 0731 job"]:
            fail(f"expected EA morning and Old 0731 job to be unpinned, got {names}")

        _, jobs = load(home)
        by_name = {job["name"]: job for job in jobs}
        for name in ("EA morning", "Old 0731 job"):
            if by_name[name].get("model") or by_name[name].get("provider"):
                fail(f"{name} still pinned: {by_name[name].get('provider')} / {by_name[name].get('model')}")
        if by_name["Owner chose Claude"].get("model") != "~anthropic/claude-sonnet-latest":
            fail("a job pinned to another model must keep its pin")
        if by_name["Other provider"].get("provider") != "nous":
            fail("a job pinned to another provider must keep its pin")

        again = bridge(python, root, home, {"action": "unpin_models", "models": OLD_MODELS})
        if not again.get("success") or again.get("unpinned"):
            fail(f"second unpin should change nothing: {again}")

    print("OK: Hermes cron unpin of old control plane models")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
