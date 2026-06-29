---
name: ea-time-block
description: Cal Newport time-block plan for today as a linked Excalidraw diagram.
metadata:
  hermes:
    category: executive-assistant
    version: "1.3.0"
---

# EA Time Block (Cal Newport)

On demand: build **today's** intentional schedule as a **linked Excalidraw diagram** in `${JOSHU_FILES_ROOT}/Planning/`.

Inspired by Cal Newport's [time blocking](https://calnewport.com/deep-habits-the-importance-of-planning-every-minute-of-your-work-day/): schedule column = hour grid with named blocks; right column = capture notes and optional **numbered task groups** (① → task list). Replan when disrupted — rerun this skill to refresh the diagram.

**GTD / linking context:** `docs/executive-assistant.md#gtd-workspace`

## When to use

- User asks: "time block today", "plan my day", "draw today's calendar", "Cal Newport schedule"
- After **morning review** confirms carryover — regenerate with updated `carryover[]`
- After major calendar changes — regenerate the same-day file

## Prerequisites

- `skill_view('excalidraw')` for JSON envelope rules (container-bound labels)
- `${JOSHU_FILES_ROOT}` with `connectors/calendar/` mirrors, `Projects/`, and optionally `Planning/capture-YYYY-MM-DD.md`
- `/opt/joshu/scripts/gather-time-block-input.mjs` and `/opt/joshu/scripts/render-time-block-excalidraw.mjs` on VPS (Joshu sandbox image; **not** `scripts/…` relative to Desktop — Hermes `terminal.cwd` is the ArozOS Desktop folder)
- Local factory dev from repo root: `npm run time-block:gather` and `scripts/render-time-block-excalidraw.mjs`

## Workflow

1. **`skill_view('ea-time-block')`** — this file
2. **Date & timezone** — owner local date (Hermes owner-time system message or `getOwnerTimeAnchor`). Output file: `Planning/time-block-YYYY-MM-DD.excalidraw`
3. **Gather inputs (deterministic script)** — run once before LLM synthesis:

```bash
node /opt/joshu/scripts/gather-time-block-input.mjs \
  --date YYYY-MM-DD \
  --files-root "${JOSHU_FILES_ROOT}" \
  -o "${JOSHU_FILES_ROOT}/Planning/.time-block-plan-YYYY-MM-DD.json"
```

Local dev (repo root): `npm run time-block:gather -- --stdout` or `-o …`

The script pre-fills **`blocks[]`** with today's **meeting** blocks (live calendar API when Joshu is up, else mirror scan), **`workHours`** expanded to cover meetings, **`yesterdayPlan`**, **`_gather.activeProjects`**, **`_gather.recentJournals`**, and **`_gather.planningFiles`** paths. See `references/calendar-api-quirks.md`.

**Do not** glob mirror filenames by calendar date — mirrors are named by event UUID. Prefer **`google_calendar_list_events`** (Composio MCP) or Joshu `GET /joshu/api/connectors/calendar/google/events?date=&timezone=` when the gather script is unavailable.

4. **Synthesize plan (LLM)** — read the gather output and fill gaps:
   - `Planning/daily-review-YYYY-MM-DD.md` — **carryover** checkboxes (after morning review)
   - Yesterday's `.time-block-plan-*.json` if daily-review missing
   - `Planning/capture-YYYY-MM-DD.md` — open Tasks/Ideas bullets
   - `_gather.activeProjects` → deep/shallow blocks with `Projects/<slug>/about.md` links
   - `_gather.recentJournals` for context only
   - Optional `gbrain` for "today priority"
   - Do not deep-triage mail — **`ea-playbook`** owns filing
   - Merge into plan JSON; remove or ignore `_gather` before render (renderer ignores extra keys)
5. **Write plan JSON** — update `${JOSHU_FILES_ROOT}/Planning/.time-block-plan-YYYY-MM-DD.json`:

```json
{
  "date": "2026-06-18",
  "title": "Time block — Wed Jun 18",
  "yesterdayPlan": { "date": "2026-06-17", "path": "Planning/time-block-2026-06-17.excalidraw", "label": "Jun 17" },
  "carryover": [
    { "text": "Finish investor reply batch", "link": { "path": "Projects/foo/todo.md" }, "done": false }
  ],
  "workHours": { "start": "09:00", "end": "17:00" },
  "taskGroups": [
    {
      "ref": "1",
      "label": "①",
      "items": [
        { "text": "task #1", "link": { "path": "Projects/foo/todo.md" } },
        { "text": "task #2", "link": null }
      ]
    }
  ],
  "blocks": [
    {
      "start": "09:00",
      "end": "10:30",
      "label": "Deep work — Joshu EA",
      "kind": "deep_work",
      "link": { "path": "Projects/joshu-product-development/about.md" }
    },
    {
      "start": "14:00",
      "end": "15:00",
      "label": "Tasks ①",
      "kind": "shallow",
      "blockRef": "1",
      "link": { "path": "Projects/joshu-product-development/todo.md" }
    }
  ],
  "notes": ["Shutdown ritual 5pm", "buy food (from capture)"],
  "noteLinks": [null, { "path": "Planning/capture-2026-06-18.md" }]
}
```

**Block kinds:** `meeting` | `deep_work` | `shallow` | `personal` | `break` | `buffer`

**`taskGroups` + `blockRef`:** Cal Newport numbered lists — block label may include `①`; `blockRef` matches `taskGroups[].ref`. Renderer draws the group in the notes column.

**`yesterdayPlan` + `carryover`:** After morning review, set `yesterdayPlan.path` to yesterday's `.excalidraw`; populate `carryover[]` from unchecked items in `daily-review` (see **`ea-morning-review`**). Renderer shows a yesterday link under the title and a **From yesterday ☐** list in the notes column.

**Rules:**
- Minimum block **30 minutes**; batch tiny tasks into one `shallow` block or a `taskGroups` batch
- Calendar meetings → `kind: meeting` with link to the **event mirror** `.md`
- Project focus → `kind: deep_work` → `Projects/<slug>/about.md` or `todo.md`
- Email batch → `kind: shallow` → mail thread or inbox project `todo.md`
- Unfiled capture items → `notes[]` with `noteLinks` → `Planning/capture-*.md`
- Carryover from daily-review → `carryover[]` before task groups; schedule deep/shallow blocks for them
- Leave **buffer** between dense meetings when calendar shows back-to-back overload
- Every block gets a **`link`** when a canonical target exists (`joshu://` path from files root)
- Fill gaps intentionally — every work hour gets a job

6. **Render diagram** — use the **absolute** renderer path on VPS (relative `scripts/…` fails from Desktop cwd):

```bash
node /opt/joshu/scripts/render-time-block-excalidraw.mjs \
  "${JOSHU_FILES_ROOT}/Planning/.time-block-plan-YYYY-MM-DD.json" \
  -o "${JOSHU_FILES_ROOT}/Planning/time-block-YYYY-MM-DD.excalidraw"
```

Local dev (repo root): `node scripts/render-time-block-excalidraw.mjs plan.json -o …`

7. **Tell the user** — open `Planning/time-block-YYYY-MM-DD.excalidraw` in **jWhiteboard** (double-click from Files). Block links use `joshu://` paths to threads, projects, calendar events, and capture files.

## Link targets

See `references/link-targets.md`. Renderer emits `joshu://<path-from-files-root>` on each block.

## References

- `references/cal-newport-layout.md` — grid layout, replanning, shutdown note, task groups, carryover
- `references/link-targets.md` — per-block link mapping
- `references/calendar-api-quirks.md` — live calendar vs mirrors, FreeBusy calendar IDs

## Pitfalls & tips

- **Mirror glob by date fails** — event files are UUID-named; use gather script or live list_events.
- **FreeBusy `items` omitted by default (2026-06-24)** — Joshu queries `primary` + personal Gmail; use **`calendars.combined.free`** for scheduling. See [`calendar-api-quirks.md`](references/calendar-api-quirks.md).
- **End-of-day awareness** — if owner local time is past ~6 PM, confirm whether they want **tomorrow's** block, not today's.
- **Journal paths** — `Projects/*/journal_YYYY-MM-DD.md` and `Projects/_system/journal_*.md` (not repo-root journals).

## Do not

- Replace EA-playbook triage or ea-scheduling booking flows
- Upload diagrams to excalidraw.com unless user asks (local file is canonical)
- Invent calendar events — meetings come from live calendar / gather script; use LLM only for **unscheduled** blocks between fixed meetings
- Paste mail bodies into plan JSON — link to `connectors/mail/…` paths only
