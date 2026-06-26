# Link targets for time-block blocks

All links use `joshu://<relative-path>` from `${JOSHU_FILES_ROOT}`.

| Block kind | Prefer link to | Example |
|------------|----------------|---------|
| `meeting` | Calendar event mirror | `joshu://connectors/calendar/google/.../events/<uuid>.md` — resolve via gather script or live list_events (mirrors are UUID-named, not date-globs) |
| `deep_work` | Project charter | `joshu://Projects/joshu-product-development/about.md` |
| `shallow` | Triage / inbox project todo | `joshu://Projects/inbox-email-triage/todo.md` |
| Mail follow-up in label | Mail thread mirror | `joshu://connectors/mail/gmail/.../threads/<id>.md` |
| Kanban / scheduling | Project todo anchor | `joshu://Projects/<slug>/todo.md` (mention row in label) |
| Capture / unfiled riff | Day capture file | `joshu://Planning/capture-YYYY-MM-DD.md` |
| Task group batch | Project todo or specific thread | `joshu://Projects/<slug>/todo.md` |

## taskGroups + blockRef

When a block batches several next actions (Cal Newport ① pattern):

- `taskGroups[]` lists items with optional `link` per line
- `blocks[].blockRef` matches `taskGroups[].ref`
- Block `link` should point at the primary project `todo.md` or `about.md`

## Fallback order

1. Explicit `link.path` from plan JSON (gather script sets this for meetings when mirror exists)
2. Meeting → `scripts/gather-time-block-input.mjs` mirror index, or live calendar event id → mirror path
3. Project slug from LLM context → `Projects/<slug>/about.md`
4. Capture-only item → `Planning/capture-YYYY-MM-DD.md`
5. Omit `link` (block still visible, not clickable)

See also `references/calendar-api-quirks.md` for live calendar vs mirror discovery.

## jWhiteboard

Renderer sets Excalidraw element `link` to `joshu://<path>`. On click, jWhiteboard
`onLinkOpen` calls ArozOS desktop `newFloatWindow`:

- `.md` → MDEditor
- `.excalidraw` → jWhiteboard

`GET /joshu/api/files/read` is for **loading** diagrams into jWhiteboard, not for link clicks.
