# The Hermes Kanban engine and how Joshu changes it

This page covers the Hermes side of the boards and what Joshu adds on top. Joshu runs Hermes at ref `3c27eb6` (v0.20.0), pinned in `deploy/Dockerfile` (`HERMES_AGENT_REF`).

## Storage

Each board is a folder `/root/.hermes/kanban/boards/<slug>/` in the `joshu-stack` container, with `kanban.db` (SQLite), `board.json` (name, description, default workdir), and `logs/<task_id>.log` (output of every worker run). Joshu always names a board, so its tasks are never on the Hermes `default` board.

Table `tasks` holds one row per task. The columns that matter to Joshu are:

| Column | How Joshu uses it |
|---|---|
| `id` | `t_` plus 8 hex characters, for example `t_5c2e81a0`. |
| `title`, `body` | The body starts with a `kind:` header and instructions. Joshu later appends to it. |
| `assignee` | Always `default` (`JOSHU_HERMES_KANBAN_ASSIGNEE`). |
| `status`, `block_kind` | See below. Joshu reads `block_kind` to find owner questions. |
| `skills` | The preloaded skills of the worker, for example `["ea-mail-track"]`. Hermes puts each whole `SKILL.md` into the system prompt of the worker. |
| `workspace_path` | The folder the worker starts in: `<files>` or `<files>/Projects/<slug>`. |
| `idempotency_key` | Stops the same email or request from making two tasks. |
| `max_runtime_seconds` | 28800 on EA boards; not set on project boards. |

The other tables are `task_events` (one row per change; the block reason lives in the newest `blocked` event), `task_comments`, `task_runs` (one row per worker run, with outcome and summary), and `task_links` (parent and child links from auto-decompose).

## Statuses

Joshu tasks use seven Hermes statuses:

- `ready`: waiting for the dispatcher.
- `running`: a worker owns the task.
- `blocked`: no worker runs until an unblock. The block reason and block kind say why.
- `done`: finished.
- `todo`: waiting for parent tasks (auto-decompose children, and tasks with a dependency block that have an open parent task).
- `triage`: waiting for auto-decompose (only project triage roots).
- `archived`: cancelled.

```mermaid
stateDiagram-v2
  [*] --> ready: create
  [*] --> triage: create with triage (project root)
  triage --> todo: auto-decompose
  todo --> ready: parents done
  ready --> running: dispatcher claims
  running --> done: kanban_complete
  running --> blocked: kanban_block
  running --> todo: kanban_block kind dependency, open parent task
  running --> ready: crash or timeout
  ready --> blocked: 2 failures in a row
  blocked --> ready: unblock
  done --> ready: reopen (realtime goals)
  blocked --> archived: cancel
  running --> archived: cancel
```

For mail tracks and onboarding tasks, Joshu calls `create` and then `block` at once, so the dispatcher never sees them `ready`. The bridge can also complete a task in any open status, for example when the owner replies DONE to a nudge.

## The dispatcher and workers

The dispatcher is a loop inside the Hermes gateway. Joshu turns it on in `ensureJoshuHermesConfig` (`src/hermesApi.ts`) with `kanban.dispatch_in_gateway: true`, `dispatch_interval_seconds: 60`, and `auto_decompose: true`. On each tick it stops workers that crashed or ran too long, promotes `todo` tasks whose parents are done, and claims each `ready` task (oldest first) and starts a worker:

```
hermes -p default --cli --accept-hooks --skills ea-mail-track chat -q "work kanban task t_9d41b7e2"
```

The worker starts in the task's workspace with `HERMES_KANBAN_TASK=<id>` and `HERMES_KANBAN_BOARD=<slug>` set. Its only prompt is `work kanban task <id>`. It learns the rest from the skills on the task, from Hermes' worker guidance in the system prompt, and from `kanban_show`, which returns the body, comments, events, and earlier runs.

A worker can change only its own task, with `kanban_complete`, `kanban_block`, `kanban_comment`, and `kanban_heartbeat`. Joshu also gives the `kanban` tools to chat sessions (jChat, SMS, voice), so the companion can read and close tasks when the owner asks.

Hermes has three limits:

- A run that exceeds `max_runtime_seconds` is stopped.
- After 2 crashes or timeouts in a row, the task is blocked with event `gave_up`.
- After the same block kind twice in a row, stock Hermes moves the task to `triage` (the unblock-loop breaker). A Joshu patch keeps EA, project, and team board tasks `blocked` instead. The patch also writes a `blocked` event, so that the dispatcher (`recompute_ready`) does not move the task back to `ready`. The task stays blocked until the next handoff unblocks it.

**Auto-decompose** sends `triage` tasks to an LLM, which splits them into child tasks. In Joshu only project triage roots start in `triage`, and the patch below turns auto-decompose off for EA boards.

### Dependency blocks

A worker can call `kanban_block` with block kind `dependency`. Stock Hermes then sets status `todo`, not `blocked`, and writes a `dependency_wait` event. The dispatcher (`recompute_ready`) moves a `todo` task to `ready` when all its parent tasks are `done` or `archived`. That check is true for a task with no parent task, so stock Hermes ran the worker again on the next tick, within a minute, with nothing new to do. Workers choose `dependency` for a track that waits on an outside person, because the description of `kanban_block` says that `dependency` "resumes automatically". Most mail tracks have no parent task.

The patch `patch-hermes-ea-kanban-no-autodecompose.py` adds this rule to `block_task`:

1. When the block kind is `dependency` and the task has no open parent task, the patch clears the block kind, and `block_task` continues on its normal path. The task gets status `blocked` and a `blocked` event, so `recompute_ready` keeps it blocked until a handoff unblocks it. The block also counts for the unblock-loop breaker, the same as a block with no block kind. Writing status `blocked` inside the dependency branch was rejected, because it needs a copy of the normal path, and the unblock-loop breaker would count `dependency` apart from no block kind.
2. An open parent task is a parent task whose status is not `done` and not `archived`. These are the statuses that `recompute_ready` treats as finished, so the patch clears the block kind exactly when `recompute_ready` would promote the task at once.
3. The rule applies on every board, because the loop does not depend on the board. A dependency block on a task with an open parent task keeps the behavior of Hermes.

A delay before the dispatcher claims a task again was rejected: the reruns had no new email, so a delay only postpones the same empty run. Test: `HERMES_DIR=<hermes-agent checkout> npm run test:hermes-ea-kanban-keep-blocked`.

## Joshu patches to Hermes

`deploy/scripts/vps-start.sh` applies these at every container start (three also run at image build):

| Script | Effect |
|---|---|
| `patch-hermes-ea-kanban-no-autodecompose.py` | Auto-decompose skips the EA boards and the Multiplayer team boards `team-<slug>`. A block loop on an EA, project, or team board keeps the task `blocked` and writes a `blocked` event, so the dispatcher does not promote it to `ready`. On every board, a dependency block on a task with no open parent task becomes a block with no block kind (see [Dependency blocks](#dependency-blocks)). |
| `patch-hermes-kanban-worker-terminate-on-complete.py` | A worker exits 3 seconds after `kanban_complete` or `kanban_block`. When another process completes or blocks a running task, the worker of the task is stopped first, except when the caller belongs to that worker (see [Stopping the worker of a task](#stopping-the-worker-of-a-task)). Each tick kills up to 5 workers whose task is no longer running. |
| `patch-hermes-kanban-guidance-gate.py` | The worker guidance goes into the system prompt only for workers, not for chat sessions. |
| `apply-hermes-kanban-ws-base-path-patch.sh` | Fixes the dashboard's live updates when it is served under `/joshu/hermes-admin`. |

The Joshu API also runs `scripts/hermes-kanban-orphan-reaper.py` every 60 seconds, which stops leftover worker processes in the same way.

### Stopping the worker of a task

When a task leaves status `running` because some process other than its worker closed it, the worker process must stop, or it keeps running with no task and can still send mail (upstream Hermes issue 61923). So `complete_task` and `block_task` first send SIGTERM to the PID in `tasks.worker_pid`, and SIGKILL 5 seconds later if the worker still runs. The native tools `kanban_complete` and `kanban_block` run in the worker process itself, so the patch skips the signal when `tasks.worker_pid` is the PID of the caller.

A worker can also close its own task with `hermes kanban complete <task id>` or `hermes kanban block <task id>` through its terminal tool. The CLI is then a child process of the worker, through a shell. Before October 2026 the patch killed the worker in that case, so the worker ended with exit code 130, and the dispatcher recorded a crashed run with "protocol violation". The patch now skips the signal in two more cases:

1. `HERMES_KANBAN_TASK` in the environment of the caller is the id of the task. The dispatcher sets the variable only in the worker of that task, and the terminal tool keeps it in each command. The patch does not skip the signal for each caller that has the variable, because a worker of task A that closes task B must still stop the worker of task B.
2. The worker process is the parent, the grandparent, or a further ancestor of the caller. The patch reads the parent PID from `/proc/<pid>/stat` for each step, at most 64 steps. The check covers a caller that lost the variable, for example a child of `delegate_task`, whose environment Hermes cleans. Without `/proc`, the patch checks only the direct parent.

Removing the signal and relying on the orphan reaper was rejected, because the reaper runs once a minute, and a worker whose task the owner closed could keep working for that minute. On a box that has the old patch, the patch script replaces the old helper with the new one at the next container start. Test: `HERMES_DIR=<hermes-agent checkout> HERMES_PYTHON=<its venv python> npm run test:hermes-kanban-worker-terminate`.

## The Kanban bridge

The Joshu API does all board work through `callKanbanBridge` (`src/hermesKanbanBridge.ts`), which runs `scripts/hermes-kanban-bridge.py` with one JSON request and reads one JSON response. The bridge imports `hermes_cli.kanban_db`, so it uses the same code and files as Hermes.

On create, the bridge adds two rules. On EA boards, a task must have an assignee and cannot start in `triage`. When a task with the same idempotency key exists, the bridge does not make a second one: it unblocks a blocked match, returns an open match, and for a `done` match creates a new task with key `<key>-wave-<unix time>`. Realtime goals use a strict mode that returns any existing task, archived ones included.

The main actions are `ensure_board`, `create`, `list`, `show`, `block`, `unblock`, `update_block_reason`, `comment`, `append_body`, `complete`, `reopen`, `cancel`, `archive_stale_blocked`, and `find_open_by_text`. `find_open_by_text` searches the task bodies on many boards in one process and returns each task with the given statuses whose body contains the text, with its full body and its board (used for owner Gmail replies, see [Mail and project boards](mail-and-project-boards.md#tracks)). With `include_activity`, `list` and `show` add the block reason, the last comments, and `block_cause`, which says whether the worker blocked with a question (`source: worker`) or the system stopped the task (`source: system`). `cancel` stops the worker, comments, archives the task, and cancels its browser handoffs. `archive_stale_blocked` works on board `ea-mail-ingress` only: it comments on and archives each stale ingress task and returns task ids, never titles (see [Mail and project boards](mail-and-project-boards.md#an-ingress-task-that-cannot-finish)).

## The dashboard

The Kanban tab of the Hermes dashboard runs on `127.0.0.1:9119`. Caddy publishes it at `hermes-admin.<customer domain>` with basic auth (`deploy/scripts/render-caddyfile.sh`). From it the owner can view any board and also create, edit, comment on, move, and archive tasks. Those changes go straight into the same SQLite file.
