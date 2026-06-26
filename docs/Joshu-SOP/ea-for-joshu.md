# Executive Assistant — Joshu product spec (v2)

Target architecture for Joshu boxes. Replaces the PARA `workspace/` tree (`00-start-here`, `Areas/*`, duplicate filing docs) with a **deterministic ingest pipe** + **project folders** + **Hermes skill-backed crons**.

Human VA reference (legacy): [`executive-assistant.md`](executive-assistant.md). Implementation tracking: repo `integrations/hermes/skills/executive-assistant/`, `src/connectors/`, `src/onboarding/eaCronJobs.ts`, factory seeds.

---

## Channels (v1)

| Role | Channel | Storage |
|------|---------|---------|
| **Owner (principal)** | Gmail via Composio (`connectors/mail/gmail/{account_key}/`) | Thread mirrors on disk |
| **Agent (Joshu)** | Nylas mailbox (`connectors/mail/nylas/`) | Thread mirrors on disk |

There is **no** forward-from-owner-to-agent setup. Owner mail and agent mail are separate accounts; both are polled and mirrored.

**Outbound (v1):** Joshu always sends email from the **agent Nylas** mailbox (`POST /joshu/api/nylas/messages/send`) — summaries, scheduling confirmations, holding replies. Owner Gmail (Composio) is read/sync only, not send. The API appends a branded HTML signature (companion name, `{owner}'s Joshu`, https://joshu.me CTA) on every send — agents pass plain text in `body` only.

Future (not v1): high-priority async (SMS, Slack, phone) as separate inbound types with their own stubs.

---

## Source of truth

| Information | Canonical location |
|-------------|-------------------|
| Mail/calendar **bodies** & metadata | `connectors/mail/…`, `connectors/calendar/…` |
| **Work queue** (what to process) | `Triage/*.stub.md` → pointer to connector path |
| **Tasks & waiting** (owner-facing) | `Projects/<slug>/todo.md` — not a duplicate Kanban backlog |
| **Project context** | `Projects/<slug>/about.md`, `journal_YYYY-MM-DD.md` |
| **Multi-step / HITL execution** | Hermes Kanban board `project-<slug>` (skill **`ea-project-kanban`**); pointer in `about.md` (`kanban_board`, `kanban_root_task`) |
| **Calendar times** | Nylas Calendar API (not markdown) |
| **Owner preferences** | Welcome → `profile.json` + seeded `Projects/*/about.md` |
| **Intraday capture (chat/voice)** | `Planning/capture-YYYY-MM-DD.md` |
| **Today's time-block plan** | `Planning/time-block-YYYY-MM-DD.excalidraw` (+ `.time-block-plan-*.json`) — one file per day |
| **Day handoff** | `Planning/daily-review-YYYY-MM-DD.md` (checkboxes, carryover, shutdown) |
| **Product version** | `workspace/.joshu-ea-version` (see [Versioning](#versioning)) |

Hermes uses filesystem tools under `${JOSHU_FILES_ROOT}` only. gbrain is **read/search** for mail recall (skill **`joshu-mail`**); do not dual-write via `put_page`.

**GTD mapping, link discipline, capture vs triage:** [`gtd-workspace-linking.md`](gtd-workspace-linking.md).

---

## Folder tree

All paths under `${JOSHU_FILES_ROOT}` (ArozOS `Desktop/joshu's files/`).

```text
joshu's files/
├── FILING.md                    # single agent-facing filing doc (replaces LOCATION + RESOLVER + schema)
├── connectors/                  # machine-written mirrors (existing)
│   ├── mail/gmail/{account_key}/threads/*.md
│   ├── mail/nylas/threads/*.md
│   ├── calendar/…
│   └── _state/                  # sync cursors + scheduling-queue markers
├── Planning/                    # daily capture + time-block diagrams (see gtd-workspace-linking.md)
│   ├── capture-YYYY-MM-DD.md
│   ├── daily-review-YYYY-MM-DD.md
│   ├── .time-block-plan-YYYY-MM-DD.json
│   └── time-block-YYYY-MM-DD.excalidraw
├── Triage/                      # mail stub queue only (see below)
│   └── <provider>-<threadId>.stub.md
└── Projects/
    ├── <slug>/                  # one folder per active project
    │   ├── about.md
    │   ├── todo.md
    │   ├── scheduling/          # legacy MD cases only — do not create new
    │   └── journal_YYYY-MM-DD.md
    ├── other/                   # catch-all (same file set; weekly merge review)
    └── _archive/<slug>/         # completed projects (moved, not deleted)
```

When **`ea-project-kanban`** runs, `about.md` frontmatter may include `kanban_board` and `kanban_root_task` (pointers to Hermes Admin — not a duplicate backlog in `todo.md`).

Drop from v1 seeds: `workspace/Areas/`, `workspace/00-start-here.md`, `02-open-items.md`, `03-waiting-for.md`, `WORKSPACE.md`, top-level `journals/` / `inbox/` unless reused for non-EA capture.

---

## Project Kanban (multi-step / HITL, 2026-06)

**Default for work that is not a single chat turn:** several steps, parallel lanes, timed follow-ups, or **human-in-the-loop** (owner approval, replies, browser steps, judgment calls). Examples: drip/outreach campaigns, vendor chases, research → draft → send pipelines, anything that should **`kanban_block`** while waiting.

**Not** for: inbox stub filing (`ea-playbook`), or meeting-mail scheduling (`ea-scheduling` on `ea-sched-*` boards).

| Piece | Detail |
|-------|--------|
| **Skill** | [`ea-project-kanban`](../../integrations/hermes/skills/executive-assistant/ea-project-kanban/SKILL.md) |
| **Board** | `project-<slug>` (one per user-initiated project; slug = `Projects/<slug>/` folder name) |
| **Filesystem** | Brief in `about.md` + supporting files (`recipients.md`, `brief.md`); **do not** mirror every card in `todo.md` |
| **Kickoff** | Triage root card (no assignee) → global **`kanban.auto_decompose`** fans out child tasks |
| **jChat kickoff tools** | Connectors MCP: **`project_kanban_ensure_board`**, **`project_kanban_create_triage_root`** (`mcp_joshu_connectors_*` in Langfuse) — not `scheduling_*`, not CLI |
| **Worker tools** | Native Hermes **`kanban_*`** (list, block, complete, comment); outbound mail via **`nylas_send_message`** (action guard = HITL) |
| **UI** | Hermes Admin — `https://hermes-admin.<slug>.box.joshu.me/` |

**Config (Joshu-managed):** `kanban.auto_decompose: true`; EA scheduling stays safe because Joshu creates ingress/meeting tasks with **assignee → ready** (never triage). Bridge [`hermes-kanban-bridge.py`](../../scripts/hermes-kanban-bridge.py) rejects triage creates on `ea-scheduling` / `ea-sched-ingress`. See [hermes-customizations — Kanban](../hermes-customizations.md#hermes-web-dashboard).

**Kickoff (operator / agent summary):**

1. Create `Projects/<slug>/` + `about.md` (leave `kanban_board` / `kanban_root_task` null until step 3).
2. **`project_kanban_ensure_board`** — `{ projectSlug: "<slug>", name, description }` → board `project-<slug>`.
3. **`project_kanban_create_triage_root`** — `{ projectSlug, title, body }` with body from skill `references/decomposition-template.md` → triage root task id.
4. Patch `about.md` frontmatter with `kanban_board` + `kanban_root_task`; dispatcher + decomposer spawn workers; owner supervises on Hermes Admin.

CLI (`hermes kanban boards create …`) is a **fallback** when connectors MCP tools are missing from the gateway catalog — see [partial MCP catalog](../vps-sandbox/troubleshooting-and-lessons.md#partial-mcp-tool-catalog-jchat--telegram).

**Hotpatch:** Lane A (skills, `joshu-connectors-mcp-http-server.mjs`) + Lane B3 (`dist/ea/triageRoutes.js`, `dist/hermesKanbanBridge.js`, …) — see [hotpatch-running-box.md](../vps-sandbox/hotpatch-running-box.md#lane-a--git-hotfix-skills-mcp-boot-scripts).

---

## Phase 1 — Deterministic ingest (Joshu app)

Poll **all** connected mail accounts every **10 minutes** ([`src/connectors/scheduler.ts`](../../src/connectors/scheduler.ts)) using **`syncMode: incremental`**:

- **Gmail (Composio):** prefer [`GMAIL_LIST_HISTORY`](https://docs.composio.dev/toolkits/gmail) from stored `historyId`; on `historyIdTooOld`, recover with `GMAIL_FETCH_EMAILS` `newer_than:1d` (ids-only list + per-thread `GMAIL_FETCH_MESSAGE_BY_THREAD_ID`). Persist `historyId` from `GMAIL_GET_PROFILE` after each run. Skip mirror/stub when `message_ids` unchanged.
- **Nylas agent inbox:** `newer_than:1d`, ~40 messages; skip unchanged mirrors.
- **Manual / Day 0:** `syncMode: full` (default **7d** / 30d Day 0) — not the cron path.

For each **new** inbound message (dedupe by provider + `thread_id`; mirror skip when `message_ids` match):

1. **Junk skip** — do not mirror or stub: Gmail categories/labels (Spam, Promotions, Social, Forums, Newsletters where labeled). Prefer Gmail native labels over LLM.
2. **Mirror** — write/update thread under `connectors/mail/…` (existing mirror writer).
3. **Agent skip** — do not stub or classify when `from` is the Joshu agent mailbox (`.joshu/nylas/agent.json` + profile `assistantEmail`). Outbound confirmations / summaries must not re-enter triage or scheduling.
4. **Gmail+Nylas dedup** — same message in owner Gmail and agent Nylas → process once via **RFC `Message-ID`** ([`mailDedup.ts`](../../src/ea/mailDedup.ts), mirror `rfc_message_id`).
5. **Universal mail classify** — cheap LLM on every new message ([`classifyInboundMail`](../../src/ea/classifier.ts)); taxonomy in [mail-classifier-taxonomy.md](mail-classifier-taxonomy.md). Langfuse trace **`ea-mail-classifier`** (tag `joshu-app`).
6. **Route by disposition:**
   - `noise` — skip (no stub, no Kanban)
   - `info` — thin stub → immediate `_done/` (transactional FYI)
   - `track` — thin stub + **`ea-mail-ingress`** Kanban task ([`mailCron.ts`](../../src/ea/mailCron.ts)) → Patrick files to **`project-<slug>`**; scheduling only when **`scheduling_eligible: true`** on the ingress task (standalone → `Projects/other/`)

Ingest no longer queues **`ea-sched-ingress`** (legacy board only). See [mail-classifier-taxonomy.md](mail-classifier-taxonomy.md).

**Day 0:** mirror-only — no triage stubs, no classification on historical mail.

### Triage stub format

Stub is a **pointer + queue state**, not a copy of the email.

```markdown
---
state: new
provider: gmail
account_key: db_at_project_aeon_com
thread_id: 19e6fea65cf18ced
source_path: connectors/mail/gmail/db_at_project_aeon_com/threads/19e6fea65cf18ced.md
subject: "…"
from: "…"
received_at: 2026-06-03T14:22:00Z
message_id: "…"
---

# Triage

Read body at `source_path` (under JOSHU_FILES_ROOT). Policy flags live on the **`ea-mail-ingress`** Kanban task (`agent_authorized`, `scheduling_eligible`, `allowed_actions`).
```

States: `new` → `processing` (morning/evening cron holds snapshot) → `done` (moved to `Triage/_done/`).

**Stub archival (deterministic):** Hermes must not rely on hand-moving stubs. When a scheduling case reaches `confirmed` / `cancelled`, call MCP **`archive_scheduling_stubs`** (`caseId`) or REST `POST /joshu/api/ea/triage/archive-stubs`. That moves linked stubs from `Triage/` → `Triage/_done/` and sets `state: done`. Patching `state: done` in place without moving is repaired by **`reconcile_triage_stubs`** (MCP) or `POST /joshu/api/ea/triage/reconcile-stubs`, which also runs after each connector sync ([`src/connectors/syncHelpers.ts`](../../src/connectors/syncHelpers.ts)).

States: `new` → ingress worker updates `Projects/` → `done` (moved to `Triage/_done/`). Morning/evening crons **do not batch-drain** stubs — they send summary emails only.

### Mail classifier + mail ingress Kanban (2026-06)

Universal ingress — one queue for all actionable mail:

| Board | Cardinality | Worker | Job |
|-------|-------------|--------|-----|
| **`ea-mail-ingress`** | 1 task per actionable email | `ea-playbook` MAIL INGRESS | File to **`project-<slug>`** → `mail_*` track → optional **`scheduling_*` child** (only when `scheduling_eligible: true`) → `kanban_complete` |
| **`ea-scheduling`** | 1+ meeting tasks | `ea-scheduling` | Calendar negotiation (spawned after filing, not at ingest) |
| **`ea-sched-ingress`** | legacy only | `ea-scheduling` | No new ingest tasks |
| **`project-<slug>`** | 1+ track cards per project | ingress / track worker | `Projects/` docs; **`blocked`** while waiting on human |

MCP: `mail_list_track_tasks`, `mail_create_track_task`, `mail_handoff_track_task` → [`triageRoutes.ts`](../../src/ea/triageRoutes.ts) `/api/ea/mail/tracks`.

### Scheduling classifier (legacy name — now part of universal classifier)

- **Model:** `JOSHU_EA_CLASSIFIER_MODEL` default `openai/gpt-5.4-nano` (same stack as Day 0 — [`src/day0/llm.ts`](../../src/day0/llm.ts), OpenRouter).
- **Observability:** Langfuse trace **`ea-mail-classifier`** (tag `joshu-app`). See [hermes-customizations — Langfuse](../hermes-customizations.md#langfuse-observability).
- **Input:** ~2k chars from the **latest** message in the mirrored thread (subject, from, body preview).
- **Output:** `disposition` (`noise` | `info` | `track`), `category` (hint, e.g. `scheduling`), `project_slug`, `is_new_track`, `reason`. Taxonomy: [mail-classifier-taxonomy.md](mail-classifier-taxonomy.md).
- **Routing:** All actionable mail → thin **Triage stub** + **`ea-mail-ingress`** Kanban task with authorization flags ([`agentAuthorization.ts`](../../src/ea/agentAuthorization.ts)). No ingest queue on **`ea-sched-ingress`** (as of 2026-06-17).

**Act vs observe:** Patrick may **file** any `track` mail. **Scheduling** (`scheduling_create_meeting_task`, calendar negotiation, `nylas_send_message` on the thread) requires **`agent_authorized: true`** — Patrick on To/CC/BCC, owner delegation in thread ("Copying Patrick…"), or mail on the agent Nylas inbox addressed to Patrick. Enforced in ingest ([`triageStub.ts`](../../src/ea/triageStub.ts)), Kanban task body, REST (`403` on scheduling create / Nylas send when unauthorized), and skills.

**Scheduling HITL defer:** `scheduling_eligible: true` means Patrick *may* schedule, not *must*. On confirmations, already-booked threads, or **any doubt**, ingress uses **file-only** or **owner-review notes** (`journal_*` section `## Scheduling — owner review needed`, `todo.md` row owned by Dan, `about.md` `owner_decisions_pending: true`) — no `scheduling_create_meeting_task`, no `find_free_slots`, no outbound mail. Owner clears these at morning review / jChat. See [`ea-playbook` v2.14+ scheduling decision gate](../../integrations/hermes/skills/executive-assistant/ea-playbook/SKILL.md).

### Scheduling (Kanban-first, 2026-06 v4.11) {#scheduling-kanban-first-2026-06-v410}

Scheduling mail is **filed via `ea-mail-ingress` first** — meeting tasks on **`ea-scheduling`** are spawned by the ingress worker when needed (`scheduling_*` MCP). Standalone cold scheduling → **`Projects/other/`**.

| Board | Cardinality | Worker | Job |
|-------|-------------|--------|-----|
| **`ea-mail-ingress`** | 1 task per actionable email | `ea-playbook` MAIL INGRESS | File to `Projects/<slug>/`, `mail_*` track, optional scheduling child |
| **`ea-scheduling`** | 1 Kanban task per meeting | `ea-scheduling` | Live Google availability → book → `kanban_block` / `kanban_complete` |
| **`ea-sched-ingress`** | **Legacy only** | `ea-scheduling` | No new ingest tasks; finish existing cards |

Skill: [`ea-scheduling` v4.19.0](../../integrations/hermes/skills/executive-assistant/ea-scheduling/SKILL.md), [`ea-playbook` v2.16.0](../../integrations/hermes/skills/executive-assistant/ea-playbook/SKILL.md).

**Flow (current):**

1. Mirror → classify → Joshu creates **Triage stub** + **`ea-mail-ingress`** task ([`mailCron.ts`](../../src/ea/mailCron.ts), [`triageStub.ts`](../../src/ea/triageStub.ts)).
2. Hermes **mail ingress** worker files project (`mail_*` MCP), updates `Projects/`, archives stub.
3. If **`scheduling_eligible: true`** — run the **scheduling decision gate** (proceed / closed / owner-review HITL). Only **proceed** calls **`scheduling_list_meeting_tasks`** (by `thread_id`) then **`scheduling_handoff_meeting_task`** or **`scheduling_create_meeting_task`** (pass **`threadId`** + **`provider`**).
4. Hermes **meeting** worker on **`ea-scheduling`** negotiates or books; `kanban_block` when waiting on others or when owner review is needed.

#### EA scheduling — dedupe layers (2026-06-23)

Three stacked mechanisms — each keyed differently. Do not conflate them.

| Layer | Key | Prevents | Does **not** prevent |
|-------|-----|----------|----------------------|
| **Ingest** ([`mailDedup.ts`](../../src/ea/mailDedup.ts)) | RFC `Message-ID` (or subject+minute+body hash) | Same physical email processed twice (Gmail + Nylas mirror of one send) | Follow-up mail on the same thread (new Message-ID — **should** process) |
| **Kanban idempotency** ([`hermes-kanban-bridge.py`](../../scripts/hermes-kanban-bridge.py)) | Per-board keys (`ea-mail-ingress-{msg}`, `ea-meet-msg-{msg}`) | Re-queuing the **same message** on the **same board** | Tasks on **different boards** (separate SQLite DBs) |
| **Meeting thread dedup** ([`schedulingCron.ts`](../../src/ea/schedulingCron.ts)) | `thread_id` on open `ea-scheduling` tasks | Second `scheduling_create_meeting_task` for the same mail thread | Competing workers on **`project-<slug>`** that never call scheduling MCP |
| **Skill handoff** ([`ea-scheduling` v4.18+](../../integrations/hermes/skills/executive-assistant/ea-scheduling/SKILL.md)) | Worker lists + matches `thread_id` | Duplicate negotiation when ingress follows skill | Project-board auto_decompose spawning parallel “Schedule call …” cards |

**Follow-up mail** (counterparty picks a time): ingest **creates a new ingress task** (correct). Ingress must **`scheduling_handoff_meeting_task`** to the existing blocked meeting — not dedupe at ingest.

#### EA scheduling — cross-board execution (2026-06-23)

**Scheduling sends and calendar negotiation run only on board `ea-scheduling`.** Workers on **`project-<slug>`** (mail tracks, auto-decomposed children, `ea-project-kanban` campaigns) file docs and update `todo.md` — they **must not** call `nylas_send_message` or `find_free_slots` for meeting negotiation.

| Symptom (UP.Labs trace, 2026-06-23) | What happened |
|-------------------------------------|---------------|
| `t_c9d81a79` on **`ea-scheduling`** + `t_4814baa5` on **`project-uplabs-role`** both tried send | Two execution lanes for one thread — Kanban idempotency is per-board |
| Duplicate worker reported “MCP unreachable” at ~120s | Action guard blocked REST up to 30 min; Hermes MCP tool call timed out first |
| One send succeeded after Telegram approve | Canonical path was **`ea-scheduling`**; close duplicate project cards with handoff comment |

**Ops:** When two workers race on the same thread, complete the non-`ea-scheduling` card with `duplicate_of: <meeting task_id>`. Only the meeting worker should wake on Jackson’s reply.

**Code safety net (2026-06-23):** `POST /api/ea/scheduling/meetings` with `threadId` returns `{ action: "existing_thread", task_id }` when an open meeting already exists for that thread. `GET …/meetings?threadId=` filters to the match.

Implementation: [`mailIngress.ts`](../../src/ea/mailIngress.ts), [`schedulingCron.ts`](../../src/ea/schedulingCron.ts), [`classifier.ts`](../../src/ea/classifier.ts). Legacy ingest path: [`schedulingIngress.ts`](../../src/ea/schedulingIngress.ts) (`forwardSchedulingMail` deprecated).

**Ingress filters:** skip agent-sent mail and stale scheduling ([`ingestFilters.ts`](../../src/ea/ingestFilters.ts), default 36h).

#### EA scheduling — board isolation (Hermes)

**Mail ingress** workers are pinned to **`ea-mail-ingress`**. They **cannot** `kanban_create` on **`ea-scheduling`** — use **`scheduling_*` MCP** (Joshu bridge with explicit `board: ea-scheduling`).

**Legacy `ea-sched-ingress` workers** (existing cards only) are pinned to **`ea-sched-ingress`** — same MCP rule. Verified on patrick (2026-06):

| What agents tried | Hermes reality |
|-------------------|----------------|
| `kanban_create` with `board: ea-scheduling` in YAML body | **No `board` param** — creates on **worker's pinned board** |
| `kanban_list(board=ea-scheduling)` | **`kanban_list` is orchestrator-only** — refused for workers |
| `hermes kanban --board ea-scheduling create` from ingress | **Still creates on pinned board** |

**Fix:** use **`mcp-joshu-connectors`** `scheduling_*` / `mail_*` tools → Joshu REST → [`hermes-kanban-bridge.py`](../../scripts/hermes-kanban-bridge.py).

#### EA scheduling — ingress handoff (replies to blocked meetings)

When a reply arrives for a meeting that is **`kanban_block`ed** waiting on someone else:

| Layer | Responsibility |
|-------|----------------|
| **Ingress worker** (legacy `ea-sched-ingress` or mail ingress scheduling child) | **`scheduling_handoff_meeting_task`** — neutral summary, append `source_path` + `ingress_handoff` to meeting body. Does **not** judge if waiting is over. |
| **Joshu** | If task was **blocked**, queue **one meeting-worker evaluation** (`evaluation_queued` — mechanical wake, not “case resolved”). |
| **Meeting worker** | Read new mail; decide: book, negotiate, or **`kanban_block`** again (e.g. “let me find a time” → stay blocked). |

Do **not** have ingress call `scheduling_unblock_meeting_task` or treat comment as “unblock waiting.”

REST: `POST /api/ea/scheduling/meetings/:taskId/handoff` — body: `sourcePath`, `messageId`, `summary`, optional `from`.

#### EA scheduling — calendar source of truth

| Use | Tool / API | Notes |
|-----|------------|-------|
| **Owner busy/free** | **`google_calendar_find_free_slots`** | **Live Composio** `GOOGLECALENDAR_FIND_FREE_SLOTS`. **Omit `items`** — Joshu defaults to `primary` + owner `personalEmail` (profile) + selected/reader Gmail calendars on the connected account. Response includes **`calendars.combined`** (union of busy) — **schedule from `combined.free`**, not `primary.free` alone. Respects transparent (Show as free) events. |
| **Event titles / transparency** | `google_calendar_list_events` | **Not** for availability — includes `blocksAvailability` (best-effort; may be null on reader calendars) |
| **Agent holds** | `nylas_list_events` | Patrick’s **coordination ledger** only — not owner truth |
| **Stale fallback** | gbrain / `connectors/calendar/google/` mirrors | Lag behind live Google; owner may edit/delete events since sync |
| **External attendees** | — | No calendar on box — email + `kanban_block` |

Owner can change their real Google calendar without updating Nylas. **Never** infer owner availability from agent Nylas, mirrors, or event titles when live Composio is connected.

**Wrong calendar scope:** `items: ["primary"]` alone checks only the work calendar (`db@project-aeon.com`). Owner meetings often live on a personal Gmail calendar (e.g. `dbenyamin@gmail.com`) — FreeBusy returns `busy: []` on primary while the personal calendar is blocked. See [`calendar-api-quirks.md`](../../integrations/hermes/skills/executive-assistant/ea-time-block/references/calendar-api-quirks.md).

REST: `GET /api/connectors/calendar/google/free-slots?date=YYYY-MM-DD&timezone=IANA` (or `timeMin` / `timeMax`; optional `items` comma-separated). Response: per-calendar `busy`/`free` plus **`calendars.combined`**. Events: `GET /api/connectors/calendar/google/events?date=...`.

#### EA scheduling — ops retry (denied send / bad slots)

When a meeting worker drafted bad availability (wrong calendar scope, wrong slots) and action guard **denied** or owner rejected the Telegram prompt — **no mail was sent** (`blocked-*` `messageId`, or audit `decision: denied`).

1. **Do not** approve stale Telegram prompts.
2. **Do not** re-send from a `project-*` board — only **`ea-scheduling`** meeting workers negotiate calendar mail.
3. Optional ops comment on the meeting task: prior send denied; use `calendars.combined.free`.
4. **Unblock** the meeting task only:
   - `POST /api/ea/scheduling/meetings/:taskId/unblock`, or
   - `hermes kanban --board ea-scheduling unblock <taskId>`
5. **Dispatch:** `hermes kanban --board ea-scheduling dispatch` (gateway also auto-dispatches ~60s).
6. Worker re-runs `google_calendar_find_free_slots`, drafts new mail → **approve** on Telegram when slots look right.

**Do not** call `scheduling_handoff_meeting_task` for a calendar-fix retry unless new mail arrived — unblock is enough.

Book on owner Google via Composio **`GOOGLECALENDAR_CREATE_EVENT`** (not `nylas_create_event` — MCP policy blocks Nylas calendar writes). Confirm via **`nylas_send_message`**.

#### EA scheduling — MCP / REST (ingress + meeting)

| Action | MCP wire name | REST |
|--------|---------------|------|
| List open meetings (incl. **blocked**; optional `threadId` filter) | `scheduling_list_meeting_tasks` | `GET /api/ea/scheduling/meetings` or `?threadId=` — each task includes `block_reason` (latest blocked event) and `recent_comments` (last 5) when listed via MCP/API |
| Create meeting (after mail ingress filing) | `scheduling_create_meeting_task` | `POST /api/ea/scheduling/meetings` — pass **`threadId`**; returns **`existing_thread`** when open meeting matches |
| **Handoff reply to meeting** | `scheduling_handoff_meeting_task` | `POST /api/ea/scheduling/meetings/:taskId/handoff` |
| Simple comment (e.g. after create) | `scheduling_comment_meeting_task` | `POST /api/ea/scheduling/meetings/:taskId/comment` |
| Manual unblock (ops) | `scheduling_unblock_meeting_task` | `POST /api/ea/scheduling/meetings/:taskId/unblock` |
| **Owner availability (live)** | `google_calendar_find_free_slots` | `GET /api/connectors/calendar/google/free-slots` |
| Event titles (not availability) | `google_calendar_list_events` | `GET /api/connectors/calendar/google/events` |
| Agent ledger | `nylas_list_events` | `GET /api/nylas/events` |
| Book on owner calendar | Composio `GOOGLECALENDAR_CREATE_EVENT` | Composio MCP |
| Mail | `nylas_send_message`, … | `/api/nylas/…` |

Hermes exposes prefixed names: `mcp_joshu_connectors_<tool>`. See [`docs/connectors.md`](../connectors.md#connectors-mcp-http-8795).

**Legacy JSONL ingress** (deprecated): `GET /api/ea/scheduling/ingress`, `scheduling_ingress_pending`, `mark_scheduling_ingress_processed`. Replaced by universal **`ea-mail-ingress`** (2026-06-17).

**Legacy MD stubs:** `archive_scheduling_stubs`, `reconcile_triage_stubs`.

### Scheduling cases (legacy MD — deprecated)

<details>
<summary>Old coordination unit — do not create new cases</summary>

Path: `Projects/<slug>/scheduling/<case-id>.md` — replaced by Kanban meeting tasks. Open legacy cases remain readable for stub archival.

</details>

### Scheduling cron behavior

- Meeting worker: **`google_calendar_find_free_slots`** for owner availability (FreeBusy — respects Google **Show as free** / transparent events), then book on owner Google via Composio **`GOOGLECALENDAR_CREATE_EVENT`**, mail via **`nylas_send_message`**.
- **Agent calendar = coordination ledger** — read-only on Nylas for holds Patrick placed. **Owner availability = live FreeBusy** (`google_calendar_find_free_slots`), not `list_events` titles, Nylas, or mirrors ([Calendar source of truth](#ea-scheduling--calendar-source-of-truth)).
- Kanban task body includes injected owner profile (timezone, emails) — do not read `.joshu` under `${JOSHU_FILES_ROOT}`.
- Send email from **agent Nylas** mailbox (proposals, confirmations).
- Update case state + `Projects/<slug>/todo.md` Waiting on.
- Patch stub `scheduling_queued: true`, `scheduling_case_id` when handler queued.
- On terminal state: agent calls **`archive_scheduling_stubs`** (not in-place `state: done` only). Sync reconcile catches stragglers.

**Hermes bridge:** one-shot jobs must pass **`repeat` as an integer** (`repeat: 1`), not `{ times: 1 }`. The Python bridge (`scripts/hermes-cron-bridge.py`) normalizes both; [`src/ea/schedulingCron.ts`](../../src/ea/schedulingCron.ts) sends `repeat: 1`. Wrong shape logs `[ea-scheduling] cron create failed: '<=' not supported between instances of 'dict' and 'int'`.

**Nylas routes (agent only)** — use Joshu REST under `/joshu/api/nylas/` (see [`docs/nylas-agent-mailbox.md`](../nylas-agent-mailbox.md)):

| Action | Method | Path | Required body fields |
|--------|--------|------|----------------------|
| List events | `GET` | `/events` | **`date` + `timezone`** (preferred) **or** unix `start` / `end` query params |
| Create event | `POST` | `/events` | `title` + (**`date`, `startLocal`, `endLocal`, `timezone`** preferred **or** `startTime`, `endTime` epochs) + optional `description`, `location`, **`participants`**, `notifyParticipants` |
| Update event | `PATCH` | `/events/:id` | `eventId` in path; same local-slot or epoch fields as create |
| Delete event | `DELETE` | `/events/:id` | `eventId` in path |
| Send confirmation | `POST` | `/messages/send` | `to` (string or array), `subject`, `body`; optional **`cc`**, **`bcc`**, `replyToMessageId` — **not** comma-separated `to` |
| Update profile | `POST` | `/profile` | e.g. `timezone`, `primaryWorkEmail` — persist after TZ resolved ([`src/nylas/profile.ts`](../../src/nylas/profile.ts)) |
| Archive scheduling stubs | `POST` | `/ea/triage/archive-stubs` | `caseId` or `caseRelativePath` (terminal case only) |
| Reconcile triage stubs | `POST` | `/ea/triage/reconcile-stubs` | (no body) — move `state: done` + terminal-case stubs to `_done/` |

Local-slot conversion: [`src/nylas/localSlot.ts`](../../src/nylas/localSlot.ts) (`@js-temporal/polyfill`). Agents pass wall-clock times; Joshu converts to epochs server-side — no Python/terminal math in Hermes.

**Not exposed:** `/nylas/calendars`, `/nylas/events/create`, `/nylas/events/delete`, bare `/nylas/` — agents probing these get **404** in container logs (harmless trial-and-error).

---

## Phase 2 — Hermes crons (skill-backed)

Use [Hermes skill-backed cron jobs](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron#skill-backed-cron-jobs). **No midday window.**

Installed on Welcome complete ([`src/onboarding/eaCronJobs.ts`](../../src/onboarding/eaCronJobs.ts)) as [Hermes skill-backed crons](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron#skill-backed-cron-jobs): `skills: ["ea-playbook"]`, `deliver: local`.

| Job name | Schedule | Skill | Purpose |
|----------|----------|-------|---------|
| `EA morning` | `workingHoursStart` weekdays | `ea-playbook` → **`ea-morning-review`** | Prep `Planning/daily-review-*.md` + **pointer email**; owner completes plan in jChat ("morning review") |
| `EA evening` | `workingHoursEnd` weekdays | `ea-playbook` → **`ea-shutdown`** | Draft shutdown section + journals + **evening pointer**; owner confirms in jChat ("shutdown") |
| `EA weekly` | Friday `workingHoursStart` | `ea-playbook` | Project hygiene + summary |
| `EA scheduling` | Kanban (`ea-scheduling` board) | `ea-scheduling` | Meeting tasks (spawned after mail ingress filing) |
| **Project Kanban** | On demand (jChat) | `ea-project-kanban` | User-initiated multi-step / HITL on `project-<slug>` boards |

**Trigger model:** a `Triage/*.stub.md` (`state: new`) means “process this message into the right project docs.” **Multi-step / HITL** work from the user → **`ea-project-kanban`** (Kanban board), not rows in `todo.md` alone.

### EA skills in jChat (catalog → `skill_view`)

Hermes injects a short **skills index** (`<available_skills>`) into the system prompt every turn. Only the `description:` frontmatter line appears there — Hermes truncates anything over **60 characters**. Full procedures load only after **`skill_view(name)`** (model choice; not automatic). See [hermes-customizations — Skill catalog](../hermes-customizations.md#skill-catalog-descriptions-and-skill_view).

| User / ingest signal | Load this skill |
|----------------------|-----------------|
| Morning/evening cron, triage stub, inbox rollup | `ea-playbook` |
| **`EA morning` prep** (cron) / **"morning review"** in jChat | **`ea-morning-review`** (via `skill_view` from playbook cron prompt) |
| **`EA evening` prep** (cron) / **"shutdown"** in jChat | **`ea-shutdown`** |
| **"time block today"**, after morning review | **`ea-time-block`** |
| **`ea-mail-ingress` Kanban task** (mail filing) | **`ea-playbook`** — **MAIL INGRESS** section (`skill_view` required) |
| Drip/outreach, multi-step project, HITL, Kanban | `ea-project-kanban` |
| Meeting negotiation (child on `ea-scheduling` after filing) | `ea-scheduling` |
| Mail/file find, search, recall, Composio live Gmail | `joshu-mail` |
| Desktop files (non-mail) | `joshu-brain` |

**Mail ingress compliance:** Ingress workers must **`skill_view("ea-playbook")`** and follow **MAIL INGRESS** — file `Projects/<slug>/`, `mail_*` track, optional `scheduling_*` child. Do **not** load `ea-project-kanban` or scaffold full project kickoff for routine mail (UP.Labs trace `f670cfae…`, 2026-06-16).

Crons pin `ea-playbook` at job start; **on-demand jChat** work (e.g. “start a drip campaign”) must still trigger `skill_view("ea-project-kanban")` when the task type changes mid-session.

### Triage drain (morning & evening)

Avoid race with ingest:

1. List `Triage/*.stub.md` with `state: new`.
2. Write snapshot manifest: `Triage/_snapshots/YYYY-MM-DDTHH-mm-ss.json` (list of stub paths).
3. Process **only** stubs in snapshot; set `state: processing` at start, `done` when filed.
4. Ingest may add new stubs during run; they wait for the next window.

Per stub: read `source_path` → assign/update `Projects/<slug>/` (existing or new) → update `todo.md` → append/project `journal_*.md` → mark done.

### Summary email

Cron jobs still write to `Projects/_system/summary-email.md` and send via Nylas, but **morning/evening are pointer emails** — not standalone 500-word briefs. Full structure is fallback (weekly or prep failure); see **`ea-playbook`** Summary email and **`ea-morning-review`** / **`ea-shutdown`**.

| Window | Email role | Interactive follow-up |
|--------|------------|------------------------|
| **Morning** | Link to `Planning/daily-review-YYYY-MM-DD.md` + today's time block; condensed calendar/mail/scheduling | jChat: **"morning review"** → checkboxes → **`ea-time-block`** |
| **Evening** | Link to daily-review shutdown draft + journals summary | jChat: **"shutdown"** → confirm planned vs actual |

- **From:** agent Nylas mailbox. **To:** owner `primaryWorkEmail` (Gmail) from Welcome `profile.json`.
- **API:** `POST /joshu/api/nylas/messages/send` (Hermes tool `mcp_joshu_connectors_nylas_send_message` / MCP wire name `nylas_send_message`). **Action guard runs on the REST route** — agents must use the MCP tool; `execute_code` / `curl` to REST is gated the same way. Signature is appended server-side — do not include signature HTML in the tool `body`.

If the send step fails with `Unknown tool: mcp_joshu_connectors_nylas_send_message` in Langfuse, the composed brief may never be delivered — check connectors MCP health (`:8795`), not the email body. See [`docs/connectors.md`](../connectors.md#troubleshooting-unknown-tool-mcp_joshu_connectors_) and [`troubleshooting-and-lessons.md`](../vps-sandbox/troubleshooting-and-lessons.md#connectors-mcp-unknown-tool-ea-summary-send).

---

## Project lifecycle

### Create a project when

- Day 0 / Welcome names an active priority (seed folder + `about.md`).
- Triage drain: item needs outcome + deadline and does not fit an existing slug (Hermes decides).
- Owner or agent explicitly starts one in chat.

### `about.md` (required)

```markdown
---
title: "…"
urgency: 3
importance: 2
status: active
someday_review: null
owner_decisions_pending: false
---

One-paragraph outcome. Deadline: YYYY-MM-DD. Constraints: …
```

- **status:** `active` | `someday` | `reference` | `done` — lifecycle in frontmatter, **not** separate Reference/Someday/Current folders. Only **`done`** → move folder to `_archive/`.
- **someday_review:** optional `YYYY-MM-DD`; weekly cron scans these.
- **urgency / importance:** 1 = highest, 5 = lowest.
- **Updates:** Hermes during filing or on-demand; not the ingest poller.

### `todo.md` (required)

Markdown table — **waiting** and **blocker** are first-class:

| Task | Owner | Due | Waiting on | Blocker | Status |
|------|-------|-----|------------|---------|--------|
| … | agent/principal | YYYY-MM-DD | person name or — | non-person constraint or — | open/done |

- **Waiting on:** person external (vendor, principal, teammate).
- **Blocker:** non-person (approval, budget, system, missing doc).
- **Links:** when filing mail, add a pointer to `source_path` (`joshu://connectors/mail/…` or relative path) — do not paste thread bodies. See [`gtd-workspace-linking.md`](gtd-workspace-linking.md).

### `journal_YYYY-MM-DD.md`

Append-only day log for that project. Evening cron creates/extends today’s file.

### `Projects/other`

- Default bucket when slug unclear.
- **Weekly cron:** merge duplicates, promote to named project, or archive noise.

### Archive

- Project `status: done` in `about.md` → move folder to `Projects/_archive/<slug>/`.
- Stubs `done` → delete or `Triage/_done/`.

### `Planning/capture-YYYY-MM-DD.md`

Intraday inbox for **non-email** owner input (jChat riff, dictation, random items). Sections: **Tasks**, **Ideas**. Agents append here first, then clarify into `Projects/*/todo.md` with links. Unlike mail, chat has **no Triage stub** — Hindsight holds conversation context; this file is the durable capture surface before filing.

### `Planning/daily-review-YYYY-MM-DD.md`

Day handoff between yesterday and today. **Checkboxes are source of truth** for done/carryover; one `time-block-*.excalidraw` per day is the visual record (history accumulates in `Planning/`).

| Phase | Skill | Owner action |
|-------|-------|--------------|
| Evening prep | `ea-shutdown` (cron) | — |
| Evening close | `ea-shutdown` (interactive) | jChat: "shutdown" |
| Morning prep | `ea-morning-review` (cron) | Pointer email |
| Morning commit | `ea-morning-review` (interactive) | jChat: "morning review" → `ea-time-block` |

See [`time-block-planning.md`](time-block-planning.md).

### Linking (human + platform)

| Consumer | Mechanism |
|----------|-----------|
| Human click (daily plan) | `joshu://` on Excalidraw blocks — [`time-block-planning.md`](time-block-planning.md) |
| Agent recall | gbrain `query`, `get_backlinks`, `traverse_graph` over linked markdown |
| Mail queue | Triage stub `source_path` → connector mirror |
| Multi-step execution | `about.md` → `kanban_board` |

Full conventions: [`gtd-workspace-linking.md`](gtd-workspace-linking.md).

---

## Welcome & Day 0 seeding

| Step | Seeds |
|------|--------|
| **Day 0** (optional, Gmail connected) | Infer project names from mail → create `Projects/<slug>/about.md` drafts; do **not** bulk-create stubs for old mail |
| **Welcome complete** | `profile.json`, working hours, `Projects/_system/summary-email.md`, one folder per big-picture priority (+ `other/`), install crons (no midday), write `workspace/.joshu-ea-version` |

Remove legacy writes to `workspace/TOOLS.md`, `client-profile.md` as separate canon — fold into `profile.json` + per-project `about.md` (implementation detail).

---

## Versioning

| Artifact | Version source |
|----------|----------------|
| Hermes skill `ea-playbook` | `deploy/RELEASE.json` / image tag at provision |
| Factory templates | `factory/manifest.yaml` `release` |
| Per-box EA layout | `workspace/.joshu-ea-version` — e.g. `ea-layout: 2.0.0` written on factory-apply / Welcome |

Do **not** embed git hashes inside every markdown file; one manifest is enough for support/debug.

---

## Migration from v1 (current boxes)

1. Stop seeding PARA workspace templates; add `FILING.md`, `Triage/`, `Projects/` layout.
2. Replace `ea-playbook` read list with: drain snapshot rules + `Projects/*/about.md` + `todo.md`.
3. `eaCronJobs`: drop midday job; update morning/evening prompts.
4. Ingest: add stub writer + scheduling classifier after mirror.
5. One-time: optional script to archive old `workspace/` to `Projects/_archive/workspace-v1/`.

---

## Hermes skills (split)

| Skill | Role |
|-------|------|
| **`ea-playbook`** | Triage drain, Projects, capture, weekly review, link discipline — [`gtd-workspace-linking.md`](gtd-workspace-linking.md) |
| **`ea-morning-review`** | Morning prep + interactive yesterday→today handoff (`Planning/daily-review-*.md`) |
| **`ea-shutdown`** | Evening shutdown draft + interactive close |
| **`ea-scheduling`** | One-shot scheduling email → calendar + Nylas confirm |
| **`ea-time-block`** | On-demand Cal Newport time-block Excalidraw in `Planning/` — gather script + render ([time-block-planning.md](time-block-planning.md)) |
| **`excalidraw`** | Bundled Hermes diagram JSON skill (`skill_view` reference for `ea-time-block`; layout via render script) |
| **`joshu-brain`** | Mail search/recall on existing mirrors (no sync) |

Connector **sync** is Joshu `src/connectors/scheduler.ts` (10m) — not invoked from Hermes skills.

---

## Operations & logs

### Connector health (source of truth)

Do not infer Nylas/Gmail sync health from raw HTTP access lines in `docker logs`. Use:

```bash
curl -fsS http://127.0.0.1:8788/joshu/api/connectors/status | jq '.nylas.sync, .gmail.accounts[].sync'
```

Expect `lastSyncAt` advancing every ~10m, no persistent `lastError`, and `mirror.threadCount` > 0 when mail exists.

### What shows up in `docker logs` (patrick-style)

| Log line | Meaning |
|----------|---------|
| `[triage] archived N stub(s) for terminal scheduling cases` | Reconcile moved stubs to `Triage/_done/` (sync or API) |
| `[ea-scheduling] case=… action=queued` | Kanban task created on `ea-scheduling` board |
| `[ea-scheduling] case=… action=unblocked` | Follow-up mail unblocked existing Kanban task |
| `[ea-scheduling] case=… action=skipped reason=debounce` | Debounced re-queue (normal) |
| `[ea-scheduling] cron create failed: … dict … int` | Bad `repeat` shape — fixed in `schedulingCron.ts` + bridge |
| `[nylas] events.list failed: … null … length` | Nylas SDK hiccup on agent calendar list; **caught** — mail sync still OK; calendar mirror may be empty for that call ([`nylas-agent-mailbox.md`](../nylas-agent-mailbox.md#troubleshooting)) |
| `GET/POST /joshu/api/nylas/… 400` | Hermes **`ea-scheduling`** sent incomplete JSON (missing `title`/`startTime`/`endTime` or `to`/`subject`/`body`) — often retries until **200** |
| `GET/POST /joshu/api/nylas/… 404` | Wrong path (e.g. `/events/create`) — not a connector outage |
| `[connectors-cron] scheduler started` | Joshu-native poll loop; per-run failures surface as `lastError` in status API, not always as `[nylas]` lines |

**Security:** the narrow grep `ea-scheduling|gbrain|PGLite` does **not** show login brute force. ArozOS auth failures log as `login request rejected` / `Too many request`; SSH attempts are on the **host**, not in `joshu-stack` logs.

### Classifier / OpenRouter steady state

Incremental cron should **not** re-classify unchanged threads:

| Condition | Behavior |
|-----------|----------|
| `message_ids` unchanged | Skip mirror rewrite entirely (no stub, no classifier) |
| `message_ids` changed but **`external_id`** (latest message) unchanged | Mirror may rewrite (e.g. Nylas backfill of older messages) — **classifier skipped** via `priorLatestMessageId` |
| New latest message (`external_id` changed) | Classifier runs on latest-message preview |

One-time deploy after Nylas thread hydration may spike mirror writes and gbrain reindex without new OpenRouter calls if latest messages did not change. Spikes with new classifier traces usually mean full sync, wrong thread ids, or genuinely new mail. See [`docs/connectors.md`](../connectors.md) and [`troubleshooting-and-lessons.md`](../vps-sandbox/troubleshooting-and-lessons.md).

### EA scheduling — lessons from traces (2026-06)

| Symptom | Root cause | Fix |
|---------|------------|-----|
| Ingress worker scaffolds project kickoff (`about.md`, SQLite kanban) instead of filing mail | Never **`skill_view("ea-playbook")`**; loaded **`ea-project-kanban`** | MAIL INGRESS: file stub → `mail_*` track → optional scheduling child |
| Ingress uses Composio search instead of **`mail_*` MCP** | Skill not loaded; improvised tools | **`skill_view("ea-playbook")`** first; use connectors MCP |
| 6× **`list_events`** for availability | Skill bypass / wrong tool; MCP described `list_events` as busy/free source | **`google_calendar_find_free_slots`** (ea-scheduling v4.11+) |
| Asteme / “Show as free” blocks treated as busy | Agent inferred from `list_events` titles; claimed FreeBusy matched titles | **`google_calendar_find_free_slots`** — transparent events absent from `busy[]`; do not use titles |
| “Owner free” but slot conflicts | Checked **Nylas**, **list_events**, or stale mirrors only | **`google_calendar_find_free_slots`** (live FreeBusy) |
| **3pm offered while Asteme wrap busy** (Ebony 2026-06-24) | `find_free_slots` with **`items: ["primary"]` only** — events on personal Gmail calendar invisible to FreeBusy | **Omit `items`** or include personal Gmail; schedule from **`calendars.combined.free`** (ea-scheduling v4.19+, `calendarAvailability.ts`) |
| Worker comment says “sent availability” but mail never arrived | Action guard **denied** or `blocked-*` messageId | Check action-guard audit; **ops retry** ([ops retry](#ea-scheduling--ops-retry-denied-send--bad-slots)) — do not trust kanban comment alone |
| Meeting tasks never appear on **`ea-scheduling`**; only ingress cards | Ingress used `kanban_create` / CLI — Hermes pins worker to ingress board | **`scheduling_*` MCP** via Joshu bridge ([Board isolation](#ea-scheduling--board-isolation-hermes)) |
| Skill told `kanban_list(board=…)` | `kanban_list` orchestrator-only for workers | **`scheduling_list_meeting_tasks`** |
| `scheduling_list_meeting_tasks` returns **empty** but blocked task visible on board | List filtered on `kind: meeting`; meeting worker bodies omit that after `kanban_block` | List all on `ea-scheduling` except `kind: ingress` ([`schedulingCron.ts`](../../src/ea/schedulingCron.ts)) |
| Reply matched but **no meeting worker** | Comment alone does not wake blocked tasks | **`scheduling_handoff_meeting_task`** → Joshu `evaluation_queued` ([Handoff](#ea-scheduling--ingress-handoff-replies-to-blocked-meetings)) |
| Ingress “unblocked” vague reply (“let me find a time”) | Auto-unblock treated reply as resolved | Meeting worker **re-`kanban_block`s**; ingress stays neutral |
| Duplicate ingress for one email | Nylas + Gmail sync → different `messageId` | **RFC `Message-ID` dedup** ([`mailDedup.ts`](../../src/ea/mailDedup.ts)); `npm run test:mail-dedup` |
| Stubs stuck in `Triage/` after `confirmed` | Agent patched `state: done` in place | **`archive_scheduling_stubs`** / **`reconcile_triage_stubs`** |
| `POST …/messages/send 400` with comma `to` | Comma-separated `to` rejected | **`to`** + **`cc`** array ([`src/nylas/recipients.ts`](../../src/nylas/recipients.ts)) |
| Wrong calendar year in `list_events` | Hand-computed epochs | **`date` + `timezone`** — server converts |
| `timezone: MISSING` on Kanban body | Profile not persisted | **`nylas_update_profile({ timezone })`** |
| Langfuse: ingress OK but scheduling board empty | Trace success ≠ correct board — verify with bridge/list API | `GET /api/ea/scheduling/meetings` or kanban UI on **`ea-scheduling`** |
| **Two workers send on same thread** (UP.Labs 2026-06-23) | **`ea-scheduling`** meeting task + **`project-<slug>`** auto_decompose card both called `nylas_send_message` | Only **`ea-scheduling`** sends; complete duplicate project card; see [Cross-board execution](#ea-scheduling--cross-board-execution-2026-06-23) |
| Worker says “MCP down” on `nylas_send_message` at ~120s | Action guard holds REST up to 30 min; Hermes **per-tool** timeout ~120s — not connectors failure | `kanban_block(reason="awaiting owner approval")`; run **`connectors_status`** before claiming MCP down — see [connectors.md — Action guard timeout](../connectors.md#action-guard-mcp-tool-timeout-vs-approval-wait) |
| **`503 action_guard_telegram_not_linked`** crashed Joshu (legacy) | `notifyOwnerForApproval` threw when Telegram unlinked | Fixed 2026-06-23: REST returns **503**, Joshu stays up — link bot with `/start` |
| Connectors MCP “healthy” but tools return HTML 404 | **`JOSHU_CONNECTORS_API_BASE`** pointed at ArozOS `:8787` instead of Joshu `:8788` | Set `http://127.0.0.1:8788/joshu` in `~/.hermes/.env`; start script warns on `:8787` — see [connectors.md](../connectors.md#joshu-connectors-api-base-local-dev) |

**Deterministic app traces** (classifier, not Hermes): Langfuse tag **`joshu-app`**, trace name **`ea-mail-classifier`**. Ingress queue logs: `[ea-mail] ingress action=created task=… message=…`. Meeting thread dedup log: `[ea-scheduling] meeting thread dedup thread=… task=…`.

**Gmail drafts:** connector sync does **not** fetch `DRAFT` label — only `INBOX` (cron), or `INBOX`+`SENT`+`IMPORTANT` (Day 0 `allMail`). See [Mail ingest labels](#mail-ingest-labels-gmail).

Skill reference: [`ea-scheduling` v4.19.0](../../integrations/hermes/skills/executive-assistant/ea-scheduling/SKILL.md), [`ea-playbook` v2.16.0](../../integrations/hermes/skills/executive-assistant/ea-playbook/SKILL.md).

#### Mail ingest labels (Gmail)

| Mode | Labels |
|------|--------|
| 10m incremental cron | `INBOX` (+ Gmail history for touched threads) |
| Day 0 / `allMail` full | `INBOX`, `SENT`, `IMPORTANT` |
| **Not synced** | **`DRAFT`**, SPAM/TRASH (filtered via [`gmailJunk.ts`](../../src/ea/gmailJunk.ts)) |

---

## Related code (today)

| Piece | Path |
|-------|------|
| Mail mirror | [`src/connectors/mirror.ts`](../../src/connectors/mirror.ts) |
| LLM body preview (latest message) | [`src/connectors/mirrorBodyPreview.ts`](../../src/connectors/mirrorBodyPreview.ts) |
| Nylas mirror format | [`src/connectors/nylasMirrorFormat.ts`](../../src/connectors/nylasMirrorFormat.ts) |
| Nylas threads + hydration | [`src/nylas/client.ts`](../../src/nylas/client.ts) (`listThreads`, `fetchMessagesInThread`) |
| Poll scheduler | [`src/connectors/scheduler.ts`](../../src/connectors/scheduler.ts) |
| Sync → stub reconcile | [`src/connectors/syncHelpers.ts`](../../src/connectors/syncHelpers.ts) |
| Scheduling case + queue | [`src/ea/schedulingCase.ts`](../../src/ea/schedulingCase.ts), [`src/ea/schedulingCron.ts`](../../src/ea/schedulingCron.ts) |
| Triage stub ingest | [`src/ea/triageStub.ts`](../../src/ea/triageStub.ts), [`src/ea/triageStubFiles.ts`](../../src/ea/triageStubFiles.ts), [`src/ea/triageSchedulingBridge.ts`](../../src/ea/triageSchedulingBridge.ts), [`src/ea/triageTypes.ts`](../../src/ea/triageTypes.ts) |
| Triage archive API | [`src/ea/triageRoutes.ts`](../../src/ea/triageRoutes.ts) |
| Classifier | [`src/ea/classifier.ts`](../../src/ea/classifier.ts) |
| Ingest filters (agent / stale scheduling) | [`src/ea/ingestFilters.ts`](../../src/ea/ingestFilters.ts) |
| Nylas local slots + recipients | [`src/nylas/localSlot.ts`](../../src/nylas/localSlot.ts), [`src/nylas/recipients.ts`](../../src/nylas/recipients.ts) |
| Connectors MCP (EA tools) | [`scripts/joshu-connectors-mcp-http-server.mjs`](../../scripts/joshu-connectors-mcp-http-server.mjs) |
| MCP supervisor + health probes | [`src/mcpSupervisor.ts`](../../src/mcpSupervisor.ts), [`src/mcpDependencyHealth.ts`](../../src/mcpDependencyHealth.ts) |
| Action guard (Nylas send gate) | [`src/actionGuard/`](../../src/actionGuard/) |
| Mail dedup + meeting thread dedup | [`src/ea/mailDedup.ts`](../../src/ea/mailDedup.ts), [`src/ea/schedulingCron.ts`](../../src/ea/schedulingCron.ts) |
| Cron install | [`src/onboarding/eaCronJobs.ts`](../../src/onboarding/eaCronJobs.ts) |
| Cheap LLM | [`src/day0/llm.ts`](../../src/day0/llm.ts) (`JOSHU_DAY0_MODEL` / nano) |
| Factory seeds | [`factory/manifest.yaml`](../../factory/manifest.yaml) |
