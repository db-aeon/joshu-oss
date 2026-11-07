#!/usr/bin/env python3
"""
Hermes test: the toolsets of the release facts check job (RELEASE_FACTS_JOB_TOOLSETS in
src/releaseFacts.ts) give a Hermes cron agent the memory tool and no MCP server.

Needs a Hermes checkout: HERMES_AGENT_ROOT=<hermes-agent> and HERMES_PYTHON=<its venv python3>.
Without HERMES_AGENT_ROOT the test prints SKIP and exits 0.

Issue #175: the job had toolsets "file" and "skills". A Hermes cron agent runs with skip_memory,
so it had no memory tool, and the write guard (HERMES_WRITE_SAFE_ROOT) refused write_file and
patch on memories/MEMORY.md. The job could not change an untrue memory entry on any box.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

SOURCE = Path(__file__).resolve().parent.parent / "src" / "releaseFacts.ts"

# Runs inside the Hermes checkout. argv[1]: the toolsets of the job as JSON.
CHILD = r'''
import json, os, sys
import yaml
from cron.scheduler import _resolve_cron_enabled_toolsets
from run_agent import AIAgent
from tools.file_tools import write_file_tool
from tools.memory_tool import memory_tool

home = os.environ["HERMES_HOME"]
memory_file = os.path.join(home, "memories", "MEMORY.md")
cfg = yaml.safe_load(open(os.path.join(home, "config.yaml"), encoding="utf-8"))
toolsets = _resolve_cron_enabled_toolsets({"enabled_toolsets": json.loads(sys.argv[1])}, cfg)
# The same arguments as the AIAgent of a cron job in cron/scheduler.py (run_job).
agent = AIAgent(model="test/model", api_key="test", base_url="http://127.0.0.1:9/v1", provider="openrouter",
                enabled_toolsets=toolsets, skip_memory=True, platform="cron", quiet_mode=True)
denied = json.loads(write_file_tool(memory_file, "x"))
replaced = json.loads(memory_tool(action="replace", target="memory", old_text="need the browser",
                                  content="Calendar tools write every calendar account.", store=agent._memory_store))
print(json.dumps({
    "toolsets": toolsets,
    "tools": sorted(agent.valid_tool_names),
    "write_file_error": denied.get("error", ""),
    "replace": replaced,
    "memory_file": open(memory_file, encoding="utf-8").read(),
}))
'''


def fail(message: str) -> None:
    print(f"FAIL: {message}")
    sys.exit(1)


def job_toolsets() -> list[str]:
    match = re.search(r"RELEASE_FACTS_JOB_TOOLSETS = (\[[^\]]*\])", SOURCE.read_text(encoding="utf-8"))
    if not match:
        fail(f"RELEASE_FACTS_JOB_TOOLSETS not found in {SOURCE}")
    return json.loads(match.group(1))


def main() -> int:
    root = os.environ.get("HERMES_AGENT_ROOT", "").strip()
    if not root:
        print("SKIP: set HERMES_AGENT_ROOT (and HERMES_PYTHON) to a hermes-agent checkout")
        return 0
    python = os.environ.get("HERMES_PYTHON", "").strip() or sys.executable
    toolsets = job_toolsets()

    with tempfile.TemporaryDirectory(prefix="joshu-release-facts-") as tmp:
        home = Path(tmp) / "hermes"
        desktop = Path(tmp) / "Desktop"
        (home / "memories").mkdir(parents=True)
        desktop.mkdir()
        (home / "memories" / "MEMORY.md").write_text(
            "Calendar events need the browser on calendar.google.com.\n§\nThe owner likes short replies.\n",
            encoding="utf-8",
        )
        # As on a box: memory on, and an MCP server that can send mail.
        (home / "config.yaml").write_text(
            "memory:\n  memory_enabled: true\n  user_profile_enabled: true\n"
            "mcp_servers:\n  joshu_connectors:\n    command: echo\n",
            encoding="utf-8",
        )
        env = {**os.environ, "HOME": tmp, "HERMES_HOME": str(home), "HERMES_WRITE_SAFE_ROOT": str(desktop)}
        proc = subprocess.run(
            [python, "-c", CHILD, json.dumps(toolsets)],
            capture_output=True, text=True, cwd=root, env=env, timeout=300,
        )
        lines = [line for line in proc.stdout.splitlines() if line.startswith("{")]
        if proc.returncode != 0 or not lines:
            fail(f"Hermes check failed: {proc.stdout[-2000:]!r} {proc.stderr[-4000:]!r}")
        got = json.loads(lines[-1])

    if "joshu_connectors" in got["toolsets"]:
        fail(f"the job gets an MCP server: {got['toolsets']}")
    if "memory" not in got["tools"]:
        fail(f"the job has no memory tool: {got['tools']}")
    if "HERMES_WRITE_SAFE_ROOT" not in got["write_file_error"]:
        fail(f"expected the write guard to refuse write_file in memories/: {got['write_file_error']!r}")
    if not got["replace"].get("success"):
        fail(f"memory replace failed: {got['replace']}")
    if got["memory_file"] != "Calendar tools write every calendar account.\n§\nThe owner likes short replies.":
        fail(f"MEMORY.md after the replace: {got['memory_file']!r}")
    print(f"test-release-facts-hermes: ok (toolsets {got['toolsets']})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
