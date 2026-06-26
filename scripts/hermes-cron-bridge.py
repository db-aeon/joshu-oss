#!/usr/bin/env python3
"""
JSON bridge for Joshu → Hermes cron (uses the same cronjob tool / jobs.py as Hermes).

Reads one JSON object from stdin, writes one JSON object to stdout.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

# Hermes agent root (parent of cron/, tools/, etc.)
HERMES_AGENT_ROOT = Path(__file__).resolve().parent.parent
if str(HERMES_AGENT_ROOT) not in sys.path:
    # When run from Joshu repo, HERMES_AGENT_ROOT env points at the venv checkout.
    import os

    env_root = os.environ.get("HERMES_AGENT_ROOT", "").strip()
    if env_root:
        candidate = Path(env_root).resolve()
        if candidate.is_dir():
            sys.path.insert(0, str(candidate))
    else:
        # Fallback: sibling hermes-agent checkout (local dev layout).
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


def _omit_none(**kwargs: Any) -> Dict[str, Any]:
    """Drop None values so older Hermes cronjob() does not see unsupported kwargs (e.g. profile)."""
    return {k: v for k, v in kwargs.items() if v is not None}


def _normalize_repeat(raw: Any) -> Optional[int]:
    """Hermes cronjob() expects repeat as int, not { times: N }."""
    if raw is None:
        return None
    if isinstance(raw, bool):
        return None
    if isinstance(raw, int):
        return raw if raw > 0 else None
    if isinstance(raw, dict):
        times = raw.get("times")
        if isinstance(times, int) and times > 0:
            return times
    return None


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


def _job_detail(job: Dict[str, Any]) -> Dict[str, Any]:
    """Full job shape for the Schedules UI (includes prompt text)."""
    skills = job.get("skills") or ([job["skill"]] if job.get("skill") else [])
    schedule = job.get("schedule") or {}
    repeat = job.get("repeat") or {}
    deliver = job.get("deliver", "local")
    if isinstance(deliver, list):
        deliver = ",".join(str(d) for d in deliver)

    return {
        "job_id": job.get("id"),
        "name": job.get("name"),
        "prompt": job.get("prompt") or "",
        "schedule": job.get("schedule_display") or schedule.get("display") or "",
        "schedule_kind": schedule.get("kind"),
        "skills": skills,
        "deliver": deliver,
        "repeat_times": repeat.get("times"),
        "repeat_completed": repeat.get("completed", 0),
        "enabled": job.get("enabled", True),
        "state": job.get("state", "scheduled" if job.get("enabled", True) else "paused"),
        "next_run_at": job.get("next_run_at"),
        "last_run_at": job.get("last_run_at"),
        "last_status": job.get("last_status"),
        "last_error": job.get("last_error"),
        "last_delivery_error": job.get("last_delivery_error"),
        "script": job.get("script"),
        "no_agent": bool(job.get("no_agent")),
        "workdir": job.get("workdir"),
        "profile": job.get("profile"),
        "paused_at": job.get("paused_at"),
        "paused_reason": job.get("paused_reason"),
        "created_at": job.get("created_at"),
    }


def _status() -> Dict[str, Any]:
    from cron.jobs import list_jobs
    from hermes_cli.gateway import find_gateway_pids

    pids = find_gateway_pids()
    jobs = list_jobs(include_disabled=True)
    active = [j for j in jobs if j.get("enabled", True) and j.get("state") != "paused"]
    next_runs = [j.get("next_run_at") for j in active if j.get("next_run_at")]
    return {
        "success": True,
        "gateway_running": bool(pids),
        "gateway_pids": pids,
        "job_count": len(jobs),
        "active_job_count": len(active),
        "next_run_at": min(next_runs) if next_runs else None,
    }


def _get(job_id: str) -> Dict[str, Any]:
    from cron.jobs import get_job

    job = get_job(job_id)
    if not job:
        return {"success": False, "error": f"Job '{job_id}' not found"}
    return {"success": True, "job": _job_detail(job)}


def _dispatch(payload: Dict[str, Any]) -> Dict[str, Any]:
    action = str(payload.get("action") or "").strip().lower()
    if not action:
        return {"success": False, "error": "action is required"}

    if action == "status":
        return _status()

    if action == "get":
        job_id = str(payload.get("job_id") or "").strip()
        if not job_id:
            return {"success": False, "error": "job_id is required"}
        return _get(job_id)

    from tools.cronjob_tools import cronjob

    if action == "list":
        raw = cronjob(action="list", include_disabled=bool(payload.get("include_disabled", True)))
        return json.loads(raw)

    if action == "create":
        skills = _parse_skills(payload.get("skills"))
        raw = cronjob(
            action="create",
            **_omit_none(
                schedule=str(payload.get("schedule") or "").strip(),
                prompt=payload.get("prompt"),
                name=payload.get("name"),
                deliver=payload.get("deliver"),
                repeat=_normalize_repeat(payload.get("repeat")),
                skills=skills,
                script=payload.get("script"),
                no_agent=payload.get("no_agent"),
                workdir=payload.get("workdir"),
                profile=payload.get("profile"),
            ),
        )
        result = json.loads(raw)
        if result.get("success") and result.get("job_id"):
            detail = _get(result["job_id"])
            if detail.get("success"):
                result["job"] = detail["job"]
        return result

    job_id = str(payload.get("job_id") or "").strip()
    if not job_id:
        return {"success": False, "error": "job_id is required"}

    if action == "update":
        skills = _parse_skills(payload.get("skills")) if "skills" in payload else None
        raw = cronjob(
            action="update",
            job_id=job_id,
            **_omit_none(
                schedule=payload.get("schedule"),
                prompt=payload.get("prompt"),
                name=payload.get("name"),
                deliver=payload.get("deliver"),
                repeat=_normalize_repeat(payload.get("repeat")),
                skills=skills,
                script=payload.get("script"),
                no_agent=payload.get("no_agent"),
                workdir=payload.get("workdir"),
                profile=payload.get("profile"),
            ),
        )
        result = json.loads(raw)
        if result.get("success"):
            detail = _get(job_id)
            if detail.get("success"):
                result["job"] = detail["job"]
        return result

    if action in {"pause", "resume", "run", "remove"}:
        tool_action = "run" if action == "run" else action
        raw = cronjob(action=tool_action, job_id=job_id, reason=payload.get("reason"))
        return json.loads(raw)

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
    except Exception as exc:  # noqa: BLE001 — bridge must never crash the Node caller
        _fail(str(exc))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
