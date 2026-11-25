#!/usr/bin/env python3
"""
Unit test for scripts/hermes-session-prune.py and for the function of the start script
that runs it.

The test needs no Hermes and no box. It writes a small copy of the Hermes module
`hermes_state` to a temporary folder. The copy has the same rules as the pinned Hermes
for the functions that the script calls: `prune_sessions` deletes only ended sessions,
and `end_session` sets the end time only one time.

To also run the script with the code of a Hermes checkout, set JOSHU_TEST_HERMES_PYTHON to
the Python of its virtual environment and HERMES_AGENT_ROOT to the checkout.
"""
from __future__ import annotations

import importlib.util
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent / "hermes-session-prune.py"

FAKE_HERMES_STATE = '''
import sqlite3, time
from pathlib import Path

class SessionDB:
    def __init__(self, db_path):
        self._conn = sqlite3.connect(str(db_path))

    def end_session(self, session_id, end_reason):
        self._conn.execute(
            "UPDATE sessions SET ended_at = ?, end_reason = ? WHERE id = ? AND ended_at IS NULL",
            (time.time(), end_reason, session_id),
        )
        self._conn.commit()

    def prune_sessions(self, older_than_days=90, source=None, sessions_dir=None, **filters):
        import os
        if os.environ.get("FAKE_HERMES_FAIL") == "prune":
            raise RuntimeError("disk I/O error")
        cutoff = time.time() - older_than_days * 86400
        rows = self._conn.execute(
            """SELECT s.id FROM sessions s WHERE s.ended_at IS NOT NULL AND s.source = ?
               AND COALESCE((SELECT MAX(m.timestamp) FROM messages m WHERE m.session_id = s.id),
                            s.started_at) < ?""",
            (source, cutoff),
        ).fetchall()
        for (sid,) in rows:
            self._conn.execute("DELETE FROM messages WHERE session_id = ?", (sid,))
            self._conn.execute("DELETE FROM sessions WHERE id = ?", (sid,))
            if sessions_dir is not None:
                (Path(sessions_dir) / f"{sid}.jsonl").unlink(missing_ok=True)
        self._conn.commit()
        return len(rows)

    def get_meta(self, key):
        row = self._conn.execute("SELECT value FROM state_meta WHERE key = ?", (key,)).fetchone()
        return row[0] if row else None

    def set_meta(self, key, value):
        self._conn.execute("INSERT OR REPLACE INTO state_meta (key, value) VALUES (?, ?)", (key, value))
        self._conn.commit()

    def vacuum(self):
        self.set_meta("vacuum_calls", str(int(self.get_meta("vacuum_calls") or 0) + 1))
        return 0

    def close(self):
        self._conn.close()
'''

# id, source, age of the last message in days, has an end time
SESSIONS = [
    ("kanban-old", "kanban", 45, False),
    ("kanban-old-ended", "kanban", 40, True),
    ("kanban-new", "kanban", 5, False),
    ("cron-old", "cron", 60, True),
    ("cron-new", "cron", 2, True),
    ("chat-old", "api_server", 90, False),
    ("slack-old", "slack", 90, True),
    ("no-messages-old", "kanban", 50, False),
]


def build_home(home: Path) -> None:
    (home / "sessions").mkdir(parents=True)
    conn = sqlite3.connect(home / "state.db")
    conn.executescript(
        """
        CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, started_at REAL,
                               ended_at REAL, end_reason TEXT);
        CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, timestamp REAL);
        CREATE TABLE state_meta (key TEXT PRIMARY KEY, value TEXT);
        """
    )
    now = time.time()
    for sid, source, age, ended in SESSIONS:
        at = now - age * 86400
        conn.execute(
            "INSERT INTO sessions VALUES (?, ?, ?, ?, ?)",
            (sid, source, at, at + 60 if ended else None, "done" if ended else None),
        )
        if sid != "no-messages-old":
            conn.execute("INSERT INTO messages (session_id, timestamp) VALUES (?, ?)", (sid, at))
        (home / "sessions" / f"{sid}.jsonl").write_text("{}\n")
    conn.commit()
    conn.close()


PRUNE_ENV = (
    "JOSHU_SESSION_PRUNE_DAYS",
    "JOSHU_SESSION_PRUNE_SOURCES",
    "JOSHU_SESSION_PRUNE_TIMEOUT_SEC",
    "FAKE_HERMES_FAIL",
)


def run(home: Path, hermes_root: Path, expect_code: int = 0, python: str = sys.executable,
        **env: str) -> dict:
    full_env = {**os.environ, "HERMES_HOME": str(home), "HERMES_AGENT_ROOT": str(hermes_root)}
    for key in PRUNE_ENV:
        full_env.pop(key, None)
    full_env.update(env)
    done = subprocess.run(
        [python, str(SCRIPT)], env=full_env, capture_output=True, text=True, check=False
    )
    assert done.returncode == expect_code, (done.returncode, done.stdout, done.stderr)
    return json.loads(done.stdout.strip().splitlines()[-1])


def load_script():
    spec = importlib.util.spec_from_file_location("hermes_session_prune", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def message_count(home: Path, session_id: str) -> int:
    conn = sqlite3.connect(home / "state.db")
    try:
        return conn.execute(
            "SELECT COUNT(*) FROM messages WHERE session_id = ?", (session_id,)
        ).fetchone()[0]
    finally:
        conn.close()


def set_meta(home: Path, key: str, value: str) -> None:
    conn = sqlite3.connect(home / "state.db")
    conn.execute("INSERT OR REPLACE INTO state_meta VALUES (?, ?)", (key, value))
    conn.commit()
    conn.close()


def start_script_function() -> str:
    text = (SCRIPT.parent.parent / "deploy" / "scripts" / "vps-start.sh").read_text()
    found = re.search(r"^prune_hermes_session_history\(\) \{\n.*?^\}\n", text, re.S | re.M)
    assert found, "prune_hermes_session_history is not in vps-start.sh"
    return found.group(0)


def run_start_function(root: Path, python_body: str, timeout_sec: str = "240"):
    """Runs the function of the start script with a stand-in for the Python of Hermes."""
    box = Path(tempfile.mkdtemp(dir=root))
    (box / "scripts").mkdir()
    (box / "scripts" / "hermes-session-prune.py").write_text("")
    (box / "hermes" / "venv" / "bin").mkdir(parents=True)
    fake_python = box / "hermes" / "venv" / "bin" / "python"
    fake_python.write_text("#!/usr/bin/env bash\n" + python_body + "\n")
    fake_python.chmod(0o755)
    (box / "home").mkdir()
    (box / "home" / "state.db").write_text("")
    harness = box / "harness.sh"
    harness.write_text(
        "set -euo pipefail\n"
        f'JOSHU_SCRIPTS_ROOT="{box}/scripts"\nHERMES_DIR="{box}/hermes"\nHERMES_HOME="{box}/home"\n'
        f'JOSHU_SESSION_PRUNE_TIMEOUT_SEC="{timeout_sec}"\n'
        + start_script_function()
        + "prune_hermes_session_history\necho after-prune\n"
    )
    return subprocess.run(["bash", str(harness)], capture_output=True, text=True, check=False)


def session_ids(home: Path) -> set[str]:
    conn = sqlite3.connect(home / "state.db")
    try:
        return {row[0] for row in conn.execute("SELECT id FROM sessions")}
    finally:
        conn.close()


def meta(home: Path, key: str) -> str | None:
    conn = sqlite3.connect(home / "state.db")
    try:
        row = conn.execute("SELECT value FROM state_meta WHERE key = ?", (key,)).fetchone()
        return row[0] if row else None
    finally:
        conn.close()


def main() -> None:
    module = load_script()

    # Settings.
    assert module.parse_days(None) == 30.0
    assert module.parse_days("45") == 45.0
    assert module.parse_days("0") == 0.0
    assert module.parse_days("off") == 0.0, "a value that is no number turns the script off"
    assert module.parse_sources(None) == ["kanban", "cron"]
    assert module.parse_sources(" , ") == ["kanban", "cron"]
    assert module.parse_sources("cron, cli") == ["cron", "cli"]
    assert module.parse_budget("300") == 150.0
    assert module.parse_budget(None) == 120.0

    # The delete steps go from the oldest sessions to the age limit.
    assert module.step_ages(100, 30) == [90, 80, 70, 60, 50, 40, 30]
    assert module.step_ages(35, 30) == [30]
    assert module.step_ages(5, 30) == [30]

    # VACUUM needs two times the file size next to state.db and one time in the temporary folder.
    gib = 2**30
    assert module.vacuum_room_problem(4 * gib, 9 * gib, 5 * gib) is None
    assert "free disk" in module.vacuum_room_problem(4 * gib, 7 * gib, 50 * gib)
    assert "temporary" in module.vacuum_room_problem(4 * gib, 9 * gib, 3 * gib)
    now = time.time()
    assert module.vacuum_due(None, now) is True
    assert module.vacuum_due(str(now - 7 * 86400), now) is False
    assert module.vacuum_due(str(now - 31 * 86400), now) is True

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        hermes_root = root / "hermes"
        hermes_root.mkdir()
        (hermes_root / "hermes_state.py").write_text(FAKE_HERMES_STATE)

        # Default settings: old Kanban and cron sessions go, and every other session stays.
        home = root / "home-default"
        build_home(home)
        result = run(home, hermes_root)
        assert result["sources"] == ["kanban", "cron"], result
        assert result["days"] == 30.0, result
        assert result["ended"] == {"kanban": 2, "cron": 0}, result
        assert result["pruned"] == {"kanban": 3, "cron": 1}, result
        assert result["vacuumed"] is True, result
        assert session_ids(home) == {"kanban-new", "cron-new", "chat-old", "slack-old"}
        left = {path.stem for path in (home / "sessions").iterdir()}
        assert left == {"kanban-new", "cron-new", "chat-old", "slack-old"}, left
        assert message_count(home, "chat-old") == 1, "the messages of the owner stay"
        assert message_count(home, "slack-old") == 1
        assert message_count(home, "kanban-old") == 0
        assert meta(home, "vacuum_calls") == "1"

        # A second run finds nothing to delete and does not run VACUUM again.
        result = run(home, hermes_root)
        assert result["pruned"] == {"kanban": 0, "cron": 0}, result
        assert result["vacuumed"] is False, result
        assert meta(home, "vacuum_calls") == "1"

        # VACUUM ran less than 30 days ago: the delete still runs, and VACUUM waits.
        home = root / "home-recent-vacuum"
        build_home(home)
        set_meta(home, "last_vacuum", str(time.time() - 86400))
        result = run(home, hermes_root)
        assert sum(result["pruned"].values()) == 4, result
        assert result["vacuumed"] is False, result
        assert "30 days" in result["vacuum_skipped"], result
        assert meta(home, "vacuum_calls") is None
        # A later start runs the VACUUM that is still to do, also when it deletes nothing.
        set_meta(home, "last_vacuum", str(time.time() - 31 * 86400))
        result = run(home, hermes_root)
        assert sum(result["pruned"].values()) == 0, result
        assert result["vacuumed"] is True, result
        assert meta(home, "vacuum_calls") == "1"

        # No time budget: the script ends the old sessions and deletes nothing. The next
        # start deletes them.
        home = root / "home-no-time"
        build_home(home)
        result = run(home, hermes_root, JOSHU_SESSION_PRUNE_TIMEOUT_SEC="0")
        assert result["out_of_time"] is True, result
        assert sum(result["pruned"].values()) == 0, result
        assert len(session_ids(home)) == len(SESSIONS)
        result = run(home, hermes_root)
        assert result["pruned"] == {"kanban": 3, "cron": 1}, result

        # Another source list and another age limit.
        home = root / "home-custom"
        build_home(home)
        result = run(
            home, hermes_root, JOSHU_SESSION_PRUNE_SOURCES="cron", JOSHU_SESSION_PRUNE_DAYS="1"
        )
        assert result["pruned"] == {"cron": 2}, result
        assert "kanban-old" in session_ids(home)

        # 0 days turns the script off, and so does a value that is no number.
        for value in ("0", "off"):
            home = root / f"home-off-{value}"
            build_home(home)
            result = run(home, hermes_root, JOSHU_SESSION_PRUNE_DAYS=value)
            assert result["skipped"] == "turned off", result
            assert len(session_ids(home)) == len(SESSIONS)

        # A box with no session history yet.
        home = root / "home-empty"
        home.mkdir()
        result = run(home, hermes_root)
        assert result["skipped"] == "no state.db", result

        # An error in Hermes: exit code 1, and the JSON line tells the error.
        home = root / "home-error"
        build_home(home)
        result = run(home, hermes_root, expect_code=1, FAKE_HERMES_FAIL="prune")
        assert "disk I/O error" in result["error"], result
        # Hermes cannot be loaded: the same.
        result = run(home, root / "no-hermes-here", expect_code=1)
        assert "hermes_state" in result["error"], result

        # The function of the start script: a normal run writes the result line.
        done = run_start_function(root, 'echo \'{"pruned": {"kanban": 3}}\'')
        assert done.returncode == 0, done.stderr
        assert '[vps-start] hermes session prune: {"pruned"' in done.stdout, done.stdout
        # A failed run writes a warning, and the start goes on.
        done = run_start_function(root, 'echo \'{"error": "boom"}\'; exit 1')
        assert done.returncode == 0, done.stderr
        assert "WARN: hermes session prune failed" in done.stderr, done.stderr
        assert "boom" in done.stderr, done.stderr
        assert "after-prune" in done.stdout
        # A run that takes too long is stopped, and the start goes on.
        if shutil.which("timeout"):
            done = run_start_function(root, "sleep 30", timeout_sec="1")
            assert done.returncode == 0, done.stderr
            assert "WARN: hermes session prune failed" in done.stderr, done.stderr
            assert "after-prune" in done.stdout
        else:
            print("note: no `timeout` command here, so the time limit case did not run")

        real_python = os.environ.get("JOSHU_TEST_HERMES_PYTHON", "").strip()
        real_root = os.environ.get("HERMES_AGENT_ROOT", "").strip()
        if real_python and real_root:
            run_with_real_hermes(root, real_python, Path(real_root))
        else:
            print("note: JOSHU_TEST_HERMES_PYTHON is not set, so the case with the Hermes code did not run")

    # The start script of the box runs the script before the Joshu API starts. The Joshu
    # API starts the Hermes gateway, so the gateway does not write state.db during the run.
    start_script = (SCRIPT.parent.parent / "deploy" / "scripts" / "vps-start.sh").read_text()
    call = start_script.index("\nprune_hermes_session_history\n")
    assert call < start_script.index("node dist/server.js"), "prune must run before the Joshu API"
    assert "hermes-session-prune.py" in start_script

    print("hermes session prune: all checks passed")


REAL_BUILD = '''
import os, sys, time, sqlite3
from pathlib import Path
sys.path.insert(0, os.environ["HERMES_AGENT_ROOT"])
from hermes_state import SessionDB
home = Path(os.environ["HERMES_HOME"])
(home / "sessions").mkdir(parents=True)
db = SessionDB(home / "state.db")
plan = [("k-old-1", "kanban", 45, False), ("k-old-2", "kanban", 31, False),
        ("k-new", "kanban", 5, False), ("c-old", "cron", 60, True), ("c-new", "cron", 2, True),
        ("chat-old", "api_server", 90, False), ("slack-old", "slack", 90, True)]
for sid, source, age, ended in plan:
    db.create_session(sid, source)
    for i in range(40):
        db.append_message(sid, "user", content=f"marker-{sid} " + "lorem ipsum dolor " * 200)
    (home / "sessions" / f"{sid}.jsonl").write_text("{}")
    if ended:
        db.end_session(sid, "test")
db.close()
conn = sqlite3.connect(home / "state.db")
now = time.time()
for sid, source, age, ended in plan:
    at = now - age * 86400
    conn.execute("UPDATE sessions SET started_at = ? WHERE id = ?", (at, sid))
    conn.execute("UPDATE messages SET timestamp = ? WHERE session_id = ?", (at, sid))
    if ended:
        conn.execute("UPDATE sessions SET ended_at = ? WHERE id = ?", (at + 60, sid))
conn.commit()
'''


def run_with_real_hermes(root: Path, python: str, hermes_root: Path) -> None:
    """The same rules with the code of a Hermes checkout: real tables and real search indexes."""
    home = root / "home-real"
    env = {**os.environ, "HERMES_HOME": str(home), "HERMES_AGENT_ROOT": str(hermes_root)}
    home.mkdir()
    subprocess.run([python, "-c", REAL_BUILD], env=env, check=True, capture_output=True)
    result = run(home, hermes_root, python=python)
    assert result["ended"] == {"kanban": 2, "cron": 0}, result
    assert result["pruned"] == {"kanban": 2, "cron": 1}, result
    assert result["vacuumed"] is True, result
    assert result["bytes_after"] < result["bytes_before"], result
    assert session_ids(home) == {"k-new", "c-new", "chat-old", "slack-old"}
    left = {path.stem for path in (home / "sessions").iterdir()}
    assert left == {"k-new", "c-new", "chat-old", "slack-old"}, left
    assert message_count(home, "chat-old") == 40
    result = run(home, hermes_root, python=python)
    assert sum(result["pruned"].values()) == 0 and result["vacuumed"] is False, result
    print("hermes session prune: the case with the Hermes code passed")


if __name__ == "__main__":
    main()
