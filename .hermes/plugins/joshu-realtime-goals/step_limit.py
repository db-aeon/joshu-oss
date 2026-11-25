"""Step-limit warning and step-limit note for workers on board ``realtime-goals``.

Hermes allows each worker run a fixed number of model calls (the step limit,
``agent.max_turns``). When a worker reaches it, Hermes asks the model for a last
summary, records the run as ``timed_out``, and writes the summary only to the
worker log. The owner then hears nothing, and the next run repeats the same work.

This module adds two things for a worker on board ``realtime-goals``:

- the step-limit warning: from the moment 15 steps or fewer are left, each tool
  result ends with a note that tells the worker to end the run now;
- the step-limit note: when the run reached the step limit, the last summary of
  the worker becomes a comment on the Kanban task, so the next run reads it.

Each hook does nothing outside such a worker, and each hook catches its own
errors, so a failure here never changes how the worker ends.

Spec: openspec change realtime-goal-step-limit, capability realtime-goal-worker-runs.
"""

from __future__ import annotations

import os
import sys

BOARD = "realtime-goals"
DEFAULT_STEP_LIMIT = 90
WARN_AT_STEPS_LEFT = 15
NOTE_MAX_CHARS = 4000
NOTE_AUTHOR = "joshu-step-limit"
NOTE_HEADING = "## Step-limit note"
# Hermes writes this error when a worker reaches the step limit
# (agent/turn_finalizer.py). Match the start only.
STEP_LIMIT_ERROR_PREFIX = "Iteration budget exhausted"

_state = {"steps": 0}


def _log(message: str) -> None:
    print(f"[joshu-realtime-goals] {message}", file=sys.stderr)


def _realtime_goal_task() -> str | None:
    """The Kanban task id when this process is a worker on board realtime-goals."""
    task_id = (os.environ.get("HERMES_KANBAN_TASK") or "").strip()
    board = (os.environ.get("HERMES_KANBAN_BOARD") or "").strip()
    if task_id and board == BOARD:
        return task_id
    return None


def step_limit() -> int:
    """The step limit of this worker: agent.max_turns, or 90 when it is not set."""
    try:
        from hermes_cli.config import load_config  # type: ignore

        value = (load_config().get("agent") or {}).get("max_turns")
        if isinstance(value, int) and not isinstance(value, bool) and value > 0:
            return value
    except Exception:
        pass
    return DEFAULT_STEP_LIMIT


def warning_text(steps_left: int) -> str:
    left = max(steps_left, 0)
    count = "1 step is" if left == 1 else f"{left} steps are"
    return (
        f"\n\n[Joshu step-limit warning] {count} left in this run. "
        "Stop the current work now. End the run with kanban_complete when you have the "
        "result for the owner, or with kanban_block(reason=<one question the owner can "
        'answer>, kind="needs_input") that says what you found. Do not start a new action.'
    )


def note_body(summary: str) -> str:
    return f"{NOTE_HEADING}\n\n{summary.strip()[:NOTE_MAX_CHARS]}"


def is_step_limit_error(error: str | None) -> bool:
    return bool(error) and str(error).strip().startswith(STEP_LIMIT_ERROR_PREFIX)


def _connect_kanban():
    """Open the Kanban database of this worker (HERMES_KANBAN_DB).

    Hermes v0.23 moved ``connect`` to ``hermes_cli.kanban_db_connect``; the Hermes
    pin of Joshu still has it in ``hermes_cli.kanban_db``.
    """
    try:
        from hermes_cli import kanban_db_connect  # type: ignore

        return kanban_db_connect.connect()
    except ImportError:
        from hermes_cli import kanban_db  # type: ignore

        return kanban_db.connect()


def pre_api_request(api_call_count=None, **_kwargs) -> None:
    """Keep the number of model calls of this run (one worker process runs one task)."""
    if not _realtime_goal_task():
        return None
    if isinstance(api_call_count, int) and api_call_count > _state["steps"]:
        _state["steps"] = api_call_count
    return None


def transform_tool_result(result=None, **_kwargs):
    """Add the step-limit warning to a tool result when 15 steps or fewer are left."""
    try:
        if not _realtime_goal_task() or not isinstance(result, str):
            return None
        steps_left = step_limit() - _state["steps"]
        if steps_left > WARN_AT_STEPS_LEFT:
            return None
        return result + warning_text(steps_left)
    except Exception as error:
        _log(f"step-limit warning failed: {error}")
        return None


def post_llm_call(assistant_response=None, **_kwargs) -> None:
    """Write the step-limit note when Hermes ended this run at the step limit."""
    task_id = _realtime_goal_task()
    if not task_id:
        return None
    summary = assistant_response.strip() if isinstance(assistant_response, str) else ""
    run_id = (os.environ.get("HERMES_KANBAN_RUN_ID") or "").strip()
    if not summary or not run_id.isdigit():
        return None
    try:
        from hermes_cli import kanban_db  # type: ignore

        conn = _connect_kanban()
        try:
            run = kanban_db.get_run(conn, int(run_id))
            if run is None or run.outcome != "timed_out" or not is_step_limit_error(run.error):
                return None
            kanban_db.add_comment(conn, task_id, NOTE_AUTHOR, note_body(summary))
            _log(f"step-limit note written task={task_id} run={run_id}")
        finally:
            conn.close()
    except Exception as error:
        _log(f"step-limit note failed task={task_id}: {error}")
    return None


def register(ctx) -> None:
    ctx.register_hook("pre_api_request", pre_api_request)
    ctx.register_hook("transform_tool_result", transform_tool_result)
    ctx.register_hook("post_llm_call", post_llm_call)
