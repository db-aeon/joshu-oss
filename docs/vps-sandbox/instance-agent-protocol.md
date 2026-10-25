# Instance Agent Protocol

The **instance agent** runs on each customer VPS alongside the Joshu stack. It registers with the control plane, reports health, and applies signed operational commands (update, restart, rotate secrets). It also answers read-only diagnostics commands for post-release checks.

Implementation: [`packages/instance-agent/`](../../packages/instance-agent/). The agent runs from the **agent image** of the release (`joshu-instance-agent:<version>`, pin `JOSHU_INSTANCE_AGENT_IMAGE_REF`). It runs no code from the host and does not use git. It mounts `/opt/joshu` only to write the host bundle and to report runtime drift.

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
| `POST` | `/instances/box-password-reset` | Agent | Box login asked to email a desktop password reset; CP mails the owner. Always `{ ok: true }`. |
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
| `POST` | `/admin/instances/:id/diagnostics` | Queue a read-only diagnostics command (`:id` can be the box slug). Header `x-admin-key`, or `x-diagnostics-key` for the boxes in `DIAGNOSTICS_KEY_BOXES` |
| `GET` | `/admin/instances/:id/diagnostics/:jobId` | State and answers of a diagnostics command |
| `POST` | `/admin/releases` | Register `deploy/RELEASE.json` of a release tag as a Release (deploy workflow) |
| `POST` | `/admin/fleet-rollout` | Queue release updates for a batch of boxes |
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
    "voiceGateway": { "ok": true, "optional": true },
    "runtimeDrift": { "ok": true, "checkedAt": "2026-10-08T10:00:00.000Z", "items": [] }
  },
  "host": {
    "uptimeSec": 86400,
    "diskUsedPct": 42,
    "memUsedPct": 61
  }
}
```

`components` is the `components` object of `/joshu/api/instance/health`, plus `runtimeDrift`, which the agent adds. `runtimeDrift.items` lists each difference between the box and its release images: `host_mount` (a host path that compose mounts into `joshu-stack` at or below `/opt/joshu`, other than the hotfix overlay), `host_checkout` (`/opt/joshu/.git` exists), `hotfix_file` (a file in `/opt/joshu/hotfix/scripts/`), and `host_bundle_version` (`/opt/joshu/deploy/.host-bundle.json` is missing or has another release). The agent scans every 10 minutes. `runtimeDrift` never changes `healthy` or `readyForUpdate`.

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
        "requiresSnap": true
      }
    }
  ]
}
```

### Command types

| type | Payload | Agent behavior |
| --- | --- | --- |
| `update` | `{ imageRef, version, voiceImageRef?, instanceAgentImageRef?, hermesRef?, requiresSnap? }` | Two steps (see [Release update steps](#release-update-steps)): prepare (host bundle + agent image, restart the agent), then apply (optional GCS snap, patch `instance.env`, `pull` + `up -d --force-recreate` for `joshu-stack`, and for `voice-realtime` when `JOSHU_VOICE_MODE=realtime_s2s`; wait for `/joshu/api/instance/health`). The agent ignores the old fields `hostGitRequired`, `repoRef`, and `syncDistFromImage`. |
| `rollback` | `{ imageRef, version? }` | Same as `update` (restores `rollbackImageRef` from control plane) |
| `restart` | `{ services?: string[] }` | `docker compose restart` subset or all |
| `rotate_secrets` | `{ secrets: { KEY: "value" } }` | Patch `/etc/joshu/instance.env` via `scripts/patch-instance-env.mjs`, copy the Joshu state of the running stack into its volume (see [Release update steps](#release-update-steps)), recreate `joshu-stack` (+ `voice-realtime` when S2S enabled), wait for health. `dist/` comes only from the sandbox image, so a recreate cannot load a mixed `dist/`. |
| `sync_companion_identity` | `{ joshuName?, joshuImageUrl?, joshuAvatarUrl?, joshuVoiceId?, ownerDisplayName?, ownerEmail?, companionSoulMd? }` | Write `instance.env` + `/etc/joshu/secrets/companion-soul.md`, then `POST /joshu/api/instance/sync-companion-identity` (localhost, `forceSoul: true`); when `joshuVoiceId` is set and voice S2S is enabled, **`force-recreate voice-realtime`** so the new timbre loads. **`formatEnvValue()`** quotes values with spaces (e.g. `JOSHU_OWNER_NAME="Susan Paley"`) so `source instance.env` does not fail |
| `send_owner_email` | `{ sendId, flowKey, to, subject, bodyPlain, llmModel?, generatedAt? }` | `POST /joshu/api/instance/send-owner-email` (localhost-only). Sends via the box Nylas agent mailbox (`{slug}@joshu.me`) with companion HTML signature; **bypasses action guard**. Recipient must match box owner email. Subject + body go through [telephone placeholder substitution](#owner-email-placeholders) first. Ack may include `result: { messageId, from, placeholders }`. |
| `desktop_login` | `{ adminEmail }` | `POST /joshu/api/desktop-login/code` (localhost-only). Ack `result: { url, expiresAt }`: a one-time link `https://<box>/system/auth/joshu-login?code=…` that signs the browser in as the box owner for one hour. The link works one time, within 2 minutes. Changes nothing else on the box: the owner password and the owner sessions stay. The control plane sends the admin to the link and writes an audit log entry. |
| `set_aroz_password` | `{ username, passwordHash, resetTokenId? }` | Brief `joshu-stack` **stop** (not `--force-recreate`), write `passhash/<JOSHU_AROZ_USER>` in `ao.db` from a SHA-512 hex `passwordHash`, rotate `auth/sessionkey` in the same Bolt tx, then start. Agent refuses if `username` does not match `JOSHU_AROZ_USER`. Hash is scrubbed from `ProvisionJob.payload` on ack. Queued as `ProvisionJob.type = update` with `payload.commandType = set_aroz_password` — **not** `commandType: update` (that auto-rollbacks) and **not** `rotate_secrets`. Does not set `Instance.status = updating`. |
| `diagnostics` | `{ queries: [{ query, args }] }` (1 to 10 queries) | Read-only answers for post-release checks: `version`, `health`, `containers`, `logs`, `cron_jobs`, `kanban`, `realtime_goals`, `hermes_config`, `env_keys`, `skills`, `joshu_api`. The agent rejects an unknown query or argument, runs nothing from the payload, opens SQLite read-only, and shows no secret value. Ack has `result: { answers: [{ query, ok, data \| error, truncated? }] }`; the control plane keeps the result on the job. Queued as `ProvisionJob.type = update` with `payload.commandType = diagnostics`; does not set `Instance.status = updating`. The control plane fails the command after 10 minutes without an ack. Code: `packages/instance-agent/src/diagnostics.ts`. |

Public desktop is **502 / connection refused for ~2 minutes** while the stack reboots (ArozOS comes up before Joshu `:8788`). That is not a host crash. After a **completed** apply, old ArozOS cookies are invalid — log in with the new desktop password. Hermes health can stay 503 until MCP boot finishes.

**`rotate_secrets` caveats (2026-09):**

- **`instance.env` bind-mount:** compose must mount **`/etc/joshu` directory**, not `/etc/joshu/instance.env` as a single file. A file bind can leave the agent writing a stale inode while `docker compose --env-file` reads the host file — CP job shows success but running stack keeps old secrets. SSH fallback: `scripts/rotate-exposed-vendor-keys.ts` or `scripts/apply-rotate-secrets-from-job.ts`.
- **`releaseVersion` mismatch:** agent compares heartbeat `releaseVersion` to `JOSHU_RELEASE_VERSION` in its boot env. If the container was not recreated after `instance.env` changed, health wait can time out (600s). Recreate **instance-agent** after patching env on the host.

**`ao.db` visibility:** instance-agent has docker.sock + `/opt/joshu`, not `/var/lib/docker`. [`scripts/arozos-reset-password.sh`](../../scripts/arozos-reset-password.sh) is part of the host bundle (`/opt/joshu/scripts/` on the host), because it mounts its Go source into a container through the Docker socket. It must mount the **named volume** (`deploy_joshu_arozos` or `joshu_arozos`) at `/aroz` and write `/aroz/system/ao.db`. Using `docker volume inspect` host paths inside the agent fails with `ao.db not found` (first confirm **2026-08-18** — CP queued the job, hash never written, old login still valid). SSH on the VPS may still pass `AO_DB=` to that host path.

**Share Chat after bounce:** stop/start does not delete host `dist/`. On **0.1.40** boxes that never received the `dist/shareChat/ui/` overlay, guests still 500 `Share chat UI missing` after the bounce — overlay that file (no recreate). See troubleshooting #19b2.
| `collect_logs` | `{ sinceMinutes: 60 }` | Tar logs → presigned upload URL (future) |
| `deprovision` | `{}` | Stop stack, signal control plane, wipe optional |

### Owner email placeholders

The control plane cannot read a box's live telephone settings — the heartbeat is box-initiated, and the owner can change the unlock passphrase at any time in the Telephone app. So CP-composed copy references those facts as tokens and the box substitutes them in `subject` + `bodyPlain` immediately before sending (`src/telephoneSettings/emailPlaceholders.ts`):

| Placeholder | Live value |
| --- | --- |
| `{{phone_number}}` | `readTelephoneStatus().phoneNumberDisplay`, e.g. `+1 (762) 583-9074` |
| `{{phone_number_e164}}` | `readTelephoneStatus().phoneNumber`, e.g. `+17625839074` |
| `{{think_passphrase}}` | `readTelephoneStatus().thinkPassword` — the same value `voice-realtime` enforces |

Matching is case-insensitive and tolerates inner whitespace. If a placeholder is unknown, or known but unset on this box, the route returns **422 `unresolved_placeholders`** and sends nothing — a failed command beats an email quoting a wrong or empty passphrase. The ack reports only the placeholder *names* that were filled, so the passphrase never reaches the control plane; `BoxOwnerEmailSend.bodyPlain` in Supabase keeps the raw `{{…}}` tokens.

### Signature verification

```
message = `${commandId}:${type}:${issuedAt}:${canonicalJson(payload)}`
expected = HMAC_SHA256(INSTANCE_AGENT_SIGNING_SECRET, message)
```

Agent rejects commands with skewed `issuedAt` > 5 minutes or invalid signature.

### Release manifest (`Release.manifest`)

| Field | Purpose |
| --- | --- |
| `hostGitRequired`, `syncDistFromImage`, `repoRef` | Old fields. The agent image ignores them: there is no git checkout and no host `dist/` on the box. |
| `requiresSnap` | When `true` (default) and `JOSHU_SNAPSHOT_GCS_BUCKET` is set, agent POSTs `/joshu/api/box/snap` before pulling the image |
| `changelog` | Operator notes (not consumed by agent) |
| `voiceImageRef` | Optional explicit GHCR ref; default derives `joshu-oss:tag` → `joshu-oss-voice-realtime:tag` |
| `instanceAgentImageRef` | Optional explicit GHCR ref; default derives `joshu-sandbox:tag` → `joshu-instance-agent:tag` (`joshu-oss:tag` → `joshu-oss-instance-agent:tag`) |

### Release update steps

1. **Prepare** (the running agent): pull the sandbox image and the agent image of the target release (a failed pull stops the update before any change), run `install-host-bundle.sh` from the sandbox image (writes `/opt/joshu/deploy/` and `.host-bundle.json`, keeps a backup in `/opt/joshu/backups/`, empties the hotfix overlay), write `JOSHU_INSTANCE_AGENT_IMAGE_REF` to `instance.env`, write `/etc/joshu/secrets/pending-release-update.json`, and start the agent replace helper (below), which recreates only `instance-agent` (`--no-deps`).
2. **Apply** (the new agent, on the new agent image): read the pending update file without a call to `register`, take the optional GCS snapshot, write the release pins (`JOSHU_IMAGE_REF`, `JOSHU_RELEASE_VERSION`, `JOSHU_VOICE_IMAGE_REF`, `JOSHU_INSTANCE_AGENT_IMAGE_REF`), pull the stack services, copy the Joshu state of the running stack into its volume, recreate the stack services, wait for health, remove old release images, and ack.

The agent cannot recreate its own container. Compose creates the new container first and then stops the old one, and a compose process in the old agent container dies with that stop, so the new container would stay in state `Created`. The agent therefore starts the agent replace helper (`packages/instance-agent/src/agentReplace.ts`): a container named `joshu-agent-replace`, from the agent image of the target release, with entrypoint `docker`, that runs `compose -f /opt/joshu/deploy/docker-compose.yml --env-file /etc/joshu/instance.env up -d --no-deps --force-recreate instance-agent`. The helper mounts the Docker socket, `/opt/joshu`, and `/etc/joshu` read-only at the same paths, and gets only `JOSHU_COMPOSE_ENV_FILE`, `COMPOSE_PROFILES`, and `COMPOSE_PROJECT_NAME` from the agent, so it holds no secret. The helper is not part of the compose project, so it keeps running when compose stops the old agent. The old agent waits and polls the helper every 2 seconds. When the helper exits while the old agent still runs, or the helper still runs after 5 minutes, the old agent removes the helper and the pending update file, and fails the command with the last 40 lines of the helper log. The control plane then queues the usual rollback.

The new agent starts in this order when the pending update file exists: it logs `pending update file found; skipping register`, resumes and acks the update, removes the stopped helper (`removed the agent replace helper joshu-agent-replace`), and then starts the heartbeat loop. It skips `register` because the control plane sets the status `bootstrapping` on each `register`, and the deploy workflow reads that status on the old release as a rollback while the apply step runs. Without a pending update file, the agent calls `register` and then starts the heartbeat loop. An agent before change `agent-self-replace` still recreates itself in its own container, so the update away from such an agent can stall; upgrade the box once over SSH.

The copy runs the host bundle script `deploy/scripts/carry-over-joshu-state.sh` with `docker compose exec -T joshu-stack sh -c` in the old stack container (`packages/instance-agent/src/stateCarryOver.ts`). Releases up to 0.1.56 kept the team rooms and memberships, the proactive state, browser handoffs, SMS sessions, and the metered provider keys in `/opt/joshu/.joshu`, in the writable layer of the container, so a recreate lost them. The script copies each of these entries to the Joshu state folder `/var/lib/arozos/joshu-state` (volume `joshu_arozos`) when the folder does not have it yet. The agent logs `joshu state carry-over: copied teams; ...`. A failure (for example a stack that is down) logs a warning and does not stop the update. `rotate_secrets` runs the same copy before its recreate.

The agent removes old release images with `/opt/joshu/deploy/scripts/prune-release-images.sh` from the host bundle, only after the stack is healthy. For each repository of the current release images, the script keeps the current release, the newest other image (the previous release, for a rollback), and each image that a container uses. It removes the other images of those repositories and the dangling images. A failure of the script is a warning in the agent log, not a failed update. `JOSHU_PRUNE_RELEASE_IMAGES=0` in `instance.env` turns the cleanup off; `DRY_RUN=1 bash /opt/joshu/deploy/scripts/prune-release-images.sh` on the host lists what the script would remove. `scripts/lib/upgrade-box-remote.sh` runs the same script after an upgrade over SSH.

A box that still has a git clone at `/opt/joshu` runs an older agent that uses git. Upgrade such a box once over SSH with `scripts/upgrade-fleet-box-image.sh`, not with an `update` command.

### Rollback

Before queuing an `update`, the control plane stores the previous `deployedImageRef` on `Instance.rollbackImageRef`. If the update job acks `failed`, a `rollback` command is auto-queued with that image tag.

**Agent behavior:** Rollback runs the same two steps as `update` with the rollback image, and skips the GCS pre-update snapshot. The rollback release must have a host bundle and an agent image; a rollback to an older release needs SSH. Post-recreate health wait defaults to **600s** (`INSTANCE_AGENT_HEALTH_WAIT_MS`) because Hermes MCP boot can exceed 5 minutes.

### GHCR pull auth (instance-agent)

Cloud-init runs `docker login ghcr.io` on the **host** (`/root/.docker/config.json`). The agent runs `docker compose pull` from **inside** the `instance-agent` container via the host socket; the Docker CLI reads **`~/.docker/config.json` in the container**, not on the host.

**Required:** `deploy/docker-compose.yml` bind-mounts **`/root/.docker:/root/.docker:ro`** on `instance-agent`. Without it, admin **Update release** fails with `error from registry: unauthorized` while manual `docker pull` on the host still works. Cloud-init bootstrap fails if this mount is missing from compose.

**Fresh creds on update (2026-06):** The control plane injects `registryAuth` into signed **update/rollback** command payloads at heartbeat delivery (not stored in the job row). The agent runs `docker login` before `compose pull` and persists `/etc/joshu/secrets/ghcr-read.env`. New provisions seed that file at bootstrap.

**Writable copy of the Docker config (0.1.53):** The mount is read-only, and `docker login` must write `config.json`. Before the login, the agent copies the host `config.json` to `/tmp/joshu-docker-config` in its container and sets `DOCKER_CONFIG` to that folder (`useWritableDockerConfig` in `registryAuth.ts`). Each later `docker` and `docker compose` command of the agent inherits the variable. The host file does not change. An agent before 0.1.53 fails each update with `docker login failed (1): error saving credentials: … read-only file system`, so a box with such an agent needs one upgrade over SSH (`scripts/upgrade-fleet-box-image.sh`).

**Preflight:** Instance-agent calls `ensureRegistryLoginForUpdate()` before pull. Heartbeat reports `host.registryAuthOk`.

### Admin `deployedImageRef` vs heartbeat version

`Instance.deployedImageRef` updates only on a successful update **ack**. Manual hotpatches and failed updates can leave admin showing an old tag (e.g. `0.1.13`) while heartbeat `releaseVersion` / `host.imageRef` report the running box (e.g. `0.1.18`).

**Mitigation:** Heartbeat reconciles `deployedImageRef` from `host.imageRef` when the box is healthy and no update job is in flight.

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

Cloud-init sets `JOSHU_INSTANCE_ID` and `INSTANCE_AGENT_TOKEN` in `/etc/joshu/instance.env`. Agent calls `register` once at each start, except a start that resumes a pending release update; control plane marks instance `bootstrapping` → `active` when first healthy heartbeat arrives.

## Failure modes

| Symptom | Control plane action |
| --- | --- |
| No heartbeat 5 min | Alert + mark `degraded` |
| Update ack failed | Rollback command auto-queued |
| Health 503 + `components.dist.status=drift` during/after update | `JOSHU_RELEASE_VERSION` in `instance.env` is not the release of the running sandbox image — align the release pins in `instance.env` and recreate `joshu-stack` |
| `runtimeDrift.ok` false | Read `runtimeDrift.items`. `hotfix_file`: put the fix in a release, then upgrade (the upgrade empties the hotfix overlay). `host_mount`, `host_checkout`, `host_bundle_version`: upgrade the box with `scripts/upgrade-fleet-box-image.sh` |
| `instance-agent` container `Created` or missing after update | The old agent recreated itself in its own container (an agent before change `agent-self-replace`), or the agent replace helper died after compose stopped the old agent. Read `docker logs joshu-agent-replace`, remove both agent containers, and run `docker compose -f /opt/joshu/deploy/docker-compose.yml --env-file /etc/joshu/instance.env up -d --no-deps instance-agent` on the host; the new agent resumes `pending-release-update.json` |
| Update ack failed with `agent replace helper ended` or `agent replace helper still ran` | The helper could not recreate the agent, and the old agent still runs. The error has the helper log. The control plane queues a rollback |
| Deprovision ack | `terminated`, delete DNS, release Twilio number |
| Stack crash-loop after companion sync; `instance.env: line N: Last: command not found` | Owner display name with spaces must be quoted in `instance.env` — fix the env file and recreate the stack |
