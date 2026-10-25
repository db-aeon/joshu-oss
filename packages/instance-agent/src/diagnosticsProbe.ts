/**
 * Read-only Python probe for the diagnostics command (change release-deploy-automation).
 * The instance agent runs the probe in the stack container with
 * `docker exec <stack> python3 -c DIAGNOSTICS_PROBE <query> [args…]`.
 * The probe opens SQLite files read-only, reads JSON and YAML files, and prints one JSON
 * object. The probe never writes a file and never prints a secret value.
 */
export const DIAGNOSTICS_PROBE = String.raw`
import glob, json, os, re, sqlite3, sys, time

HERMES = os.environ.get("HERMES_HOME") or "/root/.hermes"
SECRET_KEY = re.compile(r"(key|token|secret|password|passwd|auth|credential|cookie)", re.I)


def open_ro(path):
    return sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=10)


def cron_jobs():
    with open(f"{HERMES}/cron/jobs.json") as handle:
        jobs = json.load(handle).get("jobs", [])
    keep = ("id", "name", "schedule", "enabled", "state", "next_run_at", "last_run_at",
            "last_status", "model", "deliver", "repeat", "skills")
    rows = []
    for job in jobs:
        row = {key: job.get(key) for key in keep if key in job}
        error = job.get("last_error")
        row["last_error"] = str(error)[:300] if error else None
        rows.append(row)
    ticker = None
    try:
        with open(f"{HERMES}/cron/ticker_last_success") as handle:
            ticker = float(handle.read().strip())
    except (OSError, ValueError):
        pass
    return {"jobs": rows, "tickerLastSuccess": ticker,
            "tickerAgeSeconds": round(time.time() - ticker) if ticker else None}


def board_paths():
    paths = {path.split("/")[-2]: path for path in sorted(glob.glob(f"{HERMES}/kanban/boards/*/kanban.db"))}
    if os.path.exists(f"{HERMES}/kanban.db"):
        paths["(default)"] = f"{HERMES}/kanban.db"
    return paths


def kanban(board, limit):
    paths = board_paths()
    if not board:
        out = {}
        for name, path in paths.items():
            db = open_ro(path)
            out[name] = dict(db.execute("SELECT status, COUNT(*) FROM tasks GROUP BY status").fetchall())
        return {"boards": out}
    if board not in paths:
        raise SystemExit(f"no board {board}; boards: {', '.join(sorted(paths))}")
    db = open_ro(paths[board])
    db.row_factory = sqlite3.Row
    columns = {row[1] for row in db.execute("PRAGMA table_info(tasks)")}
    wanted = [c for c in ("id", "title", "status", "assignee", "kind", "block_kind", "created_at",
                          "completed_at", "updated_at") if c in columns]
    order = "updated_at" if "updated_at" in columns else "created_at"
    rows = db.execute(f"SELECT {', '.join(wanted)} FROM tasks ORDER BY {order} DESC LIMIT ?", (limit,)).fetchall()
    tasks = []
    for row in rows:
        item = dict(row)
        if isinstance(item.get("title"), str):
            item["title"] = item["title"][:160]
        tasks.append(item)
    status = dict(db.execute("SELECT status, COUNT(*) FROM tasks GROUP BY status").fetchall())
    return {"board": board, "status": status, "tasks": tasks}


def realtime_goals():
    states = glob.glob("/var/lib/arozos/files/users/*/Desktop/*/.joshu/realtime-goals/state.json")
    if not states:
        return {"present": False}
    with open(states[0]) as handle:
        state = json.load(handle)
    def count(items, key):
        out = {}
        for item in items:
            value = key(item)
            out[str(value)] = out.get(str(value), 0) + 1
        return out
    goals = state.get("goals", [])
    outbox = state.get("outbox", [])
    presence = (state.get("owner") or {}).get("presence") or {}
    return {
        "present": True,
        "goalsByStatus": count(goals, lambda g: g.get("status")),
        "goalsByDelivery": count(goals, lambda g: (g.get("delivery") or {}).get("state")),
        "goalsByChannel": count(goals, lambda g: (g.get("origin") or {}).get("channel")),
        "outboxByKindState": count(outbox, lambda i: f"{i.get('kind')}/{i.get('state')}"),
        "outboxHeardVia": count([i for i in outbox if i.get("heard")], lambda i: (i.get("heard") or {}).get("via")),
        "inboxUnprocessed": sum(1 for i in state.get("inbox", []) if not i.get("processedAt")),
        "presence": {
            "lastActivityAt": (presence.get("lastActivity") or {}).get("at"),
            "lastActivityChannel": (presence.get("lastActivity") or {}).get("channel"),
            "lastByChannel": {k: (v or {}).get("at") for k, v in (presence.get("lastByChannel") or {}).items()},
            "consecutiveMisses": presence.get("consecutiveMisses"),
        },
    }


def redact(value):
    if isinstance(value, dict):
        return {k: ("[redacted]" if SECRET_KEY.search(str(k)) else redact(v)) for k, v in value.items()}
    if isinstance(value, list):
        return [redact(v) for v in value]
    return value


def hermes_config():
    import yaml
    with open(f"{HERMES}/config.yaml") as handle:
        return {"config": redact(yaml.safe_load(handle) or {})}


def env_keys():
    names = []
    with open(f"{HERMES}/.env") as handle:
        for line in handle:
            match = re.match(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=", line)
            if match:
                names.append(match.group(1))
    return {"hermesEnvKeys": sorted(set(names))}


def skill_version(text):
    # The version is in the front matter: a top-level "version:", or "version:" under
    # metadata.hermes (indented), which most factory skills use.
    front = re.match(r"---\n(.*?)\n---", text, re.S)
    if not front:
        return None
    for pattern in (r"^version:\s*['\"]?([^'\"\n]+)", r"^\s+version:\s*['\"]?([^'\"\n]+)"):
        match = re.search(pattern, front.group(1), re.M)
        if match:
            return match.group(1).strip()
    return None


def skills():
    out = {}
    for path in sorted(glob.glob(f"{HERMES}/skills/**/SKILL.md", recursive=True)):
        name = os.path.relpath(os.path.dirname(path), f"{HERMES}/skills")
        with open(path, errors="replace") as handle:
            out[name] = skill_version(handle.read(4000))
    seed = None
    try:
        with open(f"{HERMES}/skills/joshu/.joshu-seed-version") as handle:
            seed = handle.read().strip()[:200]
    except OSError:
        pass
    return {"skills": out, "seedVersion": seed}


LOG_FILES = {"hermes-agent": "logs/agent.log", "hermes-errors": "logs/errors.log", "gateway-starts": "gateway-starts.log"}


def log_file(name, lines):
    path = f"{HERMES}/{LOG_FILES[name]}"
    with open(path, "rb") as handle:
        handle.seek(0, 2)
        size = handle.tell()
        handle.seek(max(0, size - 4_000_000))
        text = handle.read().decode("utf-8", "replace")
    return {"lines": text.splitlines()[-lines:]}


def main():
    query = sys.argv[1]
    args = sys.argv[2:]
    if query == "cron_jobs":
        out = cron_jobs()
    elif query == "kanban":
        out = kanban(args[0] if args and args[0] else None, int(args[1]) if len(args) > 1 else 50)
    elif query == "realtime_goals":
        out = realtime_goals()
    elif query == "hermes_config":
        out = hermes_config()
    elif query == "env_keys":
        out = env_keys()
    elif query == "skills":
        out = skills()
    elif query == "log_file":
        out = log_file(args[0], int(args[1]))
    else:
        raise SystemExit(f"unknown probe query {query}")
    print(json.dumps(out, default=str))


main()
`;
