# GTD workspace, capture, and linking (Joshu EA v2)

How **Getting Things Done**, **Cal Newport time blocking**, and **Joshu v2** fit together: one canonical file per artifact, pointers everywhere else, gbrain for recall.

**Product spec:** [`ea-for-joshu.md`](ea-for-joshu.md) · **Time block:** [`time-block-planning.md`](time-block-planning.md) · **Agent filing:** [`../../templates/ea/FILING.md`](../../templates/ea/FILING.md)

---

## Governing rule

**One source of truth per kind of information; everything else is a link.**

| Information | Canonical location | Never duplicate |
|-------------|-------------------|-----------------|
| Mail/calendar bodies | `connectors/mail/…`, `connectors/calendar/…` | Into project files |
| Mail work queue | `Triage/*.stub.md` → `source_path` | Email body in stub |
| Next actions & waiting | `Projects/<slug>/todo.md` | Kanban card text in todo |
| Project outcome | `Projects/<slug>/about.md` | Status in chat only |
| Multi-step execution | Hermes Kanban (`ea-project-kanban`) | Every card in todo |
| Calendar times | Live Google/Nylas API | Guessed from mirrors alone |
| Intraday unprocessed capture | `Planning/capture-YYYY-MM-DD.md` | Only in Hindsight |
| Today's intentional plan | `Planning/time-block-YYYY-MM-DD.excalidraw` | Parallel schedule doc |
| Day handoff (checkboxes) | `Planning/daily-review-YYYY-MM-DD.md` | Duplicating plan in email |
| Chat conversation | Hindsight memory | Full chat logs in markdown |

---

## GTD → Joshu mapping

| GTD bucket | Joshu path | Skill / mechanism |
|------------|------------|-------------------|
| **Inbox (capture)** | Mail: `Triage/` + mirrors · Chat: `Planning/capture-*.md` | Ingest + `ea-playbook` |
| **Clarify** | Agent reads capture/stub → decides project, next action | `ea-playbook` |
| **Next actions** | `Projects/<slug>/todo.md` | Filing loop |
| **Projects (multi-step)** | `Projects/<slug>/` + optional Kanban | `ea-project-kanban` |
| **Waiting for** | `todo.md` **Waiting on** column | Filing + weekly review |
| **Someday/Maybe** | `about.md` `status: someday` | Weekly review |
| **Reference** | `connectors/` mirrors (link from journal/todo) | `joshu-mail` / gbrain |
| **Calendar** | Google calendar + time-block diagram | `ea-scheduling`, `ea-time-block` |
| **Reflect (daily handoff)** | `Planning/daily-review-*.md` + interactive jChat | `ea-morning-review`, `ea-shutdown` |
| **Archive** | `Projects/_archive/<slug>/` | Weekly review |

**Do not** use physical folders like `Reference/`, `Someday/`, `Current/` with projects nested inside. Lifecycle lives in **`about.md` frontmatter** (`status`) and **`_archive/`** for completed work. Move folders only when **archiving** — never copy between buckets.

---

## Folder tree (additions)

```text
joshu's files/
├── FILING.md
├── Planning/
│   ├── capture-YYYY-MM-DD.md          # intraday inbox (chat, dictation, random)
│   ├── daily-review-YYYY-MM-DD.md     # day handoff — checkboxes, carryover, shutdown
│   ├── .time-block-plan-YYYY-MM-DD.json
│   └── time-block-YYYY-MM-DD.excalidraw   # one diagram per day (history accumulates)
├── Triage/                            # mail queue only (pointers)
├── connectors/                        # reference mirrors
└── Projects/
    ├── <slug>/                        # about.md, todo.md, journal_*.md
    ├── other/
    └── _archive/
```

---

## Project lifecycle (`about.md`)

```yaml
status: active | someday | reference | done
someday_review: YYYY-MM-DD   # optional — resurface in weekly review
```

| `status` | Meaning | Location |
|----------|---------|----------|
| `active` | Has next actions or open threads | `Projects/<slug>/` |
| `someday` | Maybe later; no current next action | Same folder — do not move |
| `reference` | Context-only; no tasks expected | Same folder — link to connectors |
| `done` | Closed | Move to `Projects/_archive/<slug>/` |

**Weekly review:** scan `status: someday`, chase **Waiting on** / **Blocker**, merge `Projects/other/`, archive `done`.

---

## Capture: email vs chat

| Channel | Queue | After clarify |
|---------|-------|---------------|
| **Email** | Triage stub + `ea-mail-ingress` Kanban | File to project; stub → `_done/` |
| **jChat / voice riff** | Append to `Planning/capture-YYYY-MM-DD.md` first | Then project `todo.md` + journal (with links) |

Chat is **not** mirrored like mail. Hindsight holds conversation context; durable capture lands on disk via **`Planning/capture-*`** then filing.

Capture file shape:

```markdown
---
date: 2026-06-18
---

## Tasks
- buy food
- reply to investor thread

## Ideas
- time-block linking with numbered refs
```

During **time block today**, the gather script pre-fills calendar meetings; open items from capture + project todos feed the LLM synthesis step (`ea-time-block`).

---

## Link discipline

When filing mail or capture, **link — do not paste** bodies.

### In `todo.md` (after task row or in Notes column if added)

```markdown
→ [Re: Acme terms](joshu://connectors/mail/gmail/.../threads/abc.md)
```

Or relative path (gbrain indexes on sync):

```markdown
→ [thread](../connectors/mail/gmail/.../threads/abc.md)
```

### In `journal_YYYY-MM-DD.md`

```markdown
## 2026-06-18 · filed mail
- Updated todo; source: [joshu://connectors/mail/.../threads/abc.md](joshu://connectors/mail/.../threads/abc.md)
```

### Time-block diagram

- Block `link` → project, thread, or calendar event (see [`time-block-planning.md`](time-block-planning.md))
- `taskGroups[]` + `blockRef` → numbered task lists (Cal Newport ① pattern)
- `noteLinks[]` → capture lines with optional targets

### gbrain graph

Filesystem writes only; gbrain **sync** extracts markdown links and `[[wikilinks]]` for `get_backlinks` / `traverse_graph`. Prefer explicit paths in project files so recall works for humans and agents.

Optional ops (not required for v1): `gbrain config set link_resolution.global_basename true` for Obsidian-style `[[slug]]` resolution across folders.

---

## Engage pipeline (multi-step → time block)

```text
Capture (mail/chat)
  → Clarify (ea-playbook)
  → Organize (Projects/ + optional ea-project-kanban)
  → Reflect (ea-shutdown → ea-morning-review — daily-review checkboxes)
  → Plan day (ea-time-block → Planning/*.excalidraw)
  → Do (calendar + blocks)
```

- **Several steps / HITL** → `ea-project-kanban` on `project-<slug>`
- **Single next action** → `todo.md` row
- **When today** → `ea-time-block` assigns blocks with `joshu://` links

---

## Related skills

| Skill | Role |
|-------|------|
| `ea-playbook` | Filing, capture, weekly hygiene, link discipline |
| `ea-morning-review` | Morning prep + interactive yesterday→today handoff |
| `ea-shutdown` | Evening shutdown draft + interactive close |
| `ea-time-block` | Daily linked diagram from calendar + todos + capture + carryover |
| `ea-project-kanban` | Multi-step / HITL execution |
| `joshu-mail` | Mail recall (gbrain → connectors) |
| `joshu-brain` | Desktop file recall + backlinks |
