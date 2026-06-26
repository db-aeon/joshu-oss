# Kanban SQLite direct insert reference

Use when `hermes` CLI is not on PATH and `kanban_*` tools are not in the active toolset.

## Database location

Board databases live at `~/.hermes/kanban/boards/project-<slug>/kanban.db`.

If the board doesn't exist yet, ensure it first:
- Joshu bridge: `mcp_joshu_connectors_project_kanban_ensure_board`
- Then locate the db at the path returned in `.meta.db_path`

## Tables

### `tasks` — main card storage

```sql
CREATE TABLE tasks (
    id                   TEXT PRIMARY KEY,  -- t_<12-char hex>
    title                TEXT NOT NULL,
    body                 TEXT,              -- JSON metadata
    assignee             TEXT,              -- profile name or NULL
    status               TEXT NOT NULL,     -- triage, todo, ready, running, blocked, done, archived
    priority             INTEGER DEFAULT 0,
    created_by           TEXT,
    created_at           INTEGER NOT NULL,  -- unix timestamp
    started_at           INTEGER,
    completed_at         INTEGER,
    workspace_kind       TEXT NOT NULL DEFAULT 'scratch',  -- scratch, dir, worktree
    workspace_path       TEXT,
    claim_lock           TEXT,
    claim_expires        INTEGER,
    tenant               TEXT,
    result               TEXT,
    idempotency_key      TEXT,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    worker_pid           INTEGER,
    last_failure_error   TEXT,
    max_runtime_seconds  INTEGER,
    last_heartbeat_at    INTEGER,
    current_run_id       INTEGER,
    workflow_template_id TEXT,
    current_step_key     TEXT,
    skills               TEXT,              -- JSON array of skill names
    max_retries          INTEGER
);
```

### `task_links` — parent/child dependencies

```sql
CREATE TABLE task_links (
    parent_id TEXT NOT NULL,
    child_id  TEXT NOT NULL,
    PRIMARY KEY (parent_id, child_id)
);
```

### `task_comments` — durable annotations

```sql
CREATE TABLE task_comments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id    TEXT NOT NULL,
    author     TEXT NOT NULL,
    body       TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
```

### `task_events` — audit log (runs, state transitions)

```sql
CREATE TABLE task_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id    TEXT NOT NULL,
    run_id     INTEGER,
    kind       TEXT NOT NULL,  -- created, claimed, completed, blocked, etc.
    payload    TEXT,           -- JSON
    created_at INTEGER NOT NULL
);
```

### `task_runs` — worker execution history

```sql
CREATE TABLE task_runs (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id             TEXT NOT NULL,
    profile             TEXT,
    step_key            TEXT,
    status              TEXT NOT NULL,   -- running | done | blocked | crashed | timed_out | failed | released
    claim_lock          TEXT,
    claim_expires       INTEGER,
    worker_pid          INTEGER,
    max_runtime_seconds INTEGER,
    last_heartbeat_at   INTEGER,
    started_at          INTEGER NOT NULL,
    ended_at            INTEGER,
    outcome             TEXT,   -- completed | blocked | crashed | timed_out | spawn_failed | gave_up | reclaimed
    summary             TEXT,
    metadata            TEXT,   -- JSON
    error               TEXT
);
```

### `kanban_notify_subs` — notification subscriptions

```sql
CREATE TABLE kanban_notify_subs (
    task_id         TEXT NOT NULL,
    platform        TEXT NOT NULL,
    chat_id         TEXT NOT NULL,
    thread_id       TEXT NOT NULL DEFAULT '',
    user_id         TEXT,
    notifier_profile TEXT,
    created_at      INTEGER NOT NULL,
    last_event_id   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (task_id, platform, chat_id, thread_id)
);
```

## Insert patterns

### Create a new card (parked / blocked)

```python
import sqlite3, json, secrets, time

conn = sqlite3.connect(db_path)
cursor = conn.execute("SELECT id FROM tasks")
existing = {row[0] for row in cursor.fetchall()}

while True:
    new_id = "t_" + secrets.token_hex(6)
    if new_id not in existing:
        break

conn.execute(
    """INSERT INTO tasks (id, title, body, status, assignee, priority, created_by, created_at, workspace_kind)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
    (new_id,
     "Name — email@example.com",
     json.dumps({"name": "Name", "email": "email@example.com", "e1_sent": "Jun 13"}),
     "blocked",   # status
     None,        # assignee (None for blocked/parked)
     0,           # priority
     "patrick",
     int(time.time()),
     "scratch")
)
conn.commit()
```

### Create a ready-to-work card

Same pattern but: `status="todo"`, `assignee="default"`.

### Query all cards

```python
cursor = conn.execute("SELECT id, title, status, assignee FROM tasks ORDER BY created_at")
for row in cursor.fetchall():
    print(f"  {row[0]} | {row[1]} | {row[2]} | {row[3]}")
```

### Update card status

```python
conn.execute("UPDATE tasks SET status = ? WHERE id = ?", ("done", task_id))
conn.commit()
```