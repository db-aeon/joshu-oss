---
name: joshu-proactive
description: "Proactive owner nudges for blocked Kanban tasks; reply resolution."
metadata:
  hermes:
    category: joshu
    version: "0.5.2"
---

# Joshu Proactive

**Hourly sweep** runs via Joshu REST `POST /api/proactive/tick` on **localhost only** (cron / SSH — not public Caddy). Zero LLM tokens on the tick itself. **Outbound SMS/email** is composed via Hermes + SOUL.md (see Compose mode). **Daily hygiene** runs via cron `Joshu proactive hygiene`.

This skill covers:

1. **Compose** — natural owner SMS/email (nudges, feedback acks, stale review).
2. **Resolve (owner reply)** — when the owner answers a proactive nudge, interpret their text, update the originating Kanban card, and **reconcile the whole project slug** if waiting may have changed.
3. **Hygiene** — daily stale Kanban cleanup (auto-close high-confidence; ambiguous → stale-review nudge only).
4. **Evolve (preferences)** — off-hours opt-in, frequency tuning, pitfalls from owner feedback.
5. **Owner reminders** — reminders that the owner asks for, in any channel.

## Compose mode (owner-facing text)

Used by Joshu API `composeProactiveMessage` — **first person**, SOUL.md voice, plain text, no board slugs.

| Kind | When |
|------|------|
| `nudge` | **Priority 1** — owner question: a blocked task with `kind: needs_input` (hourly sweep) |
| `nudge` (setup) | `ea-onboarding` card — e.g. missing owner mobile → **email** if no SMS yet; ask for Telephone / Welcome |
| `stale_review` | **Priority 2** — hygiene ambiguous — ask DONE/KEEP |
| `feedback_ack` | Owner sent MORE/LESS/USEFUL/etc. |
| `reply_ack` | Owner reply routed to worker |

Rules:
- 2–4 sentences for SMS; weave MORE/LESS/USEFUL naturally (not a `---` footer).
- Joshu also appends a cadence line when missing: `Reply MORE for more check-ins, LESS for once a day, or USEFUL if this helped.`
- The MORE/LESS/USEFUL ask and the cadence line are for SMS only. A nudge by email does not ask for these words and gets no cadence line, because the owner keywords work only by SMS.
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
5. **Onboarding** (`ea-onboarding`, `kind: onboarding`) — follow **`ea-onboarding`**: re-check the setup step (profile, mobile, work Gmail, or calendar); guide with the steps of the card body; `kanban_complete` when box state satisfies; no mail send, no Project reconcile.
6. **Scheduling** — follow ea-scheduling; send authorized outreach (do not only file project notes).
7. **Project → scheduling** — when the project track has `thread_id` or references an open `ea-scheduling` task, load **`ea-scheduling`**, find the meeting task, and send the follow-up the owner authorized — not only update `Projects/<slug>/` files.
8. **Owner-reply** — continue deliverable; `nylas_send_message` if that was the ask.
9. **Project** — follow ea-project-kanban; action guard on sends. Then **`skill_view('ea-playbook')` → Project reconcile** on the `project_slug`: `mail_list_track_tasks(projectSlug=…)` returns the compact track list of **all** open tracks on that slug (no full bodies; `taskId=` for one full body). An outcome (“they passed”, “role closed”) completes **sibling** tracks, not only this card; set `about.md` `status: done` if nothing is left waiting.
10. Outcomes:
   - Decision clear → `kanban_unblock` or `kanban_complete` with summary.
   - Still need owner → re-`kanban_block(reason="awaiting owner — <what is still needed>", kind="needs_input")`.
11. Reply to the owner in first person about what you did or what you still need — not a routing footer.

If Hermes resolve fails, Joshu falls back to unblock + scheduling wake so the Kanban dispatcher can pick up the card.

## Owner reminders

Use this section when the owner asks to be reminded ("remind me every morning until I send it", "nudge me Thursday"), in SMS, jChat, email, voice, or a Resolve turn.

1. Call **`mcp_joshu_connectors_owner_reminder_create`**:
   - `title`: short, at most 80 characters (example: `Joseph at Wescom`).
   - `text`: the full owner-facing text, at most 320 characters, plain text, first person. The text is fixed: no LLM runs at reminder time, so write what the owner must do and what you can do for them (example: `Write Joseph at Wescom today. If you send me his address and the gist, I can draft it.`).
   - `schedule`: owner local time. Recurring: a cron expression with one minute value (`0 9 * * 1-5`) or `every 1d`. One time: `2026-10-08T09:00` or a delay such as `2h`. At most once each hour.
   - `endsAt` (optional): a recurring reminder ends after 30 days unless you give an end time (at most 180 days).
   - In a **Resolve** turn, pass the card as `linkedTaskId` + `linkedBoard`. The reminder stops by itself when the card is done.
2. Tell the owner the schedule in plain words, and that they can reply DONE to stop it.
3. Joshu sends each reminder by SMS when the box has the owner mobile, otherwise by email from your mailbox. Do not tell the owner that the box has no SMS: Joshu decides the channel at each run.
4. When the owner says the thing is done or the reminder is not needed (any wording, any channel), call `owner_reminder_list`, then `owner_reminder_stop` with the id (`ownerDone: true` when the thing is done). An SMS that is only "DONE" right after a reminder already stops it.
5. To change a reminder, stop it and make a new one.

Never use the Hermes **`cronjob`** tool for a reminder to the owner. From SMS, jChat, or a Resolve turn, its output reaches no one, and the cron guard blocks it. Use `cronjob` only for a job that sends its own messages, with `deliver='local'`.

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

- Reminders to the owner with the Hermes `cronjob` tool (use `owner_reminder_create`)

- Running sweep/send from hourly cron (use REST tick)
- Auto-completing blocked tasks without high-confidence evidence (hygiene) or owner DONE/CLOSE
- Nudging for `awaiting reply:` (counterparty waits) on hourly tick
