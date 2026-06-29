---
name: ea-morning-review
description: Daily handoff — prep yesterday carryover, interactive morning review, finalize today's time block.
metadata:
  hermes:
    category: executive-assistant
    version: "1.2.0"
---

# EA Morning Review (daily handoff)

Bridges **yesterday → today**: read yesterday's time-block plan, draft **`Planning/daily-review-YYYY-MM-DD.md`** with checkboxes (source of truth for done/carryover), run an **interactive jChat session** when the owner is ready, then refresh **today's** linked Excalidraw via **`ea-time-block`**.

**GTD / linking:** `docs/executive-assistant.md#gtd-workspace` · **Time block:** `skill_view('ea-time-block')`

## When to use

| Mode | Trigger |
|------|---------|
| **Prep (async)** | `EA morning` cron — `skill_view('ea-morning-review')` then follow **Morning prep** below |
| **Interactive** | Owner: "morning review", "what's left from yesterday", "let's plan the day", opens `@Planning/daily-review-*.md`, or references yesterday's time block |

Pair with **`ea-shutdown`** the prior evening so yesterday's review is honest.

## Artifacts (one per calendar day)

| File | Role |
|------|------|
| `Planning/daily-review-YYYY-MM-DD.md` | Checkboxes, owner answers, carryover — **mutable during review** |
| `Planning/.time-block-plan-YYYY-MM-DD.json` | Machine plan for that day |
| `Planning/time-block-YYYY-MM-DD.excalidraw` | Visual record — **do not edit yesterday's file in place** |

Yesterday's diagram stays frozen; today gets a new file after review.

## Morning prep (cron / async)

Run at start of owner workday **before** the pointer email.

1. **Bootstrap Nylas profile** — check `.joshu/nylas/profile.json` (under `$JOSHU_FILES_ROOT`). If missing or empty, call `nylas_get_profile()` then persist with `nylas_update_profile()` before any Nylas sends. See **`ea-playbook`** "Every run — read first" for the canonical startup sequence.
2. **Dates** — owner local **today** = `YYYY-MM-DD`; **yesterday** = prior calendar day.
3. **Find the most recent workday's plan** (not necessarily yesterday):
   - If yesterday had a time-block plan (weekday), read it directly.
   - If yesterday was a weekend/holiday with no plan, fall back to the **most recent workday** with `Planning/.time-block-plan-{date}.json` — typically Friday for a Monday morning. Set a `plan_date` variable for use in retrospective and frontmatter.
4. **Read the identified plan** (if files exist):
   - `Planning/.time-block-plan-{plan_date}.json` — blocks, taskGroups, notes
   - `Planning/daily-review-{plan_date}.md` — `shutdown_complete`, end-of-day section
   - `Projects/*/journal_{plan_date}.md` — what actually happened
   - `Projects/*/journal_{yesterday}.md` for weekend gap — catch any weekend processing
   - Calendar mirrors for the plan date (optional — meetings held vs planned)
5. **Create or refresh** `Planning/daily-review-{today}.md`:
   - Copy shape from `templates/ea/Planning/daily-review-template.md` if missing
   - Frontmatter: `date`, `yesterday_plan` → `Planning/time-block-{plan_date}.excalidraw` (the most recent plan, which may not be literally yesterday), `morning_review_complete: false`, `shutdown_complete: false`
   - **Last workday retrospective (draft)** — one `- [ ]` line per block from the plan (`start–end — label`); link block targets when plan JSON has `link`. Note the date gap if plan_date ≠ yesterday (e.g. "Weekend gap — last plan was Friday").
   - **Carryover to today** — unchecked items from last plan's shutdown section, open `todo.md` rows touched on the plan_date, unfiled capture from the gap days
   - **Scheduling — owner review** — projects with `owner_decisions_pending: true` or todo rows **Waiting on: owner review** (from [`ea-playbook` scheduling HITL defer](../ea-playbook/SKILL.md#hitl-defer-owner-review-notes)); list in **Decisions needed** with journal link — do not auto-schedule from cron
   - **Proposed today** — 2–4 bullet priorities (not full schedule yet)
6. **Optional draft plan** — first check if `Planning/.time-block-plan-{today}.json` already exists (pre-rendered by a late-evening session). If it does:
   - **Link to it** in the daily-review and pointer email — do not re-render.
   - Verify it references yesterday's plan correctly; patch `yesterdayPlan` if stale.
   - Skip the render entirely unless the calendar has materially changed since the file was written (check file mtime vs latest calendar events).

   If it does **not** exist and the calendar is stable, write `Planning/.time-block-plan-{today}.json` + render Excalidraw as *proposal* (owner may change in interactive step). If owner prefers review-first, skip render and note "Run time block after morning review."
7. **Pointer email** — short Nylas message to `primaryWorkEmail` (see **Email (morning pointer)**). Do **not** send the old 500-word standalone brief unless `daily-review` prep failed.

## Interactive morning review (jChat)

When the owner engages:

1. Load **`Planning/daily-review-{today}.md`** and **`yesterday_plan`** file if linked.
2. **Walk the last workday** — for each unchecked block in retrospective:
   - Ask: done / partial / skipped / rescheduled?
   - Update checkbox: `[x]` done, `[~]` partial, leave `[ ]` for carryover
   - On done: update linked `Projects/*/todo.md` row or journal line with link — **do not paste mail bodies**
   - If there's a weekend gap (plan_date ≠ yesterday), ask about both the plan blocks and any weekend activity
   - On carryover: add to **Carryover to today** with same `joshu://` link
3. **Capture & priorities** — read `Planning/capture-{today}.md`; ask what to add/drop/defer.
4. **Commit today** — `skill_view('ea-time-block')` and run its workflow:
   - Pass **carryover** into plan JSON `carryover[]` (see ea-time-block)
   - Re-render `Planning/time-block-{today}.excalidraw`
5. **Owner answers** — append concise Q&A under `## Owner answers`.
6. Set frontmatter **`morning_review_complete: true`** when the owner confirms the plan.
7. Tell owner to open **`Planning/time-block-{today}.excalidraw`** in jWhiteboard.

Keep the session **short** (5–10 min). One question batch at a time if async.

## Email (morning pointer)

Write body to `Projects/_system/summary-email.md`, send via Nylas. **~150–250 words.**

```
🌅 MORNING REVIEW READY

Yesterday: [link to yesterday time block] — {N} items to confirm
Today: [link to daily-review] · [link to time block if rendered]

Open jChat and say "morning review" (or open the daily review file) to confirm what got done and lock today's plan.

📅 CALENDAR (remaining today)
<2–3 lines — next meetings + free pockets>

📬 NEW MAIL (if any)
<only stubs from last ~12h — who, project, next step>

🔁 SCHEDULING
<blocked meeting tasks only if any>
```

Skip sections with nothing new. Full data-source table lives in **`ea-playbook`** Summary email — use the same tools but **condense** for the pointer.

## Link discipline

- Block lines in daily-review: `→ [label](joshu://Projects/.../todo.md)` when a canonical target exists
- Never duplicate thread bodies — link `connectors/mail/…`
- Chat context stays in Hindsight; durable answers land in daily-review + project files

## Do not

- Edit yesterday's `.excalidraw` to cross out blocks (history per day)
- Replace **`ea-playbook`** triage or mail ingress
- Skip interactive step and treat cron draft as final plan without owner confirmation (unless owner explicitly says "skip review today")

## References

- `references/daily-review-schema.md` — frontmatter + section contract
