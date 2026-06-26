# Joshu box state (snapshots & factory profile)

Joshu boxes have two layers of state:

| Layer | Where you define it | Storage |
|-------|---------------------|---------|
| **Factory** | Repo: [`factory/manifest.yaml`](../factory/manifest.yaml), [`templates/`](../templates/), [`integrations/hermes/`](../integrations/hermes/) | Git |
| **Personal** | Use the box (files, chat memory, Hermes voice/personalities) | `.local/*`, `~/.hermes/config.user.yaml` |

Provision secrets (`instance.env` on VPS) are a third layer — not included in user snapshots.

## CLI

```bash
# Show factory vs personal paths and existing snapshots
npm run box -- status

# List snapshots
npm run box -- list

# Checkpoint personal state (include gbrain index for full local setup)
npm run box -- snap --label local-setup --include-gbrain

# Restore a snapshot (then soft factory-apply)
npm run box -- restore --id 2026-06-01T12-00-00-000Z

# Restore a shared snapshot from GCS (e.g. on a new box)
npm run box -- restore --id 2026-06-01T12-00-00-000Z --from-box shared

# Save a snapshot as shared (restorable on any new box)
npm run box -- snap --label seed-setup --shared --include-gbrain

# Re-apply factory seeds without wiping personal data
npm run box -- factory-apply

# Hard reset personal state (requires --confirm)
npm run box -- factory-reset --mode hard --confirm
```

Snapshots are stored in **Google Cloud Storage** when configured, with a local cache under `.local/snapshots/` (`JOSHU_SNAPSHOT_DIR` to override). Without GCS, only local storage is used.

### Owner email = snapshot namespace

**Owner email** is the person who uses the box — the same value as **Owner email** on Create Sandbox, `JOSHU_AROZ_USER` on the VPS, and the ArozOS login email. Snapshots for that person live under:

```text
gs://<bucket>/boxes/<owner-email>/{snapshotId}.tar.gz
```

Use the **same owner email** on every box for that customer so reprovisioned VPS hosts can list and restore prior snapshots. Do **not** use `JOSHU_INSTANCE_ID` (changes per droplet) as the snapshot prefix.

### GCS setup (local dev)

1. Create a bucket in your GCP project (e.g. `aeon-joshu-box-snapshots`).
2. Grant the service account **Storage Object Admin** on that bucket.
3. Set credentials in **repo root `.env`**:

```bash
JOSHU_SNAPSHOT_GCS_BUCKET=aeon-joshu-box-snapshots
JOSHU_SNAPSHOT_BOX_ID=db@project-aeon.com   # your ArozOS login / owner email
JOSHU_SNAPSHOT_GCS_KEY_FILE=aeon-page-to-speech-config.json
# or: GOOGLE_APPLICATION_CREDENTIALS=…
# or reuse: HINDSIGHT_API_RERANKER_GOOGLE_SERVICE_ACCOUNT_KEY=…
```

Object layout: `boxes/{boxId}/{snapshotId}.tar.gz` and `.json`.

Use **`--shared`** (or `shared: true` in the API) to store under `boxes/shared/` so any new box can restore with `--from-box shared`.

Local cache (`JOSHU_SNAPSHOT_LOCAL_CACHE=true`, default) keeps a copy under `.local/snapshots/` for faster re-restore.

### GCS setup (VPS / control plane)

Set **one global bucket** in control-plane env — **not** a per-customer box id:

```dotenv
# apps/control-plane/.env.local (local) or Vercel env (production)
DEFAULT_JOSHU_SNAPSHOT_GCS_BUCKET=aeon-joshu-box-snapshots
```

At provision, `buildSandboxBootstrapEnv()` writes into `/etc/joshu/instance.env`:

| Var | Value |
|-----|--------|
| `JOSHU_SNAPSHOT_GCS_BUCKET` | from `DEFAULT_JOSHU_SNAPSHOT_GCS_BUCKET` |
| `JOSHU_SNAPSHOT_BOX_ID` | **Owner email** for that sandbox (same as `JOSHU_AROZ_USER`) |

GCS auth on the VPS reuses the Hindsight reranker service account already embedded at `/etc/joshu/secrets/google-reranker-service-account.json` — no separate snapshot key file is provisioned.

**Existing droplet** (provisioned before snapshot wiring): SSH and append to `/etc/joshu/instance.env`, then recreate the stack:

```bash
JOSHU_SNAPSHOT_GCS_BUCKET=aeon-joshu-box-snapshots
JOSHU_SNAPSHOT_BOX_ID=<owner-email>   # must match JOSHU_AROZ_USER
```

On the box: **Settings → Joshu → Box State**, or `npm run box -- list` / `restore` inside the container.

## HTTP API (local Joshu)

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/joshu/api/box/status` | Factory + personal summary |
| `GET` | `/joshu/api/box/snapshots` | List snapshot metadata |
| `POST` | `/joshu/api/box/snap` | `{ label?, includeGbrain?, shared? }` — localhost only |
| `POST` | `/joshu/api/box/restore` | `{ snapshotId, sourceBoxId? }` — localhost only |
| `POST` | `/joshu/api/box/factory-apply` | Soft factory apply |
| `POST` | `/joshu/api/box/factory-reset` | `{ mode: "soft"\|"hard", confirm?: true }` — hard mode returns `preflight` (Composio) and `postReset` (Hindsight, gbrain) |

Mutating snap/restore routes are **localhost-only** on the Joshu API. On VPS, use the System Setting UI or run the CLI inside the stack container.

## Hard factory reset

Hard reset returns the box to **factory defaults for personal state** while keeping product secrets (`instance.env`, repo factory seeds, Hermes managed keys in `config.yaml`). It is the same operation from **Settings → Joshu → Box State**, `POST /joshu/api/box/factory-reset`, or `npm run box -- factory-reset --mode hard --confirm`.

Soft factory apply (`factory-apply` / soft reset) only seeds missing templates and folders — it does **not** wipe personal data or show Welcome onboarding again.

### Order of operations (hard mode)

Hard reset runs steps in this order so cloud-backed services cannot immediately repopulate wiped local files:

1. **Composio preflight** — disconnect all connected accounts for the sandbox Composio `user_id` via `dist/boxHardResetHooks.js` (requires `COMPOSIO_API_KEY`); remove `.joshu/composio-session.json`; disable Composio MCP in `~/.hermes/config.yaml`. **Aborts** if disconnect fails when Composio is configured.
2. **Stop gbrain** — `stop-gbrain.sh` before wiping `GBRAIN_HOME` (avoids `EBUSY` on VPS where `/root/.gbrain` is a Docker volume mount).
3. **Local wipe** — remove personal trees (see table below); restore default `identity.json`.
4. **Desktop factory restore** — `bootstrap-joshu-files.sh` + `install_all_joshu_desktop_shortcuts` (Joshu app shortcuts, Welcome, Connectors, etc.).
5. **Hindsight** — `DELETE /v1/default/banks/{bankId}/memories` on the local Hindsight API (requires Hindsight healthy).
6. **gbrain** — `stop-gbrain.sh` → `start-gbrain.sh` → `start-gbrain-mcp-http.sh` (re-init PGLite contents and restart MCP HTTP on `:8794`).
7. **Soft factory apply** — re-seed missing templates and structure dirs under `joshu's files`.
8. **Hermes skills resync** (async) — `resyncHermesAfterBoxHardReset()` re-seeds `$HERMES_HOME/skills/joshu/` in **`overwrite`** mode (full factory copy), re-computes `skills.disabled` in `config.yaml`, restarts gateway. Companion persona (`SOUL.md`, `identity.json`) is **not** restored — use control-plane sync or `bash scripts/sync-local-portal-profile.sh` locally.

Implementation: [`packages/box-state/src/factory.ts`](../packages/box-state/src/factory.ts), [`postReset.ts`](../packages/box-state/src/postReset.ts), [`arozosDesktopRestore.ts`](../packages/box-state/src/arozosDesktopRestore.ts), [`connectorsWipe.ts`](../packages/box-state/src/connectorsWipe.ts), [`scripts/box-wipe-connectors.ts`](../scripts/box-wipe-connectors.ts), [`src/composioApi.ts`](../src/composioApi.ts) (`disconnectAllComposioConnections`), [`src/hermesApi.ts`](../src/hermesApi.ts) (`resyncHermesAfterBoxHardReset`).

### What hard reset clears

| Personal state | Location | Hard reset behavior |
|----------------|----------|---------------------|
| ArozOS Desktop + `.joshu/` | `{AROZ_DATA}/files/users/*/` | Wiped for **every** sandbox user (local dev may have `admin` + owner) |
| Connector mail/calendar mirrors | `joshu's files/connectors/` | Removed with Desktop wipe |
| Connector sync cursors | `connectors/_state/*.json` | Removed with Desktop wipe |
| Composio session pointer | `.joshu/composio-session.json` | Removed with Desktop wipe |
| Composio OAuth connections | **Composio cloud** (not on disk) | **Disconnected via Composio API** in preflight |
| Nylas agent grant pointer | `.joshu/nylas/agent.json` | Removed with Desktop wipe (Nylas cloud grant unchanged unless you revoke separately) |
| Hermes user config | `~/.hermes/config.user.yaml`, sessions, personalities, profiles, **`skills/`**, **`cron/`** | Wiped (agent-created skills and Welcome/EA cron jobs) |
| Hindsight conversation memory | Postgres (pg0 local / VPS Postgres) | Cleared via Hindsight API |
| gbrain file index | `GBRAIN_HOME` (VPS: `/root/.gbrain` volume) | **Contents** wiped (mount root kept); stack scripts re-init |
| Welcome onboarding | `.joshu/identity.json` | Reset to factory defaults from [`factory/manifest.yaml`](../factory/manifest.yaml) |
| Companion persona | `$HERMES_HOME/SOUL.md` | Wiped with Hermes home; re-synced from `/etc/joshu/secrets/companion-soul.md` on boot if provision secret remains — see [joshu-identity.md](joshu-identity.md) |

### What hard reset does **not** clear

| Layer | Why it survives |
|-------|----------------|
| `COMPOSIO_API_KEY`, `OPENROUTER_API_KEY`, etc. in `.env` / `instance.env` | Product / provision secrets — not personal |
| Hermes product keys in `~/.hermes/config.yaml` | Joshu-managed merge (model, toolsets, skills denylist, MCP URLs) |
| Repo product skills | `/opt/joshu/integrations/hermes/skills` (read-only in image) | Unchanged — not personal state |
| GCS snapshots | Intentional backup; restore explicitly with `box restore` |
| Composio **project** and billing | Only **connected accounts** for this sandbox `user_id` are deleted |

### Composio and synced mail (important)

OAuth tokens for Gmail/Slack/etc. are stored in **Composio cloud**, keyed by Composio **`user_id`**. On VPS, provision sets **`COMPOSIO_USER_ID=<customer-slug>`** (e.g. `patrick`) while ArozOS login remains **`JOSHU_AROZ_USER`** (owner email). Without `COMPOSIO_USER_ID`, every box with the same owner email shares the same Composio connections. Wiping local `.joshu/` alone does **not** revoke access.

Without the preflight disconnect step, the Joshu connector cron (`sync_composio_gmail`, every **10m**) would see accounts still connected in Composio and **re-download mail mirrors** into the freshly wiped Desktop tree — making it look like hard reset did nothing for connectors.

After a correct hard reset, Connectors shows no Gmail accounts until you OAuth again. See [`docs/connectors.md`](connectors.md#hard-factory-reset) and [`docs/hermes-chat-arozos-app.md`](hermes-chat-arozos-app.md#where-credentials-live).

### gbrain after hard reset

On VPS, `GBRAIN_HOME` is a **Docker volume mount** — hard reset wipes **contents** inside the volume, not the mount point itself (deleting the mount root returns `EBUSY`).

Hard reset stops gbrain before wipe, then post-reset scripts re-run boot init. If File Brain shows **502** on `/joshu/api/brain/pages` after reset:

- Symptom: `rows.slice is not a function` or PGLite “could not read blocks…” in `:8794/doctor`
- Fix: restart the stack (`npm run dev:arozos`) or manually: `bash scripts/stop-gbrain.sh && bash scripts/start-gbrain.sh && bash scripts/start-gbrain-mcp-http.sh` with `APP_DIR`, `GBRAIN_HOME`, and `.env` loaded

See [`docs/file-brain.md`](file-brain.md#troubleshooting).

### Hindsight after hard reset

Conversation memory is cleared via the Hindsight HTTP API (`HINDSIGHT_BANK_ID`, default `joshu`). If Hindsight is not running, the wipe is skipped (logged in `postReset.hindsight`) — restart Hindsight and run hard reset again, or call the clear endpoint manually. Local dev Postgres data lives at `~/.pg0/instances/hindsight` (port **5433**); hard reset clears **memories**, not the pg0 instance itself.

### Troubleshooting hard reset

| Symptom | Likely cause | Fix |
|--------|----------------|-----|
| Click **Hard reset…** does nothing | Semantic UI modal in jQuery-loaded fragment (pre-0.1.14) | Image **0.1.14+** uses native `confirm()` |
| `EBUSY: rmdir '/root/.gbrain'` | Tried to delete Docker volume mount root | Image **0.1.14+** wipes volume **contents** only |
| Composio still connected after reset | Preflight script imported missing `src/` on VPS | Image **0.1.14+** loads `dist/boxHardResetHooks.js`; reset aborts on disconnect failure |
| Desktop missing Joshu shortcuts | Wipe removes Desktop; boot-only install skipped | Image **0.1.14+** runs shortcut install in post-reset |
| Agent skills survive reset | `~/.hermes/skills/` not in wipe list (pre-0.1.14) | Image **0.1.14+** wipes `skills/` and `cron/` |
| All ~170 bundled Hermes skills enabled after reset or image upgrade | `skills.disabled` empty — denylist not re-merged or gateway not restarted | Joshu `ensureJoshuHermesConfig()` on gateway warm (VPS: `vps-start` nudge + `verify_hermes_skills_denylist`); hard reset triggers `resyncHermesAfterBoxHardReset()`; start a **new jChat** session |

### Manual connector disconnect (without full reset)

```bash
# Disconnect all Composio connected accounts for this sandbox user
npx tsx scripts/box-wipe-connectors.ts
```

Requires `COMPOSIO_API_KEY` and the same **`COMPOSIO_USER_ID`** (or legacy `JOSHU_AROZ_USER`) as the running stack — see [`src/composioApi.ts`](../src/composioApi.ts) `resolveComposioUserId()`.

## Environment reference

| Variable | Local (root `.env`) | Control plane (`.env.local` / Vercel) | VPS `instance.env` |
|----------|---------------------|----------------------------------------|---------------------|
| Bucket | `JOSHU_SNAPSHOT_GCS_BUCKET` | `DEFAULT_JOSHU_SNAPSHOT_GCS_BUCKET` | `JOSHU_SNAPSHOT_GCS_BUCKET` (from default) |
| Box id (owner) | `JOSHU_SNAPSHOT_BOX_ID` (your email) | *(auto)* | `JOSHU_SNAPSHOT_BOX_ID` = Owner email |
| Composio API | `COMPOSIO_API_KEY` | `DEFAULT_COMPOSIO_API_KEY` | `COMPOSIO_API_KEY` |
| Composio user | `COMPOSIO_USER_ID` (optional override) | *(auto)* | `COMPOSIO_USER_ID` = **customer slug** |
| Nylas API | `NYLAS_API_KEY` | `DEFAULT_NYLAS_API_KEY` | `NYLAS_API_KEY` |
| GCS key | `JOSHU_SNAPSHOT_GCS_KEY_FILE` or Hindsight SA path | SA file path for cloud-init embed only | `/etc/joshu/secrets/google-reranker-service-account.json` |
| Storage mode | `JOSHU_SNAPSHOT_STORAGE=auto\|gcs\|local` | `DEFAULT_JOSHU_SNAPSHOT_STORAGE` | optional |
| Local cache | `JOSHU_SNAPSHOT_LOCAL_CACHE` | `DEFAULT_JOSHU_SNAPSHOT_LOCAL_CACHE` | optional |

Implementation: [`packages/box-state/`](../packages/box-state/), provision wiring in [`apps/control-plane/src/lib/sandboxEnv.ts`](../apps/control-plane/src/lib/sandboxEnv.ts).

## System Setting UI (ArozOS)

Open **Settings** (System Setting) → sidebar **Joshu** → **Box State**.

Source: [`arozos/system-setting/box-state.html`](../arozos/system-setting/box-state.html) → synced to `web/SystemAO/joshu/` via `apply_arozos_joshu_theme.py`. The page is an **HTML fragment** (not a full document) so scripts run when loaded into System Settings. Hard reset uses a native browser `confirm()` dialog. After Go registration changes, restart `npm run dev:arozos` to rebuild the ArozOS binary.

## Factory manifest

Edit [`factory/manifest.yaml`](../factory/manifest.yaml) to change product defaults:

- **seeds** — copy from `templates/*` into `joshu's files` (`seed_if_missing`)
- **structure** — ensure folders exist (`journals/`, `research/`, …)
- **hermes.user_keys** — stored in `~/.hermes/config.user.yaml` and snapshotted
- **hermes.managed_keys** — merged by Joshu into `config.yaml` from product defaults

Boot applies factory via [`scripts/joshu-box-factory-apply.sh`](../scripts/joshu-box-factory-apply.sh) (called from [`bootstrap-joshu-files.sh`](../scripts/bootstrap-joshu-files.sh)).

## Snapshot contents

| Included (personal) | Excluded (factory / rebuildable) |
|---------------------|----------------------------------|
| ArozOS `files/users/<user>/` | `web/`, `subservice/` |
| `~/.hermes/config.user.yaml`, sessions, personalities, profiles, **skills**, **cron** | Product Hermes keys in `config.yaml` |
| Hindsight Postgres dump | gbrain PGLite (rebuilt on restore unless `--include-gbrain`) |
| `.joshu/identity.json`, Nylas profile, connector mirrors | `instance.env`, product Hermes keys, Composio **project** API key |

**Composio OAuth tokens** live in Composio cloud, not in snapshots. Snapshots include local mirrors and registry metadata; restoring a snapshot does **not** recreate Composio connections unless those accounts still exist in Composio for the same `user_id`. **Hard factory reset** explicitly disconnects Composio connected accounts — see [Hard factory reset](#hard-factory-reset).

**Local dev:** Hindsight uses embedded pg0 at `~/.pg0/instances/hindsight` (port **5433**). The CLI auto-detects this when `HINDSIGHT_API_DATABASE_URL` is unset. Keep Hindsight running during snap so `pg_dump` can connect.

## Hermes config split

Joshu separates **product** Hermes settings from **personal** ones so snapshots and factory reset can treat them differently.

| File | Source of truth for | Written by |
| --- | --- | --- |
| `~/.hermes/config.user.yaml` | Personal keys: `voice`, `stt`, `tts`, `profiles`, `personalities`, `messaging` | User / Hermes Admin / migration |
| `~/.hermes/config.yaml` (on disk) | **Merged view** Hermes reads (product + personal) | Joshu `writeMergedHermesConfig()` in [`src/hermesConfigSplit.ts`](../src/hermesConfigSplit.ts) |

On first gateway sync, Joshu migrates user-owned keys from a legacy monolithic `config.yaml` into `config.user.yaml` and strips them from the managed slice. Product keys (model, toolsets, MCP URLs, skills denylist, Camofox, …) are merged in [`ensureJoshuHermesConfig()`](../src/hermesApi.ts).

**Sync behavior (2026-06):** Joshu compares the merged config to what is already on disk and **skips the write** when nothing changed — health probes no longer rewrite `config.yaml` on every heartbeat. Writes use an in-process lock and atomic replace (temp file + rename). If `config.yaml` is corrupt, Joshu rebuilds product defaults, re-merges `config.user.yaml`, and repairs the file instead of bailing out.

See [hermes-customizations.md — Hermes runtime config](hermes-customizations.md#hermes-runtime-config-local-hermes-vs-vps--image) and [troubleshooting — corrupt config.yaml](vps-sandbox/troubleshooting-and-lessons.md#hermes-configyaml-on-vps-not-your-laptop-file).

## Tuning factory vs personal

The manifest is intentionally editable — adjust `seeds`, `structure`, and `hermes.user_keys` as you decide what belongs in factory. Re-run `npm run box -- factory-apply` after manifest changes.

Soft apply does not reset onboarding or personal state. For a full personal wipe, use hard factory reset (above).

Related: [`docs/joshu-identity.md`](joshu-identity.md), [`docs/file-brain.md`](file-brain.md), [`docs/connectors.md`](connectors.md), [`docs/hermes-customizations.md`](hermes-customizations.md), [`docs/welcome-onboarding.md`](welcome-onboarding.md), [`docs/vps-sandbox/zero-touch-provisioning.md`](vps-sandbox/zero-touch-provisioning.md), [`docs/vps-sandbox/control-plane-local-provisioning.md`](vps-sandbox/control-plane-local-provisioning.md).
