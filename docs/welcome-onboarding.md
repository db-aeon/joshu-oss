# Welcome onboarding (Executive Assistant Day-1)

First-time setup for Joshu boxes with the **EA v2** layout (`Projects/`, `Triage/` stubs). Replaces the **`ea-discovery`** Hermes skill with a desktop **Welcome** wizard.

Human SOP: [`executive-assistant.md`](executive-assistant.md). Welcome seeds project folders from big-picture priorities and installs morning/evening/weekly Hermes crons (no midday).

## User flow

1. On first login, **Welcome** auto-opens once per browser session when onboarding is incomplete (see [`arozos/web-overlays-vanilla/aroz-onboarding-launch.js`](../arozos/web-overlays-vanilla/aroz-onboarding-launch.js)).
2. **Step 1 (Welcome):** intro plus **Open Connectors** — link Gmail/calendar/apps in the Connectors desktop app (same `openModule("Connectors")` path as jMail). Optional anytime; also offered again on Review.
3. **Standalone self-host only:** if no OpenRouter key is configured, Welcome shows **Connect AI** to save API keys to `.joshu/box-secrets/local-env.json`. On the same step you can optionally add a **Gemini** key for the jChat microphone (Gemini Live). **Control-plane managed boxes skip this** — keys are already in `/etc/joshu/instance.env` at provision time.
4. **Optional Day 0:** After Gmail is connected, run **Analyze mail for setup (Day 0)** in **Connectors → Connect apps** to pre-fill the draft from 30 days of mail + calendar. See `day0-cold-start.md`.
5. Essentials wizard: big-picture priorities, work/personal email, **owner mobile**, timezone + working hours. Owner/assistant display names come from box identity / `profile.json` (not a Welcome step).
6. Progress auto-saves on each **Continue** via `PUT /joshu/api/onboarding/draft`.
7. **Finish setup** writes workspace markdown + `.joshu` profile JSON, creates **Projects/** folders, installs **EA morning / evening / weekly** Hermes crons (awaits cron sync before HTTP returns), and bootstraps the EA scheduling Kanban board. Optional **agent mailbox** can be created on Review via `POST /joshu/api/nylas/agent`.
8. After completion, reopen **Welcome** anytime to edit in the same form — header becomes **Your Joshu profile**, review button **Save changes**. Draft JSON is retained for re-editing.

### Finish setup — what the button does

**Finish setup** (first run) and **Save changes** (after completion) both call `POST /joshu/api/onboarding/complete`. The UI shows **Finishing…** until the HTTP response returns; the server **awaits** EA cron sync and scheduling Kanban bootstrap (not fire-and-forget).

| Step | What happens |
|------|----------------|
| Sync | Profile, identity, project folders, EA layout files |
| Hermes | Owner timezone → `config.yaml` + `HERMES_TIMEZONE`. On a change, Joshu realigns the stored cron run times and restarts the gateway ([Schedules — Timezone](schedules-arozos-app.md#timezone)) |
| Crons | Upsert **EA morning**, **EA evening**, **EA weekly** from working hours ([`syncEaCronJobs`](../src/onboarding/eaCronJobs.ts)) |
| Kanban | Bootstrap **`ea-scheduling`** board + reconcile **`ea-onboarding`** setup cards |
| Setup crons | Install **Joshu onboarding reconcile** (daily) + proactive tick/hygiene |

On first success the UI shows a **You're set up** summary (projects, cron times, work email) with **Open jChat** / **Open Connectors** — not just a one-line banner.

**Double-submit:** The UI blocks repeat clicks; the API serializes `/complete` and cron sync dedupes jobs by name. Historically, two rapid **Finish setup** clicks (before this hardening) could create **duplicate** EA evening/weekly jobs because Hermes allows duplicate names — see [`schedules-arozos-app.md`](schedules-arozos-app.md#duplicate-ea-cron-jobs).

**Open manually:** desktop **Welcome** shortcut ([`docs/arozos-desktop-shortcuts.md`](arozos-desktop-shortcuts.md)), or after **hard factory reset** ([`docs/box-state.md`](box-state.md#hard-factory-reset)) — which also clears Hindsight, gbrain, Composio connections, agent skills in `~/.hermes/skills/`, and EA cron jobs in `~/.hermes/cron/`.

## Setup checklist (`ea-onboarding`)

Welcome is the **front door**; incomplete setup after **Finish setup** surfaces on Hermes board **`ea-onboarding`** as blocked Kanban cards, one for each setup step in [`factory/onboarding-prompts.yaml`](../factory/onboarding-prompts.yaml). The required setup steps are `owner-profile`, `owner-mobile-sms`, `connect-work-gmail`, and `connect-calendar`; the board also has optional setup tips. Each step lists its check (`completeWhen`, in [`src/onboarding/promptPredicates.ts`](../src/onboarding/promptPredicates.ts)) and the how-to that the reconcile writes into the card body.

Welcome can finish without a mobile. **Reconcile** ([`reconcileOnboardingBoard`](../src/onboarding/reconcileOnboardingBoard.ts)) runs on Finish setup, connector changes, and daily cron; cards auto-close when predicates pass. If any required setup step is still open (including steps added in a later release), the hourly proactive tick keeps **ranking `ea-onboarding` above mail tracks** until complete — **by email** when no SMS number is on file ([`delivery.ts`](../src/proactive/delivery.ts) SMS → email fallback, also after an undelivered SMS). A box with no mobile and no work email gets no nudge, and the tick skips with reason `no_delivery_channel` without a Hermes call. The companion also adds the setup mention to one reply each day on each channel. Setup tips get neither. Setup priority does **not** expire after Welcome.

Setup status for desktop UI: `GET /joshu/api/onboarding/setup-status` (same-origin browser session or localhost only).

**Reconcile triggers:** Finish setup, Connectors refresh, Telephone `ownerCaller` save (also a save from a phone call, the owner mobile offer), and daily Hermes cron **`Joshu onboarding reconcile`** (`scripts/onboarding-reconcile.sh` → `node scripts/run-onboarding-reconcile.mjs`). There is **no** public HTTP reconcile endpoint — ops run in-process inside the container.

**VPS ship lane:** [`factory/onboarding-prompts.yaml`](../factory/onboarding-prompts.yaml) is compose bind-mounted (same lane as `factory/manifest.yaml`); `git pull` + recreate. Compiled reconcile code lives in host `dist/onboarding/` (`hotpatch-running-box.md`).

## Wizard steps

| # | Step | What the user provides |
|---|------|------------------------|
| 0 | Welcome | Intro + **Open Connectors** button (or “Review or update” if already completed) |
| 1 | Connect AI | OpenRouter API key (**standalone only**, when not provisioned); optional Gemini key for jChat voice |
| 2 | Big picture | Multi-select priorities + optional notes → `Projects/<slug>/` |
| 3 | Schedule & email | Work email, optional personal email, optional owner mobile, IANA timezone, working hours |
| 4 | Review | Summary → optional agent mailbox → **Finish setup** (creates Projects + EA crons) or **Save changes** |

Step **Connect AI** is omitted when `GET /joshu/api/box-secrets/status` reports `needsConnectAi: false` (fleet / CP boxes with provisioned `OPENROUTER_API_KEY`, or after the key is saved).

### Removed from the UI (still in draft API / Day-0)

Online-tool checkboxes, do-not-access, multi-channel contact picker, update-format / interrupt / batch notes, and VIP rows are **no longer collected in Welcome**. Connect apps via **Connectors**. Soft fields may still exist in `.joshu/onboarding.draft.json` from older runs or Day-0 merge; complete() preserves them if present.

**Not in the wizard:** SOP §8 “decision authority” (handle solo, spending threshold, etc.) — those remain Week-1 / playbook conversation.

### Big picture

Multi-select checkboxes. Optional free-text notes (appended to each new project `about.md` as Welcome notes).

Options are defined in `BIG_PICTURE_PRIORITIES` in [`src/onboarding/options.ts`](../src/onboarding/options.ts).

### Schedule & email

| Field | Purpose |
|-------|---------|
| Work email | Daily Brief / pointer destination → `profile.json` `primaryWorkEmail` |
| Personal email | Optional → `personalEmail` (calendar free/busy union) |
| Your mobile | Optional at Welcome → `communicationContacts.sms` and `.joshu/telephone/settings.json` `ownerCaller`. If skipped, **`ea-onboarding`** + proactive SMS/email nudge until set (Telephone, Welcome, or a yes to the owner mobile offer on a phone call). |
| Timezone | Required on complete — IANA dropdown (`Intl.supportedValuesOf('timeZone')`) |
| Working hours | Drive **EA morning / evening / weekly** cron times |

## Draft data model

Stored at `.joshu/onboarding.draft.json` (see [`src/onboarding/paths.ts`](../src/onboarding/paths.ts)). Type: [`src/onboarding/types.ts`](../src/onboarding/types.ts).

| Field | Type | Notes |
|-------|------|-------|
| `ownerName`, `assistantName` | string | Required for save/complete |
| `bigPicturePriorities` | string[] | Checkbox labels |
| `bigPictureNotes` | string? | |
| `communicationChannels` | string[] | Channel **ids**; UI sets `work-email` / `personal-email` / `sms` when those fields are filled |
| `communicationContacts` | `Record<string, string>` | Contact per channel id |
| `timezone`, `workingHoursStart`, `workingHoursEnd` | string? | Required `timezone` on complete — **IANA** only. Saved to `.joshu/nylas/profile.json`; jChat injects owner local time via Temporal ([`src/ianaTimezone.ts`](../src/ianaTimezone.ts)) |
| `primaryWorkEmail`, `personalEmail` | string? | Legacy; derived from `communicationContacts` on complete |
| Soft / legacy | various | `onlineTools*`, `doNotAccess`, `updateFormat`, `urgentChannel`, `interruptMeNowMeans`, `batchQuestions`, `communicationNotes`, `vips` — optional; not shown in UI |

On **complete**, work/personal emails resolve into `profile.json` ([`src/onboarding/workspaceWriter.ts`](../src/onboarding/workspaceWriter.ts)).

## What gets written

| Output | Purpose |
|--------|---------|
| `.joshu/onboarding.json` | `{ completed: true, completedAt }` |
| `.joshu/onboarding.draft.json` | Full last answers (kept after complete for re-editing) |
| `.joshu/identity.json` | Owner + assistant display names |
| `.joshu/nylas/profile.json` | Timezone, hours, urgent channel (if set), work/personal email |
| `.joshu/telephone/settings.json` | `ownerCaller` when Welcome mobile is filled |
| `FILING.md`, `Triage/`, `Projects/other/` | EA v2 bootstrap (if missing) |
| `Projects/<slug>/` | One folder per Welcome big-picture priority (`about.md`, `todo.md`) |
| `Projects/_system/summary-email.md` | Morning/evening email template |
| `.joshu-ea-version` | `ea-layout: 2.0.0` |
| Hermes cron jobs | **EA morning**, **EA evening**, **EA weekly** via `syncEaCronJobs`; **Joshu proactive tick** (hourly) + **Joshu proactive hygiene** (weekday) via `syncProactiveCron` / `syncProactiveHygieneCron` |
| `.joshu/nylas/agent.json` | If agent mailbox created on Review |

## API

Mounted under `PUBLIC_BASE_PATH` (default `/joshu`). JSON body routes require `express.json()` **before** onboarding routes in [`src/server.ts`](../src/server.ts).

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/joshu/api/onboarding/status` | `completed`, `eaLayoutVersion`, Nylas/identity/profile hints, `projectsReady` |
| `GET` | `/joshu/api/onboarding/draft` | `{ draft }` or `{ draft: null }` |
| `PUT` | `/joshu/api/onboarding/draft` | Save partial progress (`ownerName` + `assistantName` required) |
| `POST` | `/joshu/api/onboarding/complete` | Seed Projects + mark complete; `timezone` required |
| `GET` | `/joshu/api/onboarding/setup-status` | Open required setup prompts + predicate snapshot (desktop session or localhost only) |
| `POST` | `/joshu/api/onboarding/resync-ea-crons` | Ops repair: re-sync timezone + EA crons from draft or Nylas profile; **also installs proactive tick + hygiene**; dedupes duplicate job names |

### Fleet backfill (proactive)

Proactive is **three install surfaces** — image pull alone does not enable all of them on existing boxes. See troubleshooting — Proactive fleet rollout.

| Surface | Install |
|---------|---------|
| Nudge API (`dist/`) | New sandbox image → `upgrade-fleet-box-image.sh` |
| Hermes crons (`Joshu proactive tick` + hygiene) | Each start of the Joshu API on a box where setup is finished (release after 0.1.56, see [Hermes cron jobs of a box](hermes-integration.md#hermes-cron-jobs-of-a-box)). On an older release, **`POST /joshu/api/onboarding/resync-ea-crons`** |
| `joshu-proactive` skill (hygiene + resolve) | New sandbox image → upgrade → bootstrap merge into `~/.hermes/skills/joshu/` |

**After shipping proactive (or any new factory skill) to existing fleet boxes:**

```bash
# Upgrade path (images + host bundle + recreate + skills merge)
bash scripts/upgrade-fleet-box-image.sh root@<slug>.box.joshu.me <version>

# Crons (first proactive rollout — not in upgrade script):
bash scripts/repair-fleet-ea-cron-timezone.sh
```

**Verify on a box:**

```bash
ssh root@<slug>.box.joshu.me bash -s <<'EOF'
docker exec deploy-joshu-stack-1 bash -lc '
  test -f /opt/joshu/integrations/hermes/skills/proactive/joshu-proactive/SKILL.md && echo "image proactive skill: yes" || echo "image proactive skill: no"
  test -f /root/.hermes/skills/joshu/proactive/joshu-proactive/SKILL.md && echo "seeded proactive skill: yes" || echo "seeded proactive skill: no"
  python3 -c "import json; d=json.load(open(\"/root/.hermes/cron/jobs.json\")); print(\"crons:\", [j[\"name\"] for j in d[\"jobs\"] if \"proactive\" in j.get(\"name\",\"\").lower()])"
'
EOF
```

**Boxes without Welcome profile** (no onboarding draft / Nylas `profile.json` with timezone + owner names) return **400** from `resync-ea-crons`. Install at least the hourly tick inside the container:

```bash
ssh root@<slug>.box.joshu.me \
  "docker exec deploy-joshu-stack-1 bash -lc 'cd /opt/joshu && node --input-type=module -e \"import { syncProactiveCron } from \\\"./dist/proactive/proactiveCronJobs.js\\\"; console.log(await syncProactiveCron(\\\"/opt/joshu\\\"));\"'"
```

Hygiene cron still needs a completed Welcome profile (or manual `syncProactiveHygieneCron` with a draft). Proactive **nudges** require owner timezone in profile — fix via Welcome **Save changes** if ticks skip with `missing_timezone`. Most mail-track blocks use **`awaiting reply:`** and are **not** nudge-eligible — silence can mean no qualifying candidates, not missing crons.

### Box secrets (Connect AI)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/joshu/api/box-secrets/status` | `needsConnectAi`, `needsOpenRouter`, `needsGeminiVoice`, `voiceOffered`, `geminiConfigured`, `standalone`, per-field source |
| `PUT` | `/joshu/api/box-secrets` | Save `OPENROUTER_API_KEY` and/or `GEMINI_API_KEY` to `.joshu/box-secrets/local-env.json`; sync Hermes; restart gateway when OpenRouter changes |

`POST /complete` is serialized server-side and re-syncs EA crons idempotently (dedupes duplicate job names, refreshes schedules from draft). Double-clicks or parallel requests must not create extra cron jobs.

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
| Bootstrap auto-secrets | [`deploy/scripts/ensure-instance-env-secrets.sh`](../deploy/scripts/ensure-instance-env-secrets.sh) |
| React UI | [`apps/welcome/`](../apps/welcome/) (imports options via Vite alias `@joshu/onboarding`) |
| ArozOS subservice | [`arozos/subservice/welcome/`](../arozos/subservice/welcome/) → `dist/welcome/` |
| Auto-launch overlay | [`arozos/web-overlays-vanilla/aroz-onboarding-launch.js`](../arozos/web-overlays-vanilla/aroz-onboarding-launch.js) |
| EA templates | [`templates/ea/`](../templates/ea/) |
| EA cron sync | [`src/onboarding/eaCronJobs.ts`](../src/onboarding/eaCronJobs.ts) |
| Setup prompt registry | [`factory/onboarding-prompts.yaml`](../factory/onboarding-prompts.yaml), [`src/onboarding/promptRegistry.ts`](../src/onboarding/promptRegistry.ts) |
| Predicates + prompt state | [`src/onboarding/promptPredicates.ts`](../src/onboarding/promptPredicates.ts), [`src/onboarding/promptState.ts`](../src/onboarding/promptState.ts) |
| Kanban reconcile | [`src/onboarding/reconcileOnboardingBoard.ts`](../src/onboarding/reconcileOnboardingBoard.ts), [`src/onboarding/eaOnboardingKanbanBootstrap.ts`](../src/onboarding/eaOnboardingKanbanBootstrap.ts) |
| Daily reconcile cron | [`src/onboarding/onboardingCronJobs.ts`](../src/onboarding/onboardingCronJobs.ts), [`scripts/onboarding-reconcile.sh`](../scripts/onboarding-reconcile.sh) |
| Proactive rank boost | [`src/onboarding/onboardingProactive.ts`](../src/onboarding/onboardingProactive.ts) |
| `ea-onboarding` skill | [`integrations/hermes/skills/executive-assistant/ea-onboarding/`](../integrations/hermes/skills/executive-assistant/ea-onboarding/SKILL.md) |
| Playbook skill | [`integrations/hermes/skills/executive-assistant/ea-playbook/`](../integrations/hermes/skills/executive-assistant/ea-playbook/SKILL.md) |

## Dev

```bash
npm run dev:welcome          # standalone UI http://127.0.0.1:3008 (proxies /joshu/api → :8788)
npm run build:welcome        # → dist/welcome/
npm run dev:arozos           # syncs subservice, desktop shortcut, auto-launch script
```

After UI or API changes: rebuild Welcome (`npm run build:welcome`) and restart Joshu / `dev:arozos` so the subservice serves fresh assets.

## Related docs

- [`executive-assistant.md`](executive-assistant.md) — full EA operating model
- [`ea-for-joshu.md`](hermes-integration.md#project-kanban-multi-step--hitl-2026-06) — project Kanban for multi-step / HITL work (after Day-1 setup)
- [`docs/hermes-integration.md`](hermes-integration.md) — skills, workspace bootstrap
- [`docs/box-state.md`](box-state.md) — factory reset vs personal state
- [`docs/nylas-agent-mailbox.md`](nylas-agent-mailbox.md) — agent inbox provisioning
- [`docs/arozos-desktop-shortcuts.md`](arozos-desktop-shortcuts.md) — Welcome shortcut
- [`docs/connectors-arozos-app.md`](connectors-arozos-app.md) — Connectors desktop app
