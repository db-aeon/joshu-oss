#!/usr/bin/env python3
"""Stop Kanban workers after terminal transitions (Joshu fleet fix for #61923).

Root cause (finn, 2026-09-09): worker called kanban_complete → DB status=done and
worker_pid=NULL, but the Hermes CLI kept running (7h CPU loop). Upstream fix
pending in NousResearch/hermes-agent#61967.

Patches:
  1) tools/kanban_tools.py — after successful kanban_complete/kanban_block from
     a dispatcher worker, arm a short os._exit backstop.
  2) hermes_cli/kanban_db.py — terminate foreign worker_pid on complete_task /
     block_task; reap orphan CLI processes on each dispatch tick.

Marker: _joshu_kanban_worker_terminate_on_complete
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

HERMES_DIR = Path(os.environ.get("HERMES_DIR", "/opt/hermes-agent")).resolve()
MARKER = "_joshu_kanban_worker_terminate_on_complete"

KANBAN_TOOLS = HERMES_DIR / "tools/kanban_tools.py"
KANBAN_DB = HERMES_DIR / "hermes_cli/kanban_db.py"


def _die(msg: str) -> None:
    print(f"[hermes-kanban-worker-terminate] error: {msg}", file=sys.stderr)
    sys.exit(1)


def _patch_kanban_tools(text: str) -> str:
    if MARKER in text and "_joshu_request_worker_stop_after_terminal" in text:
        print("[hermes-kanban-worker-terminate] kanban_tools: already applied")
        return text

    helper_anchor = "logger = logging.getLogger(__name__)"
    if helper_anchor not in text:
        _die("kanban_tools: logger anchor not found")

    helper = f'''
logger = logging.getLogger(__name__)


def _joshu_request_worker_stop_after_terminal() -> None:
    """Joshu ({MARKER}): exit dispatcher workers after terminal kanban tools."""
    if not os.environ.get("HERMES_KANBAN_TASK"):
        return
    import threading
    import time as _time

    def _backstop() -> None:
        _time.sleep(3.0)
        os._exit(0)

    threading.Thread(
        target=_backstop,
        daemon=True,
        name="joshu-kanban-exit-backstop",
    ).start()
'''

    text = text.replace(helper_anchor, helper.strip(), 1)

    complete_anchor = """            if not ok:
                return tool_error(
                    f"could not complete {tid} (unknown id or already terminal)"
                )
            run = kb.latest_run(conn, tid)"""

    if complete_anchor not in text:
        _die("kanban_tools: kanban_complete success anchor not found")

    complete_repl = f"""            if not ok:
                return tool_error(
                    f"could not complete {{tid}} (unknown id or already terminal)"
                )
            _joshu_request_worker_stop_after_terminal()  # {MARKER}
            run = kb.latest_run(conn, tid)"""

    text = text.replace(complete_anchor, complete_repl, 1)

    block_anchor = """            if not ok:
                return tool_error(
                    f"could not block {tid} (unknown id or not in "
                    f"running/ready)"
                )
            run = kb.latest_run(conn, tid)"""

    if block_anchor not in text:
        _die("kanban_tools: kanban_block success anchor not found")

    block_repl = f"""            if not ok:
                return tool_error(
                    f"could not block {{tid}} (unknown id or not in "
                    f"running/ready)"
                )
            _joshu_request_worker_stop_after_terminal()  # {MARKER}
            run = kb.latest_run(conn, tid)"""

    return text.replace(block_anchor, block_repl, 1)


def _patch_kanban_db(text: str) -> str:
    if MARKER in text and "_joshu_reap_orphan_kanban_workers" in text:
        print("[hermes-kanban-worker-terminate] kanban_db: already applied")
        return text

    helper_anchor = "def _terminate_reclaimed_worker("
    if helper_anchor not in text:
        _die("kanban_db: _terminate_reclaimed_worker anchor not found")

    helper = f'''
def _joshu_terminate_foreign_worker_for_task(
    conn: sqlite3.Connection,
    task_id: str,
) -> None:
    """Joshu ({MARKER}): SIGTERM foreign worker before clearing worker_pid."""
    row = conn.execute(
        "SELECT status, worker_pid, claim_lock FROM tasks WHERE id = ?",
        (task_id,),
    ).fetchone()
    if not row or not row["worker_pid"] or row["status"] != "running":
        return
    try:
        pid = int(row["worker_pid"])
    except (TypeError, ValueError):
        return
    if pid <= 0 or pid == os.getpid():
        return
    _terminate_reclaimed_worker(pid, row["claim_lock"])


def _joshu_reap_orphan_kanban_workers(
    conn: sqlite3.Connection,
    *,
    board: Optional[str] = None,
    max_kills: int = 5,
) -> list[int]:
    """Joshu ({MARKER}): kill live kanban CLI when DB says task is not running."""
    import re
    import signal

    killed: list[tuple[int, str]] = []
    if max_kills <= 0 or not hasattr(os, "kill"):
        return killed

    pattern = re.compile(r"work kanban task (t_[0-9a-f]+)")
    proc_root = Path("/proc")
    if not proc_root.is_dir():
        return killed

    for entry in proc_root.iterdir():
        if not entry.name.isdigit() or len(killed) >= max_kills:
            continue
        pid = int(entry.name)
        if pid == os.getpid():
            continue
        try:
            cmdline = (entry / "cmdline").read_bytes().replace(b"\\0", b" ").decode(
                "utf-8", errors="ignore"
            )
        except OSError:
            continue
        if "hermes" not in cmdline or "work kanban task" not in cmdline:
            continue
        match = pattern.search(cmdline)
        if not match:
            continue
        task_id = match.group(1)
        row = conn.execute(
            "SELECT status, worker_pid FROM tasks WHERE id = ?",
            (task_id,),
        ).fetchone()
        if row is None or row["status"] == "running":
            continue
        if row["worker_pid"] is not None and int(row["worker_pid"]) == pid:
            continue
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            continue
        except OSError:
            continue
        for _ in range(10):
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                killed.append((pid, task_id))
                break
            except OSError:
                break
            time.sleep(0.5)
        else:
            try:
                sigkill = getattr(signal, "SIGKILL", signal.SIGTERM)
                os.kill(pid, sigkill)
                killed.append((pid, task_id))
            except (ProcessLookupError, OSError):
                pass
    for pid, task_id in killed:
        try:
            _append_event(
                conn,
                task_id,
                "orphan_worker_terminated",
                {{"pid": pid, "board": board or get_current_board()}},
            )
        except Exception:
            pass
    return [pid for pid, _ in killed]


{helper_anchor}'''

    text = text.replace(helper_anchor, helper, 1)

    complete_anchor = '    now = int(time.time())\n\n    # Gate: verify created_cards BEFORE the main write txn.'
    if complete_anchor not in text:
        _die("kanban_db: complete_task now= anchor not found")

    complete_repl = f"""    _joshu_terminate_foreign_worker_for_task(conn, task_id)  # {MARKER}
    now = int(time.time())

    # Gate: verify created_cards BEFORE the main write txn."""

    text = text.replace(complete_anchor, complete_repl, 1)

    block_anchor = """    recurrences = 0
    with write_txn(conn):
        cur_row = conn.execute(
            "SELECT status, block_kind, block_recurrences FROM tasks WHERE id = ?",
            (task_id,),
        ).fetchone()"""

    if block_anchor not in text:
        _die("kanban_db: block_task write_txn anchor not found")

    block_repl = f"""    _joshu_terminate_foreign_worker_for_task(conn, task_id)  # {MARKER}
    recurrences = 0
    with write_txn(conn):
        cur_row = conn.execute(
            "SELECT status, block_kind, block_recurrences FROM tasks WHERE id = ?",
            (task_id,),
        ).fetchone()"""

    text = text.replace(block_anchor, block_repl, 1)

    dispatch_anchor = """    # Reap zombie children from previously spawned workers. See
    # reap_worker_zombies() for the full rationale.
    reap_worker_zombies()

    result = DispatchResult()"""

    if dispatch_anchor not in text:
        _die("kanban_db: dispatch_once_locked reap anchor not found")

    dispatch_repl = f"""    # Reap zombie children from previously spawned workers. See
    # reap_worker_zombies() for the full rationale.
    reap_worker_zombies()
    try:
        _joshu_reap_orphan_kanban_workers(conn, board=board)  # {MARKER}
    except Exception:
        logging.getLogger(__name__).debug(
            "orphan kanban worker reap failed", exc_info=True
        )

    result = DispatchResult()"""

    return text.replace(dispatch_anchor, dispatch_repl, 1)


def main() -> int:
    if not KANBAN_TOOLS.is_file():
        print(f"[hermes-kanban-worker-terminate] skip: {KANBAN_TOOLS} not found")
        return 0
    if not KANBAN_DB.is_file():
        print(f"[hermes-kanban-worker-terminate] skip: {KANBAN_DB} not found")
        return 0

    tools = KANBAN_TOOLS.read_text(encoding="utf-8")
    kanban = KANBAN_DB.read_text(encoding="utf-8")

    new_tools = _patch_kanban_tools(tools)
    new_kanban = _patch_kanban_db(kanban)

    changed = False
    if new_tools != tools:
        KANBAN_TOOLS.write_text(new_tools, encoding="utf-8")
        print(f"[hermes-kanban-worker-terminate] patched {KANBAN_TOOLS}")
        changed = True
    if new_kanban != kanban:
        KANBAN_DB.write_text(new_kanban, encoding="utf-8")
        print(f"[hermes-kanban-worker-terminate] patched {KANBAN_DB}")
        changed = True

    if not changed:
        print("[hermes-kanban-worker-terminate] already applied")
    else:
        print(
            "[hermes-kanban-worker-terminate] done — restart Hermes gateway to load changes"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
