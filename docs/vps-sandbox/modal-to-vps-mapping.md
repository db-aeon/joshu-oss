# Modal → VPS Runtime Mapping

Audit of how the current Modal parity stack maps to a **per-customer VPS** running Docker Compose. Use this when porting env vars, volumes, and boot order.

## Process topology

| Modal (`modal-start.sh`) | VPS Compose service | Notes |
| --- | --- | --- |
| Camofox `node server.js` in `/app` | `camofox` | Same image `ghcr.io/jo-inc/camofox-browser:latest`; patch applied at image build |
| Joshu `node dist/server.js` on `127.0.0.1:8788` | `joshu` | `PUBLIC_BASE_PATH=/joshu`; not exposed directly |
| ArozOS binary on `0.0.0.0:8787` | `arozos` | Public desktop; proxies `/joshu/*` to Joshu |
| Hindsight API + local Postgres | `postgres` + `hindsight` | **Use durable volume** for Postgres data on VPS (Modal used ephemeral `/tmp`) |
| Hermes gateway (child of Joshu) | Started by Joshu (`HERMES_API_AUTO_START`) | Optional separate `hermes` service later |
| Twilio WSS on Joshu upgrade handler | `joshu` + `voice-realtime` | OpenAI Realtime S2S on `:8792` |
| — | `caddy` | TLS + routing for `customer.example.com` |
| — | `instance-agent` | Control-plane heartbeats and updates |

## Path mapping

| Modal path | VPS path (Compose volume) |
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
| `/tmp/hindsight-postgres/data` | `./data/postgres` → **persistent** |
| `/root/.gbrain` | `./data/gbrain` → **persistent** (file-brain PGLite index) |

## Environment variables

| Variable | Modal default | VPS recommendation |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | `127.0.0.1` (Joshu behind Caddy/ArozOS) |
| `PORT` | `8788` | `8788` |
| `PUBLIC_BASE_PATH` | `/joshu` | `/joshu` |
| `PUBLIC_AROZ_PORT` | `8787` | `8787` (internal); Caddy publishes `443` |
| `CAMOFOX_AUTO_RESTART` | `false` | `false` (Compose restarts `camofox` service) |
| `JOSHU_HINDSIGHT_ENABLED` | from secret | `true` with external embeddings on CPU VPS |
| `HINDSIGHT_API_DATABASE_URL` | local Postgres | same; **must** use volume-backed data dir |
| `HERMES_HOME` | `/root/.hermes` volume | `./data/hermes` mount |
| `TWILIO_*` | Modal secret | Injected per customer via instance-agent / env file |

## Boot sequence (equivalent)

Modal `modal-start.sh` order is preserved in `deploy/scripts/vps-start.sh`:

1. Load secrets / `$HERMES_HOME/.env`
2. Start Camofox → wait `/health`
3. Start Hindsight Postgres (if local) → Hindsight API
4. Start Joshu → wait `/joshu/api/status`
5. Bootstrap ArozOS data from template (first boot) + refresh subservices
6. Start ArozOS (foreground in Modal; under `supervisord` or separate container in Compose)
7. Instance-agent registers with control plane (VPS-only)

## Modal-only behaviors to drop or replace

| Modal behavior | VPS replacement |
| --- | --- |
| `modal.Volume` mounts | Docker named volumes under `./data/*` |
| `modal.Secret` / `*_B64` env | Instance-agent pulls secrets from control plane; or SOPS/env on VPS |
| `max_containers=1` | One VPS per customer (your tenancy model) |
| `scaledown_window` / cold start | Always-on VPS; no scale-to-zero |
| `MODAL_EMBED_LOCAL_DIST` | CI builds `dist/` into image; tag `joshu-sandbox:<semver>` |
| 24h function timeout | No platform timeout; use systemd/Compose `restart: unless-stopped` |
| Ephemeral Postgres under `/tmp` | **Required fix:** persist `./data/postgres` |

## Image build parity

`modal_app.py` image build steps map to `deploy/Dockerfile` stages:

- Base: `camofox-browser` + apt packages (ffmpeg, postgres client, go for ArozOS build)
- Hermes: pinned `HERMES_AGENT_REF`, venv, `HERMES_MODAL_EXTRAS` parity
- ArozOS: build from `vendor/arozos` → `/opt/arozos-template`
- Joshu: `npm ci`, `npm run build`, app bundles → template subservices
- Camofox patch: `patch-camofox-single-tab.mjs` at build time

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
