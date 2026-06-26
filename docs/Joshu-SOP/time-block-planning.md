# Time-block planning (Cal Newport + Excalidraw)

On-demand **time blocking** for the owner: live calendar + file context (gather script) → linked **Excalidraw** diagram in `Planning/`.

**Factory skill:** `ea-time-block` **v1.3.0** — deterministic gather + LLM synthesis + render.

**GTD / capture / linking:** [`gtd-workspace-linking.md`](gtd-workspace-linking.md)

## Daily handoff (morning review)

Time blocks are **one `.excalidraw` per calendar day** — files accumulate in `Planning/` as history. Yesterday is not edited in place.

| Artifact | Role |
|----------|------|
| `Planning/daily-review-YYYY-MM-DD.md` | Checkboxes for done/carryover — **source of truth** for handoff |
| `Planning/time-block-YYYY-MM-DD.excalidraw` | Visual plan for that day |

**Flow:**

1. **Evening** — `ea-shutdown` drafts planned-vs-actual in today's daily-review; owner says "shutdown" in jChat to confirm.
2. **Morning cron** — `ea-morning-review` preps today's daily-review from yesterday's plan + sends a short pointer email.
3. **Interactive** — owner says "morning review" → agent walks checkboxes → runs `ea-time-block` with `carryover[]` → renders today's diagram.

See [`ea-morning-review/SKILL.md`](../../integrations/hermes/skills/executive-assistant/ea-morning-review/SKILL.md) and [`ea-shutdown/SKILL.md`](../../integrations/hermes/skills/executive-assistant/ea-shutdown/SKILL.md).

## Skill

| Skill | Trigger | Output |
|-------|---------|--------|
| `ea-time-block` | jChat: "time block today", after "morning review" | `Planning/time-block-YYYY-MM-DD.excalidraw` |
| `ea-morning-review` | jChat: "morning review"; cron prep | `Planning/daily-review-YYYY-MM-DD.md` |
| `ea-shutdown` | jChat: "shutdown"; cron draft | daily-review end-of-day section |

Also enabled: bundled Hermes `excalidraw` (JSON envelope reference).

Factory skill: [`integrations/hermes/skills/executive-assistant/ea-time-block/SKILL.md`](../../integrations/hermes/skills/executive-assistant/ea-time-block/SKILL.md)

## Method (Cal Newport)

1. Fixed meetings from **live calendar** (gather script or API) first; mirrors supply links
2. Assign **deep work**, **shallow** batches, **buffers** to remaining hours
3. Pull open items from **`Planning/capture-YYYY-MM-DD.md`** and project `todo.md` files
4. Optional **numbered task groups** (①) linked to shallow blocks
5. Right column = capture notes (optional links)
6. Replan by re-running the skill — intention over perfect adherence

## Workflow

1. **Gather (deterministic)** — VPS: `node /opt/joshu/scripts/gather-time-block-input.mjs -o …` · local: `npm run time-block:gather -- -o Planning/.time-block-plan-YYYY-MM-DD.json` — pre-fills meeting blocks, active projects, journal paths, planning file pointers (live calendar API when Joshu is up)
2. **Synthesize (agent)** — read gather output + `Planning/daily-review-YYYY-MM-DD.md` (carryover) + `Planning/capture-YYYY-MM-DD.md`; fill deep/shallow/buffer blocks; optional gbrain
3. Writes/updates plan JSON: `Planning/.time-block-plan-YYYY-MM-DD.json`
4. Renders diagram:

**VPS** (Hermes terminal cwd is Desktop — use absolute paths):

```bash
node /opt/joshu/scripts/render-time-block-excalidraw.mjs \
  "${JOSHU_FILES_ROOT}/Planning/.time-block-plan-YYYY-MM-DD.json" \
  -o "${JOSHU_FILES_ROOT}/Planning/time-block-YYYY-MM-DD.excalidraw"
```

**Local dev** (repo root):

```bash
node scripts/render-time-block-excalidraw.mjs \
  "${JOSHU_FILES_ROOT}/Planning/.time-block-plan-YYYY-MM-DD.json" \
  -o "${JOSHU_FILES_ROOT}/Planning/time-block-YYYY-MM-DD.excalidraw"
```

5. Open in **jWhiteboard** (double-click from Files, or launch jWhiteboard — it auto-loads today's `Planning/time-block-YYYY-MM-DD.excalidraw` when present)

Or gather + render locally:

```bash
npm run time-block:gather -- -o "${JOSHU_FILES_ROOT}/Planning/.time-block-plan-YYYY-MM-DD.json"
npm run time-block:render -- "${JOSHU_FILES_ROOT}/Planning/.time-block-plan-YYYY-MM-DD.json" -o "${JOSHU_FILES_ROOT}/Planning/time-block-YYYY-MM-DD.excalidraw"
```

## Plan JSON shape

Intermediate file: `Planning/.time-block-plan-YYYY-MM-DD.json` (written by `ea-time-block`, consumed by the renderer).

| Field | Purpose |
|-------|---------|
| `date`, `title` | Diagram header |
| `yesterdayPlan` | `{ path, date?, label? }` — link strip under title to prior day's diagram |
| `carryover[]` | `{ text, link?, done? }` — **From yesterday ☐** in notes column |
| `workHours.start` / `end` | Hour grid (`"09:00"` … `"17:00"`, 24h) |
| `blocks[]` | `{ start, end, label, kind, link?, blockRef? }` — schedule column |
| `taskGroups[]` | `{ ref, label, items[] }` — numbered lists in notes column (`items[].text`, `items[].link`) |
| `notes[]` | Right-column capture lines |
| `noteLinks[]` | Parallel to `notes`; optional `joshu://` target per line |
| `_gather` | Optional — written by gather script only; agent context (`activeProjects`, `recentJournals`, `planningFiles`, `calendarEvents`). Ignored by renderer. |

**Scripts:**

| npm script | Script | Role |
|------------|--------|------|
| `time-block:gather` | `scripts/gather-time-block-input.mjs` | Pre-fill meeting blocks + file pointers |
| `time-block:render` | `scripts/render-time-block-excalidraw.mjs` | Plan JSON → `.excalidraw` |

VPS: both bind-mounted at `/opt/joshu/scripts/` (`deploy/docker-compose.yml`). Hermes agents must use **absolute** paths on VPS — relative `scripts/…` from Desktop cwd fails (see [hotpatch — skills seed gotcha](../vps-sandbox/hotpatch-running-box.md#skills-seed-after-docker-compose-recreate-gotcha)).

**Calendar:** prefer live `GET /joshu/api/connectors/calendar/google/events?date=&timezone=` (or Composio `google_calendar_list_events`). Mirror files are UUID-named — do not glob by date. See skill reference [`calendar-api-quirks.md`](../../integrations/hermes/skills/executive-assistant/ea-time-block/references/calendar-api-quirks.md).

**Block kinds:** `meeting` | `deep_work` | `shallow` | `personal` | `break` | `buffer`

**Link field:** string path, `joshu://…`, or `{ "path": "Projects/…/about.md" }` → renderer emits Excalidraw element `link`.

**blockRef:** matches `taskGroups[].ref` when block label uses ①-style batching.

Full schema: [`ea-time-block/SKILL.md`](../../integrations/hermes/skills/executive-assistant/ea-time-block/SKILL.md).

## Links (living hypertext)

Block rectangles carry `joshu://<path>` links (native Excalidraw `link` on shapes — no Excalidraw fork):

| Kind | Target |
|------|--------|
| Meeting | Calendar event `.md` mirror |
| Deep work | `Projects/<slug>/about.md` |
| Shallow / email | `Projects/.../todo.md` or mail thread mirror |
| Capture note | `Planning/capture-YYYY-MM-DD.md` |
| Notes | Optional `noteLinks` in plan JSON |

**Click:** jWhiteboard `onLinkOpen` → ArozOS desktop `newFloatWindow` → **MDEditor** for `.md`, **jWhiteboard** for `.excalidraw`.

**Load diagram:** jWhiteboard `GET /joshu/api/files/read?path=...` (localhost-only; not used for link clicks).

## Import Patrick files (local dev)

```bash
bash scripts/import-joshu-files-zip.sh /path/to/joshu-files.zip
```

Backs up current tree to `.local/backups/`, replaces `joshu's files`, runs factory bootstrap, optional gbrain reindex.

## Related

- [`gtd-workspace-linking.md`](gtd-workspace-linking.md) — capture, GTD buckets, link discipline
- [`docs/excalidraw-sandbox.md`](../excalidraw-sandbox.md) — jWhiteboard app, file open, API
- [`docs/Joshu-SOP/ea-for-joshu.md`](ea-for-joshu.md) — EA mail/projects layout
- [`docs/Joshu-SOP/executive-assistant.md`](executive-assistant.md) — Cal Newport references in EA philosophy
