# Daily review file schema

Path: `Planning/daily-review-YYYY-MM-DD.md`

## Frontmatter

| Field | Type | Purpose |
|-------|------|---------|
| `date` | `YYYY-MM-DD` | Review day (today during morning) |
| `yesterday_plan` | path | `Planning/time-block-{yesterday}.excalidraw` |
| `morning_review_complete` | boolean | Owner confirmed morning interactive session |
| `shutdown_complete` | boolean | Owner completed end-of-day shutdown |

Optional: `morning_review_at`, `shutdown_at` (ISO timestamps) when completing sessions.

## Sections

| Section | Writer | Reader |
|---------|--------|--------|
| **Yesterday retrospective (draft)** | Morning prep cron | Interactive morning review |
| **Carryover to today** | Morning prep + interactive | `ea-time-block` → `carryover[]` |
| **Owner answers** | Interactive morning | — |
| **Proposed today** | Morning prep; finalized in interactive | Owner |
| **End of day (shutdown)** | Evening prep + interactive shutdown | Next morning prep |

## Checkbox conventions

- `[ ]` — open / not done / carryover
- `[x]` — done (confirmed by owner)
- `[~]` — partial (optional — note in Owner answers)

Partial blocks may still generate carryover lines for the remainder.

## `[~]` in carryover JSON

When building `.time-block-plan-*.json` `carryover[]`, include items still `[ ]` or `[~]` from daily-review with original `link` paths from yesterday plan JSON.
