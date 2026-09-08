---
name: joshu-proactive
description: "Proactive owner nudges for blocked Kanban tasks; reply resolution."
metadata:
  hermes:
    category: joshu
    version: "0.2.0"
---

# Joshu Proactive

**Hourly sweep** runs via Joshu REST `POST /api/proactive/tick` on **localhost only** (cron / SSH — not public Caddy). Zero LLM tokens on the tick itself. **Outbound SMS/email** is composed via Hermes + SOUL.md (see Compose mode). **Daily hygiene** runs via cron `Joshu proactive hygiene`.

This skill covers:

1. **Compose** — natural owner SMS/email (nudges, feedback acks, stale review).
2. **Resolve (owner reply)** — when the owner answers a proactive nudge, interpret their text and update the originating Kanban card.
3. **Hygiene** — daily stale Kanban cleanup (auto-close high-confidence; ambiguous → stale-review nudge only).
4. **Evolve (preferences)** — off-hours opt-in, frequency tuning, pitfalls from owner feedback.

## Compose mode (owner-facing text)

Used by Joshu API `composeProactiveMessage` — **first person**, SOUL.md voice, plain text, no board slugs.

| Kind | When |
|------|------|
| `nudge` | Blocked task needs owner input |
| `stale_review` | Hygiene ambiguous — ask DONE/KEEP |
| `feedback_ack` | Owner sent MORE/LESS/USEFUL/etc. |
| `reply_ack` | Owner reply routed to worker |

Rules:
- 2–4 sentences for SMS; weave MORE/LESS/USEFUL naturally (not a `---` footer).
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
2. `skill_view` the board skill (`ea-scheduling` / `ea-owner-reply` / `ea-project-kanban`).
3. `kanban_show` — title, block_reason, body, source_paths, owner-reply comment.
4. Treat owner text as authoritative for the blocked step.
5. **Scheduling** — follow ea-scheduling; send authorized outreach (do not only file project notes).
6. **Project → scheduling** — when the project track has `thread_id` or references an open `ea-scheduling` task, load **`ea-scheduling`**, find the meeting task, and send the follow-up the owner authorized — not only update `Projects/<slug>/` files.
7. **Owner-reply** — continue deliverable; `nylas_send_message` if that was the ask.
8. **Project** — follow ea-project-kanban; action guard on sends.
9. Outcomes:
   - Decision clear → `kanban_unblock` or `kanban_complete` with summary.
   - Still need owner → re-`kanban_block(reason="awaiting owner")`.
10. Reply to the owner in first person about what you did or what you still need — not a routing footer.

If Hermes resolve fails, Joshu falls back to unblock + scheduling wake so the Kanban dispatcher can pick up the card.

## Hygiene mode (daily cron)

Max **20 cards/run** — oldest or most date-stale blocked cards first.

For each blocked card:
1. `kanban_show` — title, block_reason, body, source_paths, recent_comments.
2. **Date check** — event dates in title/body vs today.
3. **gbrain query** — thread from `source_path`; completion signals (confirmation sent, calendar booked, worker noted DONE).
4. **Classify:**
   - **High confidence stale** → `kanban_complete` + audit comment (evidence cited).
   - **Ambiguous** → skip auto-close (hourly tick may stale-review nudge).
   - **Still active** → leave blocked.

High-confidence examples:
- `ea-scheduling` blocked `awaiting reply:` but worker booked meeting + sent confirmation.
- Project track with interview dates weeks past + mail mirror shows loop closed.
- Worker comment: "Meeting is DONE" / "Scheduling already closed".

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
