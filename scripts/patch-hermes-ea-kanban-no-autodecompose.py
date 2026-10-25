#!/usr/bin/env python3
"""Stop Hermes auto-decompose / block-loop triage from hijacking EA scheduling.

Root cause (fleet box, 2026-08-12):
  ingress unblocks meeting task → worker sends + kanban_block("awaiting reply")
  → Hermes block_loop (same kind ×2) routes task to triage
  → global auto_decompose fans out children that also nylas_send_message

Joshu scheduling is one meeting card → one worker. auto_decompose is only for
project-<slug> boards (ea-project-kanban). EA boards must never auto-fan-out.

Patches:
  1) gateway/kanban_watchers.py — skip ea-scheduling / ea-mail-ingress /
     ea-sched-ingress in _auto_decompose_tick
  2) hermes_cli/kanban_db.py — on block_loop for those boards, stay blocked
     instead of routing to triage. Boards named project-<slug> also stay
     blocked (unblock-loop breaker, openspec/glossary.md): each handoff
     unblocks a track and the worker blocks it again with the same block kind.
     project-<slug> boards keep auto-decompose (patch 1 does not list them).
     The kept-blocked branch also appends a "blocked" event. Hermes
     recompute_ready promotes a blocked task to ready unless the newest
     "blocked"/"unblocked" event is "blocked" (_has_sticky_block). Without
     this event, the newest one is the "unblocked" event of the handoff, so
     the dispatcher re-ran the task about 30 s later and the loop continued
     (Mina box, track t_a5afaa50, 2026-10-08).
     Boards named team-<slug> (Multiplayer team boards, change box-teams-standup)
     stay blocked too, and they have no auto-decompose.

Markers: _joshu_ea_kanban_no_autodecompose, _joshu_keep_blocked_sticky
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

HERMES_DIR = Path(os.environ.get("HERMES_DIR", "/opt/hermes-agent")).resolve()
MARKER = "_joshu_ea_kanban_no_autodecompose"
STICKY_MARKER = "_joshu_keep_blocked_sticky"

WATCHERS = HERMES_DIR / "gateway/kanban_watchers.py"
KANBAN_DB = HERMES_DIR / "hermes_cli/kanban_db.py"

EA_BOARDS_LITERAL = (
    '{"ea-scheduling", "ea-mail-ingress", "ea-sched-ingress", "ea-owner-reply", '
    '"ea-onboarding", "realtime-goals"}  # ' + MARKER
)
# Keep-blocked check for project-<slug> boards (change proactive-clarify-hardening)
# and team-<slug> boards (change box-teams-standup).
OLD_PROJECT_KEEP_BLOCKED_EXPR = 'str(get_current_board() or "").startswith("project-")'
PROJECT_KEEP_BLOCKED_EXPR = 'str(get_current_board() or "").startswith(("project-", "team-"))'
# Auto-decompose skip for team-<slug> boards (change box-teams-standup).
OLD_WATCHERS_SKIP = "                if slug in EA_NO_AUTODECOMPOSE:\n                    continue"
WATCHERS_SKIP = (
    "                if slug in EA_NO_AUTODECOMPOSE or str(slug).startswith(\"team-\"):\n                    continue"
)
KEEP_BLOCKED_PREFIX = "_joshu_ea_keep_blocked = get_current_board() in "
KEEP_BLOCKED_PREFIX_WITH_PROJECT = (
    f"_joshu_ea_keep_blocked = {PROJECT_KEEP_BLOCKED_EXPR} or get_current_board() in "
)
LEGACY_EA_BOARDS_LITERAL = (
    '{"ea-scheduling", "ea-mail-ingress", "ea-sched-ingress", "ea-owner-reply"}'
)
# End of the block_loop_detected event that the keep-blocked patch writes.
# The sticky "blocked" event goes directly after it.
LOOP_EVENT_END = """                    **({"joshu_ea_keep_blocked": True} if _joshu_ea_keep_blocked else {}),
                },
                run_id=run_id,
            )
"""
STICKY_BLOCKED_EVENT = f"""            if _joshu_ea_keep_blocked:
                # Joshu ({STICKY_MARKER}): recompute_ready promotes a blocked
                # task unless the newest "blocked"/"unblocked" event is
                # "blocked". The newest one is the "unblocked" event of the
                # handoff, so write a "blocked" event to keep the task blocked.
                _append_event(
                    conn, task_id, "blocked",
                    {{
                        "reason": reason,
                        "kind": kind,
                        "recurrences": recurrences,
                        "joshu_ea_keep_blocked": True,
                    }},
                    run_id=run_id,
                )
"""


def _die(msg: str) -> None:
    print(f"[hermes-ea-kanban-no-autodecompose] error: {msg}", file=sys.stderr)
    sys.exit(1)


def _patch_watchers(text: str) -> str:
    if MARKER in text and "EA_NO_AUTODECOMPOSE" in text:
        upgraded = False
        if '"realtime-goals"' not in text:
            text = text.replace(LEGACY_EA_BOARDS_LITERAL, EA_BOARDS_LITERAL)
            print("[hermes-ea-kanban-no-autodecompose] watchers: expanded managed boards")
            upgraded = True
        if WATCHERS_SKIP not in text:
            if OLD_WATCHERS_SKIP not in text:
                _die("watchers: EA_NO_AUTODECOMPOSE skip line not found")
            text = text.replace(OLD_WATCHERS_SKIP, WATCHERS_SKIP, 1)
            print("[hermes-ea-kanban-no-autodecompose] watchers: team boards skip auto-decompose")
            upgraded = True
        if not upgraded:
            print("[hermes-ea-kanban-no-autodecompose] watchers: already applied")
        return text

    needle = """            for b in boards:
                slug = b.get("slug") or _kb.DEFAULT_BOARD
                if attempted >= auto_decompose_per_tick:
                    break
                # Pin this board for the duration of the call — same"""

    if needle not in text:
        _die("watchers: auto_decompose board loop anchor not found")

    insert = f"""            # Joshu: never auto-decompose EA mail/scheduling boards ({MARKER}).
            # Meeting cards are single-worker; fan-out caused duplicate outreach.
            EA_NO_AUTODECOMPOSE = {EA_BOARDS_LITERAL}
            for b in boards:
                slug = b.get("slug") or _kb.DEFAULT_BOARD
                if attempted >= auto_decompose_per_tick:
                    break
{WATCHERS_SKIP}
                # Pin this board for the duration of the call — same"""

    return text.replace(needle, insert, 1)


def _patch_kanban_db(text: str) -> str:
    if not (MARKER in text and "joshu_ea_keep_blocked" in text):
        return _add_sticky_blocked_event(_add_keep_blocked(text))
    upgraded = False
    if '"realtime-goals"' not in text:
        text = text.replace(LEGACY_EA_BOARDS_LITERAL, EA_BOARDS_LITERAL)
        print("[hermes-ea-kanban-no-autodecompose] kanban_db: expanded managed boards")
        upgraded = True
    if PROJECT_KEEP_BLOCKED_EXPR not in text:
        if OLD_PROJECT_KEEP_BLOCKED_EXPR in text:
            text = text.replace(OLD_PROJECT_KEEP_BLOCKED_EXPR, PROJECT_KEEP_BLOCKED_EXPR, 1)
            print("[hermes-ea-kanban-no-autodecompose] kanban_db: team boards stay blocked")
        elif KEEP_BLOCKED_PREFIX in text:
            text = text.replace(KEEP_BLOCKED_PREFIX, KEEP_BLOCKED_PREFIX_WITH_PROJECT, 1)
            print("[hermes-ea-kanban-no-autodecompose] kanban_db: project and team boards stay blocked")
        else:
            _die("kanban_db: keep-blocked line not found")
        upgraded = True
    if STICKY_MARKER not in text:
        text = _add_sticky_blocked_event(text)
        print("[hermes-ea-kanban-no-autodecompose] kanban_db: kept-blocked tasks stay sticky")
        upgraded = True
    if not upgraded:
        print("[hermes-ea-kanban-no-autodecompose] kanban_db: already applied")
    return text


def _add_sticky_blocked_event(text: str) -> str:
    if STICKY_MARKER in text:
        return text
    if text.count(LOOP_EVENT_END) != 1:
        _die("kanban_db: block_loop_detected event of the keep-blocked patch not found")
    return text.replace(LOOP_EVENT_END, LOOP_EVENT_END + STICKY_BLOCKED_EVENT, 1)


def _add_keep_blocked(text: str) -> str:
    """Write the keep-blocked branch (the patch before the sticky event)."""
    needle = """        if recurrences >= BLOCK_RECURRENCE_LIMIT:
            # Loop detected — stop letting the unblocker spin this task. Route
            # to triage for a human-in-the-loop decision instead of blocked.
            cur = conn.execute(
                \"\"\"
                UPDATE tasks
                   SET status        = 'triage',
                       claim_lock    = NULL,
                       claim_expires = NULL,
                       worker_pid    = NULL,
                       block_kind    = ?,
                       block_recurrences = ?
                 WHERE id = ?
                   AND status IN ('running', 'ready')
                \"\"\" + (\"\" if expected_run_id is None else \" AND current_run_id = ?\"),
                (kind, recurrences, task_id) if expected_run_id is None
                else (kind, recurrences, task_id, int(expected_run_id)),
            )
            if cur.rowcount != 1:
                return False
            run_id = _end_run(
                conn, task_id,
                outcome=\"blocked\", status=\"blocked\",
                summary=reason,
            )
            if run_id is None and reason:
                run_id = _synthesize_ended_run(
                    conn, task_id, outcome=\"blocked\", summary=reason,
                )
            _append_event(
                conn, task_id, \"block_loop_detected\",
                {
                    \"reason\": reason,
                    \"kind\": kind,
                    \"recurrences\": recurrences,
                    \"limit\": BLOCK_RECURRENCE_LIMIT,
                },
                run_id=run_id,
            )
"""

    if needle not in text:
        _die("kanban_db: block_loop triage anchor not found")

    replacement = f"""        if recurrences >= BLOCK_RECURRENCE_LIMIT:
            # Loop detected — stop letting the unblocker spin this task. Route
            # to triage for a human-in-the-loop decision instead of blocked.
            #
            # Joshu ({MARKER}): EA scheduling/mail boards intentionally
            # unblock→work→re-block ("awaiting reply") across ingress handoffs.
            # Escalating those cards to triage lets auto_decompose fan out
            # duplicate outreach workers. Keep them blocked instead.
            # project-<slug> boards: each handoff unblocks a track, and the
            # worker blocks it again with the same block kind. Keep them blocked.
            # team-<slug> boards (Multiplayer): the same for team commitments.
            {KEEP_BLOCKED_PREFIX_WITH_PROJECT}{EA_BOARDS_LITERAL}
            _joshu_loop_status = "blocked" if _joshu_ea_keep_blocked else "triage"
            cur = conn.execute(
                \"\"\"
                UPDATE tasks
                   SET status        = ?,
                       claim_lock    = NULL,
                       claim_expires = NULL,
                       worker_pid    = NULL,
                       block_kind    = ?,
                       block_recurrences = ?
                 WHERE id = ?
                   AND status IN ('running', 'ready')
                \"\"\" + (\"\" if expected_run_id is None else \" AND current_run_id = ?\"),
                (
                    (_joshu_loop_status, kind, recurrences, task_id)
                    if expected_run_id is None
                    else (_joshu_loop_status, kind, recurrences, task_id, int(expected_run_id))
                ),
            )
            if cur.rowcount != 1:
                return False
            run_id = _end_run(
                conn, task_id,
                outcome=\"blocked\", status=\"blocked\",
                summary=reason,
            )
            if run_id is None and reason:
                run_id = _synthesize_ended_run(
                    conn, task_id, outcome=\"blocked\", summary=reason,
                )
            _append_event(
                conn, task_id, \"block_loop_detected\",
                {{
                    \"reason\": reason,
                    \"kind\": kind,
                    \"recurrences\": recurrences,
                    \"limit\": BLOCK_RECURRENCE_LIMIT,
                    **({{"joshu_ea_keep_blocked": True}} if _joshu_ea_keep_blocked else {{}}),
                }},
                run_id=run_id,
            )
"""

    return text.replace(needle, replacement, 1)


def main() -> int:
    if not WATCHERS.is_file():
        print(f"[hermes-ea-kanban-no-autodecompose] skip: {WATCHERS} not found")
        return 0
    if not KANBAN_DB.is_file():
        print(f"[hermes-ea-kanban-no-autodecompose] skip: {KANBAN_DB} not found")
        return 0

    watchers = WATCHERS.read_text(encoding="utf-8")
    kanban = KANBAN_DB.read_text(encoding="utf-8")

    new_watchers = _patch_watchers(watchers)
    new_kanban = _patch_kanban_db(kanban)

    changed = False
    if new_watchers != watchers:
        WATCHERS.write_text(new_watchers, encoding="utf-8")
        print(f"[hermes-ea-kanban-no-autodecompose] patched {WATCHERS}")
        changed = True
    if new_kanban != kanban:
        KANBAN_DB.write_text(new_kanban, encoding="utf-8")
        print(f"[hermes-ea-kanban-no-autodecompose] patched {KANBAN_DB}")
        changed = True

    if not changed:
        print("[hermes-ea-kanban-no-autodecompose] already applied")
    else:
        print(
            "[hermes-ea-kanban-no-autodecompose] done — restart Hermes gateway to load changes"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
