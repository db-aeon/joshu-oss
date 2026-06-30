# VPS Runtime Topology

How the Joshu box stack maps to a **per-customer VPS** running Docker Compose — process layout, paths, env vars, and boot order.

## Process topology

| Component | VPS Compose service | Notes |
| --- | --- | --- |
| Camofox `node server.js` in `/app` | `camofox` | Base image from `deploy/RELEASE.json` → `camofoxBase` (digest pin); `patch-camofox-single-tab.mjs` at image build |
| Joshu `node dist/server.js` on `127.0.0.1:8788` | `joshu` | `PUBLIC_BASE_PATH=/joshu`; not exposed directly |
| ArozOS binary on `0.0.0.0:8787` | `arozos` | Public desktop; proxies `/joshu/*` to Joshu |
| Hindsight API + local Postgres | `postgres` + `hindsight` | **Use durable volume** for Postgres data |
| Hermes gateway (child of Joshu) | Started by Joshu (`HERMES_API_AUTO_START`) | Optional separate `hermes` service later |
| Twilio WSS on Joshu upgrade handler | `joshu` + `voice-realtime` | OpenAI Realtime S2S on `:8792` |
| — | `caddy` | TLS + routing for `customer.example.com` |
| — | `instance-agent` | Control-plane heartbeats and updates |

## Path mapping

| Image path | VPS path (Compose volume) |
| --- | --- |
| `/opt/joshu` | `/opt/joshu` (image) |
| `/opt/hermes-agent` | `/opt/hermes-agent` (image) |
| `/opt/arozos-template` | `/opt/arozos-template` (image seed) |
| `/var/lib/arozos` | `./data/arozos` → `/var/lib/arozos` |
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
| `CAMOFOX_AUTO_RESTART` | `false` (Compose restarts `camofox` service) |
| `JOSHU_HINDSIGHT_ENABLED` | `true` with external embeddings on CPU VPS |
| `HINDSIGHT_API_DATABASE_URL` | local Postgres; **must** use volume-backed data dir |
| `HERMES_HOME` | `./data/hermes` mount |
| `TWILIO_*` | Injected per customer via instance-agent / env file |

## Boot sequence

Order is preserved in `deploy/scripts/vps-start.sh`:

1. Load secrets / `$HERMES_HOME/.env`
2. Start Camofox → wait `/health`
3. Start Hindsight Postgres (if local) → Hindsight API
4. Start Joshu → wait `/joshu/api/status`
5. Bootstrap ArozOS data from template (first boot) + refresh subservices
6. Start ArozOS (under `supervisord` or separate container in Compose)
7. Instance-agent registers with control plane (VPS-only)

## Image build

`deploy/Dockerfile` stages:

- Base: `camofoxBase` from [`deploy/RELEASE.json`](../../deploy/RELEASE.json) (`ARG CAMOFOX_BASE`) + apt packages (ffmpeg, postgres client, go for ArozOS build)
- Hermes: pinned `hermesRef` / `HERMES_AGENT_REF` from [`deploy/RELEASE.json`](../../deploy/RELEASE.json), venv, image extras parity
- ArozOS: build from `vendor/arozos` → `/opt/arozos-template`
- Joshu: `npm run build:deploy`, app bundles → template subservices
- Camofox patch: `patch-camofox-single-tab.mjs` at build time

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
| Camofox | `http://127.0.0.1:9377/health` |
| Instance agent | `http://127.0.0.1:8790/health` |

## systemd alternative

For bare-metal VPS without Docker:

- `joshu-stack.target` wants `camofox.service`, `postgres-hindsight.service`, `hindsight-api.service`, `joshu.service`, `arozos.service`, `caddy.service`, `instance-agent.service`
- Use same env file `/etc/joshu/instance.env`
- `vps-start.sh` logic can run from `ExecStartPre` health waits
