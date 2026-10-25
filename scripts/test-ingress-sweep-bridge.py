#!/usr/bin/env python3
"""Test for action archive_stale_blocked of the Kanban bridge (change stale-ingress-sweep).

Hermes is not installed on a development machine, so the test replaces
hermes_cli.kanban_db with a small fake that has the same tables and calls.
Usage: python3 scripts/test-ingress-sweep-bridge.py
"""
import importlib.util
import sqlite3
import sys
import time
import types
from pathlib import Path

HOUR = 3600
NOW = int(time.time())
conns = {}


def connect(board=None):
    if board not in conns:
        c = sqlite3.connect(":memory:")
        c.executescript(
            """
            CREATE TABLE tasks (id TEXT PRIMARY KEY, status TEXT, block_kind TEXT,
                                worker_pid INTEGER, created_at INTEGER);
            CREATE TABLE task_events (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT,
                                      kind TEXT, created_at INTEGER);
            CREATE TABLE task_comments (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT,
                                        author TEXT, body TEXT, created_at INTEGER);
            """
        )
        conns[board] = c
    return conns[board]


def add_comment(conn, task_id, author, body):
    conn.execute(
        "INSERT INTO task_comments (task_id, author, body, created_at) VALUES (?, ?, ?, ?)",
        (task_id, author, body, NOW),
    )
    return 1


def archive_task(conn, task_id):
    cur = conn.execute("UPDATE tasks SET status = 'archived' WHERE id = ? AND status != 'archived'", (task_id,))
    if cur.rowcount != 1:
        return False
    conn.execute("INSERT INTO task_events (task_id, kind, created_at) VALUES (?, 'archived', ?)", (task_id, NOW))
    return True


fake = types.ModuleType("hermes_cli.kanban_db")
fake.DEFAULT_BOARD = "default"
fake.connect = connect
fake.add_comment = add_comment
fake.archive_task = archive_task
pkg = types.ModuleType("hermes_cli")
pkg.kanban_db = fake
sys.modules["hermes_cli"] = pkg
sys.modules["hermes_cli.kanban_db"] = fake

spec = importlib.util.spec_from_file_location("bridge", Path(__file__).with_name("hermes-kanban-bridge.py"))
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


def add_task(board, task_id, status, kind=None, pid=None, created_hours_ago=100, event_hours_ago=None):
    c = connect(board)
    c.execute(
        "INSERT INTO tasks (id, status, block_kind, worker_pid, created_at) VALUES (?, ?, ?, ?, ?)",
        (task_id, status, kind, pid, NOW - created_hours_ago * HOUR),
    )
    if event_hours_ago is not None:
        c.execute(
            "INSERT INTO task_events (task_id, kind, created_at) VALUES (?, 'blocked', ?)",
            (task_id, NOW - event_hours_ago * HOUR),
        )


def status(board, task_id):
    return connect(board).execute("SELECT status FROM tasks WHERE id = ?", (task_id,)).fetchone()[0]


B = "ea-mail-ingress"
add_task(B, "t_gave_up", "blocked", None, event_hours_ago=49)  # stale, no kind
add_task(B, "t_transient", "blocked", "transient", event_hours_ago=72)  # stale
add_task(B, "t_capability", "blocked", "capability", event_hours_ago=500)  # stale
add_task(B, "t_no_events", "blocked", "transient", created_hours_ago=60)  # stale by created_at
add_task(B, "t_recent_event", "blocked", "transient", created_hours_ago=720, event_hours_ago=2)  # recent event
add_task(B, "t_owner_question", "blocked", "needs_input", event_hours_ago=240)  # owner question
add_task(B, "t_ready", "ready", None, event_hours_ago=72)
add_task(B, "t_running", "blocked", "transient", pid=4242, event_hours_ago=72)  # has a worker
add_task("project-x", "t_other_board", "blocked", "transient", event_hours_ago=720)

res = bridge._dispatch({"action": "archive_stale_blocked", "board": B, "max_age_seconds": 48 * HOUR})
assert res["success"], res
assert sorted(res["archived"]) == ["t_capability", "t_gave_up", "t_no_events", "t_transient"], res
assert res["remaining"] == 0, res
for keep in ("t_recent_event", "t_owner_question", "t_ready", "t_running"):
    assert status(B, keep) != "archived", keep
assert status("project-x", "t_other_board") == "blocked"
comments = connect(B).execute("SELECT DISTINCT author FROM task_comments").fetchall()
assert comments == [("joshu-ingress-sweep",)], comments
assert "not by the owner" in connect(B).execute("SELECT body FROM task_comments").fetchone()[0]

# A second run changes nothing.
res = bridge._dispatch({"action": "archive_stale_blocked", "board": B, "max_age_seconds": 48 * HOUR})
assert res["success"] and res["archived"] == [] and res["remaining"] == 0, res

# Other board: refused.
res = bridge._dispatch({"action": "archive_stale_blocked", "board": "project-x", "max_age_seconds": 48 * HOUR})
assert not res["success"], res

# The limit bounds a run and reports the rest.
for i in range(5):
    add_task(B, f"t_bulk_{i}", "blocked", "transient", event_hours_ago=100 + i)
res = bridge._dispatch({"action": "archive_stale_blocked", "board": B, "max_age_seconds": 48 * HOUR, "limit": 3})
assert len(res["archived"]) == 3 and res["remaining"] == 2, res
assert res["archived"][0] == "t_bulk_4", res  # the oldest event first

# Bad input is refused.
for bad in ({}, {"max_age_seconds": 0}, {"max_age_seconds": "x"}):
    res = bridge._dispatch({"action": "archive_stale_blocked", "board": B, **bad})
    assert not res["success"], bad

print("test-ingress-sweep-bridge: ok")
