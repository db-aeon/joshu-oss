# Instance Agent Protocol

The **instance agent** runs on each customer VPS alongside the Joshu stack. It registers with the control plane, reports health, and applies signed operational commands (update, restart, rotate secrets).

Implementation: [`packages/instance-agent/`](../../packages/instance-agent/)

## Authentication

- Each `Instance` row stores `agentTokenHash` (bcrypt of a random `INSTANCE_AGENT_TOKEN`).
- Agent sends header: `Authorization: Bearer <token>`
- Control plane API validates token → resolves `instanceId`.

## Endpoints (control plane)

Base URL: `https://admin.example.com/api` (Vercel)

| Method | Path | Caller | Purpose |
| --- | --- | --- | --- |
| `POST` | `/instances/register` | Agent (first boot) | Body: `{ instanceId, hostname, releaseVersion, vpsIpv4? }` → `{ ok, pollIntervalSec }` |
| `POST` | `/instances/heartbeat` | Agent (every 30s) | Body: see below → `{ ok, commands[] }` |
| `GET` | `/instances/:id/commands/:commandId` | Agent | Fetch full command payload after heartbeat hint |

Admin-only (session auth):

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/admin/instances` | List sandboxes |
| `GET` | `/admin/instances/:id` | Inspect sandbox, jobs, recent heartbeats |
| `PATCH` | `/admin/instances/:id` | Update admin-owned metadata/status fields |
| `DELETE` | `/admin/instances/:id?force=true` | Queue or force teardown |
| `POST` | `/admin/instances/:id/provision` | Queue create job |
| `POST` | `/admin/instances/:id/update` | Queue release update |
| `POST` | `/admin/instances/:id/destroy` | Teardown |
| `POST` | `/admin/instances/:id/recreate` | Reset agent token and queue a fresh create job |

## Heartbeat body

```json
{
  "instanceId": "clx...",
  "reportedAt": "2026-05-20T18:00:00.000Z",
  "releaseVersion": "0.2.0",
  "healthy": true,
  "components": {
    "joshu": { "ok": true, "url": "http://127.0.0.1:8788/joshu/api/instance/health" },
    "camofox": { "ok": true },
    "hermes": { "ok": true },
    "hindsight": { "ok": true },
    "arozos": { "ok": true },
    "voiceGateway": { "ok": true, "optional": true }
  },
  "host": {
    "uptimeSec": 86400,
    "diskUsedPct": 42,
    "memUsedPct": 61
  }
}
```

Control plane persists `Instance.lastHealth`, appends optional `Heartbeat` row, updates `lastHeartbeatAt`. If `healthy === false` for 3 consecutive heartbeats → `Instance.status = degraded`.

## Commands (control plane → agent)

Returned inline from heartbeat response (max 1 in-flight per type):

```json
{
  "commands": [
    {
      "id": "cmd_abc",
      "type": "update",
      "issuedAt": "2026-05-20T18:00:05.000Z",
      "signature": "hmac-sha256-hex...",
      "payload": {
        "commandType": "update",
        "imageRef": "ghcr.io/org/joshu-sandbox:0.2.1",
        "hermesRef": "498bfc7...",
        "version": "0.2.1",
        "hostGitRequired": false,
        "repoRef": "main",
        "requiresSnap": true
      }
    }
  ]
}
```

### Command types

| type | Payload | Agent behavior |
| --- | --- | --- |
| `update` | `{ imageRef, voiceImageRef?, hermesRef?, version?, hostGitRequired?, syncDistFromImage?, repoRef?, requiresSnap? }` | Optional GCS snap; optional `git pull` in `/opt/joshu`; **`syncDistFromImage`** (default true) copies `dist/` from pulled image to host mount; patch `instance.env` (`JOSHU_IMAGE_REF`, **`JOSHU_VOICE_IMAGE_REF`**); `pull` + `up -d --force-recreate` for `joshu-stack`; when `JOSHU_VOICE_MODE=realtime_s2s`, **`pull` + `--force-recreate voice-realtime`** from GHCR (profile `voice-rt`); wait for `/joshu/api/instance/health` (includes `components.dist`) |
| `rollback` | `{ imageRef, version? }` | Same as `update` (restores `rollbackImageRef` from control plane) |
| `restart` | `{ services?: string[] }` | `docker compose restart` subset or all |
| `rotate_secrets` | `{ secrets: { KEY: "value" } }` | Write `/etc/joshu/instance.env`, restart joshu |
| `sync_companion_identity` | `{ joshuName?, joshuImageUrl?, joshuAvatarUrl?, joshuVoiceId?, ownerDisplayName?, ownerEmail?, companionSoulMd? }` | Write `instance.env` + `/etc/joshu/secrets/companion-soul.md`, then `POST /joshu/api/instance/sync-companion-identity` (localhost, `forceSoul: true`); when `joshuVoiceId` is set and voice S2S is enabled, **`force-recreate voice-realtime`** so the new timbre loads. **`formatEnvValue()`** quotes values with spaces (e.g. `JOSHU_OWNER_NAME="Susan Paley"`) so `source instance.env` does not fail |
| `collect_logs` | `{ sinceMinutes: 60 }` | Tar logs → presigned upload URL (future) |
| `deprovision` | `{}` | Stop stack, signal control plane, wipe optional |

### Signature verification

```
message = `${commandId}:${type}:${issuedAt}:${canonicalJson(payload)}`
expected = HMAC_SHA256(INSTANCE_AGENT_SIGNING_SECRET, message)
```

Agent rejects commands with skewed `issuedAt` > 5 minutes or invalid signature.

### Release manifest (`Release.manifest`)

| Field | Purpose |
| --- | --- |
| `hostGitRequired` | When `true`, agent runs `git fetch/checkout/pull` in `/opt/joshu` before compose (updates bind-mounted `vps-start.sh`) |
| `syncDistFromImage` | When `true` (default), after `docker compose pull` the agent copies `/opt/joshu/dist` (and `packages/box-state/dist`) from the pulled image onto the host bind mount and writes `dist/.release-provenance.json`. Prevents stale host `dist/` from shadowing the image. **`instance.env` is patched only after dist sync succeeds** (same target version) so rollback cannot leave env at N−1 while dist stays at N. |
| `repoRef` | Git ref to checkout (default: control-plane `JOSHU_REPO_REF`, usually `main`) |
| `requiresSnap` | When `true` (default) and `JOSHU_SNAPSHOT_GCS_BUCKET` is set, agent POSTs `/joshu/api/box/snap` before pulling the image |
| `changelog` | Operator notes (not consumed by agent) |
| `voiceImageRef` | Optional explicit GHCR ref; default derives `joshu-sandbox:tag` → `joshu-voice-realtime:tag` |

### Rollback

Before queuing an `update`, the control plane stores the previous `deployedImageRef` on `Instance.rollbackImageRef`. If the update job acks `failed`, a `rollback` command is auto-queued with that image tag.

**Agent behavior (2026-06):** Rollback skips the GCS pre-update snapshot, syncs host `dist/` from the rollback image **before** patching `instance.env`, then recreates `joshu-stack`. Post-recreate health wait defaults to **600s** (`INSTANCE_AGENT_HEALTH_WAIT_MS`) because Hermes MCP boot can exceed 5 minutes.

### GHCR pull auth (instance-agent)

Cloud-init runs `docker login ghcr.io` on the **host** (`/root/.docker/config.json`). The agent runs `docker compose pull` from **inside** the `instance-agent` container via the host socket; the Docker CLI reads **`~/.docker/config.json` in the container**, not on the host.

**Required:** `deploy/docker-compose.yml` bind-mounts **`/root/.docker:/root/.docker:ro`** on `instance-agent`. Without it, admin **Update release** fails with `error from registry: unauthorized` while manual `docker pull` on the host still works. Cloud-init bootstrap fails if this mount is missing from compose.

**Fresh creds on update (2026-06):** The control plane injects `registryAuth` into signed **update/rollback** command payloads at heartbeat delivery (not stored in the job row). The agent runs `docker login` before `compose pull` and persists `/etc/joshu/secrets/ghcr-read.env`. New provisions seed that file at bootstrap.

**Preflight:** Instance-agent calls `ensureRegistryLoginForUpdate()` before pull. Heartbeat reports `host.registryAuthOk`.

### Admin `deployedImageRef` vs heartbeat version

`Instance.deployedImageRef` updates only on a successful update **ack**. Manual hotpatches and failed updates can leave admin showing an old tag (e.g. `0.1.13`) while heartbeat `releaseVersion` / `host.imageRef` report the running box (e.g. `0.1.18`).

**Mitigation:** Heartbeat reconciles `deployedImageRef` from `host.imageRef` when the box is healthy and no update job is in flight (control-plane deploy required). See [troubleshooting §19c–19d](troubleshooting-and-lessons.md).

## Joshu instance health API

Joshu exposes deep health for the agent (no auth on localhost; agent only):

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/instance/health` | Version, component booleans, update readiness |
| `GET` | `/api/instance/version` | `{ version, hermesRef, imageRef, channel }` |

Mounted under `PUBLIC_BASE_PATH` (e.g. `/joshu/api/instance/health`).

## Polling loop (agent)

```
every POLL_INTERVAL_SEC (default 30):
  health = GET joshu /api/instance/health
  POST control-plane /instances/heartbeat
  for cmd in response.commands:
    verify signature
    execute cmd
    POST control-plane /instances/commands/:id/ack { status, error? }
```

## First-boot registration

Cloud-init sets `JOSHU_INSTANCE_ID` and `INSTANCE_AGENT_TOKEN` in `/etc/joshu/instance.env`. Agent calls `register` once; control plane marks instance `bootstrapping` → `active` when first healthy heartbeat arrives.

## Failure modes

| Symptom | Control plane action |
| --- | --- |
| No heartbeat 5 min | Alert + mark `degraded` |
| Update ack failed | Rollback command auto-queued |
| Health 503 + `components.dist.status=drift` during/after update | Release state mismatch (`instance.env` vs `dist/` provenance vs image) — see [troubleshooting §19f](troubleshooting-and-lessons.md) |
| `instance-agent` container `Created` or missing after update | Self-restart race during `prepareAgentThenRestart` — `compose up -d --no-deps instance-agent`; check `pending-release-update.json` |
| Deprovision ack | `terminated`, delete DNS, release Twilio number |
| Stack crash-loop after companion sync; `instance.env: line N: Last: command not found` | Owner display name unquoted in `instance.env` on boxes with pre-quote instance-agent — fix manually and redeploy agent image; see [troubleshooting](troubleshooting-and-lessons.md#admin-create-sandbox--companion--boot-pitfalls-2026-06) |
