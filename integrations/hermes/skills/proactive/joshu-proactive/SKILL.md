---
name: joshu-proactive
description: "Proactive owner nudges for blocked Kanban tasks; reply resolution."
metadata:
  hermes:
    category: joshu
    version: "0.3.2"
---

# Joshu Proactive

**Hourly sweep** runs via Joshu REST `POST /api/proactive/tick` on **localhost only** (cron / SSH — not public Caddy). Zero LLM tokens on the tick itself. **Outbound SMS/email** is composed via Hermes + SOUL.md (see Compose mode). **Daily hygiene** runs via cron `Joshu proactive hygiene`.

This skill covers:

1. **Compose** — natural owner SMS/email (nudges, feedback acks, stale review).
2. **Resolve (owner reply)** — when the owner answers a proactive nudge, interpret their text, update the originating Kanban card, and **reconcile the whole project slug** if waiting may have changed.
3. **Hygiene** — daily stale Kanban cleanup (auto-close high-confidence; ambiguous → stale-review nudge only).
4. **Evolve (preferences)** — off-hours opt-in, frequency tuning, pitfalls from owner feedback.

## Compose mode (owner-facing text)

Used by Joshu API `composeProactiveMessage` — **first person**, SOUL.md voice, plain text, no board slugs.

| Kind | When |
|------|------|
| `nudge` | Blocked task needs owner input |
| `nudge` (setup) | `ea-onboarding` card — e.g. missing owner mobile → **email** if no SMS yet; ask for Telephone / Welcome |
| `stale_review` | Hygiene ambiguous — ask DONE/KEEP |
| `feedback_ack` | Owner sent MORE/LESS/USEFUL/etc. |
| `reply_ack` | Owner reply routed to worker |

Rules:
- 2–4 sentences for SMS; weave MORE/LESS/USEFUL naturally (not a `---` footer).
- Joshu also appends a cadence line when missing: `Reply MORE for more check-ins, LESS for once a day, or USEFUL if this helped.`
- 1–2 **specific suggested follow-ups** for the task.
- End nudges with `Ref: pj/t_<id>` on its own line (machine routing).

Owner keywords (Joshu API): `MORE`, `LESS`, `USEFUL`, `NOT USEFUL`, `DONE`, `CLOSE`, `KEEP`, evenings/weekends toggles.

## Resolve mode (owner reply — dedicated Hermes session)

When the owner replies to a proactive nudge (SMS or jChat with pending `feedbackPending` / `Ref: pj/t_…`):

Joshu **does not** send a thin “got it” ack. It:

1. Comments the owner text on the Kanban card (`## Owner reply (proactive nudge)`).
2. Runs a **full Hermes chat turn** on session **`proactive:resolve:<taskId>`** (not the sticky SMS session — avoids 100+ message history blowing the resolve turn).
3. SMS/jChat gets your **real conversational reply** after you act.

**Fallback:** if Hermes resolve fails or times out, Joshu comments + unblocks the card and, for **project** tracks, wakes linked **`ea-scheduling`** meeting tasks via [`schedulingHandoff.ts`](../../../../../src/proactive/schedulingHandoff.ts) (thread_id / task-id mentions in comments). Fallback SMS may add “I'm also picking up the scheduling follow-up now.”

You must:

1. `skill_view('joshu-proactive')` — this Resolve section.
2. `skill_view` the board skill (`ea-onboarding` / `ea-scheduling` / `ea-owner-reply` / `ea-project-kanban`).
3. `kanban_show` — title, block_reason, body, source_paths, owner-reply comment.
4. Treat owner text as authoritative for the blocked step.
5. **Onboarding** (`ea-onboarding`, `kind: onboarding`) — follow **`ea-onboarding`**: re-check Connectors/mobile predicates; guide to desktop app; `kanban_complete` when box state satisfies; no mail send, no Project reconcile.
6. **Scheduling** — follow ea-scheduling; send authorized outreach (do not only file project notes).
7. **Project → scheduling** — when the project track has `thread_id` or references an open `ea-scheduling` task, load **`ea-scheduling`**, find the meeting task, and send the follow-up the owner authorized — not only update `Projects/<slug>/` files.
8. **Owner-reply** — continue deliverable; `nylas_send_message` if that was the ask.
9. **Project** — follow ea-project-kanban; action guard on sends. Then **`skill_view('ea-playbook')` → Project reconcile** on the `project_slug`: `mail_list_track_tasks` for **all** open tracks on that slug. An outcome (“they passed”, “role closed”) completes **sibling** tracks, not only this card; set `about.md` `status: done` if nothing is left waiting.
10. Outcomes:
   - Decision clear → `kanban_unblock` or `kanban_complete` with summary.
   - Still need owner → re-`kanban_block(reason="awaiting owner")`.
11. Reply to the owner in first person about what you did or what you still need — not a routing footer.

If Hermes resolve fails, Joshu falls back to unblock + scheduling wake so the Kanban dispatcher can pick up the card.

## Hygiene mode (daily cron)

Max **20 cards/run** — oldest or most date-stale blocked cards first.

**Always start with Joshu precompute (never invent your own cross-board scan):**

1. **`proactive_hygiene_prepare`** (connectors MCP) — scans all Kanban boards on this box, writes `.joshu/proactive/hygiene-plan.json`, returns the candidate list with hints (`isDateStale`, `ageDays`).
2. Optional: **`proactive_hygiene_plan`** if a plan was prepared earlier the same run.

For each candidate in the plan:
1. `kanban_show` — title, block_reason, body, source_paths, recent_comments.
2. **Skip onboarding** — if body contains `kind: onboarding`, leave blocked; never auto-close (setup registry handles completion).
3. **Date check** — event dates in title/body vs today (hints are advisory only).
3. **gbrain query** — thread from `source_path`; completion signals (confirmation sent, calendar booked, worker noted DONE).
4. **Classify:**
   - **High confidence stale** → `kanban_complete` + audit comment (evidence cited).
   - **Ambiguous** → skip auto-close; include in `proactive_hygiene_record` `ambiguous[]` (hourly tick may stale-review nudge).
   - **Still active** → leave blocked; count as `active` in record.

When done:
- **`proactive_hygiene_record`** — `closedTaskIds`, `ambiguous[]`, `skipped`, `active` counts. Do not edit `state.json` directly.

High-confidence examples:
- `ea-scheduling` blocked `awaiting reply:` but worker booked meeting + sent confirmation.
- Project track with interview dates weeks past + mail mirror shows loop closed.
- Worker comment: "Meeting is DONE" / "Scheduling already closed".

### Hygiene forbidden

- `execute_code`, SQLite, `kanban-sqlite.md`, or Python/shell scripts on the Desktop for Kanban analytics
- Direct edits to `.joshu/proactive/state.json` (use `proactive_hygiene_record`)
- Nudging the owner during hygiene (ambiguous cards go to the hourly tick as `stale_review`)

## Evolution mode (jChat / background_review)

Defaults (`.joshu/proactive/state.json`):

- 1 nudge per local day
- Weekdays within Welcome working hours only
- Evenings and weekends off until owner opts in

**When to ask about off-hours:** After owner replies `MORE` or positive usefulness — not on every nudge.

Nuanced rules → patch this SKILL.md via `skill_manage`; mirror simple flags to state.

## Forbidden

- Running sweep/send from hourly cron (use REST tick)
- Auto-completing blocked tasks without high-confidence evidence (hygiene) or owner DONE/CLOSE
- Nudging for `awaiting reply:` (counterparty waits) on hourly tick
