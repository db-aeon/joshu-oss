#!/usr/bin/env python3
"""Test patch-hermes-kanban-worker-terminate-on-complete.py against a real Hermes tree.

Needs a hermes-agent checkout at the pinned HERMES_AGENT_REF (deploy/Dockerfile)
and a Python that has the Hermes dependencies (HERMES_PYTHON, as in CI):
  HERMES_DIR=~/dev/hermes-agent HERMES_PYTHON=~/dev/hermes-agent/venv/bin/python \
    python3 scripts/test-hermes-kanban-worker-terminate-on-complete.py
Without HERMES_DIR (and without /opt/hermes-agent), the test is skipped.

Checks:
  - fresh apply writes the markers, and a second apply changes nothing;
  - a box with the old patch is upgraded to the same text as a fresh apply;
  - runtime: a worker that runs `hermes kanban complete|block` on its own task
    through its terminal tool (the CLI is a child or grandchild of the worker)
    is not killed. With the old patch, the CLI killed its own worker (joshua
    and clara, 2026-10-25: exit 130, run recorded as a protocol violation);
  - runtime: a CLI that is not a descendant but has HERMES_KANBAN_TASK set to
    the task id does not kill the worker;
  - runtime: complete or block from a foreign process still kills the worker.
"""
from __future__ import annotations

import importlib.util
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PATCHER = ROOT / "scripts" / "patch-hermes-kanban-worker-terminate-on-complete.py"
PYTHON = os.environ.get("HERMES_PYTHON", "").strip() or sys.executable


def _load_patcher():
    spec = importlib.util.spec_from_file_location("joshu_terminate_on_complete", PATCHER)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _copy_tree(src: Path, dst: Path) -> None:
    shutil.copytree(src / "hermes_cli", dst / "hermes_cli",
                    ignore=shutil.ignore_patterns("__pycache__"))
    (dst / "tools").mkdir(parents=True)
    shutil.copy2(src / "tools" / "kanban_tools.py", dst / "tools" / "kanban_tools.py")


def _run_patcher(tree: Path) -> str:
    r = subprocess.run(
        [sys.executable, str(PATCHER)],
        env={**os.environ, "HERMES_DIR": str(tree)},
        capture_output=True, text=True,
    )
    assert r.returncode == 0, f"patcher failed:\n{r.stdout}\n{r.stderr}"
    return r.stdout


# Shared prelude: import the patched hermes_cli.kanban_db of the tree.
PRELUDE = r"""
import os, sys
tree, hermes_dir, home = sys.argv[1:4]
sys.path[:0] = [tree, hermes_dir]
os.environ["HERMES_HOME"] = home
from pathlib import Path
from hermes_cli import kanban_db as kb
assert kb.__file__.startswith(tree), kb.__file__
conn = kb.connect(db_path=Path(home) / "kanban.db")
"""

# Creates a task and prints its id.
CREATE = PRELUDE + r"""
print(kb.create_task(conn, title="track", assignee="worker"))
"""

# Plays the dispatcher worker: claims the task with its own pid, then either
# runs the CLI as its child ("child"), as a grandchild through a shell
# ("grandchild"), or only waits ("wait") for a foreign CLI.
WORKER = PRELUDE + r"""
import subprocess, time
tid, op, how, cli_src = sys.argv[4:8]
assert kb.claim_task(conn, tid, claimer=kb._claimer_id())
with kb.write_txn(conn):
    conn.execute("UPDATE tasks SET worker_pid = ? WHERE id = ?", (os.getpid(), tid))
print("claimed", flush=True)
if how == "wait":
    time.sleep(30)
    sys.exit(3)
env = {k: v for k, v in os.environ.items() if k != "HERMES_KANBAN_TASK"}
cmd = [sys.executable, "-c", cli_src, tree, hermes_dir, home, tid, op]
if how == "grandchild":
    import shlex
    cmd = ["sh", "-c", " ".join(shlex.quote(c) for c in cmd) + "; exit $?"]
subprocess.run(cmd, env=env, check=True)
sys.exit(0)
"""

# Plays `hermes kanban complete|block <tid>`.
CLI = PRELUDE + r"""
tid, op = sys.argv[4:6]
if op == "complete":
    ok = kb.complete_task(conn, tid, result="done by cli")
else:
    ok = kb.block_task(conn, tid, reason="needs owner")
assert ok, f"{op} returned False"
(Path(home) / "cli-done").write_text(kb.get_task(conn, tid).status)
"""


def _wait_for(path: Path, timeout: float = 20.0) -> str:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if path.is_file():
            return path.read_text()
        time.sleep(0.1)
    raise AssertionError(f"CLI did not finish ({path})")


def _scenario(tree: Path, hermes_dir: Path, op: str, how: str) -> tuple[bool, str]:
    """Run one case. Returns (worker killed, task status after the CLI)."""
    home = Path(tempfile.mkdtemp(prefix="joshu-kanban-term-"))
    base = [str(tree), str(hermes_dir), str(home)]
    env = {k: v for k, v in os.environ.items() if k != "HERMES_KANBAN_TASK"}
    tid = subprocess.run(
        [PYTHON, "-c", CREATE, *base], env=env,
        capture_output=True, text=True, check=True,
    ).stdout.strip().splitlines()[-1]
    worker_how = how if how in ("child", "grandchild") else "wait"
    worker = subprocess.Popen(
        [PYTHON, "-c", WORKER, *base, tid, op, worker_how, CLI],
        env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    try:
        if worker_how == "wait":
            assert worker.stdout.readline().strip() == "claimed"
            cli_env = dict(env)
            if how == "env":
                cli_env["HERMES_KANBAN_TASK"] = tid
            cli = subprocess.Popen(
                [PYTHON, "-c", CLI, *base, tid, op], env=cli_env,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            )
            if how == "foreign":
                worker.wait(timeout=20)
            out, err = cli.communicate(timeout=20)
            assert cli.returncode == 0, f"CLI failed:\n{out}\n{err}"
        try:
            status = _wait_for(home / "cli-done")
        except AssertionError:
            if worker.poll() is None:
                worker.kill()
            raise AssertionError(f"{op}/{how}: CLI did not finish:\n{worker.stderr.read()}")
        if worker_how == "wait" and worker.poll() is None:
            return False, status
        rc = worker.wait(timeout=20)
        if rc not in (0, -15, -9):
            raise AssertionError(f"worker rc={rc}:\n{worker.stderr.read()}")
        return rc != 0, status
    finally:
        if worker.poll() is None:
            worker.kill()
            worker.wait()
        shutil.rmtree(home, ignore_errors=True)


def _check(tree: Path, hermes_dir: Path, op: str, how: str, expect_killed: bool) -> None:
    killed, status = _scenario(tree, hermes_dir, op, how)
    want = "done" if op == "complete" else "blocked"
    assert status == want, f"{op}/{how}: status {status} != {want}"
    assert killed == expect_killed, f"{op}/{how}: worker killed={killed}, want {expect_killed}"
    print(f"  ok {op} {how} killed={killed}")


def main() -> int:
    hermes_dir = Path(os.environ.get("HERMES_DIR", "/opt/hermes-agent")).expanduser()
    if not (hermes_dir / "hermes_cli" / "kanban_db.py").is_file():
        print(f"skip: no Hermes tree at {hermes_dir} (set HERMES_DIR)")
        return 0
    patcher = _load_patcher()
    tmp = Path(tempfile.mkdtemp(prefix="joshu-terminate-on-complete-"))

    # Fresh apply, then idempotency.
    fresh = tmp / "fresh"
    _copy_tree(hermes_dir, fresh)
    _run_patcher(fresh)
    fresh_db = (fresh / "hermes_cli" / "kanban_db.py").read_text(encoding="utf-8")
    assert patcher.MARKER in fresh_db and patcher.SELF_MARKER in fresh_db
    assert "already applied" in _run_patcher(fresh)
    assert (fresh / "hermes_cli" / "kanban_db.py").read_text(encoding="utf-8") == fresh_db
    print("ok fresh apply + idempotent")

    # Old patch (no self-worker guard).
    old = tmp / "old"
    _copy_tree(hermes_dir, old)
    old_db_path = old / "hermes_cli" / "kanban_db.py"
    old_db_path.write_text(
        fresh_db.replace(patcher.FOREIGN_HELPER.rstrip("\n"), patcher.OLD_FOREIGN_HELPER, 1),
        encoding="utf-8",
    )
    shutil.copy2(fresh / "tools" / "kanban_tools.py", old / "tools" / "kanban_tools.py")
    assert patcher.SELF_MARKER not in old_db_path.read_text(encoding="utf-8")
    # The old patch has the bug: the CLI kills its own worker.
    _check(old, hermes_dir, "complete", "child", True)
    shutil.rmtree(old / "hermes_cli" / "__pycache__", ignore_errors=True)
    out = _run_patcher(old)
    assert "upgrade" in out, out
    assert old_db_path.read_text(encoding="utf-8") == fresh_db
    print("ok upgrade from old patch")

    # Runtime with the fix.
    for op in ("complete", "block"):
        _check(fresh, hermes_dir, op, "child", False)
        if Path("/proc").is_dir():
            _check(fresh, hermes_dir, op, "grandchild", False)
        _check(fresh, hermes_dir, op, "env", False)
        _check(fresh, hermes_dir, op, "foreign", True)
    if not Path("/proc").is_dir():
        print("  note: no /proc, grandchild case not run")
    shutil.rmtree(tmp, ignore_errors=True)
    print("all ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
