# Schedules ArozOS app (Hermes cron)

Joshu includes a **Schedules** desktop app for managing **Hermes cron jobs** — recurring agent tasks, script-only watchdogs, and EA time windows. It is the product-facing GUI for the same scheduler that Hermes exposes via chat (`/cron`), CLI (`hermes cron`), and the `cronjob` agent tool.

## Not the same as arozOS Task Scheduler

ArozOS ships a stock **Tasks Scheduler** module (AECron) under System Tools. That is a **separate** system:

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

Changes from any channel appear in `~/.hermes/cron/jobs.json` immediately. Refresh the Schedules app to see CLI/chat edits.

## Executive Assistant template jobs

**Welcome onboarding** installs EA v2 jobs via [`src/onboarding/eaCronJobs.ts`](../src/onboarding/eaCronJobs.ts) with **`skills: ["ea-playbook"]`** and **`deliver: local`** ([Hermes skill-backed crons](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron#skill-backed-cron-jobs)). Times come from working hours in the Welcome draft.

| Job | Skill | Procedure (via `skill_view`) |
|-----|-------|--------------------------------|
| `EA morning` / `EA evening` / `EA weekly` | `ea-playbook` | Morning → **`ea-morning-review`**; evening → **`ea-shutdown`**; weekly → playbook weekly section |
| `EA scheduling` Kanban tasks (`ea-scheduling` board) | `ea-scheduling` | Meeting negotiation |

Manual install (if needed):

```bash
hermes cron create "0 8 * * 1-5" \
  "Use skill ea-playbook. skill_view('ea-morning-review') — prep Planning/daily-review-YYYY-MM-DD.md, send morning POINTER email to owner." \
  --name "EA morning" \
  --skill ea-playbook \
  --deliver local
```

See [`docs/Joshu-SOP/ea-for-joshu.md`](Joshu-SOP/ea-for-joshu.md) and [`time-block-planning.md`](Joshu-SOP/time-block-planning.md) for daily handoff. Human VA reference: [`executive-assistant.md`](Joshu-SOP/executive-assistant.md). EA also runs **on demand** via jChat between scheduled windows.

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

Quick API check (Joshu on loopback):

```bash
curl -s http://127.0.0.1:8788/joshu/api/cron/status | jq .
curl -s http://127.0.0.1:8788/joshu/api/cron/jobs | jq .
```

## Related docs

- Desktop shortcuts: [`arozos-desktop-shortcuts.md`](arozos-desktop-shortcuts.md)
- Hermes product config: [`hermes-customizations.md`](hermes-customizations.md) (Executive Assistant section)
- jChat (on-demand EA): [`hermes-chat-arozos-app.md`](hermes-chat-arozos-app.md)
- Local stack: [`local-installation.md`](local-installation.md)
