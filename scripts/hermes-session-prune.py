#!/usr/bin/env python3
"""
Deletes old worker sessions from the Hermes session history (state.db).

A box writes one Hermes session for each Kanban worker run and each cron run, and Hermes
never deletes a session by itself on a box. The start script of the box runs this script
before the Hermes gateway starts, so no other process writes state.db at that time.

The script deletes a session only when its source is in JOSHU_SESSION_PRUNE_SOURCES
(default: kanban,cron) and its last message is older than JOSHU_SESSION_PRUNE_DAYS days
(default: 30). Sessions of every other source stay, for example the chats of the owner.

Hermes deletes only ended sessions, and a Kanban worker session never gets an end time.
So the script first ends each old session of the chosen sources, and then calls the
prune function of Hermes, which also removes the transcript files of the session.

The start of the box waits for this script, so the script works in steps and has a time
budget. It deletes the oldest sessions first, in steps of 10 days of age, and it starts
no new step after the budget. The next start of the box goes on from there.

After a delete, the script runs VACUUM, which gives the freed space back to the disk.
VACUUM runs at most one time in 30 days, only inside the time budget, and only when the
disk has room. A key in table state_meta records that a VACUUM is still to do, so a later
start runs it when this start could not.

Environment:
  HERMES_HOME                      folder with state.db (default: ~/.hermes)
  HERMES_AGENT_ROOT                folder of the Hermes source, for `import hermes_state`
  JOSHU_SESSION_PRUNE_DAYS         age limit in days; 0 or a value that is no number
                                   turns the script off
  JOSHU_SESSION_PRUNE_SOURCES      session sources to delete, separated by commas
  JOSHU_SESSION_PRUNE_TIMEOUT_SEC  the start script stops this script after this time
                                   (default 240); the time budget is half of it

Stdout: one JSON object. Exit code 0, or 1 when the JSON object has the key "error".
"""
from __future__ import annotations

import json
import os
import shutil
import sqlite3
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Optional

DEFAULT_DAYS = 30.0
DEFAULT_SOURCES = "kanban,cron"
DEFAULT_TIMEOUT_SEC = 240.0
END_REASON = "joshu_session_prune"
STEP_DAYS = 10.0
VACUUM_INTERVAL_DAYS = 30
VACUUM_PENDING_KEY = "joshu_session_prune_vacuum_pending"
# VACUUM writes a copy of the file to the temporary folder and then writes the copy back
# through the journal, so the folder of state.db can need two times the size of the file.
VACUUM_DB_DIR_FACTOR = 2.0
VACUUM_TMP_DIR_FACTOR = 1.0

LAST_ACTIVE_SQL = (
    "COALESCE((SELECT MAX(m.timestamp) FROM messages m WHERE m.session_id = s.id), s.started_at)"
)


def _ensure_hermes_import_path() -> None:
    root = os.environ.get("HERMES_AGENT_ROOT", "").strip()
    if not root:
        return
    candidate = Path(root).resolve()
    if candidate.is_dir() and str(candidate) not in sys.path:
        sys.path.insert(0, str(candidate))


def parse_days(raw: Optional[str]) -> float:
    """The age limit in days. 0 means off. A value that is no number also means off."""
    text = (raw or "").strip()
    if not text:
        return DEFAULT_DAYS
    try:
        days = float(text)
    except ValueError:
        return 0.0
    return days if days > 0 else 0.0


def parse_sources(raw: Optional[str]) -> list[str]:
    parts = [part.strip() for part in (raw or "").split(",") if part.strip()]
    return parts or [part for part in DEFAULT_SOURCES.split(",")]


def parse_budget(raw: Optional[str]) -> float:
    """Half of the time limit of the start script, so a started step can still end."""
    try:
        limit = float((raw or "").strip() or DEFAULT_TIMEOUT_SEC)
    except ValueError:
        limit = DEFAULT_TIMEOUT_SEC
    return max(limit, 0.0) / 2


def step_ages(oldest_age_days: float, days: float) -> list[float]:
    """Age limits for the delete steps, oldest sessions first, ending at `days`."""
    ages: list[float] = []
    age = oldest_age_days - STEP_DAYS
    while age > days:
        ages.append(age)
        age -= STEP_DAYS
    ages.append(days)
    return ages


def vacuum_room_problem(db_bytes: int, free_db_dir: int, free_tmp_dir: int) -> Optional[str]:
    """Why the disk has no room for VACUUM, or None when it has room."""
    need_db_dir = int(db_bytes * VACUUM_DB_DIR_FACTOR)
    if free_db_dir < need_db_dir:
        return f"free disk {free_db_dir} bytes is less than {need_db_dir} bytes"
    need_tmp_dir = int(db_bytes * VACUUM_TMP_DIR_FACTOR)
    if free_tmp_dir < need_tmp_dir:
        return f"free temporary space {free_tmp_dir} bytes is less than {need_tmp_dir} bytes"
    return None


def vacuum_due(last_vacuum: Optional[str], now: float) -> bool:
    if not last_vacuum:
        return True
    try:
        return now - float(last_vacuum) >= VACUUM_INTERVAL_DAYS * 86400
    except (TypeError, ValueError):
        return True


def _size(path: Path) -> int:
    try:
        return path.stat().st_size
    except OSError:
        return 0


def _read_only(db_path: Path) -> sqlite3.Connection:
    return sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)


def old_open_session_ids(db_path: Path, source: str, cutoff: float) -> list[str]:
    """Sessions of one source that have no end time and no message after the cutoff."""
    conn = _read_only(db_path)
    try:
        rows = conn.execute(
            f"SELECT s.id FROM sessions s WHERE s.source = ? AND s.ended_at IS NULL "
            f"AND {LAST_ACTIVE_SQL} < ?",
            (source, cutoff),
        ).fetchall()
    finally:
        conn.close()
    return [row[0] for row in rows]


def oldest_last_active(db_path: Path, source: str) -> Optional[float]:
    conn = _read_only(db_path)
    try:
        row = conn.execute(
            f"SELECT MIN({LAST_ACTIVE_SQL}) FROM sessions s WHERE s.source = ?", (source,)
        ).fetchone()
    finally:
        conn.close()
    return row[0] if row else None


def prune(db: Any, db_path: Path, hermes_home: Path, days: float, sources: list[str],
          budget_sec: float, result: dict[str, Any]) -> None:
    started = time.monotonic()
    now = time.time()

    def in_budget() -> bool:
        return time.monotonic() - started < budget_sec

    for source in sources:
        ids = old_open_session_ids(db_path, source, now - days * 86400)
        for session_id in ids:
            db.end_session(session_id, END_REASON)
        result["ended"][source] = len(ids)
        result["pruned"][source] = 0

        oldest = oldest_last_active(db_path, source)
        if oldest is None:
            continue
        for age in step_ages((now - oldest) / 86400, days):
            if not in_budget():
                result["out_of_time"] = True
                break
            result["pruned"][source] += db.prune_sessions(
                older_than_days=age,
                source=source,
                sessions_dir=hermes_home / "sessions",
            )

    if sum(result["pruned"].values()) > 0:
        db.set_meta(VACUUM_PENDING_KEY, "1")
    if db.get_meta(VACUUM_PENDING_KEY) != "1":
        return
    if not vacuum_due(db.get_meta("last_vacuum"), now):
        result["vacuum_skipped"] = "VACUUM ran less than 30 days ago"
        return
    if not in_budget():
        result["vacuum_skipped"] = "out of time"
        return
    problem = vacuum_room_problem(
        _size(db_path),
        shutil.disk_usage(db_path.parent).free,
        shutil.disk_usage(tempfile.gettempdir()).free,
    )
    if problem:
        result["vacuum_skipped"] = problem
        return
    db.vacuum()
    db.set_meta("last_vacuum", str(now))
    db.set_meta(VACUUM_PENDING_KEY, "0")
    result["vacuumed"] = True


def main() -> int:
    days = parse_days(os.environ.get("JOSHU_SESSION_PRUNE_DAYS"))
    sources = parse_sources(os.environ.get("JOSHU_SESSION_PRUNE_SOURCES"))
    budget_sec = parse_budget(os.environ.get("JOSHU_SESSION_PRUNE_TIMEOUT_SEC"))
    hermes_home = Path(os.environ.get("HERMES_HOME", "").strip() or Path.home() / ".hermes")
    db_path = hermes_home / "state.db"
    result: dict[str, Any] = {
        "days": days,
        "sources": sources,
        "ended": {},
        "pruned": {},
        "vacuumed": False,
    }

    if days <= 0:
        result["skipped"] = "turned off"
        print(json.dumps(result))
        return 0
    if not db_path.is_file():
        result["skipped"] = "no state.db"
        print(json.dumps(result))
        return 0

    result["bytes_before"] = _size(db_path)
    db = None
    try:
        _ensure_hermes_import_path()
        from hermes_state import SessionDB

        db = SessionDB(db_path)
        prune(db, db_path, hermes_home, days, sources, budget_sec, result)
    except Exception as exc:  # noqa: BLE001 - the start of the box must go on
        result["error"] = f"{type(exc).__name__}: {exc}"
    finally:
        close = getattr(db, "close", None)
        if callable(close):
            try:
                close()
            except Exception:  # noqa: BLE001
                pass

    result["bytes_after"] = _size(db_path)
    print(json.dumps(result))
    return 1 if "error" in result else 0


if __name__ == "__main__":
    sys.exit(main())
