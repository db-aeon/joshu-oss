# Executive Assistant (EA v2)

Generic guide to the Joshu **Executive Assistant** layout: GTD-style workspace, mail triage, scheduling, time blocking, and daily handoff. Identity (companion name, owner email) comes from **Welcome onboarding**, `identity.json`, and `instance.env` — never hardcoded in skills.

## Workspace layout

Factory seeds `templates/ea/` on first boot (`factory/manifest.yaml`):

```text
{files_root}/
  Triage/           # Mail stubs (work queue)
  Projects/         # Active work (about.md, todo.md, journal)
  Planning/         # Time-block diagrams + daily review
  Resources/        # Key contacts, reference
```

See [`templates/ea/FILING.md`](../templates/ea/FILING.md) for filing rules the companion follows.

## GTD mapping

| GTD bucket | Joshu path | Hermes skill |
|------------|------------|--------------|
| Inbox | `Triage/` + mail mirrors | `ea-playbook` |
| Next actions | `Projects/<slug>/todo.md` | `ea-playbook` |
| Multi-step / HITL | Kanban + project board | `ea-project-kanban` |
| Calendar / meetings | Live Google/Nylas + scheduling tasks | `ea-scheduling` |
| Owner→agent asks | Ready Kanban on `ea-owner-reply` | `ea-owner-reply` |
| Setup board (profile, mobile, work Gmail, calendar, setup tips) | Kanban on `ea-onboarding` | `ea-onboarding` |
| Daily plan | `Planning/time-block-*.excalidraw` | `ea-time-block` |
| Morning / shutdown | `Planning/daily-review-*.md` | `ea-morning-review`, `ea-shutdown` |
| Proactive owner nudges | `proactive/state.json` in the Joshu state folder (`JOSHU_STATE_DIR`) + Kanban blocked tasks | `joshu-proactive` (compose/reply/hygiene/evolve); hourly tick localhost-only; **owner nudge replies use a dedicated Hermes session** `proactive:resolve:<taskId>` (not SMS history) with Resolve context; **`ea-onboarding`** cards excluded from hygiene auto-close |

**Rule:** one canonical file per artifact; link elsewhere. Mail bodies stay in `connectors/mail/` mirrors — do not duplicate into project files.

**Project lifecycle:** `Projects/<slug>/` (`about.md` `status`) is the unit that can be “over.” `mail_track` cards are waiting-on attachments. After mail file/handoff, or when the owner reports an outcome on SMS/jChat/voice, **Project reconcile** (ea-playbook) gets the compact track list of that slug (title, status, thread ids, and latest handoff summary of each open track, without the task bodies) and completes the tracks that the signal supersedes. After a handoff wakes the worker of a track, that worker runs Project reconcile, and the ingress worker skips it. Hourly nudges skip projects whose `about.md` status is not `active`.

## Identity at runtime

Skills must use live profile data, not example names:

| Need | Source |
|------|--------|
| Companion name | `identity.json` → `name`, or `JOSHU_NAME` |
| Owner display name | `identity.json` → `owner.displayName` |
| Owner work email | `JOSHU_OWNER_EMAIL`, Nylas `primaryWorkEmail` |
| Agent mailbox | Nylas agent grant / `nylas_get_profile` |
| Personal calendar | Connected Gmail calendars from profile |

## Onboarding

Day-1 setup: [`welcome-onboarding.md`](welcome-onboarding.md) — Welcome wizard seeds project folders and Hermes crons.

**Setup board after Welcome:** each required setup step that is not done (owner profile, owner mobile, work Gmail, calendar) is a blocked card on Kanban board **`ea-onboarding`**, with a how-to in the card body. Optional setup tips are cards too, without reminders. The steps are in [`factory/onboarding-prompts.yaml`](../factory/onboarding-prompts.yaml). The owner hears about open required steps through the hourly proactive nudge (email when no SMS on file) and through the setup mention, once a day on each channel. Each setup step lists its check and its how-to in that file.

Optional mail analysis: `day0-cold-start.md` — run **Analyze mail for setup (Day 0)** in Connectors after Gmail is connected.

## Time blocking

Cal Newport-style daily planning on **jWhiteboard**:

- Gather: `scripts/gather-time-block-input.mjs`
- Render: `scripts/render-time-block-excalidraw.mjs`
- Docs: [`excalidraw-sandbox.md`](excalidraw-sandbox.md)

On VPS, run scripts at `/opt/joshu/scripts/…` (not relative to Hermes Desktop cwd).

Full product / Kanban / scheduling / time-block SOP: [`hermes-integration.md`](hermes-integration.md) · [`excalidraw-sandbox.md`](excalidraw-sandbox.md).

## Mail and connectors

- Agent inbox: [`nylas-agent-mailbox.md`](nylas-agent-mailbox.md)
- Owner Gmail + sync: [`connectors.md`](connectors.md)
- Mail search skill order: [`integrations/hermes/skills/mail/joshu-mail/SKILL.md`](../integrations/hermes/skills/mail/joshu-mail/SKILL.md)

**Classifier guard (owner→agent):** ingest classifies a **quote-stripped latest message** (not the full quoted thread). Substantive owner mail on the agent Nylas inbox is forced to **`track` / `owner_note`** — never silently archived as `info` or left as `owner_sent_update` (includes thread replies with DONE/KEEP status). Pure one-line acks (Thanks, OK) may stay `info`. See [`ownerAgentInboxMail.ts`](../src/ea/ownerAgentInboxMail.ts) and [`biasOwnerAgentInboxClassification`](../src/ea/classifier.ts). **Counterparty threads** (owner emails an external party with the agent CC'd) take **scheduling path A**, not owner-reply path D — see coordination scope below.

## Coordination scope (2026-09)

One owner-facing **ask** (schedule with Michael, invite myself, etc.) must not spawn parallel workers on `ea-scheduling` and `ea-owner-reply`. **Coordination scope** mutexes spawns across boards and mail provider thread aliases (Gmail vs Nylas RFC Message-ID).

| Need | Tool / API |
|------|------------|
| Resolve scope before spawn | MCP **`coordination_scope_resolve`** or **`coordination_list_active`** |
| REST debug | `GET /joshu/api/coordination/scope?channel=mail&threadId=…&sourcePath=…` |
| Conflict on create | `scheduling_create_meeting_task` / `owner_reply_create_task` return `action: existing_coordination` |

Mail is **phase 1**. SMS / Slack / voice will plug into the same layer ([`src/coordination/`](../src/coordination/)). Fleet SOP: [`hermes-integration.md`](hermes-integration.md#coordination-scope-multi-channel-2026-09).

Tests: `npm run test:coordination-scope` · `npm run test:owner-reply` · `npm run test:nylas-attachments`.

**Owner-reply deliverables:** when the ask produces a file (`.pptx`, `.pdf`, …), attach it via `nylas_send_message` **`attachments`** (Desktop-relative paths) — do not paste long filesystem paths in the email body. See [nylas-agent-mailbox.md — Outbound attachments](nylas-agent-mailbox.md#outbound-attachments).

## Proactive owner nudges (2026-09)

Hourly sweep (`POST /api/proactive/tick`, localhost-only) picks owner questions and sends SMS/email nudges (1/day default). An owner question is a blocked Kanban task with block kind `needs_input`; the text of the block reason does not count. After **`mail_handoff_track_task`** adds an email to a blocked track, Joshu unblocks the track. The worker of the track reads the email and completes the track, blocks it with `kind: needs_input` when the owner must decide or act, or blocks it without a kind when it waits on an external party. Joshu does not judge the words of the email. Terms: `openspec/glossary.md`. Spec: `owner-nudge`.

Owner replies route through [`resolveOwnerReply.ts`](../src/proactive/resolveOwnerReply.ts):

| Piece | Behavior |
|-------|----------|
| Resolve session | `proactive:resolve:<taskId>` — isolated from SMS/jChat history |
| SMS idle | Owner chat uses `sms:<e164>:<epoch>` rotated after `JOSHU_HERMES_MESSAGING_IDLE_MINUTES` ([`twilioSmsSession.ts`](../src/twilioSmsSession.ts)) |
| Project → scheduling | Fallback + resolve prompt: wake linked `ea-scheduling` tasks via [`schedulingHandoff.ts`](../src/proactive/schedulingHandoff.ts) when owner approves on a project track |
| Ops unblock | `POST /joshu/api/ea/scheduling/meetings/:taskId/unblock` (localhost) |
| **Project reconcile** | ea-playbook: after mail or owner outcome, close sibling tracks on the same slug; `about.md` `status: done` when nothing is left waiting |
| **Daily hygiene** | MCP `proactive_hygiene_prepare` → per-card agent review → `proactive_hygiene_record`; ambiguous cards → hourly `stale_review` nudges |
| **Cross-board Kanban** | [`crossBoardKanban.ts`](../src/proactive/crossBoardKanban.ts) — all boards on this box (not multi-box) |
| **Meeting blackout** | Hourly tick skips nudges when Google Calendar FreeBusy shows owner in a busy block (+ 5 min pre-buffer) |
| **Cadence hints** | Every nudge/stale_review includes MORE/LESS/USEFUL line (deterministic append if Hermes compose omits it) |
| **Inactive projects** | Hourly tick skips `mail_track` when `Projects/<slug>/about.md` `status` is not `active` |

Skill: [`joshu-proactive`](../integrations/hermes/skills/proactive/joshu-proactive/SKILL.md). Tests: `npm run test:proactive`.

**Fleet ops:** Proactive has **three install surfaces** — do not assume image pull enables everything. See troubleshooting — Proactive fleet rollout.

| Surface | Backfill |
|---------|----------|
| Nudge API | `upgrade-fleet-box-image.sh` |
| Hermes crons | `repair-fleet-ea-cron-timezone.sh` → `resync-ea-crons` |
| `joshu-proactive` skill | `upgrade-fleet-box-image.sh` (skills seed at the first start after the recreate) |

Owner **nudges** use API compose (no skill file). **Hygiene** and **owner-reply resolve** need the seeded skill under `~/.hermes/skills/joshu/proactive/`. Details: [welcome-onboarding.md — Fleet backfill](welcome-onboarding.md#fleet-backfill-proactive).

## Owner reminders (2026-10)

When the owner asks to be reminded, the companion calls the connectors MCP tool `owner_reminder_create` with a title, a fixed owner-facing text, and a schedule. Joshu keeps the owner reminder in `<files>/.joshu/owner-reminders/state.json` and runs it as a Hermes cron job named `Owner reminder: <title>`. The Hermes cron job has `no_agent: true` and runs the script `~/.hermes/scripts/owner-reminder-<id>.sh`, which calls `POST /api/owner-reminders/<id>/fire`. A run calls no LLM. A run sends the text on the owner text channel: SMS when the box has the owner mobile, otherwise (or when the SMS send fails, or the carrier rejects the SMS) email from the companion mailbox. The owner text channel waits at most 45 seconds for the delivery receipt of the SMS. An SMS without a final status after 45 seconds counts as delivered. A run that no channel delivered records result "failed" with the cause, for example `sms_failed:twilio undelivered 30034`, and the Hermes cron job ends with `last_status: error`. Proactive nudges use the same channel code ([`ownerTextChannel.ts`](../src/ownerTextChannel.ts)).

| Piece | Behavior |
|-------|----------|
| Schedules | Cron expression with one minute value, `every 2h` / `every 1d`, a time such as `2026-10-08T09:00`, or a delay such as `2h`. At most once each hour. A recurring owner reminder ends after 30 days unless it has an end time (at most 180 days). At most 20 owner reminders are active. |
| Stop | The owner replies DONE by SMS within the proactive follow-up window (default 2 hours) after a reminder SMS, when no nudge came after it. The companion calls `owner_reminder_stop` when the owner says the thing is done. A run retires the owner reminder when its linked Kanban task is `done` or `archived`, or when its end time is in the past. A one-time owner reminder retires after its run. |
| Failure | When no channel delivers, the fire route returns 502 and the script exits with code 1. Hermes stores `last_status: error`, and `components.failures` of `/api/instance/health` lists the job. Each owner reminder keeps its last 20 runs: `GET /api/owner-reminders?includeRetired=1` (localhost). |
| Cron guard | The Hermes plugin `joshu-realtime-goals` blocks a `cronjob` call whose cron delivery target cannot reach anyone, for example `deliver` omitted in an SMS, jChat, or proactive resolve turn. The block message names `owner_reminder_create`. |
| Undeliverable jobs | `components.failures` also lists each enabled undeliverable cron job with last status `undeliverable`. |

API (all localhost-only): `GET /api/owner-reminders`, `POST /api/owner-reminders`, `POST /api/owner-reminders/:id/stop`, `POST /api/owner-reminders/:id/fire`. MCP tools: `owner_reminder_create`, `owner_reminder_list`, `owner_reminder_stop`. Skill: [`joshu-proactive`](../integrations/hermes/skills/proactive/joshu-proactive/SKILL.md), section Owner reminders. Terms: `openspec/glossary.md`. Tests: `npm run test:owner-reminders`.

**Fleet check (read-only):** `npx tsx scripts/check-reminder-crons.mjs --box <slug>` lists the undeliverable cron jobs of a box and the reminder-like jobs that are not owner reminders. `--file <jobs.json>` reads a local copy.

## Hermes skills (factory allowlist)

Enabled in [`integrations/hermes/skills-enabled.yaml`](../integrations/hermes/skills-enabled.yaml):

- `ea-playbook`, `ea-scheduling`, `ea-owner-reply`, `ea-time-block`, `ea-morning-review`, `ea-shutdown`, `ea-project-kanban`
- `joshu-brain`, `joshu-mail`, `excalidraw`, kanban tools
