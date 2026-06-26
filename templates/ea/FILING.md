# Joshu files — filing guide

All agent writes go under **`JOSHU_FILES_ROOT`** (this folder). Do not use macOS `~/Desktop`.

**GTD + linking:** lifecycle via `about.md` `status` (not Reference/Someday/Current folders); capture in `Planning/`; link mail via `joshu://connectors/mail/…` — see Joshu SOP *gtd-workspace-linking* (factory docs).

## Layout

| Path | Purpose |
|------|---------|
| `connectors/mail/…` | Synced mail mirrors (machine-written; read/search) — **reference, do not copy bodies** |
| `connectors/calendar/…` | Synced calendar mirrors |
| `connectors/_state/` | Sync cursors and scheduling-queue markers |
| `Triage/*.stub.md` | **Mail-only** work queue — pointers to connector threads |
| `Planning/capture-YYYY-MM-DD.md` | Intraday inbox — chat, dictation, random items before filing |
| `Planning/daily-review-YYYY-MM-DD.md` | Day handoff — checkboxes, carryover, shutdown (`ea-morning-review`, `ea-shutdown`) |
| `Planning/.time-block-plan-YYYY-MM-DD.json` | Intermediate plan (ea-time-block) |
| `Planning/time-block-YYYY-MM-DD.excalidraw` | Linked Cal Newport diagram — one per day |
| `Projects/<slug>/` | Active work: `about.md`, `todo.md`, `journal_YYYY-MM-DD.md`; optional `kanban_board` in `about.md` when **`ea-project-kanban`** runs |
| `Projects/<slug>/scheduling/` | **Legacy** scheduling case files — replaced by Kanban `ea-scheduling` |
| `Projects/other/` | Catch-all project |
| `Projects/_archive/` | Completed projects (moved when `status: done`) |
| `research/kb/inbox/` | **PDF drop folder** — auto-extracted to `research/kb/*.md` (see below) |
| `research/kb/.raw/` | Archived PDF originals (reference only; not indexed) |

**Do not** create `Reference/`, `Someday/`, or `Current/` parent folders. Use `about.md` **`status`** (`active` \| `someday` \| `reference` \| `done`) and move to `_archive/` only when done.

## Link discipline (required when filing)

**One fact, one home — link everywhere else.**

| When | Write |
|------|--------|
| Filed mail | In `todo.md` or journal: `→ [subject](joshu://connectors/mail/…/threads/<id>.md)` using stub `source_path` |
| Chat capture | Append to `Planning/capture-YYYY-MM-DD.md` first; when filed, link to project + optional Hindsight note in journal |
| Time-block block | Plan JSON `link` → project, thread, or calendar `.md` |
| Multi-step work | `about.md` `kanban_board` pointer — not duplicate cards in `todo.md` |

gbrain indexes markdown links and `[[wikilinks]]` on sync — use links so agents can `get_backlinks` / `traverse_graph`.

## Triage stubs (mail only)

Stubs are **not** email copies. Read the body at `source_path` in frontmatter.

Why stubs exist: decouple **10m ingest** from **Hermes filing** — durable queue + classifier hints without duplicating thread bodies.

States: `new` → `processing` (cron snapshot) → `done` (removed or `Triage/_done/`).

Scheduling stubs may include `scheduling_case_id` and `scheduling_queued: true` (legacy frontmatter) — meeting state lives on **`ea-scheduling`** Kanban tasks.

## Capture (non-email)

jChat / voice ideas → **`Planning/capture-YYYY-MM-DD.md`** (sections: Tasks, Ideas) → clarify into `Projects/<slug>/todo.md` + journal. No Triage stub for chat.

## Scheduling (Kanban)

Active scheduling runs on Hermes board **`ea-scheduling`** (skill `ea-scheduling`). Ingest queues **`ea-mail-ingress`** only; the ingress worker files the project, then may call **`scheduling_create_meeting_task`**. Standalone cold scheduling → **`Projects/other/`**. Legacy board **`ea-sched-ingress`** — finish existing cards only; no new ingest tasks.

Legacy path `Projects/<slug>/scheduling/<case-id>.md` may still exist for old boxes; do not create new case files.

## Ad-hoc Kanban projects

**Multi-step work** — especially with **human-in-the-loop** (approvals, replies, owner decisions) — should run on Hermes Kanban, not only in `todo.md`. Skill **`ea-project-kanban`**, board `project-<slug>`, brief in `Projects/<slug>/about.md` (`kanban_board` pointer). Examples: drip/outreach, research pipelines, vendor chases, browser-assisted flows. Kanban holds execution; markdown holds summary only.

## Projects

### `about.md`

- **Outcome**, urgency/importance (1=highest), deadline, `owner_decisions_pending`
- **`status`:** `active` | `someday` | `reference` | `done` (default `active`)
- **`someday_review`:** optional `YYYY-MM-DD` for weekly scan
- **`kanban_board` / `kanban_root_task`:** when **`ea-project-kanban`** runs

### `todo.md`

Task table with **Waiting on** (person) and **Blocker** (non-person). Add source links on filed items (see Link discipline).

### `journal_YYYY-MM-DD.md`

Append-only daily log. Cite `joshu://` or relative paths to threads and plans — do not paste mail bodies.

## Mail recall

Search via gbrain → connector paths. See skill **`joshu-mail`**.

## Knowledge base (PDFs)

Drop **text PDFs** in **`research/kb/inbox/`**. Joshu extracts plain text automatically (no LLM), writes **`research/kb/<slug>.md`**, archives the original under **`research/kb/.raw/`**, and indexes via gbrain (type **`research`**). Scanned/image PDFs are not supported yet — transcribe or OCR externally first.

Manual ingest: `npm run kb:ingest-pdf`. Details: Joshu **`docs/file-brain.md`** (Knowledge base section).

## Outbound email

Joshu sends from the **agent Nylas** mailbox only (`POST /joshu/api/nylas/messages/send`). Owner Gmail is read/sync only. The API appends the companion HTML signature automatically — pass message content only in `body`.

## Page types (gbrain)

Path prefix drives index type: `connectors/mail/` → `connector-mail`; `Planning/` and project markdown index under the Desktop federated source. Optional YAML `type:` is for humans; **path wins**.
