# Joshu VPS Deploy

Production packaging for **one VPS per customer**. Replaces VPS for always-on sandboxes.

## Prerequisites

- `vendor/arozos` submodule initialized (ArozOS source build)
- Local bundles: `npm run build:deploy`
- Docker on the VPS (or build in CI and pull from GHCR)

## Build image

Hermes is baked at image build time from the pin in `deploy/RELEASE.json` (same as the sandbox image).
`npm run vps:sync-hermes-pin` copies `hermesRef` into `deploy/Dockerfile`;
`npm run vps:sync-camofox-pin` copies `camofoxBase` (digest pin for `camofox-browser`).
`npm run vps:build-image` passes both as Docker build-args.

```bash
npm run build:deploy

# Local load (default tag: local)
npm run vps:build-image

# Push to GHCR (sandbox + voice-realtime images, same tag)
JOSHU_IMAGE_TAG=0.1.14 JOSHU_IMAGE_REPO=ghcr.io/YOUR_ORG/joshu-sandbox JOSHU_IMAGE_PUSH=1 npm run vps:build-image
```

Pushes **`ghcr.io/YOUR_ORG/joshu-oss:<tag>`** and **`ghcr.io/YOUR_ORG/joshu-oss-voice-realtime:<tag>`** (override with `JOSHU_VOICE_IMAGE_REPO` / `JOSHU_VOICE_IMAGE_REF`).

Current stable pin: [`deploy/RELEASE.json`](RELEASE.json) (**`0.1.32`**).

After `npm run hermes:update`, `npm run vps:sync-hermes-pin` runs automatically (also invoked by `vps:build-image`).
After bumping `camofoxBase`, run `npm run vps:sync-camofox-pin` before rebuild.

Image tags and upstream pins (`hermesRef`, `gbrainRef`, `camofoxBase`) live in [`deploy/RELEASE.json`](RELEASE.json).

**Hermes config:** The image does not include your laptop `~/.hermes/config.yaml`. Product
settings come from `instance.env`, `integrations/hermes/skills-enabled.yaml`, and
Joshu startup (`src/hermesApi.ts`). Details:
[hermes-integration.md](../docs/hermes-integration.md) and [local-installation.md](../docs/local-installation.md).

CI: [`.github/workflows/joshu-oss-image.yml`](../.github/workflows/joshu-oss-image.yml)
— builds **joshu-oss** and **joshu-oss-voice-realtime**; reads `hermesRef`, `camofoxBase`, and `gbrainRef` from `deploy/RELEASE.json`.

## Configure instance

```bash
sudo mkdir -p /etc/joshu
sudo cp deploy/.env.vps.example /etc/joshu/instance.env
sudo chmod 600 /etc/joshu/instance.env
# Edit: JOSHU_INSTANCE_ID, INSTANCE_AGENT_TOKEN, CONTROL_PLANE_URL, CUSTOMER_DOMAIN, secrets
```

Required runtime secrets:

- `HERMES_API_KEY` and `API_SERVER_KEY` must be the same per-instance random
  gateway secret. Joshu sends `HERMES_API_KEY`; the Hermes gateway validates
  `API_SERVER_KEY`.
- `OPENROUTER_API_KEY` is required when the Hermes config uses
  `provider: openrouter` (Joshu default for local dev and VPS).
- Hindsight needs its own LLM and embedding/reranker secrets when
  `JOSHU_HINDSIGHT_ENABLED=true`.
- Files referenced by secret env vars should live under `/etc/joshu/secrets`;
  that directory is mounted read-only into `joshu-stack`.

**Runtime npm deps:** Container `node_modules` come from [`deploy/runtime/package.json`](runtime/package.json) at image build (not from host git). Adding deps there (e.g. `@langfuse/tracing` for Joshu deterministic Langfuse) requires a **new image** — rebuild, push a new tag, pull on the host, then sync `dist/`. Dist-only updates cannot change `node_modules` inside the image.

## Run

```bash
docker compose -f deploy/docker-compose.yml --env-file /etc/joshu/instance.env up -d
```

## Stop (containers only)

Stop all stack services **without** deleting Docker volumes (Desktop data, gbrain PGLite, Hermes, Hindsight):

```bash
ssh root@<customer-hostname>
cd /opt/joshu/deploy
docker compose -f docker-compose.yml --env-file /etc/joshu/instance.env down
```

Start again with the same `up -d` command as [Run](#run). Same teardown as the instance-agent **`deprovision`** command — DNS and the VPS remain.

**File brain (gbrain):** On boot, `vps-start.sh` runs `start-gbrain.sh` (quick boot) then `start-gbrain-mcp-http.sh` on port **8794**, plus **`ensure-gbrain-indexed.sh`** at 45s / 3m and empty-index watchdogs. Hermes uses `http://127.0.0.1:8794/mcp`. After deploy, verify inside the container:

```bash
curl -fsS http://127.0.0.1:8788/joshu/api/instance/health | jq '.components.gbrain'
curl -fsS http://127.0.0.1:8794/health | jq '.session_ready,.page_count'
curl -fsS 'http://127.0.0.1:8794/list?limit=5' | jq '.raw' | head -c 400
```

Expect **`gbrain.indexed_ok: true`** and **`page_count > 0`** when markdown exists on Desktop (not just `gbrain.ok`). Manual recovery: `bash /opt/joshu/scripts/ensure-gbrain-indexed.sh` (see [`docs/file-brain.md`](../docs/file-brain.md#health-vs-indexed-pages-vps)).

### Hermes skills denylist (after upgrade)

Product sandboxes disable ~160 bundled Hermes skills via `skills.disabled` in `/root/.hermes/config.yaml` (computed from `integrations/hermes/skills-enabled.yaml` at gateway sync). On boot, `vps-start.sh` nudges Joshu to merge the denylist and runs `verify_hermes_skills_denylist` if the count is too low.

```bash
# Inside container or via SSH
python3 -c "import yaml; c=yaml.safe_load(open('/root/.hermes/config.yaml')); print('disabled:', len(c.get('skills',{}).get('disabled',[])))"
# Expect ~150–165

docker logs deploy-joshu-stack-1 2>&1 | rg 'Hermes skills policy|skills.disabled'
```

If count is near zero after image upgrade: confirm `HERMES_DIR=/opt/hermes-agent` in the container (`docker exec … env | rg HERMES`), restart the stack, or `curl -fsS http://127.0.0.1:8788/joshu/api/hermes-chat/status` from inside the container. Start a **new jChat** session — Hermes caches the skill catalog per session.

See [Hermes skills denylist (after upgrade)](#hermes-skills-denylist-after-upgrade) above and [local-installation.md](../docs/local-installation.md) (factory reset).

**Connectors MCP (`:8795`):** EA summary sends and connector sync actions. On boot, `vps-start.sh` starts it and runs a 60s health watchdog.

```bash
curl -fsS http://127.0.0.1:8795/health
```

If summary sends fail with `Unknown tool: mcp_joshu_connectors_*`, see [`docs/connectors.md`](../docs/connectors.md#troubleshooting-unknown-tool-mcp_joshu_connectors_).

**gbrain MCP HTTP watchdog:** `vps-start.sh` restarts `:8794` when `session_ready` drops (60s poll). **Empty-index watchdog:** every **`GBRAIN_EMPTY_INDEX_WATCHDOG_SEC`** (default 300s) runs `ensure-gbrain-indexed.sh --check-only` and auto-recovers when disk has `.md` but the index is empty.

See [`docs/file-brain.md`](../docs/file-brain.md) for multi-source search (`query` + `source_id: __all__` vs MCP `search`).

Optional realtime voice profile:

```bash
docker compose -f deploy/docker-compose.yml --env-file /etc/joshu/instance.env --profile voice up -d
```

## First-boot on empty VPS

Cloud-init (control-plane provision) runs `bootstrap-vps.sh`, which clones the repo to **`/opt/joshu`** and starts compose from `/opt/joshu/deploy`.

**Host bind-mounts:** Compose overlays several paths from the **host** clone at `/opt/joshu`:

| Host path | Container path | Lane |
| --- | --- | --- |
| `dist/` | `/opt/joshu/dist/` | B — API hotfix / `syncDistFromImage` |
| `integrations/hermes/skills/` | `/opt/joshu/integrations/hermes/skills/` | A — factory skills source for bootstrap |
| `integrations/hermes/skills-enabled.yaml` | same | A — Hermes allowlist / bundled denylist |
| `scripts/render-time-block-excalidraw.mjs`, `gather-time-block-input.mjs` | `/opt/joshu/scripts/` | A — EA time-block pipeline |
| `templates/ea/` | `/opt/joshu/templates/ea/` | A — EA filesystem seeds |
| `deploy/scripts/vps-start.sh`, selected `scripts/` | `/opt/joshu/scripts/` | A — boot / MCP |

`git pull` alone does not refresh `dist/` — the host bind-mount shadows the image copy. Match the update path to what you changed:

| You changed | Update path |
| --- | --- |
| Skills, MCP scripts, `vps-start.sh`, templates (bind-mounted paths) | `git pull` on host → recreate `joshu-stack` |
| Compiled Joshu API (`src/` → `dist/`) | Sync host `dist/` from image (below) → recreate |
| `deploy/Dockerfile`, Hermes pin, `deploy/runtime/package.json` | New image tag → pull → dist sync → recreate |

Quick dist recovery after a release image pull:

```bash
JOSHU_IMAGE_REF=ghcr.io/db-aeon/joshu-sandbox:0.1.17 \
JOSHU_RELEASE_VERSION=0.1.17 \
bash /opt/joshu/scripts/sync-dist-from-image.sh
cd /opt/joshu/deploy && docker compose -f docker-compose.yml --env-file /etc/joshu/instance.env up -d --force-recreate joshu-stack
curl -fsS http://127.0.0.1:8788/joshu/api/instance/health | jq '.components.dist'
```

Manual bootstrap on an empty VPS (pulls `JOSHU_IMAGE_REF` by default; set `JOSHU_BUILD_IMAGE=1` to build locally):

```bash
sudo bash deploy/scripts/bootstrap-vps.sh
```

See [vps-quickstart.md](../docs/vps-quickstart.md) for a full Ubuntu VPS walkthrough.

## Smoke checks

```bash
curl -fsS https://<customer-hostname>/joshu/api/instance/health | jq '.healthy,.components.gbrain'

curl -N -H 'Content-Type: application/json' \
  -d '{"sessionId":"smoke","messages":[{"role":"user","content":"Reply with exactly: VPS Hermes is working."}]}' \
  https://<customer-hostname>/joshu/api/hermes-chat/stream
```

The Hermes stream should emit `status`, at least one `delta`, and `done`.

**Hermes Admin** (direct vhost, default on VPS):

```bash
curl -fsS -u admin:<JOSHU_HERMES_DASHBOARD_PASSWORD> \
  -o /dev/null -w '%{http_code}\n' \
  https://hermes-admin.<customer-hostname>/
```

Expect **200** and HTML (not `Invalid Host header`). Caddy rewrites upstream `Host` to `127.0.0.1:9119` — see [hermes-integration.md](../docs/hermes-integration.md).

## Architecture docs

- [docs/self-host.md](../docs/self-host.md) — standalone bootstrap
