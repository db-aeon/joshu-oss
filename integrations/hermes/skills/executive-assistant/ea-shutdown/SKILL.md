---
name: ea-shutdown
description: End-of-day shutdown — draft planned vs actual, interactive close, seed tomorrow handoff.
metadata:
  hermes:
    category: executive-assistant
    version: "1.1.0"
---

# EA Shutdown (end of day)

Cal Newport **shutdown ritual**: close the workday intentionally, record **planned vs actual** for today, and seed **`Planning/daily-review-{tomorrow}.md`** carryover for morning review.

**Pair with:** `skill_view('ea-morning-review')` next workday.

## When to use

| Mode | Trigger |
|------|---------|
| **Prep (async)** | `EA evening` cron — draft shutdown section before evening email |
| **Interactive** | Owner: "shutdown", "end my day", "close out today", references today's daily-review or time block |

## Evening prep (cron / async)

1. **Today** = owner local `YYYY-MM-DD`.
2. Read **`Planning/.time-block-plan-{today}.json`** (if it exists) and **`Planning/daily-review-{today}.md`** (create daily-review from template if missing — same date as today).
3. Read **`Projects/*/journal_{today}.md`** and calendar mirrors for today.
4. Under **`## End of day (shutdown)`** in daily-review:
   - **Today — planned vs actual (draft)** — one `- [ ]` per today's block, sourced from:
     - **Plan JSON** (preferred) — if `.time-block-plan-{today}.json` exists, use its blocks as the canonical list
     - **Calendar events** (fallback) — if plan JSON is missing (morning review not completed), use today's Google Calendar events. Note in the draft that blocks are inferred from calendar, not the time-block plan. Also pull any carryover items from the daily-review's Proposed today / Carryover sections.
     - Pre-check `[x]` only when journal/calendar clearly shows completion. Mark as *draft* in a one-line note above the list.
   - **Notes for tomorrow** — bullet list: open loops, first meeting, anything the owner should see at morning prep
5. Do **not** set `shutdown_complete: true` until interactive session (or owner explicitly says "skip shutdown" in jChat that day).
6. Continue **`ea-playbook`** evening duties: send evening summary with shutdown pointer (see below).

   **Pitfall — journal duplication**: Mail ingress workers already append `journal_{today}.md` for projects that received mail during the day. Before appending to any project journal, check whether the file already exists and what it contains. Only append evening-level observations (e.g. scheduling status changes, call outcome noted from calendar context) — do not duplicate what ingress already wrote. If all project activity was already journaled by ingress, skip the append step entirely. The system journal (`Projects/_system/journal_{today}.md`) is the right place for the evening-level meta-entry.

## Interactive shutdown (jChat)

1. Load **`Planning/daily-review-{today}.md`** + today's time-block plan.
2. For each block in **planned vs actual**:
   - Ask: done / partial / skipped?
   - Update checkboxes; on partial/skipped, add line under **Notes for tomorrow**
3. Update **`Projects/*/todo.md`** (close done rows, extend Waiting on) and append **`journal_{today}.md`** with links — no pasted bodies.
4. Optional: add note line to plan JSON `notes`: `"Shutdown complete ☑"` and re-render today's Excalidraw (cosmetic — checkbox truth stays in markdown).
5. Set frontmatter **`shutdown_complete: true`**.
6. Confirm tomorrow's morning prep will read this file.

**Target duration:** 2–5 minutes.

## Evening email (pointer)

Append to evening summary (or standalone if minimal day):

```
🌙 SHUTDOWN

Today's plan: [joshu://Planning/time-block-{today}.excalidraw]
Review draft: [joshu://Planning/daily-review-{today}.md]

Say "shutdown" in jChat to confirm what got done (2 min). Morning review picks up carryover tomorrow.
```

If no time-block plan was created today (morning review not completed, `morning_review_complete: false`), omit the "Today's plan" link and instead note: "Blocks inferred from calendar (no time-block plan today)."

Keep the rest of the evening summary per **`ea-playbook`** — journals, notable project movement — but **shorter** when shutdown draft is present.

## Do not

- Mark `shutdown_complete: true` from cron alone without owner confirmation (except explicit owner "skip shutdown")
- Delete today's time-block files — they are the historical record
- Duplicate mail into daily-review — link only
- Re-append to `Projects/*/journal_{today}.md` when mail ingress already wrote them (check file content first). Use `Projects/_system/journal_{today}.md` for evening-level meta entries instead.

## References

- `ea-morning-review/references/daily-review-schema.md` — shared file shape
