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
    if include_body:
        out["body"] = task.body
    return out


def _task_activity(conn: Any, task_id: str, *, max_comments: int = 5) -> Dict[str, Any]:
    """Recent Kanban comments and latest block reason for scheduling status queries."""
    from hermes_cli import kanban_db

    comments = kanban_db.list_comments(conn, task_id)
    events = kanban_db.list_events(conn, task_id)
    recent = comments[-max_comments:] if comments else []
    block_reason: Optional[str] = None
    for ev in reversed(events):
        if ev.kind != "blocked":
            continue
        payload = ev.payload if isinstance(ev.payload, dict) else {}
        reason = payload.get("reason")
        if isinstance(reason, str) and reason.strip():
            block_reason = reason.strip()
            break
    return {
        "block_reason": block_reason,
        "recent_comments": [
            {
                "author": c.author,
                "body": c.body,
                "created_at": c.created_at,
            }
            for c in recent
        ],
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
EA_KANBAN_BOARDS = frozenset({"ea-scheduling", "ea-sched-ingress", "ea-mail-ingress"})


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
    return out


def _find_by_idempotency(conn: Any, key: str) -> Optional[Any]:
    from hermes_cli import kanban_db

    row = conn.execute(
        "SELECT id FROM tasks WHERE idempotency_key = ? AND status != 'archived' "
        "ORDER BY created_at DESC LIMIT 1",
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
        task = _find_by_idempotency(conn, key)
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
            existing = _find_by_idempotency(conn, str(idempotency_key))
            if existing:
                status = existing.status
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
