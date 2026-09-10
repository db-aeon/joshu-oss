#!/usr/bin/env python3
"""
Joshu-side belt-and-suspenders: kill Hermes Kanban CLI workers whose task
is no longer ``running`` in the board DB (Finn-class zombie after complete).

Stdout: one JSON object. Exit 0 unless misconfigured.
"""
from __future__ import annotations

import json
import os
import re
import signal
import sys
import time
from pathlib import Path
from typing import Any

def _ensure_hermes_import_path() -> None:
    root = os.environ.get("HERMES_AGENT_ROOT", "").strip()
    if not root:
        return
    candidate = Path(root).resolve()
    if candidate.is_dir() and str(candidate) not in sys.path:
        sys.path.insert(0, str(candidate))


_ensure_hermes_import_path()

WORKER_CMD = re.compile(r"work kanban task (t_[0-9a-f]+)")
DEFAULT_MAX_KILLS = 5


def _scan_boards(hermes_home: Path) -> list[str]:
    boards_dir = hermes_home / "kanban" / "boards"
    if not boards_dir.is_dir():
        return ["default"]
    slugs = [p.name for p in boards_dir.iterdir() if p.is_dir()]
    return slugs or ["default"]


def _task_status(conn: Any, task_id: str) -> tuple[str | None, int | None]:
    row = conn.execute(
        "SELECT status, worker_pid FROM tasks WHERE id = ?",
        (task_id,),
    ).fetchone()
    if row is None:
        return None, None
    pid = row["worker_pid"]
    try:
        worker_pid = int(pid) if pid is not None else None
    except (TypeError, ValueError):
        worker_pid = None
    return str(row["status"]), worker_pid


def _terminate_pid(pid: int) -> bool:
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        return True
    except OSError:
        return False
    for _ in range(10):
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return True
        except OSError:
            return False
        time.sleep(0.5)
    try:
        sigkill = getattr(signal, "SIGKILL", signal.SIGTERM)
        os.kill(pid, sigkill)
        return True
    except (ProcessLookupError, OSError):
        return False


def _iter_worker_processes() -> list[tuple[int, str, str]]:
    """Return (pid, task_id, cmdline) for kanban worker CLIs."""
    found: list[tuple[int, str, str]] = []
    proc_root = Path("/proc")
    if not proc_root.is_dir():
        return found
    for entry in proc_root.iterdir():
        if not entry.name.isdigit():
            continue
        pid = int(entry.name)
        try:
            cmdline = entry.joinpath("cmdline").read_bytes().replace(b"\0", b" ").decode(
                "utf-8", errors="ignore"
            )
        except OSError:
            continue
        if "hermes" not in cmdline or "work kanban task" not in cmdline:
            continue
        if "gateway run" in cmdline:
            continue
        match = WORKER_CMD.search(cmdline)
        if not match:
            continue
        found.append((pid, match.group(1), cmdline.strip()))
    return found


def main() -> int:
    max_kills = int(os.environ.get("JOSHU_KANBAN_ORPHAN_REAP_MAX", str(DEFAULT_MAX_KILLS)))
    hermes_home = Path(os.environ.get("HERMES_HOME", "/root/.hermes")).expanduser()

    try:
        from hermes_cli import kanban_db
    except ImportError as exc:
        print(json.dumps({"ok": False, "error": f"kanban_db import failed: {exc}"}))
        return 1

    boards = _scan_boards(hermes_home)
    killed: list[dict[str, Any]] = []
    skipped = 0

    for pid, task_id, cmdline in _iter_worker_processes():
        if len(killed) >= max_kills:
            break
        status: str | None = None
        worker_pid: int | None = None
        matched_board: str | None = None
        for board in boards:
            conn = kanban_db.connect(board=board)
            try:
                status, worker_pid = _task_status(conn, task_id)
            finally:
                conn.close()
            if status is not None:
                matched_board = board
                break
        if status is None:
            skipped += 1
            continue
        if status == "running" and worker_pid == pid:
            skipped += 1
            continue
        if _terminate_pid(pid):
            killed.append(
                {
                    "pid": pid,
                    "task_id": task_id,
                    "board": matched_board,
                    "db_status": status,
                    "cmdline": cmdline[:200],
                }
            )
            print(
                f"[kanban-orphan-reaper] terminated pid={pid} task={task_id} "
                f"board={matched_board} status={status}",
                file=sys.stderr,
            )

    print(
        json.dumps(
            {
                "ok": True,
                "killed": killed,
                "killed_count": len(killed),
                "skipped": skipped,
            }
        )
    )
    return 0


def _self_test() -> int:
    samples = [
        ("hermes -p default work kanban task t_abc123", "t_abc123"),
        ("python /opt/hermes-agent/venv/bin/hermes work kanban task t_deadbeef extra", "t_deadbeef"),
        ("hermes gateway run", None),
    ]
    for cmdline, expected in samples:
        match = WORKER_CMD.search(cmdline)
        got = match.group(1) if match else None
        if got != expected:
            print(f"self-test failed: {cmdline!r} expected {expected!r} got {got!r}", file=sys.stderr)
            return 1
    print(json.dumps({"ok": True, "self_test": "passed"}))
    return 0


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--self-test":
        raise SystemExit(_self_test())
    raise SystemExit(main())
