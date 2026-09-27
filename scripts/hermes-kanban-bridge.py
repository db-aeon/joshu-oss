#!/usr/bin/env python3
"""
JSON bridge for Joshu → Hermes Kanban (uses kanban_db directly, same as CLI).

Reads one JSON object from stdin, writes one JSON object to stdout.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

HERMES_AGENT_ROOT = Path(__file__).resolve().parent.parent
if str(HERMES_AGENT_ROOT) not in sys.path:
    env_root = os.environ.get("HERMES_AGENT_ROOT", "").strip()
    if env_root:
        candidate = Path(env_root).resolve()
        if candidate.is_dir():
            sys.path.insert(0, str(candidate))
    else:
        sibling = HERMES_AGENT_ROOT.parent / "hermes-agent"
        if sibling.is_dir():
            sys.path.insert(0, str(sibling))


def _respond(payload: Dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload))
    sys.stdout.flush()


def _fail(message: str, **extra: Any) -> None:
    body: Dict[str, Any] = {"success": False, "error": message}
    body.update(extra)
    _respond(body)


def _parse_skills(raw: Any) -> Optional[List[str]]:
    if raw is None:
        return None
    if isinstance(raw, str):
        parts = [p.strip() for p in raw.split(",")]
    elif isinstance(raw, list):
        parts = [str(p).strip() for p in raw]
    else:
        return None
    normalized = [p for p in parts if p]
    return normalized or None


def _task_summary(task: Any, *, include_body: bool = False) -> Dict[str, Any]:
    out: Dict[str, Any] = {
        "task_id": task.id,
        "title": task.title,
        "status": task.status,
        "assignee": task.assignee,
        "idempotency_key": getattr(task, "idempotency_key", None),
    }
    created = getattr(task, "created_at", None)
    if created is not None:
        out["created_at"] = created
    if include_body:
        out["body"] = task.body
    return out


# Events that start or end a blocked period. The most recent one explains the
# task's *current* blocked status; older ``blocked`` reasons may be stale.
_BLOCK_CAUSE_EVENTS = frozenset({"blocked", "block_loop_detected", "gave_up", "unblocked"})

# Reasons the bridge itself writes when a caller omits one — not a real question.
_PLACEHOLDER_BLOCK_REASONS = frozenset({"blocked"})


def _block_cause(events: List[Any]) -> Optional[Dict[str, Any]]:
    """Why the task is blocked right now.

    ``source`` is ``worker`` when a worker/operator called kanban_block with a
    reason, and ``system`` when Hermes's circuit breaker parked the task
    (``gave_up``: repeated crashes, spawn failures, timeouts, or clean exits
    without kanban_complete/kanban_block). System blocks carry no owner question.
    """
    for ev in reversed(events):
        if ev.kind not in _BLOCK_CAUSE_EVENTS:
            continue
        if ev.kind == "unblocked":
            return None
        payload = ev.payload if isinstance(ev.payload, dict) else {}
        if ev.kind == "gave_up":
            return {
                "source": "system",
                "event": ev.kind,
                "error": str(payload.get("error") or "").strip()[:500] or None,
                "trigger": str(payload.get("trigger_outcome") or "").strip() or None,
                "protocol_violations": payload.get("protocol_violations"),
            }
        reason = payload.get("reason")
        reason = reason.strip() if isinstance(reason, str) else ""
        if reason.lower() in _PLACEHOLDER_BLOCK_REASONS:
            reason = ""
        return {
            "source": "worker" if reason else "system",
            "event": ev.kind,
            "reason": reason or None,
        }
    return None


def _task_activity(conn: Any, task_id: str, *, max_comments: int = 5) -> Dict[str, Any]:
    """Recent Kanban comments and latest block reason for scheduling status queries."""
    from hermes_cli import kanban_db

    comments = kanban_db.list_comments(conn, task_id)
    events = kanban_db.list_events(conn, task_id)
    recent = comments[-max_comments:] if comments else []
    block_reason: Optional[str] = None
    completion_summary: Optional[str] = None
    for ev in reversed(events):
        payload = ev.payload if isinstance(ev.payload, dict) else {}
        if block_reason is None and ev.kind == "blocked":
            reason = payload.get("reason")
            if isinstance(reason, str) and reason.strip():
                block_reason = reason.strip()
        if completion_summary is None and ev.kind == "completed":
            summary = payload.get("summary")
            if isinstance(summary, str) and summary.strip():
                completion_summary = summary.strip()
    return {
        # Legacy: latest worker block reason, even if a later event superseded it.
        "block_reason": block_reason,
        # Current cause of the blocked status (see _block_cause).
        "block_cause": _block_cause(events),
        "completion_summary": completion_summary,
        "recent_comments": [
            {
                "author": c.author,
                "body": c.body,
                "created_at": c.created_at,
            }
            for c in recent
        ],
    }


def _latest_run_summary(conn: Any, task_id: str) -> Optional[Dict[str, Any]]:
    """Full latest run handoff; task events carry only a one-line preview."""
    from hermes_cli import kanban_db

    runs = kanban_db.list_runs(conn, task_id)
    if not runs:
        return None
    run = runs[-1]
    return {
        "run_id": run.id,
        "outcome": run.outcome,
        "summary": run.summary,
        "error": run.error,
        "metadata": run.metadata,
        "worker_pid": run.worker_pid,
    }


def _enrich_task_summary(
    conn: Any,
    summary: Dict[str, Any],
    *,
    include_activity: bool,
) -> Dict[str, Any]:
    if not include_activity:
        return summary
    task_id = str(summary.get("task_id") or "").strip()
    if not task_id:
        return summary
    summary.update(_task_activity(conn, task_id))
    return summary


def _create_task(conn: Any, board: str, **kwargs: Any) -> str:
    """Hermes 0.14 selects board via connect(); newer builds may accept board= on create_task."""
    from hermes_cli import kanban_db
    import inspect

    sig = inspect.signature(kanban_db.create_task)
    if "board" in sig.parameters:
        kwargs["board"] = board
    return kanban_db.create_task(conn, **kwargs)


# EA scheduling + mail ingress boards: tasks must be created with assignee → ready (never triage).
EA_KANBAN_BOARDS = frozenset({
    "ea-scheduling",
    "ea-sched-ingress",
    "ea-mail-ingress",
    "ea-owner-reply",
    "ea-onboarding",
    "realtime-goals",
})


def _parse_parents(raw: Any) -> Optional[List[str]]:
    if raw is None:
        return None
    if isinstance(raw, str):
        parts = [p.strip() for p in raw.split(",")]
    elif isinstance(raw, list):
        parts = [str(p).strip() for p in raw]
    else:
        return None
    normalized = [p for p in parts if p]
    return normalized or None


def _optional_create_kwargs(sig_params: Any, payload: Dict[str, Any]) -> Dict[str, Any]:
    """Pass triage, scheduled_at, parents when supported by kanban_db.create_task."""
    out: Dict[str, Any] = {}
    if "triage" in sig_params and payload.get("triage") is not None:
        out["triage"] = bool(payload.get("triage"))
    scheduled_at = payload.get("scheduled_at")
    if "scheduled_at" in sig_params and scheduled_at:
        out["scheduled_at"] = str(scheduled_at).strip()
    parents = _parse_parents(payload.get("parents"))
    if "parents" in sig_params and parents:
        out["parents"] = parents
    max_runtime = payload.get("max_runtime_seconds")
    if "max_runtime_seconds" in sig_params and max_runtime is not None:
        try:
            out["max_runtime_seconds"] = int(max_runtime)
        except (TypeError, ValueError):
            pass
    return out


def _find_by_idempotency(
    conn: Any,
    key: str,
    *,
    include_archived: bool = False,
) -> Optional[Any]:
    from hermes_cli import kanban_db

    archived_filter = "" if include_archived else " AND status != 'archived'"
    row = conn.execute(
        "SELECT id FROM tasks WHERE idempotency_key = ?" + archived_filter +
        " ORDER BY created_at DESC LIMIT 1",
        (key,),
    ).fetchone()
    if not row:
        return None
    return kanban_db.get_task(conn, row["id"])


def _dispatch(payload: Dict[str, Any]) -> Dict[str, Any]:
    action = str(payload.get("action") or "").strip().lower()
    if not action:
        return {"success": False, "error": "action is required"}

    from hermes_cli import kanban_db

    board = str(payload.get("board") or kanban_db.DEFAULT_BOARD).strip() or kanban_db.DEFAULT_BOARD

    if action == "ensure_board":
        slug = str(payload.get("slug") or board).strip()
        default_workdir = payload.get("default_workdir")
        board_kwargs: Dict[str, Any] = {
            "name": str(payload.get("name") or "EA Scheduling"),
            "description": str(
                payload.get("description") or "Joshu executive assistant scheduling cases"
            ),
        }
        if default_workdir:
            import inspect

            sig = inspect.signature(kanban_db.create_board)
            if "default_workdir" in sig.parameters:
                board_kwargs["default_workdir"] = str(default_workdir)
        meta = kanban_db.create_board(slug, **board_kwargs)
        kanban_db.init_db(board=slug)
        return {"success": True, "board": meta}

    conn = kanban_db.connect(board=board)

    if action == "find_by_idempotency":
        key = str(payload.get("idempotency_key") or "").strip()
        if not key:
            return {"success": False, "error": "idempotency_key is required"}
        task = _find_by_idempotency(
            conn,
            key,
            include_archived=bool(payload.get("include_archived")),
        )
        if not task:
            return {"success": True, "found": False}
        return {"success": True, "found": True, "task": _task_summary(task)}

    if action == "create":
        title = str(payload.get("title") or "").strip()
        if not title:
            return {"success": False, "error": "title is required"}
        body = payload.get("body")
        assignee = payload.get("assignee")
        idempotency_key = payload.get("idempotency_key")
        strict_idempotency = bool(payload.get("strict_idempotency"))
        skills = _parse_skills(payload.get("skills"))
        workspace_path = payload.get("workspace_path") or payload.get("workspace")
        workspace_kind = str(payload.get("workspace_kind") or "dir").strip()
        if workspace_kind not in ("dir", "scratch", "worktree"):
            workspace_kind = "dir"
        if workspace_kind == "dir" and not workspace_path:
            return {"success": False, "error": "workspace_path is required for dir workspace"}

        triage = bool(payload.get("triage"))
        assignee_str = str(assignee).strip() if assignee else ""
        if board in EA_KANBAN_BOARDS:
            if triage or not assignee_str:
                return {
                    "success": False,
                    "error": (
                        f"board {board} requires assignee and forbids triage creates "
                        "(EA scheduling uses ready tasks, not auto-decompose)"
                    ),
                }

        if idempotency_key:
            if strict_idempotency:
                # Hermes's general idempotency index is intentionally non-unique.
                # Realtime goals need an atomic uniqueness boundary because a
                # duplicate can repeat external work after a crash.
                with kanban_db.write_txn(conn):
                    conn.execute(
                        "CREATE UNIQUE INDEX IF NOT EXISTS "
                        "idx_joshu_realtime_goal_idempotency "
                        "ON tasks(idempotency_key) "
                        "WHERE idempotency_key LIKE 'realtime-goal:v1:%'"
                    )
            existing = _find_by_idempotency(
                conn,
                str(idempotency_key),
                include_archived=strict_idempotency,
            )
            if existing:
                status = existing.status
                if strict_idempotency:
                    return {
                        "success": True,
                        "task_id": existing.id,
                        "action_taken": "existing",
                        "task": _task_summary(existing),
                    }
                if status == "blocked":
                    kanban_db.unblock_task(conn, existing.id)
                    refreshed = kanban_db.get_task(conn, existing.id)
                    return {
                        "success": True,
                        "task_id": existing.id,
                        "action_taken": "unblocked",
                        "task": _task_summary(refreshed) if refreshed else _task_summary(existing),
                    }
                if status in ("ready", "running", "todo", "triage", "scheduled"):
                    return {
                        "success": True,
                        "task_id": existing.id,
                        "action_taken": "existing_active",
                        "task": _task_summary(existing),
                    }
                # Terminal kanban column — allow a new handler wave for still-open cases.
                if status == "done":
                    wave_key = f"{idempotency_key}-wave-{int(__import__('time').time())}"
                    idempotency_key = wave_key

        try:
            import inspect

            from hermes_cli import kanban_db as _kanban_db

            sig = inspect.signature(_kanban_db.create_task)
            extra = _optional_create_kwargs(sig.parameters, payload)
            task_id = _create_task(
                conn,
                board,
                title=title,
                body=str(body) if body is not None else None,
                assignee=assignee_str or None,
                workspace_kind=workspace_kind,
                workspace_path=str(workspace_path) if workspace_path else None,
                idempotency_key=str(idempotency_key) if idempotency_key else None,
                skills=skills,
                **extra,
            )
            parents = _parse_parents(payload.get("parents"))
            if parents and "parents" not in sig.parameters and hasattr(_kanban_db, "link_tasks"):
                for parent_id in parents:
                    _kanban_db.link_tasks(conn, parent_id, task_id)
        except ValueError as exc:
            return {"success": False, "error": str(exc)}

        task = kanban_db.get_task(conn, task_id)
        return {
            "success": True,
            "task_id": task_id,
            "action_taken": "created",
            "task": _task_summary(task) if task else {"task_id": task_id},
        }

    if action == "reopen":
        task_id = str(payload.get("task_id") or "").strip()
        if not task_id:
            return {"success": False, "error": "task_id is required"}
        task = kanban_db.get_task(conn, task_id)
        if not task:
            return {"success": False, "error": f"task {task_id} not found"}
        status = str(task.status or "")
        if status in ("ready", "running", "todo", "blocked"):
            return {
                "success": True,
                "task_id": task_id,
                "action_taken": "already_active",
                "task": _task_summary(task),
            }
        if status != "done":
            return {
                "success": False,
                "error": f"task {task_id} cannot reopen from status {status}",
            }
        conn.execute("UPDATE tasks SET status = ? WHERE id = ?", ("ready", task_id))
        conn.commit()
        refreshed = kanban_db.get_task(conn, task_id)
        return {
            "success": True,
            "task_id": task_id,
            "action_taken": "reopened",
            "task": _task_summary(refreshed) if refreshed else {"task_id": task_id},
        }

    if action == "unblock":
        task_id = str(payload.get("task_id") or "").strip()
        idempotency_key = str(payload.get("idempotency_key") or "").strip()
        if not task_id and idempotency_key:
            found = _find_by_idempotency(conn, idempotency_key)
            if not found:
                return {"success": False, "error": "task not found for idempotency_key"}
            task_id = found.id
        if not task_id:
            return {"success": False, "error": "task_id or idempotency_key is required"}
        ok = kanban_db.unblock_task(conn, task_id)
        if not ok:
            task = kanban_db.get_task(conn, task_id)
            if task and task.status in ("ready", "running", "todo"):
                return {
                    "success": True,
                    "task_id": task_id,
                    "action_taken": "already_active",
                    "task": _task_summary(task),
                }
            return {"success": False, "error": f"could not unblock task {task_id}"}
        task = kanban_db.get_task(conn, task_id)
        return {
            "success": True,
            "task_id": task_id,
            "action_taken": "unblocked",
            "task": _task_summary(task) if task else {"task_id": task_id},
        }

    if action == "block":
        task_id = str(payload.get("task_id") or "").strip()
        if not task_id:
            return {"success": False, "error": "task_id is required"}
        reason = str(payload.get("reason") or "blocked").strip() or "blocked"
        block_fn = getattr(kanban_db, "block_task", None)
        if not callable(block_fn):
            return {"success": False, "error": "kanban_db.block_task not available"}
        ok = block_fn(conn, task_id, reason=reason)
        if not ok:
            task = kanban_db.get_task(conn, task_id)
            if task and task.status == "blocked":
                return {
                    "success": True,
                    "task_id": task_id,
                    "action_taken": "already_blocked",
                    "task": _task_summary(task),
                }
            return {"success": False, "error": f"could not block task {task_id}"}
        task = kanban_db.get_task(conn, task_id)
        return {
            "success": True,
            "task_id": task_id,
            "action_taken": "blocked",
            "task": _task_summary(task) if task else {"task_id": task_id},
        }

    if action == "list":
        status = payload.get("status")
        limit = payload.get("limit")
        include_body = bool(payload.get("include_body"))
        include_activity = bool(payload.get("include_activity"))
        tasks = kanban_db.list_tasks(
            conn,
            status=str(status) if status else None,
            limit=int(limit) if limit is not None else 50,
        )
        summaries = [_task_summary(t, include_body=include_body) for t in tasks]
        if include_activity:
            summaries = [_enrich_task_summary(conn, s, include_activity=True) for s in summaries]
        return {
            "success": True,
            "tasks": summaries,
        }

    if action == "show":
        task_id = str(payload.get("task_id") or "").strip()
        if not task_id:
            return {"success": False, "error": "task_id is required"}
        task = kanban_db.get_task(conn, task_id)
        if not task:
            return {"success": False, "error": f"task {task_id} not found"}
        summary = _task_summary(task, include_body=True)
        if bool(payload.get("include_activity")):
            summary = _enrich_task_summary(conn, summary, include_activity=True)
        if bool(payload.get("include_run")):
            summary["latest_run"] = _latest_run_summary(conn, task_id)
        return {"success": True, "task": summary}

    if action == "comment":
        task_id = str(payload.get("task_id") or "").strip()
        body = payload.get("body")
        author = str(payload.get("author") or "joshu").strip() or "joshu"
        if not task_id:
            return {"success": False, "error": "task_id is required"}
        if not body or not str(body).strip():
            return {"success": False, "error": "body is required"}
        cid = kanban_db.add_comment(conn, task_id, author=author, body=str(body))
        return {"success": True, "task_id": task_id, "comment_id": cid}

    if action == "update_block_reason":
        # Rewrite block_reason on an already-blocked task without unblock→ready
        # (which would race the dispatcher). Appends a new "blocked" event —
        # list APIs read the latest blocked event's reason.
        task_id = str(payload.get("task_id") or "").strip()
        reason = str(payload.get("reason") or "").strip()
        comment = payload.get("comment")
        author = str(payload.get("author") or "joshu").strip() or "joshu"
        if not task_id:
            return {"success": False, "error": "task_id is required"}
        if not reason:
            return {"success": False, "error": "reason is required"}
        task = kanban_db.get_task(conn, task_id)
        if not task:
            return {"success": False, "error": f"task {task_id} not found"}
        status = str(task.status or "")
        if status == "done":
            return {
                "success": False,
                "error": f"task {task_id} is done — refuse to rewrite block reason",
            }
        if status in ("ready", "running", "todo"):
            ok = kanban_db.block_task(conn, task_id, reason=reason)
            if not ok:
                return {"success": False, "error": f"could not block task {task_id}"}
        elif status == "blocked":
            append_fn = getattr(kanban_db, "_append_event", None)
            write_txn = getattr(kanban_db, "write_txn", None)
            if not callable(append_fn) or not callable(write_txn):
                return {
                    "success": False,
                    "error": "kanban_db._append_event/write_txn not available",
                }
            with write_txn(conn):
                append_fn(conn, task_id, "blocked", {"reason": reason})
        else:
            return {
                "success": False,
                "error": f"unsupported status {status!r} for update_block_reason",
            }
        comment_id = None
        if comment is not None and str(comment).strip():
            comment_id = kanban_db.add_comment(conn, task_id, author=author, body=str(comment).strip())
        refreshed = kanban_db.get_task(conn, task_id)
        summary = _task_summary(refreshed) if refreshed else {"task_id": task_id}
        summary = _enrich_task_summary(conn, summary, include_activity=True)
        return {
            "success": True,
            "task_id": task_id,
            "action_taken": "block_reason_updated",
            "comment_id": comment_id,
            "task": summary,
        }

    if action == "append_body":
        task_id = str(payload.get("task_id") or "").strip()
        append = payload.get("append")
        if not task_id:
            return {"success": False, "error": "task_id is required"}
        if append is None or not str(append).strip():
            return {"success": False, "error": "append is required"}
        task = kanban_db.get_task(conn, task_id)
        if not task:
            return {"success": False, "error": f"task {task_id} not found"}
        new_body = f"{(task.body or '').rstrip()}\n{str(append).strip()}\n"
        if hasattr(kanban_db, "update_task"):
            kanban_db.update_task(conn, task_id, body=new_body)
        else:
            conn.execute("UPDATE tasks SET body = ? WHERE id = ?", (new_body, task_id))
            conn.commit()
        refreshed = kanban_db.get_task(conn, task_id)
        return {
            "success": True,
            "task_id": task_id,
            "task": _task_summary(refreshed, include_body=True) if refreshed else {"task_id": task_id},
        }

    if action == "complete":
        task_id = str(payload.get("task_id") or "").strip()
        comment = payload.get("comment")
        author = str(payload.get("author") or "joshu").strip() or "joshu"
        if not task_id:
            return {"success": False, "error": "task_id is required"}
        if comment is None or not str(comment).strip():
            return {"success": False, "error": "comment is required for complete (audit trail)"}
        task = kanban_db.get_task(conn, task_id)
        if not task:
            return {"success": False, "error": f"task {task_id} not found"}
        if str(task.status or "") == "done":
            return {
                "success": True,
                "task_id": task_id,
                "action_taken": "already_done",
                "task": _task_summary(task),
            }
        complete_fn = getattr(kanban_db, "complete_task", None)
        if callable(complete_fn):
            ok = complete_fn(conn, task_id)
        else:
            conn.execute("UPDATE tasks SET status = ? WHERE id = ?", ("done", task_id))
            conn.commit()
            ok = True
        if not ok:
            return {"success": False, "error": f"could not complete task {task_id}"}
        comment_id = kanban_db.add_comment(conn, task_id, author=author, body=str(comment).strip())
        refreshed = kanban_db.get_task(conn, task_id)
        return {
            "success": True,
            "task_id": task_id,
            "action_taken": "completed",
            "comment_id": comment_id,
            "task": _task_summary(refreshed) if refreshed else {"task_id": task_id},
        }

    if action == "cancel":
        # Archive prevents future dispatch. If a worker is active, terminate the
        # worker first; archive alone closes its DB run but does not stop it.
        import signal
        import time

        task_id = str(payload.get("task_id") or "").strip()
        reason = str(payload.get("reason") or "Owner cancelled").strip()
        if not task_id:
            return {"success": False, "error": "task_id is required"}
        task = kanban_db.get_task(conn, task_id)
        if not task:
            return {"success": False, "error": f"task {task_id} not found"}
        if str(task.status or "") == "archived":
            return {
                "success": True,
                "task_id": task_id,
                "action_taken": "already_cancelled",
                "task": _task_summary(task),
            }

        worker_pid = getattr(task, "worker_pid", None)
        terminated = False
        if worker_pid and int(worker_pid) > 0:
            pid = int(worker_pid)
            pid_alive = getattr(kanban_db, "_pid_alive", None)
            alive = bool(pid_alive(pid)) if callable(pid_alive) else True
            if alive and sys.platform == "linux":
                try:
                    environ = Path(f"/proc/{pid}/environ").read_bytes().split(b"\0")
                    expected = f"HERMES_KANBAN_TASK={task_id}".encode("utf-8")
                    if expected not in environ:
                        return {
                            "success": False,
                            "error": f"worker pid {pid} does not belong to task {task_id}",
                        }
                except FileNotFoundError:
                    alive = False
                except (PermissionError, OSError) as exc:
                    return {
                        "success": False,
                        "error": f"cannot verify worker pid {pid}: {exc}",
                    }

            if alive:
                try:
                    # Dispatcher starts workers in their own session. Kill the
                    # process group so browser/tool children cannot outlive cancel.
                    os.killpg(pid, signal.SIGTERM)
                    terminated = True
                except ProcessLookupError:
                    alive = False
                except (PermissionError, OSError) as exc:
                    return {
                        "success": False,
                        "error": f"could not terminate worker pid {pid}: {exc}",
                    }
                for _ in range(20):
                    alive = bool(pid_alive(pid)) if callable(pid_alive) else False
                    if not alive:
                        break
                    time.sleep(0.1)
                if alive:
                    try:
                        os.killpg(pid, signal.SIGKILL)
                    except ProcessLookupError:
                        alive = False
                    except (PermissionError, OSError) as exc:
                        return {
                            "success": False,
                            "error": f"could not kill worker pid {pid}: {exc}",
                        }
                    for _ in range(10):
                        alive = bool(pid_alive(pid)) if callable(pid_alive) else False
                        if not alive:
                            break
                        time.sleep(0.1)
                if alive:
                    return {
                        "success": False,
                        "error": f"worker pid {pid} remained alive after SIGKILL",
                    }

        kanban_db.add_comment(
            conn,
            task_id,
            author="joshu-realtime-goals",
            body=f"Cancelled by owner: {reason[:500]}",
        )
        archived = kanban_db.archive_task(conn, task_id)
        refreshed = kanban_db.get_task(conn, task_id)
        # Drop pending browser handoffs tied to this task so cloud idle stop can run.
        try:
            import json
            import urllib.request

            base = os.environ.get("JOSHU_CONNECTORS_API_BASE", "http://127.0.0.1:8788/joshu").strip().rstrip("/")
            req = urllib.request.Request(
                f"{base}/api/browser-handoff/cancel-by-kanban-task",
                data=json.dumps({"task_id": task_id}).encode("utf-8"),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            urllib.request.urlopen(req, timeout=5)
        except Exception:
            pass
        return {
            "success": bool(archived),
            "task_id": task_id,
            "action_taken": "cancelled" if archived else "cancel_failed",
            "worker_terminated": terminated,
            "task": _task_summary(refreshed) if refreshed else {"task_id": task_id},
        }

    return {"success": False, "error": f"unknown action: {action}"}


def main() -> int:
    try:
        raw = sys.stdin.read()
        if not raw.strip():
            _fail("empty request body")
            return 1
        payload = json.loads(raw)
        if not isinstance(payload, dict):
            _fail("request body must be a JSON object")
            return 1
        result = _dispatch(payload)
        _respond(result)
        return 0 if result.get("success") else 1
    except json.JSONDecodeError as exc:
        _fail(f"invalid JSON: {exc}")
        return 1
    except Exception as exc:  # noqa: BLE001
        _fail(str(exc))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
