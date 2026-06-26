# Cal Newport layout (time block diagram)

## Visual layout (rendered by `scripts/render-time-block-excalidraw.mjs`)

| Region | Content |
|--------|---------|
| Left column | Hour labels + colored blocks (30 min minimum height) |
| Right column (top) | **Task groups** — numbered refs (①) with linked bullet lists |
| Right column (below) | Yellow **Notes / capture** list (optional links) |
| Title | `Time block — <date>` |

## Planning principles

1. **Assign every work hour** — meetings from **live calendar** (or gather script / mirrors) are fixed blocks first.
2. **Deep before shallow** — protect 90–120 min deep blocks early when possible.
3. **Batch shallow work** — one `shallow` block for email/Slack/admin, or a `taskGroups` batch labeled `Tasks ①`.
4. **Pull from capture** — unfiled items in `Planning/capture-YYYY-MM-DD.md` become `notes[]` or `taskGroups[]` before disappearing into a project block.
5. **Buffers** — 15–30 min `buffer` after meeting stacks.
6. **Replan, don't quit** — if the day shifts, rerun `ea-time-block` to redraw the **remainder** or full day.

## Numbered task groups (notebook ① pattern)

Use when one time block covers several distinct next actions:

```json
"taskGroups": [{ "ref": "1", "label": "①", "items": [{ "text": "…", "link": { "path": "…" } }] }],
"blocks": [{ "label": "Tasks ①", "blockRef": "1", "kind": "shallow", … }]
```

## Shutdown ritual (optional note line)

Add a note: "Shutdown complete ☐" — Cal's planner uses a checkbox to end the workday intentionally. **`ea-shutdown`** owns the interactive ritual; markdown checkboxes in `Planning/daily-review-*.md` are authoritative.

## Carryover (morning review → today)

When `Planning/daily-review-YYYY-MM-DD.md` has unchecked **Carryover to today** lines, map them into plan JSON `carryover[]` with the same `joshu://` links. Set `yesterdayPlan` to link today's diagram back to yesterday's file (one `.excalidraw` per day — do not edit yesterday's canvas).

## Work hours

Default `09:00`–`17:00` unless user context or calendar implies otherwise (early calls, travel days).
