# Welcome onboarding (Executive Assistant Day-1)

First-time setup for Joshu boxes with the **EA v2** layout (`Projects/`, `Triage/` stubs). Replaces the **`ea-discovery`** Hermes skill with a desktop **Welcome** wizard.

Human SOP: [`executive-assistant.md`](executive-assistant.md). Welcome seeds project folders from big-picture priorities and installs morning/evening/weekly Hermes crons (no midday).

**Prefer CLI / headless setup?** See [`env-without-wizard.md`](env-without-wizard.md) for API keys via `instance.env`. If Welcome shows **`draft path unavailable`**, fix ArozOS paths first — [`box-paths.md`](box-paths.md).

## User flow

1. On first login, **Welcome** auto-opens once per browser session when onboarding is incomplete (see [`arozos/web-overlays-vanilla/aroz-onboarding-launch.js`](../arozos/web-overlays-vanilla/aroz-onboarding-launch.js)).
2. **Standalone self-host only:** if required API keys are missing, Welcome shows **Connect AI** to save keys to `.joshu/box-secrets/local-env.json`:
   - **OpenRouter** — jChat + Hindsight LLM (when not in `instance.env`)
   - **Google Gemini** — file brain (gbrain embeddings), Hindsight embeddings, and jChat microphone (Gemini Live) when voice is enabled
   Fleet / control-plane boxes skip this — keys are in `/etc/joshu/instance.env` at provision time.
3. **Optional Day 0:** After Gmail is connected, run **Analyze mail for setup (Day 0)** in **Connectors → Connect apps** to pre-fill the draft from 30 days of mail + calendar. See [`day0-cold-start.md`](day0-cold-start.md).
4. Seven-step wizard captures priorities, communication (with contact details), online tools, and optional VIPs.
5. Progress auto-saves on each **Continue** via `PUT /joshu/api/onboarding/draft`.
6. **Finish setup** writes workspace markdown + `.joshu` profile JSON; **ea-playbook** reads those files on every operational run.
7. After completion, reopen **Welcome** anytime to edit in the same form — header becomes **Your Joshu profile**, review button **Save changes**. Draft JSON is retained for re-editing.

**Dismiss without completing:** **Finish later** sets `sessionStorage.joshu-onboarding-dismissed` so auto-launch does not reopen until the next browser session.

**Open manually:** desktop **Welcome** shortcut ([`docs/arozos-desktop-shortcuts.md`](arozos-desktop-shortcuts.md)), or after **hard factory reset** ([`docs/box-state.md`](box-state.md#hard-factory-reset)) — which also clears Hindsight, gbrain, Composio connections, agent skills in `~/.hermes/skills/`, and EA cron jobs in `~/.hermes/cron/`.

## Wizard steps

| # | Step | What the user provides |
|---|------|------------------------|
| 0 | Welcome | Intro (or “Review or update” if already completed) |
| 1 | Connect AI | OpenRouter API key (**standalone**, when not provisioned); **Google Gemini** key for file brain + voice (when not provisioned) |
| 2 | You & your assistant | Principal name, assistant persona name |
| 3 | Big picture | Multi-select priorities + optional notes |
| 4 | Communication | Channel checkboxes **with contact fields** + schedule/rhythm |
| 5 | Online tools | App checkboxes + notes, do-not-access, optional Nylas agent mailbox |
| 6 | Key people | Optional VIP rows |
| 7 | Review | Summary → **Finish setup** or **Save changes** |

Step **Connect AI** is omitted when `GET /joshu/api/box-secrets/status` reports `needsConnectAi: false` (all required standalone keys present — from provision or Welcome).

### Big picture (step 2)

Multi-select checkboxes (business owners, parents, contractors, anyone busy). Optional free-text notes.

Options are defined in `BIG_PICTURE_PRIORITIES` in [`src/onboarding/options.ts`](../src/onboarding/options.ts), e.g. inbox triage, calendar, travel, family logistics, sales, hiring, etc.

### Communication (step 3)

Each channel is a checkbox; when checked, a contact field appears (email, phone, handle).

| Channel id | Label | Contact collected |
|------------|-------|-------------------|
| `work-email` | Work email | Work email address (Daily Brief destination; synced to `profile.json`) |
| `personal-email` | Personal email | Personal email address |
| `phone` | Phone call | Phone number |
| `sms` | Text message (SMS) | Mobile number |
| `whatsapp` | WhatsApp | WhatsApp number |
| `telegram` | Telegram | Username |
| `slack` | Slack | Member ID or workspace |
| `google-chat` | Google Chat | Email or space |

Also on this step (not checkboxes): time zone, working hours, update format (Daily Brief / EOD), **urgent channel** (dropdown of selected channels when available), “interrupt me now” definition, batch vs ad-hoc questions, optional communication notes.

**Not in the wizard:** SOP §8 “decision authority” (handle solo, spending threshold, etc.) — those remain Week-1 / playbook conversation, not Welcome fields.

### Online tools (step 4)

Grouped multi-select checkboxes only (no separate work/personal email fields here — those live on Communication).

| Section | Examples |
|---------|----------|
| Email & calendar | Gmail, Google Calendar, Microsoft Outlook, Teams |
| Docs & cloud | Google Drive + Docs, OneDrive + Office |
| Social | LinkedIn, X, Instagram, Facebook |
| Notes & knowledge | Notion, Apple Notes, Obsidian, Evernote, OneNote |
| Tasks & projects | Todoist, Asana, Trello, Monday.com, Apple Reminders |

Optional: other tools/notes, do-not-access list, **agent mailbox** provisioning via `POST /joshu/api/nylas/agent` (uses work email from Communication when set).

### Key people (step 5)

Optional table: who, priority, gatekeep notes → `workspace/Resources/key-contacts.md`.

## Draft data model

Stored at `.joshu/onboarding.draft.json` (see [`src/onboarding/paths.ts`](../src/onboarding/paths.ts)). Type: [`src/onboarding/types.ts`](../src/onboarding/types.ts).

| Field | Type | Notes |
|-------|------|-------|
| `ownerName`, `assistantName` | string | Required for save/complete |
| `bigPicturePriorities` | string[] | Checkbox labels |
| `bigPictureNotes` | string? | |
| `communicationChannels` | string[] | Channel **ids** (e.g. `work-email`, `sms`) |
| `communicationContacts` | `Record<string, string>` | Contact per selected channel id |
| `communicationNotes` | string? | |
| `onlineTools` | string[] | App labels |
| `onlineToolsNotes` | string? | |
| `timezone`, `workingHoursStart`, `workingHoursEnd` | string? | Required `timezone` on complete — **IANA** only (e.g. `America/Los_Angeles`, not `PST`). Saved to `.joshu/nylas/profile.json`; jChat injects owner local time via Temporal ([`src/ianaTimezone.ts`](../src/ianaTimezone.ts)) |
| `updateFormat`, `urgentChannel`, `interruptMeNowMeans`, `batchQuestions` | string? | |
| `doNotAccess` | string? | |
| `vips` | `{ who, priority?, gatekeepNotes? }[]` | |
| `primaryWorkEmail`, `personalEmail` | string? | Legacy; derived from `communicationContacts` on complete |

On **complete**, work/personal emails resolve into `profile.json` ([`src/onboarding/workspaceWriter.ts`](../src/onboarding/workspaceWriter.ts)).

## What gets written

| Output | Purpose |
|--------|---------|
| `.joshu/onboarding.json` | `{ completed: true, completedAt }` |
| `.joshu/onboarding.draft.json` | Full last answers (kept after complete for re-editing) |
| `.joshu/identity.json` | Owner + assistant display names |
| `.joshu/nylas/profile.json` | Timezone, hours, urgent channel, work/personal email |
| `FILING.md`, `Triage/`, `Projects/other/` | EA v2 bootstrap (if missing) |
| `Projects/<slug>/` | One folder per Welcome big-picture priority (`about.md`, `todo.md`) |
| `Projects/_system/summary-email.md` | Morning/evening email template |
| `.joshu-ea-version` | `ea-layout: 2.0.0` |
| Hermes cron jobs | **EA morning**, **EA evening**, **EA weekly** (midday removed) via `syncEaCronJobs` — morning/evening prep **`Planning/daily-review-*.md`** + pointer email; owner completes in jChat ("morning review" / "shutdown") |

## API

Mounted under `PUBLIC_BASE_PATH` (default `/joshu`). JSON body routes require `express.json()` **before** onboarding routes in [`src/server.ts`](../src/server.ts).

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/joshu/api/onboarding/status` | `completed`, `eaLayoutVersion`, Nylas/identity/profile hints, `projectsReady` |
| `GET` | `/joshu/api/onboarding/draft` | `{ draft }` or `{ draft: null }` |
| `PUT` | `/joshu/api/onboarding/draft` | Save partial progress (`ownerName` + `assistantName` required) |
| `POST` | `/joshu/api/onboarding/complete` | Seed Projects + mark complete; `timezone` required |

### Box secrets (Connect AI)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/joshu/api/box-secrets/status` | `needsConnectAi`, `needsOpenRouter`, `needsGeminiMl`, `needsEmbeddingsGemini`, `needsGeminiVoice`, `voiceOffered`, `embeddingsProvider`, per-field source |
| `PUT` | `/joshu/api/box-secrets` | Save keys to `.joshu/box-secrets/local-env.json`; Gemini also sets `HINDSIGHT_API_EMBEDDINGS_GEMINI_API_KEY`; OpenRouter change restarts Hermes gateway (Gemini-only saves do not block Welcome) |

`POST /complete` is idempotent for updates: re-running refreshes markdown/profile without a second running-log entry.

## Factory reset

| Action | Welcome again? | Draft retained? |
|--------|----------------|-----------------|
| **Hard reset** | Yes — wipes `.joshu/onboarding.json` and personal tree | No |
| **Soft apply** | No — onboarding stays complete | Yes (if draft file existed) |

## Implementation map

| Piece | Path |
|-------|------|
| Options (checkbox lists) | [`src/onboarding/options.ts`](../src/onboarding/options.ts) |
| Types, paths | [`src/onboarding/types.ts`](../src/onboarding/types.ts), [`src/onboarding/paths.ts`](../src/onboarding/paths.ts) |
| Markdown writer | [`src/onboarding/workspaceWriter.ts`](../src/onboarding/workspaceWriter.ts) |
| HTTP routes | [`src/onboardingApi.ts`](../src/onboardingApi.ts) |
| Box secrets API | [`src/boxSecrets/`](../src/boxSecrets/) |
| Bootstrap auto-secrets | [`deploy/scripts/ensure-instance-env-secrets.sh`](../../deploy/scripts/ensure-instance-env-secrets.sh) |
| React UI | [`apps/welcome/`](../apps/welcome/) (imports options via Vite alias `@joshu/onboarding`) |
| ArozOS subservice | [`arozos/subservice/welcome/`](../arozos/subservice/welcome/) → `dist/welcome/` |
| Auto-launch overlay | [`arozos/web-overlays-vanilla/aroz-onboarding-launch.js`](../arozos/web-overlays-vanilla/aroz-onboarding-launch.js) |
| EA templates | [`templates/ea/`](../templates/ea/) |
| Playbook skill | [`integrations/hermes/skills/executive-assistant/ea-playbook/`](../integrations/hermes/skills/executive-assistant/ea-playbook/SKILL.md) |

## Dev

```bash
npm run dev:welcome          # standalone UI http://127.0.0.1:3008 (proxies /joshu/api → :8788)
npm run build:welcome        # → dist/welcome/
npm run dev:arozos           # syncs subservice, desktop shortcut, auto-launch script
```

After UI or API changes: rebuild Welcome (`npm run build:welcome`) and restart Joshu / `dev:arozos` so the subservice serves fresh assets.

## Troubleshooting

| Symptom | Doc |
|---------|-----|
| **`draft path unavailable`** on Continue | [`box-paths.md`](box-paths.md) — set `JOSHU_AROZ_USER` to ArozOS login email; ensure `Desktop/` exists |
| Skip Connect AI / set keys in shell | [`env-without-wizard.md`](env-without-wizard.md) |
| `gbrain.ok: false` in health | [`box-paths.md`](box-paths.md), [`file-brain.md`](file-brain.md) |

## Related docs

- [`box-paths.md`](box-paths.md) — filesystem layout on the box
- [`env-without-wizard.md`](env-without-wizard.md) — secrets without Welcome
- [`executive-assistant.md`](executive-assistant.md) — full EA operating model
- [`executive-assistant.md`](executive-assistant.md#project-kanban-multi-step--hitl-2026-06) — project Kanban for multi-step / HITL work (after Day-1 setup)
- [`docs/hermes-integration.md`](hermes-integration.md) — skills, workspace bootstrap
- [`docs/box-state.md`](box-state.md) — factory reset vs personal state
- [`docs/nylas-agent-mailbox.md`](nylas-agent-mailbox.md) — agent inbox provisioning
- [`docs/arozos-desktop-shortcuts.md`](arozos-desktop-shortcuts.md) — Welcome shortcut
