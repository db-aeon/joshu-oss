#!/usr/bin/env python3
"""Test patch-hermes-ea-kanban-no-autodecompose.py against a real Hermes tree.

Needs a hermes-agent checkout at the pinned HERMES_AGENT_REF (deploy/Dockerfile):
  HERMES_DIR=~/dev/hermes-agent python3 scripts/test-hermes-ea-kanban-keep-blocked.py
Without HERMES_DIR (and without /opt/hermes-agent), the test is skipped.

Checks:
  - fresh apply writes both markers, and a second apply changes nothing;
  - a box with the old patch (no sticky "blocked" event) is upgraded to the
    same text as a fresh apply;
  - runtime: a project-<slug> track that hits block_loop_detected stays
    blocked after recompute_ready (the dispatcher tick). With the old patch,
    recompute_ready promoted it to ready (Mina box, t_a5afaa50, 2026-10-08);
  - runtime: the default board still goes to triage (stock Hermes).
"""
from __future__ import annotations

import importlib.util
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PATCHER = ROOT / "scripts" / "patch-hermes-ea-kanban-no-autodecompose.py"


def _load_patcher():
    spec = importlib.util.spec_from_file_location("joshu_no_autodecompose", PATCHER)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _copy_tree(src: Path, dst: Path) -> None:
    shutil.copytree(src / "hermes_cli", dst / "hermes_cli",
                    ignore=shutil.ignore_patterns("__pycache__"))
    (dst / "gateway").mkdir(parents=True)
    shutil.copy2(src / "gateway" / "kanban_watchers.py", dst / "gateway" / "kanban_watchers.py")


def _run_patcher(tree: Path) -> str:
    r = subprocess.run(
        [sys.executable, str(PATCHER)],
        env={**os.environ, "HERMES_DIR": str(tree)},
        capture_output=True, text=True,
    )
    assert r.returncode == 0, f"patcher failed:\n{r.stdout}\n{r.stderr}"
    return r.stdout


# Runs in a child process so each tree imports its own hermes_cli.kanban_db.
RUNTIME_CHECK = r"""
import os, sys, tempfile
tree, hermes_dir, board, expect_loop, expect_after = sys.argv[1:6]
sys.path[:0] = [tree, hermes_dir]
os.environ["HERMES_HOME"] = tempfile.mkdtemp()
from hermes_cli import kanban_db as kb
assert kb.__file__.startswith(tree), kb.__file__
kb.get_current_board = lambda: board
from pathlib import Path
conn = kb.connect(db_path=Path(os.environ["HERMES_HOME"]) / "kanban.db")
tid = kb.create_task(conn, title="track", assignee="worker", initial_status="running")
# Handoff 1: worker blocks; ingress unblocks with new mail.
assert kb.block_task(conn, tid, reason="awaiting reply", kind="needs_input")
assert kb.unblock_task(conn, tid)
# Handoff 2: worker blocks again with the same kind -> block_loop_detected.
assert kb.block_task(conn, tid, reason="awaiting reply", kind="needs_input")
kinds = [e.kind for e in kb.list_events(conn, tid)]
assert "block_loop_detected" in kinds, kinds
status = kb.get_task(conn, tid).status
assert status == expect_loop, f"after loop: {status} != {expect_loop}"
# Dispatcher tick.
kb.recompute_ready(conn)
status = kb.get_task(conn, tid).status
assert status == expect_after, f"after recompute_ready: {status} != {expect_after} ({kinds})"
# Handoff 3: ingress unblocks again; the worker can still run and re-block.
if expect_after == "blocked":
    assert kb.unblock_task(conn, tid)
    assert kb.get_task(conn, tid).status == "ready"
    assert kb.block_task(conn, tid, reason="awaiting reply", kind="needs_input")
    kb.recompute_ready(conn)
    assert kb.get_task(conn, tid).status == "blocked"
print("ok", board, expect_loop, expect_after)
"""


def _runtime(tree: Path, hermes_dir: Path, board: str, expect_loop: str, expect_after: str) -> None:
    r = subprocess.run(
        [sys.executable, "-c", RUNTIME_CHECK, str(tree), str(hermes_dir), board,
         expect_loop, expect_after],
        capture_output=True, text=True,
    )
    assert r.returncode == 0, f"runtime check failed ({board}):\n{r.stdout}\n{r.stderr}"
    print(f"  {r.stdout.strip()}")


def main() -> int:
    hermes_dir = Path(os.environ.get("HERMES_DIR", "/opt/hermes-agent")).expanduser()
    if not (hermes_dir / "hermes_cli" / "kanban_db.py").is_file():
        print(f"skip: no Hermes tree at {hermes_dir} (set HERMES_DIR)")
        return 0
    patcher = _load_patcher()
    tmp = Path(tempfile.mkdtemp(prefix="joshu-keep-blocked-"))

    # Fresh apply, then idempotency.
    fresh = tmp / "fresh"
    _copy_tree(hermes_dir, fresh)
    _run_patcher(fresh)
    fresh_db = (fresh / "hermes_cli" / "kanban_db.py").read_text(encoding="utf-8")
    assert patcher.MARKER in fresh_db and patcher.STICKY_MARKER in fresh_db
    assert "already applied" in _run_patcher(fresh)
    assert (fresh / "hermes_cli" / "kanban_db.py").read_text(encoding="utf-8") == fresh_db
    print("ok fresh apply + idempotent")

    # Old patch (keep-blocked without the sticky event), then upgrade.
    old = tmp / "old"
    _copy_tree(hermes_dir, old)
    old_db_path = old / "hermes_cli" / "kanban_db.py"
    old_db_path.write_text(
        patcher._add_keep_blocked(old_db_path.read_text(encoding="utf-8")), encoding="utf-8",
    )
    assert patcher.STICKY_MARKER not in old_db_path.read_text(encoding="utf-8")
    # The old patch has the bug: recompute_ready promotes the kept-blocked track.
    _runtime(old, hermes_dir, "project-nova-360", "blocked", "ready")
    shutil.rmtree(old / "hermes_cli" / "__pycache__", ignore_errors=True)
    out = _run_patcher(old)
    assert "kept-blocked tasks stay sticky" in out, out
    assert old_db_path.read_text(encoding="utf-8") == fresh_db
    print("ok upgrade from old patch")

    # Runtime with the fix.
    _runtime(fresh, hermes_dir, "project-nova-360", "blocked", "blocked")
    _runtime(fresh, hermes_dir, "ea-scheduling", "blocked", "blocked")
    _runtime(fresh, hermes_dir, "default", "triage", "triage")
    shutil.rmtree(tmp, ignore_errors=True)
    print("all ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
