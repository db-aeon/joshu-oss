# Joshu VPS Deploy

Production packaging for **one VPS per customer**. Replaces VPS for always-on sandboxes.

## Prerequisites

- `vendor/arozos` submodule initialized (ArozOS source build)
- Local bundles: `npm run build:deploy`
- Docker on the VPS (or build in CI and pull from GHCR)

## Build image

Hermes is baked at image build time from the pin in `deploy/RELEASE.json` (same as the sandbox image).
`npm run vps:sync-hermes-pin` copies `hermesRef` into `deploy/Dockerfile`.
`npm run vps:build-image` passes `hermesRef` and `gbrainRef` as Docker build-args.
The sandbox image is built `FROM debian:trixie-slim`. The shared browser in the image is local Chromium.

```bash
npm run build:deploy
npm run test:runtime-assets

# Local load (default tag: local)
npm run vps:build-image

# Push to GHCR (sandbox, voice-realtime, and instance-agent images, same tag)
JOSHU_IMAGE_TAG=0.1.14 JOSHU_IMAGE_REPO=ghcr.io/YOUR_ORG/joshu-sandbox JOSHU_IMAGE_PUSH=1 npm run vps:build-image
```

Pushes **`ghcr.io/YOUR_ORG/joshu-sandbox:<tag>`**, **`ghcr.io/YOUR_ORG/joshu-voice-realtime:<tag>`**, and **`ghcr.io/YOUR_ORG/joshu-instance-agent:<tag>`** (override with `JOSHU_VOICE_IMAGE_REPO` / `JOSHU_VOICE_IMAGE_REF` and `JOSHU_AGENT_IMAGE_REPO` / `JOSHU_AGENT_IMAGE_REF`). `JOSHU_BUILD_DRY_RUN=1` prints the three image refs and builds nothing.

Current stable pin: [`deploy/RELEASE.json`](RELEASE.json).

After `npm run hermes:update`, `npm run vps:sync-hermes-pin` runs automatically (also invoked by `vps:build-image`).

Image tags and upstream pins (`hermesRef`, `gbrainRef`) live in [`deploy/RELEASE.json`](RELEASE.json). See [runtime-topology — Image build](../docs/vps-sandbox/runtime-topology.md#image-build) for how they flow into the Docker image.

**Hermes config:** The image does not include your laptop `~/.hermes/config.yaml`. Product
settings come from `instance.env`, `integrations/hermes/skills-enabled.yaml`, and
Joshu startup (`src/hermesApi.ts`). Details:
[hermes-integration.md](../docs/hermes-integration.md) and [local-installation.md](../docs/local-installation.md).

CI: [`.github/workflows/joshu-sandbox-image.yml`](../.github/workflows/joshu-sandbox-image.yml)
— reads `hermesRef` and `gbrainRef` from `deploy/RELEASE.json`, passes them to `docker build`, and pushes the three release images (sandbox, voice-realtime, instance-agent) with the same tag. A `v*` tag push is a release (tags `vX`, `X`, `latest`). A manual run (`workflow_dispatch`) asks for a test tag and does not push `latest`. The fleet build needs the repository secret that can read the design pack (see the comment in the workflow). Workflow `release.yml` calls the build for a release, because a tag that a workflow pushes does not start the push trigger. Script `scripts/bump-release-pins.mjs <version>` sets the version and the image tags in `deploy/RELEASE.json` and `deploy/.env.vps.example`.

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

**Runtime npm deps:** Container `node_modules` come from [`deploy/runtime/package.json`](runtime/package.json) at image build (not from host git). Adding deps there (e.g. `@langfuse/tracing` for Joshu deterministic Langfuse) requires a **new image** — rebuild, push a new tag, and upgrade the box. `dist/` and `node_modules` both come only from the image.

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

Expect **`gbrain.indexed_ok: true`** and **`page_count > 0`** when markdown exists on Desktop (not just `gbrain.ok`). Manual recovery: `docker exec deploy-joshu-stack-1 bash /opt/joshu/scripts/ensure-gbrain-indexed.sh` (see [`docs/file-brain.md`](../docs/file-brain.md#health-vs-indexed-pages-vps)).

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

`bootstrap-vps.sh` installs Docker, pulls the sandbox image, and writes the **host bundle** from the image to `/opt/joshu/deploy/` (`deploy/scripts/install-host-bundle.sh`). It does not clone the repository, except with `JOSHU_BUILD_IMAGE=1`, where the clone in `/opt/joshu-src` is only the build context.

```bash
sudo bash deploy/scripts/bootstrap-vps.sh
```

## What runs from where

The release images are the only source of code on a box:

| Container | Image |
| --- | --- |
| `joshu-stack` | sandbox image (`JOSHU_IMAGE_REF`) |
| `instance-agent` (profile `fleet`) | agent image (`JOSHU_INSTANCE_AGENT_IMAGE_REF`) |
| `voice-realtime` (profile `voice-rt`) | voice image (`JOSHU_VOICE_IMAGE_REF`) |

The host keeps only configuration (`/etc/joshu`), the Docker volumes, the host bundle, the hotfix overlay, and backups. Compose mounts **no host code** into `joshu-stack`. The one exception is the hotfix overlay `/opt/joshu/hotfix/scripts/`: at boot, `vps-start.sh` copies those files over the image scripts (`bash scripts/hotpatch-boot.sh root@host <path>`). Each upgrade empties the hotfix overlay.

The host bundle is in the sandbox image at `/opt/joshu/.image/host/`: `deploy/docker-compose.yml`, `deploy/.env.vps.example`, the Caddy scripts, `install-host-bundle.sh`, `ensure-instance-env-secrets.sh`, and `scripts/arozos-reset-password*`. `/opt/joshu/deploy/.host-bundle.json` records its release. The compose file sets the project name `deploy`, so the volume names stay `deploy_joshu_*` and `deploy_caddy_*`.

| You changed | Update path |
| --- | --- |
| Anything in the image (`src/`, skills, `factory/`, ArozOS overlays, `public/`, templates, Hermes plugins, `deploy/Dockerfile`) | New release images → upgrade (below) |
| One boot or bridge script, urgent | `bash scripts/hotpatch-boot.sh root@host <path>` (hotfix overlay), then the next release |
| New Hermes crons (e.g. proactive tick) | **`bash scripts/repair-fleet-ea-cron-timezone.sh`** after upgrade — crons are not in the image |

Upgrade one box over SSH (also the first upgrade of a box that still has a git clone at `/opt/joshu`):

```bash
bash scripts/upgrade-fleet-box-image.sh root@host <version>
```

The script pulls the three images, moves an old clone at `/opt/joshu` aside (and removes credentials from its git remote URLs), writes the host bundle, empties the hotfix overlay, writes the release pins to `instance.env`, and recreates the services. Fleet boxes with the instance agent get the same steps from a control plane release update — see [instance-agent-protocol.md](../docs/vps-sandbox/instance-agent-protocol.md). Read-only check of a box: `bash scripts/audit-box-runtime-drift.sh <slug>`.

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
- [docs/vps-sandbox/README.md](../docs/vps-sandbox/README.md) — VPS / Docker index
- [docs/vps-sandbox/runtime-topology.md](../docs/vps-sandbox/runtime-topology.md) — process layout, paths, boot order
- [docs/vps-sandbox/instance-agent-protocol.md](../docs/vps-sandbox/instance-agent-protocol.md) — optional fleet sidecar (heartbeats, release updates)
- [docs/vps-sandbox/control-plane.md](../docs/vps-sandbox/control-plane.md) — proprietary managed hosting (not in this repo)
