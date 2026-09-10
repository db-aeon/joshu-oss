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
| Setup debt (Connectors, mobile, …) | Kanban on `ea-onboarding` | `ea-onboarding` |
| Daily plan | `Planning/time-block-*.excalidraw` | `ea-time-block` |
| Morning / shutdown | `Planning/daily-review-*.md` | `ea-morning-review`, `ea-shutdown` |
| Proactive owner nudges | `.joshu/proactive/state.json` + Kanban blocked tasks | `joshu-proactive` (compose/reply/hygiene/evolve); hourly tick localhost-only; **owner nudge replies use a dedicated Hermes session** `proactive:resolve:<taskId>` (not SMS history) with Resolve context; **`ea-onboarding`** cards excluded from hygiene auto-close |

**Rule:** one canonical file per artifact; link elsewhere. Mail bodies stay in `connectors/mail/` mirrors — do not duplicate into project files.

**Project lifecycle:** `Projects/<slug>/` (`about.md` `status`) is the unit that can be “over.” `mail_track` cards are waiting-on attachments. After mail file/handoff, or when the owner reports an outcome on SMS/jChat/voice, **Project reconcile** (ea-playbook) lists all open tracks on that slug and completes ones the signal supersedes. Hourly nudges skip projects whose `about.md` status is not `active`.

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

**Setup debt after Welcome:** incomplete Connectors / owner mobile surface as blocked cards on Kanban board **`ea-onboarding`**, driven by [`factory/onboarding-prompts.yaml`](../factory/onboarding-prompts.yaml) and hourly proactive nudges (email when no SMS on file). See Welcome doc § Setup checklist.

Optional mail analysis: [`day0-cold-start.md`](day0-cold-start.md) — run **Analyze mail for setup (Day 0)** in Connectors after Gmail is connected.

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

Hourly sweep (`POST /api/proactive/tick`, localhost-only) picks blocked Kanban cards needing owner input and sends SMS/email nudges (1/day default). Owner replies route through [`resolveOwnerReply.ts`](../src/proactive/resolveOwnerReply.ts):

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

## Hermes skills (factory allowlist)

Enabled in [`integrations/hermes/skills-enabled.yaml`](../integrations/hermes/skills-enabled.yaml):

- `ea-playbook`, `ea-scheduling`, `ea-owner-reply`, `ea-time-block`, `ea-morning-review`, `ea-shutdown`, `ea-project-kanban`
- `joshu-brain`, `joshu-mail`, `excalidraw`, kanban tools
