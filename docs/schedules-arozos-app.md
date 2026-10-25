# Schedules ArozOS app (Hermes cron)

Joshu includes a **Schedules** desktop app for managing **Hermes cron jobs** — recurring agent tasks, script-only watchdogs, and EA time windows. It is the product-facing GUI for the same scheduler that Hermes exposes via chat (`/cron`), CLI (`hermes cron`), and the `cronjob` agent tool.

## Not the same as arozOS Task Scheduler

ArozOS ships a stock **Tasks Scheduler** module (AECron) under System Tools. That is a **separate** system (and Joshu hides the stock module UI via `HiddenModules` in `joshu-core.patch` — use this Schedules app instead):

| | **Schedules** (Joshu) | **Tasks Scheduler** (stock arozOS) |
|---|---|---|
| **Storage** | `~/.hermes/cron/jobs.json` | `system/cron.json` |
| **Engine** | Hermes gateway background ticker (60s) | Go goroutine inside arozOS (60s) |
| **Runs** | Hermes agent sessions (prompt + skills) or `--no-agent` scripts | AGI scripts (`.js` / `.agi`) |
| **Schedule syntax** | Intervals (`every 30m`), cron expressions (`0 9 * * 1-5`), one-shots | Fixed interval in seconds + base time anchor |
| **UI** | `arozos/subservice/schedules/` | `SystemAO/arsm/scheduler.html` |

For Joshu product work (Executive Assistant windows, skill-driven automation, delivery to messaging channels), use **Schedules / Hermes cron**. The stock arozOS scheduler remains available for legacy AGI script polling but is not integrated with Hermes.

Neither system uses Linux `crontab`. Both are in-process schedulers.

## Shape

| Piece | Location |
|-------|----------|
| React UI | `apps/schedules/` |
| Built assets | `dist/schedules/` → `arozos/subservice/schedules/app/` |
| ArozOS registration | `arozos/subservice/schedules/moduleInfo.json` |
| Static subservice server | `scripts/aroz-static-subservice.mjs` (via `start.sh`) |
| Joshu REST API | `src/hermesCronApi.ts` → `/joshu/api/cron/*` |
| Hermes bridge | `scripts/hermes-cron-bridge.py` (calls Hermes `cronjob` tool / `cron/jobs.py`) |
| Job storage | `~/.hermes/cron/jobs.json` (Hermes-owned) |
| Run output | `~/.hermes/cron/output/{job_id}/` |

The UI talks to Joshu at `/joshu/api/cron/*`. Joshu spawns the Python bridge with `HERMES_HOME` and `HERMES_AGENT_ROOT` set (same pattern as Hermes Chat STT/TTS). The bridge uses Hermes’s own CRUD functions, so jobs created in the UI, via `hermes cron create`, or via chat `/cron` all share one registry.

**Manifest v2 pilot:** `arozos/subservice/schedules/joshu.app.json` declares a headless invoke action:

```json
{
  "agent": {
    "headless": true,
    "actions": [{ "name": "listCronJobs", "description": "List Hermes cron jobs" }]
  }
}
```

Agents and MCP tools can call:

```bash
curl -s -X POST http://127.0.0.1:8788/joshu/api/apps/schedules/invoke \
  -H 'Content-Type: application/json' \
  -d '{"action":"listCronJobs","args":{}}' | jq .
```

Same handler as `GET /joshu/api/cron/jobs`. See [`platform-architecture.md`](platform-architecture.md#app-invoke-api).

## ArozOS desktop registration

- **Module name:** `Schedules` (`moduleInfo.json` → `"Name"`)
- **Shortcut:** `Schedules.shortcut` (see [`arozos-desktop-shortcuts.md`](arozos-desktop-shortcuts.md))
- **Icon:** `arozos/icons/schedules.png` → `web/img/joshu/schedules.png`

Install helpers in `scripts/lib/arozos-desktop-shortcuts.sh` (`install_schedules_shortcuts`) run on every `dev-arozos` / VPS / VPS prepare.

## REST API

All routes are on the Joshu Express router (prefix `/joshu` when `PUBLIC_BASE_PATH=/joshu`).

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/cron/status` | Gateway running, job counts, next run |
| `GET` | `/api/cron/jobs?includeDisabled=true` | List jobs |
| `GET` | `/api/cron/jobs/:jobId` | Full job (includes prompt) |
| `POST` | `/api/cron/jobs` | Create |
| `PATCH` | `/api/cron/jobs/:id` | Update |
| `POST` | `/api/cron/jobs/:id/pause` | Pause |
| `POST` | `/api/cron/jobs/:id/resume` | Resume |
| `POST` | `/api/cron/jobs/:id/run` | Schedule for next gateway tick |
| `DELETE` | `/api/cron/jobs/:id` | Remove |

Create/update body fields (JSON): `name`, `schedule`, `prompt`, `deliver` (`local` | `origin`), `skills` (array or comma-separated string), `noAgent`, `script` (relative to `~/.hermes/scripts/` when `noAgent` is true), optional **`repeat`** (integer — one-shot jobs use `1`; Hermes `cronjob()` does **not** accept `{ times: N }`).

Joshu ingest queues EA scheduling **case handlers** via [`src/ea/schedulingCron.ts`](../src/ea/schedulingCron.ts) → [`scripts/hermes-kanban-bridge.py`](../scripts/hermes-kanban-bridge.py) on board `ea-scheduling`. Legacy one-shot crons: `npx tsx scripts/migrate-remove-scheduling-crons.mjs`.

## Schedule syntax (Hermes)

Valid examples for the **Schedule** field:

| Pattern | Meaning |
|---------|---------|
| `every 30m` | Every 30 minutes |
| `every 2h` | Every 2 hours |
| `0 9 * * 1-5` | Weekdays at 9:00 (cron expression) |
| `30m` | One-shot in 30 minutes |

**Not supported:** natural phrases like `every 1d at 09:00` (Hermes parses `every` + duration only). Use a cron expression for time-of-day schedules.

Agent jobs require a **prompt** and/or **skills**. Script-only jobs set **no-agent** and require a **script** path under `~/.hermes/scripts/`.

## Timezone

Hermes reads the hour and minute of a cron expression in the owner's local time. The owner timezone is in `timezone` of `~/.hermes/config.yaml` and in `HERMES_TIMEZONE` of `~/.hermes/.env`. Welcome onboarding writes both values ([`src/hermesOwnerTimezone.ts`](../src/hermesOwnerTimezone.ts)). A box without an owner timezone uses the server clock, which is UTC on a VPS.

The Hermes gateway reads the timezone one time, when the gateway process starts. Hermes also stores `next_run_at` of each job as a time with a UTC offset. Thus, when the owner timezone changes, Joshu does two things:

1. The bridge action `realign_timezone` calculates `next_run_at` again for each enabled recurring cron job that Hermes stored with the offset of a different timezone. Without this step, a job stored at 09:00 UTC for an owner at UTC+8 runs one more time at 17:00 local time.
2. Joshu restarts the gateway, so that the scheduler uses the new timezone. When a cron job or a Hermes turn is active, Joshu waits and tries again every 30 seconds.

## Gateway requirement

Cron jobs fire only when the **Hermes gateway** is running. The Schedules UI shows gateway status at the top.

```bash
hermes cron status          # gateway + next runs
hermes gateway              # foreground
hermes gateway start        # user service (if installed)
```

`npm run dev:arozos` starts Joshu and typically warms the Hermes gateway via `HermesApiRunner`. If the banner shows “Gateway stopped”, jobs will not run until the gateway is up.

## Other ways to manage jobs

Hermes retains full control — the UI is additive:

| Channel | Example |
|---------|---------|
| **Schedules app** | Create / edit / pause / delete from desktop |
| **CLI** | `hermes cron create "0 8 * * 1-5" "Morning triage" --skill ea-playbook` |
| **Chat** | `/cron add 0 8 * * 1-5 "Morning triage" --skill ea-playbook` |
| **Agent tool** | `cronjob(action="create", …)` during a session |
| **Owner reminder** | MCP `owner_reminder_create` — Joshu creates a job `Owner reminder: <title>` with `no_agent: true` and script `owner-reminder-<id>.sh` ([executive-assistant.md — Owner reminders](executive-assistant.md#owner-reminders-2026-10)) |

On a box, the Hermes gateway pushes cron output only to Telegram and Slack. The SMS platform of Hermes is off, and an api_server session (SMS, jChat, proactive reply) cannot receive cron output. The Hermes plugin `joshu-realtime-goals` therefore blocks an agent `cronjob` call whose `deliver` cannot reach anyone (for example `deliver` omitted in an SMS turn). A job that sends its own email uses `deliver: local`. A reminder to the owner uses `owner_reminder_create`. Do not delete an `Owner reminder: …` job in this app: stop the owner reminder with `owner_reminder_stop`, so Joshu also deletes its script and record.

Changes from any channel appear in `~/.hermes/cron/jobs.json` immediately. Refresh the Schedules app to see CLI/chat edits.

## Executive Assistant template jobs

**Welcome onboarding** installs EA v2 jobs via [`src/onboarding/eaCronJobs.ts`](../src/onboarding/eaCronJobs.ts) with **`skills: ["ea-playbook"]`** and **`deliver: local`** ([Hermes skill-backed crons](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron#skill-backed-cron-jobs)). Times come from working hours in the Welcome draft.

| Job | Skill | Procedure (via `skill_view`) |
|-----|-------|--------------------------------|
| `EA morning` / `EA evening` / `EA weekly` | `ea-playbook` | Morning → **`ea-morning-review`**; evening → **`ea-shutdown`**; weekly → playbook weekly section |
| `EA scheduling` Kanban tasks (`ea-scheduling` board) | `ea-scheduling` | Meeting negotiation |
| `EA owner-reply` Kanban tasks (`ea-owner-reply` board) | `ea-owner-reply` | Do owner ask then reply on Nylas thread |

Manual install (if needed):

```bash
hermes cron create "0 8 * * 1-5" \
  "Use skill ea-playbook. skill_view('ea-morning-review') — prep Planning/daily-review-YYYY-MM-DD.md, send morning POINTER email to owner." \
  --name "EA morning" \
  --skill ea-playbook \
  --deliver local
```

See [`executive-assistant.md`](executive-assistant.md) and [`time-block-planning.md`](excalidraw-sandbox.md) for daily handoff. Human VA reference: [`executive-assistant.md`](executive-assistant.md). EA also runs **on demand** via jChat between scheduled windows.

### Parallel cron runs (fleet default)

Joshu syncs **`HERMES_CRON_MAX_PARALLEL=2`** into `~/.hermes/.env` and **`cron.max_parallel_jobs: 2`** in `config.yaml` on gateway start ([`src/hermesApi.ts`](../src/hermesApi.ts)). Override with `JOSHU_HERMES_CRON_MAX_PARALLEL` in Joshu `.env` / VPS `instance.env` (when writable). This caps **cron-vs-cron** concurrency only — jChat and Kanban workers still share the same gateway process.

Unset / unbounded parallel crons plus a wedged gateway contributed to **600s inactivity timeouts** on joshua.box (2026-08-19); see [Duplicate EA cron jobs](#duplicate-ea-cron-jobs) and `troubleshooting-and-lessons.md`.

### Duplicate EA cron jobs

**Symptom:** Two **`EA evening`** and/or two **`EA weekly`** jobs in Schedules or `hermes cron list` (same name, different job ids).

**Cause (validated joshua.box 2026-08-18):** Two **`POST /joshu/api/onboarding/complete`** requests within ~75ms (double **Finish setup**). Each run called `syncEaCronJobs` with a stale job list snapshot while the first run was still creating jobs → second run updated morning but **created** evening + weekly again.

**Fix on a live box:**

```bash
# Prefer resync (dedupes + refreshes schedules) after Joshu with eaCronJobs fix is deployed:
curl -fsS -X POST http://127.0.0.1:8788/joshu/api/onboarding/resync-ea-crons | jq .

# Or remove duplicates manually — keep the *older* job id (earlier created_at):
hermes cron remove <duplicate_job_id>
```

**Prevention (main):** Welcome UI submit guard, serialized `/complete`, `syncEaCronJobs` mutex + name dedupe + fresh list per upsert ([`welcome-onboarding.md`](welcome-onboarding.md#finish-setup--what-the-button-does)).

Owner-specific **Training Q&A auto-reply** crons (script + `joshu-mail` skill) are separate from Welcome; install via Desktop `Training/` scripts, not `syncEaCronJobs`.

## Build and dev

```bash
npm run build:schedules          # production bundle → dist/schedules/
npm run dev:schedules            # Vite on :3008, proxies /joshu → :8788
```

After UI or subservice changes:

```bash
npm run build:schedules
npm run dev:arozos               # rsyncs subservice + desktop shortcut
```

Included in `npm run build:deploy` and Docker image build (`deploy/Dockerfile` rsyncs `dist/schedules/` into the ArozOS template).

## Troubleshooting

| Symptom | Likely cause |
|---------|----------------|
| UI shows “Gateway stopped” | Hermes gateway not running — start gateway or restart `dev:arozos` |
| Jobs never fire | Same as above; or job is paused (`state: paused`) |
| Create fails “schedule is required” | POST body not JSON-parsed — ensure `Content-Type: application/json` (Joshu registers cron routes **after** `express.json()`) |
| Invalid duration / cron error | Bad schedule string — use `every Nm`, `every Nh`, or `0 9 * * *` |
| Job missing after CLI create | Refresh UI; confirm `~/.hermes/cron/jobs.json` |
| Bridge import error | `HERMES_BIN` / venv must resolve; bridge needs `HERMES_AGENT_ROOT` for `cron/jobs.py` |
| `TimeoutError: idle for 601s (limit 600s)` | Hermes **inactivity** watchdog — agent thread stuck (not “job needs 10 min”). Restart gateway; set `HERMES_CRON_MAX_PARALLEL=2`; dedupe duplicate EA jobs — troubleshooting |
| Duplicate `EA evening` / `EA weekly` | Double Welcome **Finish setup** — [Duplicate EA cron jobs](#duplicate-ea-cron-jobs) |
| EA jobs run at UTC wall clock, not owner local time | The gateway started before the owner timezone was set and did not restart. Joshu up to release 0.1.49 did not restart it. See [Timezone](#timezone); repair a box with `bash scripts/repair-box-ea-cron-timezone-remote.sh <slug>` |

Quick API check (Joshu on loopback):

```bash
curl -s http://127.0.0.1:8788/joshu/api/cron/status | jq .
curl -s http://127.0.0.1:8788/joshu/api/cron/jobs | jq .
```

## Related docs

- Platform invoke pilot: [`platform-architecture.md`](platform-architecture.md)
- Desktop shortcuts: [`arozos-desktop-shortcuts.md`](arozos-desktop-shortcuts.md)
- Hermes product config: [`hermes-integration.md`](hermes-integration.md) (Executive Assistant section)
- jChat (on-demand EA): [`hermes-chat-arozos-app.md`](hermes-chat-arozos-app.md)
- Local stack: [`local-installation.md`](local-installation.md)
