# VPS Runtime Topology

How the Joshu box stack maps to a **per-customer VPS** running Docker Compose — process layout, paths, env vars, and boot order.

## Process topology

| Component | VPS Compose service | Notes |
| --- | --- | --- |
| Shared browser: local Chromium on Xvfb `:99` + Chromium supervisor (`/opt/browser/supervisor.mjs`; CDP `127.0.0.1:9222`, health `127.0.0.1:9377`) | `joshu-stack` | Started by `vps-start.sh` from `/opt/browser/entrypoint.sh`. With `JOSHU_CLOUD_BROWSER=1` the shared browser is Browser Use Cloud and local Chromium stays off |
| Joshu `node dist/server.js` on `127.0.0.1:8788` | `joshu-stack` | `PUBLIC_BASE_PATH=/joshu`; not exposed directly |
| ArozOS binary on `0.0.0.0:8787` | `joshu-stack` | Public desktop; Caddy sends `/joshu/*` to Joshu and other paths to ArozOS |
| Hindsight API (`:8888`) + local Postgres | `joshu-stack` | **Use durable volume** for Postgres data |
| Hermes gateway (child of Joshu, `api_server` on `:8642`) | `joshu-stack` | Started by Joshu (`HERMES_API_AUTO_START`) |
| Twilio WSS on Joshu upgrade handler | `joshu-stack` + `voice-realtime` | OpenAI Realtime or Gemini Live S2S on `:8792` (profile `voice-rt`) |
| — | `caddy` | TLS + routing for `customer.example.com` |
| — | `instance-agent` | Control-plane heartbeats and updates (profile `fleet`) |

## Path mapping

| Image path | VPS path (Compose volume) |
| --- | --- |
| `/opt/joshu` | `/opt/joshu` (image) |
| `/opt/hermes-agent` | `/opt/hermes-agent` (image) |
| `/opt/arozos-template` | `/opt/arozos-template` (image seed) |
| `/var/lib/arozos` | `./data/arozos` → `/var/lib/arozos` |
| `/var/lib/arozos/joshu-state` | Joshu state folder (`JOSHU_STATE_DIR`) in the ArozOS volume: team rooms and memberships, proactive state, browser handoffs, SMS sessions, metered provider keys |
| `/root/.hermes` | `./data/hermes` → `/root/.hermes` (persistent volume; **not** developer `~/.hermes`) |
| `/opt/joshu/.hermes/plugins` | Repo project plugins in image (`COPY .hermes`) |
| `/opt/joshu/integrations/hermes/skills-enabled.yaml` | Product skill allowlist (Joshu computes `skills.disabled` into `/root/.hermes/config.yaml` at gateway sync) |
| `/home/hindsight/.hindsight` | `./data/hindsight-home` |
| `/home/hindsight/.cache/huggingface` | `./data/hindsight-cache` |
| Postgres data dir | `./data/postgres` → **persistent** |
| `/root/.gbrain` | `./data/gbrain` → **persistent** (file-brain PGLite index) |

## Environment variables

| Variable | VPS recommendation |
| --- | --- |
| `HOST` | `127.0.0.1` (Joshu behind Caddy/ArozOS) |
| `PORT` | `8788` |
| `PUBLIC_BASE_PATH` | `/joshu` |
| `PUBLIC_AROZ_PORT` | `8787` (internal); Caddy publishes `443` |
| `CAMOFOX_AUTO_RESTART` | `false` (`vps-start.sh` default; no Docker restart of a browser container on the box) |
| `CAMOFOX_URL` | `http://127.0.0.1:9377` — health URL of the Chromium supervisor (the name is older than local Chromium) |
| `BROWSER_CDP_URL` | `http://127.0.0.1:9222` when the shared browser is local Chromium |
| `VNC_RESOLUTION` | `1024x768` — Xvfb screen size for local Chromium |
| `JOSHU_HINDSIGHT_ENABLED` | `true` with external embeddings on CPU VPS |
| `HINDSIGHT_API_DATABASE_URL` | local Postgres; **must** use volume-backed data dir |
| `HERMES_HOME` | `./data/hermes` mount |
| `JOSHU_STATE_DIR` | `/var/lib/arozos/joshu-state` (set in the sandbox image). Without it, Joshu keeps its state in `<projectRoot>/.joshu`, which is in the writable layer of the container on a box |
| `TWILIO_*` | Injected per customer via instance-agent / env file |

## Boot sequence

Order is preserved in `deploy/scripts/vps-start.sh`:

1. Load secrets / `$HERMES_HOME/.env`
2. Start the shared browser: local Chromium (`/opt/browser/entrypoint.sh`) → wait `:9377/health`; skipped when `JOSHU_CLOUD_BROWSER=1`
3. Start Hindsight Postgres (if local) → Hindsight API
4. Start Joshu → wait `/joshu/api/status`
5. Bootstrap ArozOS data from template (first boot) + refresh subservices
6. Start ArozOS (under `supervisord` or separate container in Compose)
7. Instance-agent registers with control plane (VPS-only)

## PID files

Several services in the stack container have a PID file, which holds the process ID of the service: the gbrain MCP HTTP server (`/root/.gbrain/gbrain-mcp-http.pid`), gbrain `sync --watch` (`/root/.gbrain/gbrain-sync.pid`), the Hermes dashboard (`/root/.hermes/hermes-dashboard.pid`), the Hermes gateway (`/root/.hermes/gateway.pid`, JSON written by Hermes), the connectors MCP, the Composio MCP guard, and the fal MCP relay (`/root/.joshu/*.pid`). The start scripts and `scripts/stop-gbrain.sh` read a PID file to stop an old copy of the service before they start a new one.

The folders `/root/.gbrain` and `/root/.hermes` are persistent volumes, so their PID files stay after a restart of the stack container. After the restart, the processes start again from low PIDs, and the PID in an old PID file often belongs to a different service. In October 2026, `stop-gbrain.sh` read an old `gbrain-mcp-http.pid` whose PID belonged to `hindsight-api`, and stopped Hindsight. No script restarts Hindsight, so the memory of the box was down until an operator restarted it.

How the scripts stop the process of a PID file:

1. First, the script reads the command line of the PID (`/proc/<pid>/cmdline`, or `ps` on macOS) and checks that it contains the expected command of the service, for example `gbrain-mcp-http-server` or `hermes*gateway run`.
2. Second, if the command line matches, the script sends SIGTERM, waits, checks the command line again, and sends SIGKILL only if the same process still runs.
3. Third, if the command line does not match, the script sends no signal. It writes the PID and the command line to the log ("removing only the PID file") and removes the PID file. The script also does not treat the service as "already running".

Code: `stop_pid_file_process` and `pid_runs_command` in [`scripts/lib/pid-file.sh`](../../scripts/lib/pid-file.sh), and `pidRunsCommand` in [`src/pidFile.ts`](../../src/pidFile.ts), which the Joshu API uses before it stops the Hermes gateway by `gateway.pid`. Test: `npm run test:pid-file-kill-check`.

Design decisions (2026-10):

- Check the command line, and match a part of it that is unique to the service. Rejected: compare the start time of the process with the modification time of the PID file, because the check is harder to read and a clock change or a copied volume makes it wrong. Rejected: stop the service only with `pkill -f`, because on a local development machine more than one stack can run, and `pkill -f` would stop the services of the other stack.
- Use one shell function for all scripts, so each script waits, rechecks, and logs in the same way. Each script sources the library from its own folder, so a script from the hotfix overlay uses the library of the same boot scripts folder.
- `stop-gbrain.sh` only removes `gbrain-embed.pid` and sends no signal, because no script writes that PID file now, and the PID in an old file can belong to any process.
- The Joshu API uses the same check in TypeScript before it sends SIGTERM to the PID of `gateway.pid`, because `gateway.pid` is on a persistent volume too.

## Image build

`deploy/Dockerfile` stages:

- Base: `debian:trixie-slim` (`ARG BASE_IMAGE`) + apt packages (ffmpeg, Postgres, `chromium`, `xvfb`, fonts); Go in the builder stage for the ArozOS build
- Hermes: pinned `hermesRef` / `HERMES_AGENT_REF` from [`deploy/RELEASE.json`](../../deploy/RELEASE.json), venv, image extras parity
- ArozOS: build from `vendor/arozos` → `/opt/arozos-template`
- Joshu: `npm run build:deploy` (includes `copy-runtime-assets.mjs` → `dist/`), app bundles → template subservices
- Shared browser: `browser/chromium/` (supervisor, entrypoint, local proxy) → `/opt/browser/`

Build locally:

```bash
npm run vps:predeploy
npm run vps:build-image
```

## Health endpoints

| Check | URL |
| --- | --- |
| Joshu status | `http://127.0.0.1:8788/joshu/api/status` |
| Instance deep health | `http://127.0.0.1:8788/joshu/api/instance/health` |
| Twilio readiness | `http://127.0.0.1:8788/joshu/api/twilio/health` |
| ArozOS | `http://127.0.0.1:8787/` (login page) |
| Shared browser (local Chromium supervisor) | `http://127.0.0.1:9377/health` |
| Instance agent | `http://127.0.0.1:8790/health` |

## systemd alternative

For bare-metal VPS without Docker:

- `joshu-stack.target` wants a shared browser service (Xvfb + Chromium supervisor), `postgres-hindsight.service`, `hindsight-api.service`, `joshu.service`, `arozos.service`, `caddy.service`, `instance-agent.service`
- Use same env file `/etc/joshu/instance.env`
- `vps-start.sh` logic can run from `ExecStartPre` health waits
