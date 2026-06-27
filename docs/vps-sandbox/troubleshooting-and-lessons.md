# VPS Sandbox Troubleshooting and Lessons Learned

This document captures issues found while bringing **DigitalOcean** sandboxes to parity with VPS/Hetzner: ArozOS desktop, Hermes chat, and Hindsight on first boot. It complements [zero-touch-provisioning.md](zero-touch-provisioning.md) (operator checklist) and [first-provisioning-notes.md](first-provisioning-notes.md) (first Hetzner run).

**Validated end state (2026-05):** New provisions with image **`0.1.7+`**, **`main`** on the host clone (`JOSHU_REPO_REF`), complete control-plane `DEFAULT_*` secrets, and **Owner email** set at create reach working box URL, ArozOS desktop, Hermes stream with text, gbrain MCP, and Hindsight health — without SSH repair.

**Current stable image:** `ghcr.io/db-aeon/joshu-sandbox:0.1.24` (`deploy/RELEASE.json`) — jChat desktop presentation (typed fast path, Hermes `desktop_open`, voice `open_desktop`). Prior **`0.1.23`**: jChat voice (Gemini Live), think-path guardrails. See [control-plane-local-provisioning.md](control-plane-local-provisioning.md) and [Connectors on VPS](#connectors-nylas-and-composio-on-vps).

---

## Mental model

```text
Control plane (local pnpm dev or Vercel)
  └─ buildSandboxBootstrapEnv() → cloud-init write_files
        └─ /etc/joshu/instance.env  (host, per instance)
              └─ docker compose --env-file … up
                    └─ joshu-stack container
                          ├─ vps-start.sh → Joshu :8788, Camofox, Hindsight, ArozOS
                          └─ Hermes gateway :8642 (spawned by Joshu)
```

Two delivery channels matter:

| Channel | Updates | Examples |
|--------|---------|----------|
| **Docker image** (`JOSHU_IMAGE_REF`) | Compiled Joshu (`dist/`), Hermes venv, ArozOS template baked in image | `src/hermesApi.ts`, `deploy/Dockerfile` |
| **Git clone at bootstrap** (`JOSHU_REPO_REF`) | `deploy/docker-compose.yml`, `deploy/scripts/vps-start.sh`, cloud-init | `deploy/` only on host |

Changing `deploy/` without rebuilding the image fixes bootstrap scripts but **not** Joshu TypeScript until you push a new image tag.

### Host clone vs image (critical)

`deploy/docker-compose.yml` bind-mounts scripts from the **host**, not only from inside the image:

```yaml
# Typical mount (see deploy/docker-compose.yml)
- /opt/joshu/deploy/scripts/vps-start.sh:/opt/joshu/deploy/scripts/vps-start.sh:ro
```

Cloud-init clones `JOSHU_REPO_URL` at ref `JOSHU_REPO_REF` (usually `main`) into `/opt/joshu` during bootstrap. If that clone is **behind** your laptop (unpushed `deploy/scripts/vps-start.sh`), a brand-new box on **`0.1.7`** can still run an **old** `vps-start.sh` and fail first boot.

**Prevention:** Push `deploy/` (and related scripts) to `main` **before** provisioning; on existing hosts run `cd /opt/joshu && git pull` before `docker compose … recreate`.

**Validated failure (2026-05, `5-27.box.joshu.me`):** Stale host `vps-start.sh` (~274 lines) lacked early `PATH` for Bun → `gbrain` shebang failed (`/usr/bin/env: bun: No such file or directory`) → `vps-start` **exit 1** → container restart loop → Caddy **502** on `/` (nothing on `:8787` until a later successful boot).

**Fix on host:** `git pull` in `/opt/joshu`, or `scp` current `deploy/scripts/vps-start.sh` + `scripts/start-gbrain.sh`, then `docker compose … up -d --force-recreate`. Image **`0.1.8+`** should bake `PATH=/root/.bun/bin:…` in `deploy/Dockerfile` so a stale mount is less fatal.

---

## Hermes chat

### Two auth layers (do not conflate)

| Layer | Variables | Success means |
|-------|-----------|----------------|
| **Gateway** (Joshu ↔ Hermes HTTP API) | `HERMES_API_KEY` = `API_SERVER_KEY` | `/health` on `:8642` returns OK; stream HTTP 200 |
| **Provider** (Hermes ↔ LLM) | **Anthropic direct:** `ANTHROPIC_API_KEY`, `model.provider: anthropic`, Hermes id `claude-sonnet-4-6` | Non-zero tokens in SSE `usage`; `delta.content` with text |
| | **OpenRouter:** `OPENROUTER_API_KEY`, `model.provider: openrouter`, OpenRouter id e.g. `~anthropic/claude-sonnet-latest` | Same; monitor at [openrouter.ai/activity](https://openrouter.ai/activity) |

Gateway auth can pass while the model returns **empty** `finalText` and **0 tokens** — that almost always means the provider key or model config is wrong, not Caddy or Joshu routing.

**Joshu default:** OpenRouter via `JOSHU_HERMES_PROVIDER=openrouter` (local and VPS).
See `docs/hermes-customizations.md`.

### Empty stream signature

Gateway SSE that “succeeds” but never calls the LLM:

```text
delta: {"role": "assistant"}     # no content
delta: {} + finish_reason: stop
usage: prompt_tokens: 0, completion_tokens: 0
```

Joshu’s `/joshu/api/hermes-chat/stream` correctly surfaces `done` with `finalText: ""` when upstream has no `choices[].delta.content`.

### Root causes we hit

1. **Missing `model:` block in `/root/.hermes/config.yaml`**  
   Joshu originally only merged `skills` and `browser.camofox`. Without `model.default` + `model.provider: anthropic`, the gateway returns an empty assistant turn.  
   **Fix:** `ensure_hermes_runtime_config()` in `deploy/scripts/vps-start.sh` and `ensureJoshuHermesConfig()` in `src/hermesApi.ts`.

2. **Stale `/root/.hermes/.env` on Docker volume**  
   Persistent volume `joshu_hermes` can keep old keys. Load order in `vps-start.sh` is: `.hermes/.env` first, then **`/etc/joshu/instance.env` wins**.  
   **Fix:** Idempotent rewrite of provider lines in `ensure_hermes_runtime_config()`; restart gateway after sync.

3. **`OPENROUTER_API_KEY` not visible to the running gateway** (OpenRouter default)  
   Joshu spawns `hermes gateway` with `OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY`. If Node never received the key (compose `env_file` wrong, or provision before keys existed), the gateway process may only have `API_SERVER_KEY`.  
   Hermes also loads `~/.hermes/.env` at import via `load_hermes_dotenv()` — so a correct `.env` file can work even when `/proc/<pid>/environ` does not list `OPENROUTER` (do not use environ alone as proof).  
   **Fix:** `resolveOpenRouterApiKey()` in `hermesApi.ts` falls back to reading `~/.hermes/.env`; sync keys in `vps-start.sh` with plain `KEY=value` lines (not `printf %q`).

4. **Wrong model id in requests**  
   **Anthropic direct:** use Hermes id **`claude-sonnet-4-6`** in `config.yaml` and `JOSHU_HERMES_MODEL`, not the raw Anthropic API id (`claude-sonnet-4-20250514`). Direct `curl` to `api.anthropic.com` is a good key test but a different code path than `hermes-agent`.  
   **OpenRouter:** use OpenRouter slugs in `JOSHU_HERMES_MODEL` (e.g. `~anthropic/claude-sonnet-latest`); `claude-sonnet-4-6` is not valid on the OpenRouter provider.

5. **Malformed `toolsets` in config**  
   Appending `toolsets: "["hermes-cli", "browser"]"` as a quoted string can break YAML parsing. Prefer a YAML list in `vps-start.sh`.

6. **Corrupt `/root/.hermes/config.yaml`** (validated 2026-06, `patrick.box.joshu.me`)  
   Symptom: `hermes --version` warns `Failed to parse config.yaml`; chat returns `No models provided` (HTTP 400) while `GET /joshu/api/instance/health` still shows `hermes.ok: true` (gateway `:8642` responds without validating YAML).  
   **Cause:** Concurrent non-atomic rewrites of `config.yaml` when Joshu merged `config.user.yaml` on every health probe (pre-2026-06 fix). Garbage often looked like a duplicated TTS tail (e.g. stray `3` from `voxtral-mini-tts-2603`).  
   **Fix (image/code):** [`src/hermesConfigSplit.ts`](../../src/hermesConfigSplit.ts) — compare-before-write, write lock, atomic replace, auto-repair on parse failure.  
   **Fix (running box):** Truncate invalid tail or delete corrupt file and restart stack so Joshu rebuilds; or `git pull` + recreate `joshu-stack` on an image that includes the fix.

7. **Killing the gateway without restarting**  
   `pkill hermes gateway` leaves nothing on `:8642` until Joshu runs `ensureGatewayReady()` (e.g. `GET /joshu/api/hermes-chat/status`). Bare `curl :8642` then hangs with no output.

### Hermes diagnostics (on droplet)

```bash
# 1) Keys in provisioned env (masked)
docker exec deploy-joshu-stack-1 sed -E 's/(=).*/\1…/' /etc/joshu/instance.env \
  | grep -E '^(ANTHROPIC|OPENROUTER|HERMES_API|API_SERVER|JOSHU_HERMES)'

# 2) config.yaml must parse (no "Failed to parse" warning)
docker exec deploy-joshu-stack-1 /opt/hermes-agent/venv/bin/hermes --version 2>&1 | head -5

# 3) Hermes resolves OpenRouter (must be len >> 0)
docker exec deploy-joshu-stack-1 bash -lc "
  source /etc/joshu/instance.env
  echo openrouter_len=\${#OPENROUTER_API_KEY}
"

# 4) Direct Anthropic (bypass Hermes)
docker exec deploy-joshu-stack-1 bash -lc '
  source /etc/joshu/instance.env
  curl -sS https://api.anthropic.com/v1/messages \
    -H "x-api-key: ${ANTHROPIC_API_KEY}" \
    -H "anthropic-version: 2023-06-01" \
    -H "content-type: application/json" \
    -d "{\"model\":\"claude-sonnet-4-20250514\",\"max_tokens\":32,\"messages\":[{\"role\":\"user\",\"content\":\"Say OK\"}]}"
'

# 5) Gateway stream (must show content + non-zero usage)
docker exec deploy-joshu-stack-1 bash -lc '
  source /etc/joshu/instance.env
  curl -m 15 -sS -N http://127.0.0.1:8642/v1/chat/completions \
    -H "Authorization: Bearer ${HERMES_API_KEY}" \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"hermes-agent\",\"messages\":[{\"role\":\"user\",\"content\":\"Say OK only\"}],\"stream\":true}"
' | head -20
```

Repair script: `scripts/fix-hermes-gateway-on-vps.sh` (host SSH) or `scripts/sync-hermes-to-vps.sh` (from laptop).

---

## Hindsight

### Symptoms

- `[hindsight] missing external ML config: HINDSIGHT_API_EMBEDDINGS_PROVIDER HINDSIGHT_API_RERANKER_PROVIDER`
- `vps-start.sh` exits before `[vps-start] Joshu` → container restart loop
- Permission denied on GCP service account JSON inside container

### Root causes

1. **Incomplete `instance.env`** — provisioner only passed a subset of Hindsight vars; `*_PROVIDER` keys were required by `start-hindsight.sh` but missing.  
   **Fix:** `apps/control-plane/src/lib/hindsightBootstrap.ts` + `assertSandboxBootstrapConfig()`.

2. **SA file `root:600` on host** — Hindsight runs as user `hindsight`; cannot read reranker JSON.  
   **Fix:** Bootstrap `chown root:<hindsight_gid>` on `/etc/joshu/secrets/`; `fix_hindsight_secrets_permissions()` in `vps-start.sh`.

3. **`JOSHU_HINDSIGHT_ENABLED=true` with failed start and `set -e`** — old scripts exited entire stack when Hindsight failed.  
   **Fix:** `JOSHU_HINDSIGHT_OPTIONAL=true` default; required only when explicitly non-optional.

4. **`/etc/joshu/secrets` mode `700` after learning GitHub patch** — Hindsight runs as user `hindsight` (gid **1001**); `chmod 700` on the secrets dir blocks the Google SA key → `/api/hindsight/status` `fetch failed`.  
   **Fix:** `chown 0:1001` + `chmod 750` on `/etc/joshu/secrets`, `chmod 640` on the SA JSON; `scripts/patch-box-learning-github.sh` uses `750` (not `700`). See [session-2026-06-11](session-2026-06-11-learning-browser-sync.md#incidents-fixed-on-patrick-during-this-work).

Local dev: control plane hydrates missing `DEFAULT_HINDSIGHT_*` from monorepo root `.env` when running `pnpm dev`.

Repair: `scripts/sync-hindsight-to-vps.sh`.

---

## File brain (gbrain)

Full reference: [`docs/file-brain.md`](../file-brain.md).

### Symptoms

- `dev:arozos` fails on `.env` with `unexpected EOF while looking for matching '''`
- Hermes writes land on macOS `~/Desktop` instead of ArozOS File Manager
- `put_page` creates `Desktop/journals/…` instead of `joshu's files/journals/…`
- PGLite lock timeout; `gbrain doctor` fails while Hermes chat works
- Search returns nothing after agent wrote a `.md` file on disk
- Hermes gbrain **`search`** returns `[]` but File Brain Browse lists the page
- File Brain Search shows a hit; Inspect panel says page not found
- **`/joshu/api/instance/health` shows `gbrain.ok: true` but File Brain Browse lists 0 pages**
- Connectors status shows hundreds of mail mirror threads on disk; **`/joshu/api/brain/pages` returns `page_count: 0`**
- **`POST /joshu/api/brain/reindex` accepted** but pages stay empty; occasional **502** / MCP timeout (~30s) on `/brain/pages`
- PDF dropped in `research/kb/inbox/` stays there; no matching `research/kb/*.md`

### Root causes

1. **Unquoted `JOSHU_FILES_DIR_NAME`** in repo `.env` (bash `source`). Use `JOSHU_FILES_DIR_NAME="joshu's files"`.

2. **Slug / folder casing** — gbrain lowercases slugs; on-disk folder must be **`joshu's files`**, not `Joshu's Files`. Slugs must include the prefix: `joshu's files/journals/YYYY-MM-DD-slug`.

3. **Wrong filesystem root** — agents used `~/Desktop` or relative `Desktop/…` instead of `JOSHU_FILES_ROOT` under `AROZ_DATA`. Hermes MCP env is set in `src/hermesApi.ts`; skill: `integrations/hermes/skills/brain/joshu-brain/`.

4. **PGLite single-holder** — `sync --watch` + Hermes `gbrain serve` together. Default `GBRAIN_SYNC_WATCH=false`; run `scripts/stop-gbrain.sh` after experiments.

5. **`DATABASE_URL` in shell** — gbrain may flip PGLite config to Postgres. Joshu scripts unset it; repair in `start-gbrain.sh`.

6. **No background sync** — filesystem-only writes need `gbrain sync --apply` or restart `start-gbrain.sh`.

7. **Wrong ArozOS user (files under `admin`)** — VPS path resolution picked the first user dir when `JOSHU_AROZ_USER` was unset; UI login was a different email.  
   **Fix:** Set **Owner email** at provision → `JOSHU_AROZ_USER` + `JOSHU_OWNER_EMAIL` in `instance.env`; `bootstrap-joshu-files.sh` seeds only that user; `rebind-gbrain-owner.sh` on boot. Login with the **exact** owner email (case-sensitive; `+` in plus-addressing is part of the folder name, e.g. `db+5-27@project-aeon.com`).

8. **Hermes has no gbrain tools** — legacy `dist/hermesApi.js` reset `toolsets` to `hermes-cli` + `browser` only; or `command: gbrain` without Bun on PATH.  
   **Fix:** Image `0.1.7+`; `ensure-hermes-gbrain-mcp.mjs` + `JOSHU_HERMES_TOOLSETS` including `mcp-gbrain`; `vps-start.sh` watchdog. See [`docs/file-brain.md`](../file-brain.md).

9. **`components.gbrain.ok: false` in instance health but `gbrain doctor` OK** — health runs `gbrain doctor` with a **15s** timeout during slow boot (rebind + embed).  
   **Fix:** Wait for stack to settle; re-hit `/joshu/api/instance/health`; not necessarily a functional failure.

10. **Hermes used MCP `search` (default source only)** — federated Desktop pages (e.g. `investors/…`, workspace under Desktop) need **`query`** with `source_id: "__all__"` and `limit`. Joshu REST on `:8794` and `/joshu/api/brain/search` already use cross-source `query`; Hermes `/mcp` does not rewrite `search` automatically.  
    **Fix:** Update skill usage; see [`docs/file-brain.md`](../file-brain.md#search-vs-query-important).

11. **`get_page` fails for federated slug** — `query` / REST search may still return `chunk_text`.  
    **Fix:** Use snippet from search hit; read file under `JOSHU_DESKTOP_ROOT` (remember gbrain lowercases slugs).

12. **MCP HTTP not running** — Hermes may fail to connect or CLI may lock PGLite.  
    **Fix:** `curl http://127.0.0.1:8794/health`; `bash scripts/start-gbrain-mcp-http.sh`; `bash scripts/stop-gbrain.sh` before CLI `gbrain` debugging.

13. **KB PDF not ingested** — watcher runs inside gbrain MCP HTTP only; needs `pdftotext` or `pypdf`; scanned PDFs have no selectable text.  
    **Fix:** `npm run kb:ingest-pdf`; `tail` `${GBRAIN_HOME}/gbrain-mcp-http.log` for `[kb-pdf-ingest]`; VPS image includes poppler + pypdf (`deploy/Dockerfile`); see [`file-brain.md`](../file-brain.md#knowledge-base-pdf-drop).

14. **Joshu API crash: `Cannot find module .../dist/connectors/routes.js`** — `npm run build:connectors` (Vite) used to write to `dist/connectors` with `emptyOutDir: true`, wiping `tsc` output (`routes.js`, etc.). UI now builds to `dist/connectors-app/`.  
    **Fix:** Rebuild image after that change (`build:deploy` → `vps:build-image`); on a running box, `docker exec deploy-joshu-stack-1 test -f /opt/joshu/dist/connectors/routes.js`.

15. **Joshu API crash: `Cannot find module .../@joshu/box-state/dist/index.js` or `@composio/core`** — runtime `deploy/runtime/package.json` / Docker `COPY` layout out of sync with `dist/`. Image build runs `test -f node_modules/@joshu/box-state/dist/index.js` after `npm ci`.  
    **Fix:** Image **0.1.11+**; `JOSHU_IMAGE_REF=ghcr.io/db-aeon/joshu-sandbox:0.1.11` + pull + recreate.

16. **`gbrain.ok: true` but index empty** — instance health now also reports **`gbrain.indexed_ok`** and **`page_count`** (disk markdown vs MCP list). **`gbrain.ok`** alone is still insufficient. Auto-recovery: `scripts/ensure-gbrain-indexed.sh` + VPS watchdogs in `vps-start.sh`.  
    **Fix:** Verify `components.gbrain.indexed_ok`; run `bash scripts/ensure-gbrain-indexed.sh` inside container; see below.

17. **`GBRAIN_BOOT_QUICK=true` (VPS default)** — `start-gbrain.sh` skips the one-shot `sync --apply` + `embed` so ArozOS can start quickly. Indexing depends on MCP HTTP background reindex plus **`ensure-gbrain-indexed.sh`** (45s soft, 3m auto, 5m watchdog). After container restart, File Brain can show **0 pages** until recovery succeeds — even when connector mirrors already exist on disk.  
    **Fix:** Check `gbrain.indexed_ok`; wait for watchdog; or `bash scripts/ensure-gbrain-indexed.sh` inside the container (preferred over manual `GBRAIN_BOOT_QUICK=false start-gbrain.sh` + MCP restart).

18. **Git-gated `sync_brain` failures** — MCP bridge runs `git add -A` on `${AROZ_DATA}/files/users/` then `sync_brain` on `JOSHU_DESKTOP_ROOT`. gbrain **0.40+** federated Desktop sources also require **`.git` on the Desktop folder**. Missing git roots or failed commits → sync is a no-op. Errors log to `${GBRAIN_HOME}/gbrain-mcp-http.log` (set `GBRAIN_MCP_VERBOSE=1` for per-sync lines). Commits **`5a9ba43`**, **`9c28d95`**, and `scripts/lib/gbrain-desktop-git.mjs` / `ensure-gbrain-git.sh` harden this — ensure host `/opt/joshu` is pulled (`scripts/lib` is bind-mounted in compose).

19. **`gbrain serve` exit kills indexing** — older MCP bridge code exited the whole HTTP server when `gbrain serve` died; newer bridge respawns the child. During respawn or heavy `sync_brain`, `/brain/pages` may **502** at the 30s MCP timeout.  
    **Fix:** Tail `${GBRAIN_HOME}/gbrain-mcp-http.log`; never run a second `start-gbrain.sh` while MCP HTTP holds PGLite (`vps-start.sh` comment: “File Brain shows 0 pages”).

20. **Image vs host script lag** — `docker-compose.yml` bind-mounts `scripts/lib/` and several boot scripts from **`/opt/joshu` on the host**, not only from the GHCR tag. A box on **`0.1.12`** can still run stale gbrain git/sync logic until `git pull` + container recreate.

19b. **Image vs host `dist/` lag (API bugs after release update)** — Compose bind-mounts **`../dist:/opt/joshu/dist:ro`**. `dist/` is **gitignored**; `git pull` + image pull do not refresh the host copy unless **`syncDistFromImage`** runs (instance-agent on control-plane release updates, default **true**).  
    **Symptom:** `JOSHU_RELEASE_VERSION=0.1.17` but Nylas send alternates `opts.to.map is not a function` / `to, subject, and body are required`; MCP tools look current.  
    **Fix:** See **[hotpatch-running-box.md](hotpatch-running-box.md)** (Lane B). Quick: `bash /opt/joshu/scripts/sync-dist-from-image.sh` + recreate `joshu-stack`.

19c. **Admin update fails `fetch failed` / `ECONNREFUSED 127.0.0.1:8788` (instance-agent health probe)** — During `docker compose up --force-recreate joshu-stack`, Joshu is briefly down. Older instance-agent called `fetch()` on `/joshu/api/instance/health` without catching network errors → **`TypeError: fetch failed`** aborts the update immediately (admin shows `update / failed`, job error `fetch failed`). GHCR pull often already succeeded; `instance.env` may have been bumped then rolled back on retry.
    **Symptom:** `docker logs deploy-instance-agent-1` shows `pre-update snapshot completed`, then `command … failed: fetch failed` with `[cause]: connect ECONNREFUSED 127.0.0.1:8788`. Pull from inside agent works: `docker exec deploy-instance-agent-1 docker pull ghcr.io/db-aeon/joshu-sandbox:<tag>`.
    **Fix (2026-06):** `packages/instance-agent` — `fetchJoshuHealth()` treats unreachable health as `{ healthy: false }` and `waitForHealthyAfterUpdate()` polls through stack restarts (Hermes MCP boot can take **3–4 min**; default wait **600s**). Rebuild agent on the box: `cd /opt/joshu && git pull && docker compose -f deploy/docker-compose.yml --env-file /etc/joshu/instance.env build instance-agent && docker compose … up -d --force-recreate instance-agent`, then retry admin **Update**.

19d. **Admin update fails `error from registry: unauthorized` (instance-agent pull)** — `instance-agent` runs `docker compose pull` **inside its container** via the host socket. The Docker CLI reads **`~/.docker/config.json` inside the container**, not on the host. Without mounting host GHCR creds, pulls use anonymous auth → **401** on private `ghcr.io/db-aeon/joshu-sandbox`. **Stale bootstrap login** — GHCR token was only applied at first boot; expired tokens fail until refreshed.
    **Symptom:** Admin Health column shows stale `deployedImageRef` (e.g. `0.1.21`) vs heartbeat `releaseVersion`; last job `update / failed` (error may say `unauthorized` or `denied`).
    **Fix (durable, 2026-06):** Control plane injects fresh `registryAuth` on signed **update/rollback** commands at heartbeat delivery (not stored in DB). Instance-agent runs `docker login` before pull and writes `/etc/joshu/secrets/ghcr-read.env`. New provisions seed that secrets file at bootstrap.
    **Fix (one-time on existing box):** `GHCR_READ_USER=… GHCR_READ_TOKEN=… bash /opt/joshu/scripts/refresh-vps-ghcr-login.sh` → recreate `instance-agent` → `git pull` in `/opt/joshu` → `docker compose build instance-agent` → retry admin **Update**. Or run `bash /opt/joshu/scripts/repair-vps-admin-update.sh` (after host git pull).
    **Verify:** `docker exec deploy-instance-agent-1 docker pull ghcr.io/db-aeon/joshu-sandbox:<tag>` succeeds. Admin Health shows failed job **error** text when present.
    **Going forward:** Cloud-init bootstrap asserts the mount; instance-agent preflight checks creds before pull. Ship compose + control-plane heartbeat sync on next release.

19e. **Admin `deployedImageRef` lags heartbeat after manual upgrade** — DB field updates only on successful update ack. Hotpatch / SSH upgrade leaves admin showing an old image tag while heartbeat reports the real `releaseVersion` and `host.imageRef`.  
    **Fix:** Heartbeat syncs `deployedImageRef` from agent-reported `host.imageRef` when healthy (no in-flight update). Until deployed: retry **Update release** after the GHCR mount fix, or ignore the stale tag if health + heartbeat version match.

19f. **Release update failure loop — `dist: drift` + `stack not healthy within 600s` (Clara 2026-06)** — Validated incident where admin **Update release** never succeeded cleanly until manual repair. **This pattern is not normal** — it indicates release state got out of sync.

    #### Mental model: three release sources must match

    A healthy box keeps these aligned:

    | Source | What it controls |
    | --- | --- |
    | **`/etc/joshu/instance.env`** | `JOSHU_RELEASE_VERSION`, `JOSHU_IMAGE_REF`, `JOSHU_VOICE_IMAGE_REF` — read by compose and `provisionInstanceEnv` (**last duplicate key wins**) |
    | **`/opt/joshu/dist/.release-provenance.json`** | Version + image ref after `syncDistFromImage` — bind-mounted into `joshu-stack` |
    | **Running `joshu-stack` image** | `ghcr.io/db-aeon/joshu-sandbox:<tag>` from compose |

    `GET /joshu/api/instance/health` compares env release version to dist provenance. Any mismatch → `components.dist.status=drift` → `healthy: false` → instance-agent waits up to **600s** → job fails → control plane may auto-rollback.

    #### Failure pattern (log signature)

    ```text
    GET /joshu/api/instance/version 200
    GET /joshu/api/instance/health 503
    [instance-agent] waiting for dist provenance (status=drift)...
    [instance-agent] command … failed: stack not healthy within 600s after update
    [instance-agent] executing rollback (…)
    ```

    Version endpoint OK + health 503 + drift wait + timeout + rollback = broken update path, not a slow boot.

    #### Root causes we hit (often stacked)

    1. **Duplicate keys in `/etc/joshu/instance.env`** — Older agent replaced only the *first* `JOSHU_RELEASE_VERSION=` line while health uses *last-wins*. Dist sync writes `0.1.N` provenance but env stays on `0.1.N−1`.
    2. **Env patched before dist (older agent)** — Rollback left env at N−1 with dist at N.
    3. **Stale instance-agent process** — `docker compose build instance-agent` did not replace the running Node process; fixes in `git pull` did not run until container recreate.
    4. **No host `npm` on VPS** — Repair scripts that call `npm run build` in `/opt/joshu/packages/instance-agent` fail on the host. Even inside the agent container, `npm install` in that package alone fails with `workspace:*` (monorepo) unless you use **`docker compose build instance-agent`** and copy `dist/` + `node_modules/` from the image.
    5. **`prepareAgentThenRestart` race** — Agent writes `pending-release-update.json`, runs `compose up --force-recreate instance-agent`, exits. New container can sit in **`Created`** while the old one is **`Exited (137)`**; update stalls until `docker compose up -d --no-deps instance-agent`.
    6. **Stale control-plane jobs** — Failed update leaves a provision job `running`; admin re-queue is skipped (`job … already running`). Auto-rollback jobs can pile on.

    #### Symptoms to watch for

    | Signal | Likely meaning |
    | --- | --- |
    | `/version` **200**, `/health` **503** | Dist/env drift — stack is up, release gate failing |
    | `components.dist.status=drift` | `dist.version ≠ releaseVersion` in health JSON |
    | `waiting for releaseVersion (got X, expected Y)` | Env not yet visible inside stack after patch (often during recreate) or drift |
    | Rollback to old tag with **new `gitRef`** in provenance | `git pull` worked; image/dist rolled back — expect drift until repaired |
    | **No `instance-agent` in `docker ps`** or status **`Created`** | Mid self-restart; check `/etc/joshu/secrets/pending-release-update.json` |
    | `npm … workspace:*` in agent logs | Host-agent build failed; need compose-build fallback (`5fccc14+`) |
    | Control plane `skip — job … already running` | Clear or fail stale job before re-queueing |
    | Post-recreate `ECONNREFUSED` on health (brief) | Normal during `joshu-stack` recreate; worry only if it lasts the full 600s window |

    #### Fixes shipped (2026-06)

    - **`scripts/patch-instance-env.mjs`** — Dedupes keys on every env write (agent calls via `/opt/joshu` mount).
    - **`scripts/run-instance-agent.mjs`** — Prefers host-built agent only when **`dist/` and `node_modules/`** both exist; otherwise image-baked `/app/dist`.
    - **`prepareAgentThenRestart`** — `git pull` → build host agent (compose fallback) → write pending file → recreate agent → resume command on next boot.
    - **`src/instanceHealth.ts`** — Trusts `dist/.release-provenance.json` when `provenance.imageRef === JOSHU_IMAGE_REF`.
    - **`scripts/repair-vps-admin-update.sh`** — GHCR login + compose-build agent + copy `dist`/`node_modules` when host has no npm.
    - **`scripts/repair-instance-env-drift.sh`** — Align env release keys with provenance + recreate stack.

    #### Manual recovery playbook

    ```bash
    ssh root@<slug>.box.joshu.me
    cd /opt/joshu && git pull

    # 1) Inspect drift
    grep -E '^JOSHU_(RELEASE_VERSION|IMAGE_REF)=' /etc/joshu/instance.env
    cat dist/.release-provenance.json
    curl -fsS http://127.0.0.1:8788/joshu/api/instance/health | jq '.healthy, .releaseVersion, .components.dist'

    # 2) Repair agent + GHCR (builds via docker compose on VPS)
    bash scripts/repair-vps-admin-update.sh

    # 3) If health still shows drift — sync dist to match target image, then align env
    JOSHU_IMAGE_REF=ghcr.io/db-aeon/joshu-sandbox:0.1.29 JOSHU_RELEASE_VERSION=0.1.29 \
      bash scripts/sync-dist-from-image.sh
    docker run --rm -v /opt/joshu:/opt/joshu -v /etc/joshu:/etc/joshu node:22-bookworm-slim \
      node /opt/joshu/scripts/patch-instance-env.mjs \
      JOSHU_RELEASE_VERSION=0.1.29 \
      JOSHU_IMAGE_REF=ghcr.io/db-aeon/joshu-sandbox:0.1.29 \
      JOSHU_VOICE_IMAGE_REF=ghcr.io/db-aeon/joshu-voice-realtime:0.1.29
    docker compose -f deploy/docker-compose.yml --env-file /etc/joshu/instance.env up -d --force-recreate joshu-stack

    # 4) If agent stuck in Created after update prep
    docker compose -f deploy/docker-compose.yml --env-file /etc/joshu/instance.env up -d --no-deps instance-agent

    # 5) Retry admin Update (or queue-box-update) only after stale provision jobs are failed/cleared
    ```

    **Operational habit:** After any failed update, check `components.dist` in health, grep `instance.env` for **duplicate** release keys, confirm `instance-agent` is **`Up`** (not `Created`), then repair or re-queue — do not re-queue blindly while a job is still `running`.

21. **Connectors MCP HTTP not running (`:8795`)** — EA summary sends and connector sync actions fail; gbrain mail **recall** may still work. Hermes toolset `mcp-joshu-connectors` depends on this process.  
    **Fix:** `curl http://127.0.0.1:8795/health`; `bash scripts/start-joshu-connectors-mcp.sh`; tail `~/.joshu/connectors-mcp.log`. See [`docs/connectors.md`](../connectors.md#connectors-mcp-http-8795).

22. **All files skipped: `Google embedding requires GOOGLE_GENERATIVE_AI_API_KEY`** — `HINDSIGHT_API_EMBEDDINGS_GEMINI_API_KEY` is in `instance.env` but gbrain MCP HTTP did not map it to `GOOGLE_GENERATIVE_AI_API_KEY` for `gbrain serve`. Sync completes with **0 imported**; index stays empty despite disk markdown.  
    **Fix:** Host `/opt/joshu` at **`0568cee+`** (`start-gbrain-mcp-http.sh` exports Gemini key); restart MCP or `bash scripts/ensure-gbrain-indexed.sh --full`. Tail `${GBRAIN_HOME}/gbrain-mcp-http.log` for `[import.files] … skipped=41 errors=41`.

Local: PGLite at `.local/gbrain`, Desktop at `.local/arozos-data/files/users/<user>/Desktop/`, gbrain MCP HTTP at `http://127.0.0.1:8794`, connectors MCP at `http://127.0.0.1:8795`.

### Connectors MCP `Unknown tool` — EA summary send

**Symptom:** Langfuse tool span `mcp_joshu_connectors_nylas_send_message` with output `{ "error": "Unknown tool: mcp_joshu_connectors_nylas_send_message" }` while `to` / `subject` / `body` look fine. Morning brief may succeed the same day; end-of-day send fails.

**What it means:** Tool dispatch failed before `POST /joshu/api/nylas/messages/send`. Not invalid email content.

**Two failure modes (both observed):**

1. **Availability (most likely for intermittent failures)** — Connectors MCP process on `:8795` was down, stale, or unreachable when the evening Hermes cron session ran. Morning cron had a healthy MCP; later run did not. **Since 2026-06:** `GET /joshu/api/instance/health` includes `components.connectorsMcp` — a box can still be `healthy: false` when connectors MCP is down.

2. **Tool name on the wire** — Some clients call MCP with the Hermes **display** name (`mcp_joshu_connectors_nylas_send_message`) instead of the short MCP name (`nylas_send_message`). The Joshu MCP server returns `Unknown tool: …` with the name it received. Fix: `normalizeToolName()` in `joshu-connectors-mcp-http-server.mjs` (strips `mcp_joshu_connectors_`). A pure naming bug would fail **every** call; intermittent success points to (1), not (2) alone.

**Langfuse note:** Metadata often shows the **prefixed** Hermes tool name even when the successful wire call used `nylas_send_message`. Do not compare pass/fail traces by tool name alone — compare MCP health at call time.

**Validated incident (2026-06-04, `patrick.box.joshu.me`):**

- **Pass:** `Morning brief — 2026-06-04` → `{ ok: true, messageId, from: "patrick@joshu.me" }`.
- **Fail:** `End of day — 2026-06-04` → `Unknown tool: mcp_joshu_connectors_nylas_send_message` (owner did not receive EOD email).

**Fix applied (repo + patrick hotfix):**

- MCP server accepts prefixed tool names.
- `start-joshu-connectors-mcp.sh` — health check before “already running”; restart stale PIDs.
- `vps-start.sh` — deferred Hermes warm + `after_mcp_boot` nudge; 30s connectors/composio watchdogs that restart MCP and nudge gateway.
- `deploy/docker-compose.yml` — bind-mount connectors MCP scripts from host.

**Diagnose:**

```bash
ssh root@<slug>.box.joshu.me
docker exec deploy-joshu-stack-1 curl -fsS http://127.0.0.1:8795/health
docker exec deploy-joshu-stack-1 tail -30 /root/.joshu/connectors-mcp.log
docker exec deploy-joshu-stack-1 grep -A3 joshu_connectors /root/.hermes/config.yaml
```

**Smoke test (prefixed name → MCP):**

```bash
docker exec deploy-joshu-stack-1 bash -lc 'cd /opt/joshu && node --input-type=module -e "
import { Client } from \"@modelcontextprotocol/sdk/client/index.js\";
import { StreamableHTTPClientTransport } from \"@modelcontextprotocol/sdk/client/streamableHttp.js\";
const t = new StreamableHTTPClientTransport(new URL(\"http://127.0.0.1:8795/mcp\"));
const c = new Client({ name: \"smoke\", version: \"1\" }, { capabilities: {} });
await c.connect(t);
const r = await c.callTool({ name: \"mcp_joshu_connectors_connectors_status\", arguments: {} });
console.log(r.content?.[0]?.text?.slice(0, 120));
await c.close();
"'
```

Canonical reference: [`docs/connectors.md`](../connectors.md#troubleshooting-unknown-tool-mcp_joshu_connectors_).

### Partial MCP tool catalog (jChat / Telegram)

**Symptom:** Langfuse / jChat / **Telegram** session lists only **1–3** `mcp_joshu_connectors_*` tools (often just `nylas_send_message`) while `:8795/health` is OK. Agent may say connectors are unavailable or try **`hermes kanban …` CLI**, shell, or `curl` instead of MCP. After a **gateway restart**, the same box shows **~20** connectors tools including `project_kanban_ensure_board` and `project_kanban_create_triage_root`.

**What it means:** Hermes registers MCP `tools/list` **once at gateway boot**. Connectors MCP depends on Joshu `:8788`, so Joshu listens before connectors can start — if the gateway warmed too early, it keeps a **partial catalog** until restart. See [connectors.md — Partial MCP catalog](../connectors.md#partial-mcp-catalog-jchat--telegram) for the full mitigation stack (`JOSHU_DEFER_HERMES_GATEWAY_WARM`, `after_mcp_boot=1`, watchdogs).

**Diagnose:**

```bash
ssh root@<slug>.box.joshu.me
CID=$(docker ps -qf name=joshu-stack)
docker exec "$CID" curl -fsS http://127.0.0.1:8795/health
curl -fsS https://<slug>.box.joshu.me/joshu/api/instance/health | jq '.healthy, .components.connectorsMcp'
# Full tool list from MCP (expect ~20 tools including project_kanban_*)
docker exec "$CID" bash -lc 'cd /opt/joshu && node --input-type=module -e "
import { Client } from \"@modelcontextprotocol/sdk/client/index.js\";
import { StreamableHTTPClientTransport } from \"@modelcontextprotocol/sdk/client/streamableHttp.js\";
const t = new StreamableHTTPClientTransport(new URL(\"http://127.0.0.1:8795/mcp\"));
const c = new Client({ name: \"diag\", version: \"1\" }, { capabilities: {} });
await c.connect(t);
const { tools } = await c.listTools();
console.log(tools.length, tools.map(t => t.name).sort().join(\", \"));
await c.close();
"'
# Compare to what jChat/Telegram sees — start a **new** session after any gateway fix
docker exec "$CID" grep -iE 'defer|after_mcp|connectors MCP|telegram connected' /root/.hermes/logs/gateway.log | tail -20
```

**Fix (preferred — in-container nudge):**

```bash
docker exec "$CID" curl -fsS --max-time 120 \
  'http://127.0.0.1:8788/joshu/api/hermes-chat/status?after_mcp_boot=1'
curl -fsS -H "Authorization: Bearer $HERMES_API_KEY" http://127.0.0.1:8642/health
```

**Fix (manual gateway restart):**

```bash
docker exec "$CID" bash -c 'source /etc/joshu/instance.env
/opt/hermes-agent/venv/bin/hermes gateway stop
curl -fsS --max-time 120 "http://127.0.0.1:8788/joshu/api/hermes-chat/status?after_mcp_boot=1"
curl -fsS -H "Authorization: Bearer $HERMES_API_KEY" http://127.0.0.1:8642/health'
```

Open a **new** jChat session or send a fresh Telegram message and confirm `project_kanban_*` appear in the tool schema. Same class of bug as Composio “stale gateway MCP” — see [Troubleshooting Composio](../hermes-chat-arozos-app.md#troubleshooting-composio).

**Validated incidents:**

- **2026-06-12** (`patrick.box.joshu.me`, waitlist drip kickoff): trace before restart — 1 connectors tool, 0 composio, agent improvised with terminal + CLI; after gateway restart — 20 connectors tools.
- **2026-06-13** (`patrick.box.joshu.me`, Telegram test): `mcp_joshu_connectors_nylas_send_message` missing from toolset; agent used shell workarounds. Root cause: gateway boot race. Fix: deferred warm + `after_mcp_boot` nudge + `components.connectorsMcp` in instance health.

### Validated incident: File Brain zero pages (2026-06, `patrick.box.joshu.me`)

**Observed:** Image **`0.1.12`**, uptime ~20 min after restart. `/joshu/api/instance/health` → `healthy: true`, `components.gbrain.ok: true`. `/joshu/api/connectors/status` → **404+ Gmail mirror threads** under `…/Desktop/joshu's files/connectors/mail/`. Authenticated `/joshu/api/brain/pages?limit=5` → **`page_count: 0`**, `lane: gbrain-mcp-http`. `/brain/search?q=email` → **0 hits**. `POST /joshu/api/brain/reindex` → scheduled touch; follow-up `/pages` still 0; one poll returned **502** (MCP timeout), next poll 0 again.

**Interpretation:** Disk had connector mirrors; **PGLite index never populated** (or `sync_brain` failed silently). Health was misleading. Quick boot + async reindex did not recover within ~20 minutes on that run.

**Fix applied (2026-06-07, `patrick.box.joshu.me`):** Commits **`4d39fda`** / **`0568cee`** — `ensure-gbrain-indexed.sh`, empty-index watchdogs, `gbrain.indexed_ok` in instance health, Gemini key export on MCP boot. After `git pull` + recreate + `ensure-gbrain-indexed.sh --full`: **`indexed_ok: true`**, 41 markdown on disk, pages indexed.

**Diagnose inside container:**

```bash
ssh root@patrick.box.joshu.me   # or any <slug>.box.joshu.me

docker exec deploy-joshu-stack-1 curl -fsS http://127.0.0.1:8794/health | jq .
docker exec deploy-joshu-stack-1 curl -fsS 'http://127.0.0.1:8794/list?limit=5' | jq .

docker exec deploy-joshu-stack-1 tail -80 /root/.gbrain/gbrain-mcp-http.log

DESKTOP="$(docker exec deploy-joshu-stack-1 bash -lc 'source /etc/joshu/instance.env; echo "$JOSHU_DESKTOP_ROOT"')"
docker exec deploy-joshu-stack-1 bash -lc "
  ls -la \"${DESKTOP}/.git\" /var/lib/arozos/files/users/.git 2>&1
  git -C /var/lib/arozos/files/users status -sb | head
"
```

**Compare index vs health from outside** (when `JOSHU_READ_API_KEY` is set — same as `HERMES_API_KEY`):

```bash
curl -fsS https://<slug>.box.joshu.me/joshu/api/instance/health | jq '.components.gbrain | {ok, indexed_ok, page_count, disk_markdown}'
curl -fsS -H "Authorization: Bearer $JOSHU_READ_API_KEY" \
  'https://<slug>.box.joshu.me/joshu/api/brain/pages?limit=5' | jq '.page_count,.lane'
```

**Recover (preserves volumes):**

```bash
docker exec deploy-joshu-stack-1 bash -lc '
  export APP_DIR=/opt/joshu GBRAIN_HOME=/root/.gbrain
  source /etc/joshu/instance.env
  bash /opt/joshu/scripts/ensure-gbrain-indexed.sh
'
```

Or manually (same as ensure script full path):

```bash
docker exec deploy-joshu-stack-1 bash -lc '
  export GBRAIN_BOOT_QUICK=false APP_DIR=/opt/joshu GBRAIN_HOME=/root/.gbrain
  source /etc/joshu/instance.env
  bash /opt/joshu/scripts/stop-gbrain.sh
  bash /opt/joshu/scripts/start-gbrain.sh
  bash /opt/joshu/scripts/start-gbrain-mcp-http.sh
'
```

If logs show PGLite WASM abort / “could not read blocks”, see [`scripts/repair-gbrain-pglite.sh`](../../scripts/repair-gbrain-pglite.sh) with `GBRAIN_REPAIR_PGLITE=1`.

Full file-brain reference: [`docs/file-brain.md`](../file-brain.md).

### Stopping a box (containers only)

To stop Joshu services **without** destroying the VPS or Docker volumes (ArozOS data, gbrain PGLite, Hermes home, Hindsight Postgres):

```bash
ssh root@<slug>.box.joshu.me
cd /opt/joshu/deploy
docker compose -f docker-compose.yml --env-file /etc/joshu/instance.env down
```

**Start again:**

```bash
cd /opt/joshu/deploy
docker compose -f docker-compose.yml --env-file /etc/joshu/instance.env up -d
```

This is the same stack teardown the instance agent runs for a **`deprovision`** command (control plane). DNS and the droplet remain; only Caddy, `joshu-stack`, and `instance-agent` containers stop.

---

## ArozOS

### Symptoms

- Desktop **502** / nothing on `:8787` — often **ArozOS not listening yet** (gbrain embed blocked boot) or **container crash loop** (`docker logs deploy-joshu-stack-1 | tail -80`). Fix: `GBRAIN_BOOT_QUICK=true` + ArozOS starts before full gbrain index (`vps-start.sh`); `git pull` on host and recreate.
- Container **restart loop** (`docker inspect … Restarts` > 0)
- Panic: `tmp/tmp` path under ArozOS data dir
- Site loads only after **2–3 minutes** (slow first boot)

### Root causes

1. **`AROZOS_ENABLED` unset/false`** in early `instance.env` — Caddy proxied `/` to a port with no listener.  
   **Fix:** `AROZOS_ENABLED=true` in `sandboxEnv.ts`.

2. **`-tmp=${AROZ_DATA}/tmp`** — ArozOS appends `/tmp/` to `-tmp`; becomes `.../arozos/tmp/tmp`.  
   **Fix:** `-tmp=${AROZ_DATA}` only; `AROZ_TMP_ROOT` guard in `vps-start.sh`.

3. **`vps-start.sh` exits before ArozOS** (gbrain/Hindsight/Camofox failure with `set -e`) — see [Host clone vs image](#host-clone-vs-image-critical). Symptom: logs show Camofox/Hindsight but never `Web server listening at :8787`.

4. **Slow boot order** — when `JOSHU_AROZ_USER` is set, `rebind-gbrain-owner.sh` + `start-gbrain.sh` (embed) run **before** the ArozOS background process starts. Caddy may answer while `:8787` is still down; retry the desktop URL after health is green.

### Quick checks

```bash
ssh root@<slug>.box.joshu.me
docker inspect deploy-joshu-stack-1 --format 'restarts={{.RestartCount}}'
docker logs deploy-joshu-stack-1 2>&1 | grep -E 'vps-start|ArozOS|gbrain failed|listening at :8787' | tail -20
curl -fsS -o /dev/null -w 'arozos=%{http_code}\n' http://127.0.0.1:8787/
curl -fsS https://<slug>.box.joshu.me/joshu/api/instance/health | jq '.healthy,.components.gbrain'
wc -l /opt/joshu/deploy/scripts/vps-start.sh   # expect ~346 on current main
```

### Desktop UI — stuck clicks and init splash

| Symptom | Cause | Fix |
|---------|--------|-----|
| **“Initializing / ArozOS Web Desktop Mode”** on black for a long time | Stock `init.jpg` body wallpaper until theme API returns | Fixed in jōshu fork: plain black body + `clearDesktopInitSplash()`; `apply_arozos_joshu_theme.py` replaces `init.jpg`. Hard-refresh desktop. |
| Logged in, icons visible, **clicks dead**; `arozUnblockDesktop()` → `killed: []` | Wedged JS / incomplete init (not an overlay); common with **two desktop tabs** | `arozRecoverDesktop()` in DevTools; else close tab and open fresh desktop URL. |
| New tab works, old tab stuck | Stale tab state | Close old tab; avoid multiple `desktop.html` tabs during dev. |
| **Folder icon** correct briefly, then old tan glyph | `startThumbnailLoader()` JPEG replaced folder `src` | Fixed in jōshu fork (skip `type === "folder"`); hard-refresh. See [`docs/design/README.md`](../design/README.md#tango-icon-pipeline). |
| Desktop icons **stretched** or oval | Tall launch slot + missing `object-fit: contain` (or thumbnail `data:image` without square box CSS) | Re-run `apply_arozos_joshu_theme.py`; hard-refresh; confirm `aroz-paper-shell.css` loads. |

Console helpers (DevTools on `desktop.html`): `arozUnblockDesktop()`, `arozRecoverDesktop()`, `__arozDesktopDiag()`.

Details: [`docs/design/README.md`](../design/README.md#desktop-startup-splash), [`docs/design/README.md`](../design/README.md#desktop-interaction-recovery-stuck-clicks).

---

## Connectors, Nylas, and Composio on VPS

### Symptoms

- Connectors overview: **“NYLAS_API_KEY not configured”** while Composio works.
- **Brand new box** shows **two Gmail accounts** (or other OAuth) you connected on a different sandbox.
- `GET /joshu/api/connectors/status` → `registry.composio.userId` equals **owner email** instead of customer slug.

### Root causes

1. **Nylas never provisioned** — `NYLAS_API_KEY` was not in `buildSandboxBootstrapEnv()` until 2026-06; operator `.env` alone does not reach the VPS.
2. **Shared Composio user** — OAuth tokens live in **Composio cloud**, keyed by Composio `user_id`. Older code used `JOSHU_AROZ_USER` (owner email) for every box with the same owner → same Gmail connections everywhere.
3. **Not a snapshot restore** — local mail mirrors may be empty while Composio still lists accounts from the shared `user_id`.

### Fix (new provisions)

In `apps/control-plane/.env.local` (or Vercel):

```dotenv
DEFAULT_COMPOSIO_API_KEY=...
DEFAULT_NYLAS_API_KEY=...
# DEFAULT_NYLAS_API_URI=https://api.us.nylas.com
```

Provision again (or patch existing host). Control plane sets **`COMPOSIO_USER_ID=<customer-slug>`** automatically. Requires Joshu **`resolveComposioUserId()`** that prefers `COMPOSIO_USER_ID` (image **0.1.11+**).

### Fix (existing droplet, e.g. `patrick`)

On the host:

```bash
# Append keys (use your real values; no quotes in dotenv file)
grep -q '^NYLAS_API_KEY=' /etc/joshu/instance.env || echo 'NYLAS_API_KEY=…' >> /etc/joshu/instance.env
grep -q '^COMPOSIO_USER_ID=' /etc/joshu/instance.env || echo 'COMPOSIO_USER_ID=patrick' >> /etc/joshu/instance.env

cd /opt/joshu/deploy
docker compose -f docker-compose.yml --env-file /etc/joshu/instance.env up -d --force-recreate joshu-stack
```

Verify:

```bash
curl -fsS http://127.0.0.1:8788/joshu/api/connectors/status | jq '{nylas:.nylas.configured, composioUser:.registry.composio.userId, gmailCount:(.gmail.accounts|length)}'
```

Expect `nylas: true`, `composioUser: "patrick"` (slug), `gmailCount: 0` until Connect on **this** box.

If the image predates the `composioApi.js` fix, temporarily bind-mount patched `dist/composioApi.js` or upgrade to **0.1.11+**.

See also [control-plane-schema — instance.env](control-plane-schema.md#provisioned-instanceenv-product-secrets), [connectors.md](../connectors.md).

### Action guard — expected behavior and quick checks

Full design: [`connectors.md` — Action guard](../connectors.md#action-guard-owner-approval-for-writes).

| Symptom | Likely cause |
|---------|----------------|
| jMail send works with **no** Telegram prompt | **Expected** — browser jMail bypass (`X-Joshu-Mail-Client` + `Sec-Fetch-Site`) |
| Agent `execute_code` POST to `/nylas/messages/send` sends without prompt | **Bug** — REST gate missing or guard disabled; fixed in `src/actionGuard/nylasSendGate.ts` |
| Hermes send hangs ~30 min then “succeeds” without mail | Owner did not approve in time (timeout → silent deny) |
| Hermes send **TimeoutError at ~120s** then worker claims MCP down | Action guard still waiting; MCP tool timeout ≠ connectors failure — see [connectors.md — MCP tool timeout](../connectors.md#action-guard-mcp-tool-timeout-vs-approval-wait) |
| Hermes send never prompts Telegram | `telegramLinked: false` — owner must `/start` the bot; or `JOSHU_ACTION_GUARD_ENABLED` / token missing |
| **`503 action_guard_telegram_not_linked`** on send | Telegram not linked — expected when guard on; Joshu no longer crashes (2026-06-23) |
| Agent Composio tools fail immediately | Composio guard proxy down — check `curl -fsS http://127.0.0.1:8796/health`; restart via `vps-start.sh` watchdog |
| Langfuse shows `mcp_composio_COMPOSIO_SEARCH_TOOLS` but no gate | **Expected** — meta/read tools pass through; only `GMAIL_SEND_*` and `nylas_send_message` are gated |
| `:8795/health` OK but MCP tools return HTML / 404 | **`JOSHU_CONNECTORS_API_BASE`** wrong (often `:8787` ArozOS instead of `:8788` Joshu) — see [connectors.md](../connectors.md#joshu-connectors-api-base-local-dev) |

On-box checks:

```bash
curl -fsS http://127.0.0.1:8788/joshu/api/action-guard/status | jq '{enabled, telegramLinked}'
curl -fsS http://127.0.0.1:8796/health
grep -E 'ACTION_GUARD|COMPOSIO_MCP_GUARD' /etc/joshu/instance.env
```

Hotpatch after code changes: Lane A (`scripts/composio-mcp-guard-proxy.mjs`, `vps-start.sh`) + Lane B3 (`dist/` including `src/actionGuard/`) — see [hotpatch-running-box.md](hotpatch-running-box.md).

### Nylas “errors” in `docker logs` (usually not outages)

**Validated on `patrick.box.joshu.me` (2026-06-04):** `docker logs` showed many yellow **`400` / `404`** lines on `/joshu/api/nylas/*` plus a few `[nylas] events.list failed: Cannot read properties of null (reading 'length')`. **`GET /joshu/api/connectors/status`** still had fresh `nylas.sync.lastSyncAt`, no `lastError`, and growing `mirror.threadCount`.

| What you see | What it usually is |
|--------------|-------------------|
| `[nylas] events.list failed: … null … length` | Nylas SDK bug on agent `events.list`; caught in [`src/nylas/client.ts`](../src/nylas/client.ts) — returns `[]`, mail sync continues |
| `POST /joshu/api/nylas/events 400` (~54 B body) | **`ea-scheduling`** missing `title` / `startTime` / `endTime` before a successful retry |
| `POST /joshu/api/nylas/messages/send 400` (~138 B) | Missing `to` / `subject` / `body` |
| `404` on `/nylas/calendars`, `/events/create`, `/events/delete` | Wrong URLs — use [`docs/nylas-agent-mailbox.md`](../nylas-agent-mailbox.md) routes |
| `[ea-scheduling] queued cron for nylas/…` | Success (one-shot Hermes job registered) |

**Diagnose sync health:**

```bash
curl -fsS http://127.0.0.1:8788/joshu/api/connectors/status | jq '.nylas.sync, .nylas.mirror'
docker logs deploy-joshu-stack-1 2>&1 | grep -c '\[nylas\] events.list failed'   # expect low / boot-only
```

**EA scheduling cron create failure:** `'<=' not supported between instances of 'dict' and 'int'` — Hermes bridge expects **`repeat: 1`** (int), not `{ times: 1 }`. Fixed in `schedulingCron.ts` + `hermes-cron-bridge.py` (`_normalize_repeat`). Log success: `[ea-scheduling] queued cron for nylas/<thread_id>`.

**EA scheduling Kanban (2026-06):** Meeting state on **`ea-scheduling`**. As of **2026-06-17**, ingest uses universal **`ea-mail-ingress`** + Triage stub (no new **`ea-sched-ingress`**). Workers **cannot** cross boards with Hermes `kanban_create` / `kanban_list`; use **`scheduling_*`** / **`mail_*` MCP** ([`ea-for-joshu.md`](../Joshu-SOP/ea-for-joshu.md#ea-scheduling--board-isolation-hermes)). Owner availability: **`google_calendar_find_free_slots`** — omit `items`, use **`calendars.combined.free`** (ea-scheduling v4.19+). Hotpatch: [calendar free/busy](hotpatch-running-box.md#calendar-freebusy--transparent-events-2026-06-17), [multi-calendar + combined](hotpatch-running-box.md#calendar-multi-calendar-freebusy--combined-2026-06-24). Ops retry after denied send: [ea-for-joshu — ops retry](../Joshu-SOP/ea-for-joshu.md#ea-scheduling--ops-retry-denied-send--bad-slots).

**EA project Kanban (2026-06):** Multi-step / HITL work on **`project-<slug>`** boards via skill **`ea-project-kanban`**; global **`kanban.auto_decompose: true`**; default toolsets include **`kanban`**. Distinct from ingest-driven **`ea-sched-*`** boards. Spec: [`ea-for-joshu.md`](../Joshu-SOP/ea-for-joshu.md#project-kanban-multi-step--hitl-2026-06). Hotpatch: [`hotpatch-running-box.md`](hotpatch-running-box.md#skills-seed-after-docker-compose-recreate-gotcha).

**EA scheduling — competing workers (2026-06-23, UP.Labs):** Two Kanban tasks on **different boards** (`ea-scheduling` + `project-uplabs-role`) both tried `nylas_send_message` on the same thread. Root cause: cross-board idempotency gap + project auto_decompose — not ingest dedupe failure. Fix: only **`ea-scheduling`** sends; thread-level dedup in [`schedulingCron.ts`](../../src/ea/schedulingCron.ts); skills [`ea-playbook` v2.16+](../../integrations/hermes/skills/executive-assistant/ea-playbook/SKILL.md), [`ea-scheduling` v4.18+](../../integrations/hermes/skills/executive-assistant/ea-scheduling/SKILL.md). Full write-up: [`ea-for-joshu.md` — Cross-board execution](../Joshu-SOP/ea-for-joshu.md#ea-scheduling--cross-board-execution-2026-06-23).

### Local dev — stopping `npm run dev:arozos` (2026-06-23)

**Ctrl+C** in the dev terminal runs `cleanup` in [`scripts/dev-arozos.sh`](../../scripts/dev-arozos.sh) (`trap EXIT INT TERM`) — stops Joshu (`:8788`), ArozOS (`:8787`), Hindsight, voice-realtime, and gbrain via `stop-gbrain.sh`. **Often still running:** connectors MCP (`:8795`), composio guard (`:8796`), orphaned Hermes gateway, Hermes dashboard, Camofox Docker. Exit code **130** is normal. For a clean restart, `npm run dev:arozos` again (start scripts kill stale MCP PID files). For full teardown:

```bash
HERMES_BIN=/path/to/hermes/venv/bin/hermes
"$HERMES_BIN" kanban reclaim --all 2>/dev/null || true
"$HERMES_BIN" gateway stop 2>/dev/null || true
bash scripts/stop-gbrain.sh
kill "$(cat ~/.joshu/connectors-mcp.pid 2>/dev/null)" 2>/dev/null || true
```

23. **Agent claims time-block renderer "doesn't exist" on VPS** — Script is at **`/opt/joshu/scripts/render-time-block-excalidraw.mjs`** (and gather at **`gather-time-block-input.mjs`**). Hermes **`terminal.cwd`** is the ArozOS Desktop folder, so `node scripts/render-time-block-excalidraw.mjs` returns "No such file". **`ea-time-block`** v1.3.0+ documents absolute VPS paths. **Fix:** hotpatch runtime `SKILL.md` into `/root/.hermes/skills/joshu/…/ea-time-block/`; start a **new jChat** session. **Smoke:** `docker exec … node /opt/joshu/scripts/render-time-block-excalidraw.mjs /tmp/plan.json -o /tmp/out.excalidraw`.

### Skills bootstrap overwrites box evolution (2026-06-12)

**Observed (`patrick.box.joshu.me`):** Operator hotpatched **`joshu-mail`** by rsyncing factory skills, deleting `.joshu-seed-version`, and running `bootstrap-hermes-learning-skills.sh` while bootstrap still used **`rsync --delete`** (pre-merge). Bootstrap replaced the entire `$HERMES_HOME/skills/joshu/` tree. **`skills/.evolution.jsonl`** still listed background_review patches to `ea-playbook` and `ea-project-kanban`, but live skill files matched factory — Patrick-specific Kanban CLI fixes were gone.

| What | Survives forced **`overwrite`** bootstrap? |
| --- | --- |
| `skills/.evolution.jsonl` | Yes (audit log only — **not replayed**) |
| `db-aeon/joshu-learning-{slug}` GitHub backup | Yes (last hourly push before wipe) |
| Evolved `$HERMES_HOME/skills/joshu/**` bodies | **No** — overwritten by factory |

**Recovery:** Restore evolved files from the learning GitHub repo into `/root/.hermes/skills/joshu/`, merge intentional factory deltas (e.g. new `joshu-mail` skill), run `hermes-learning-github-sync.sh`, restart gateway.

**Prevention (2026-06+):** Routine factory rollouts bump `factory/manifest.yaml` `release` and bootstrap in **`merge`** mode (LLM per `SKILL.md` on each box). Use **`JOSHU_HERMES_SKILLS_SEED_MODE=overwrite`** only on hard factory reset. See [skills hotpatch](hotpatch-running-box.md#skills-hotpatch-on-boxes-with-learning-2026-06-12).

### Composio live Gmail mail search (2026-06-12)

**Observed (Langfuse, Patrick):** Agent asked to find principal Gmail by subject; local mirrors empty/stale. Agent loaded **`joshu-brain`** only (not mail skill), used Composio with wrong `user_id` (email address → delegation denied), got large payload offloaded to `/mnt/files/…`, never called **`COMPOSIO_REMOTE_WORKBENCH`**, loop failed on LLM error.

**Fixes shipped:**

| Area | Change |
| --- | --- |
| Skill catalog | New **`joshu-mail`** — general find/search/recall; description matches intent (not buried in `ea-playbook` triage) |
| Search model | Local cache (gbrain + mirrors) → deep server-side Composio when cache misses |
| Composio playbook | Session loop + mandatory workbench on `remote_file_info`; multi-Gmail `connectedAccountId` + `user_id: "me"` |
| Agent context | `hermesContextFile.ts`, `joshuIdentity.ts` → load `joshu-mail` for mail |

Skill: [`integrations/hermes/skills/mail/joshu-mail/`](../integrations/hermes/skills/mail/joshu-mail/SKILL.md).

### Hermes Admin local 504 / dashboard not on :9119

**Symptom (local Mac):** `http://127.0.0.1:8788/joshu/hermes-admin/` returns **504**, or the browser shows `Error occurred while trying to proxy: 127.0.0.1:8788/`. `GET /joshu/api/hermes-dashboard/status` has `"ok": false`. Running `bash scripts/start-hermes-dashboard.sh` outside the repo or without env may print `/opt/hermes-agent/venv/bin/hermes not found`.

**Cause:** Joshu reverse-proxies to Hermes dashboard on `127.0.0.1:9119`. Local dev needs `HERMES_BIN` in repo `.env` pointing at your Hermes checkout. The dashboard script loads that file when run from the repo; VPS uses `/etc/joshu/instance.env` and explicit `HERMES_DIR=/opt/hermes-agent` instead.

**Fix:**

```bash
# From joshu repo — .env must include HERMES_BIN=/path/to/hermes-agent/venv/bin/hermes
bash scripts/start-hermes-dashboard.sh
curl -fsS http://127.0.0.1:8788/joshu/api/hermes-dashboard/status   # expect "ok": true
```

Or restart the full stack: `npm run dev:arozos` (starts dashboard after Joshu is healthy). Do not browse `:9119` directly on Mac — use the Joshu proxy URL above.

### Hermes Admin Invalid Host header

**Symptom:** Opening `https://hermes-admin.<slug>.<suffix>/` returns JSON:

```json
{ "detail": "Invalid Host header. Dashboard requests must use the hostname the server was bound to." }
```

**Cause:** Hermes dashboard binds `127.0.0.1:9119` and only accepts loopback `Host` values (DNS rebinding defense). Caddy forwarded the public hostname (`hermes-admin.…`) unchanged.

**Fix:** Regenerate Caddyfile from current `render-caddyfile.sh` (includes `header_up Host 127.0.0.1:9119`) and reload Caddy:

```bash
bash /opt/joshu/deploy/scripts/render-caddyfile.sh /etc/joshu/instance.env
cd /opt/joshu/deploy && docker compose --env-file /etc/joshu/instance.env exec -T caddy caddy reload --config /etc/caddy/Caddyfile
```

**Verify:**

```bash
curl -fsS -u admin:$JOSHU_HERMES_DASHBOARD_PASSWORD -o /dev/null -w '%{http_code}\n' \
  https://hermes-admin.<slug>.<suffix>/
```

Expect **200**. Full setup: [hermes-customizations.md — Hermes web dashboard](../hermes-customizations.md#hermes-web-dashboard).

**Kanban edits not persisting:** confirm board **`ea-scheduling`** (API default is `default`). PATCH without `?board=ea-scheduling` returns 404 and the UI rolls back optimistic updates.

**Triage module split:** do not import `schedulingCase` from `triageStub.ts` — circular graph causes IDE “module not found” while `tsc` still passes. Use `triageTypes.ts`, `triageStubFiles.ts`, `triageSchedulingBridge.ts` ([`ea-for-joshu.md`](../Joshu-SOP/ea-for-joshu.md#scheduling-cases-coordination-unit)).

**Log tail for app health (not security):**

```bash
docker logs -f deploy-joshu-stack-1 2>&1 | grep -iE 'connectors-cron|ea-scheduling|gbrain|PGLite'
```

That filter does **not** show SSH or ArozOS login brute force — use host `auth.log` / `login request rejected` in full container logs for desktop auth.

---

## Hard factory reset (Box State)

Full procedure: [box-state.md](../box-state.md#hard-factory-reset). Image **`0.1.14+`** bundles the fixes below.

| Symptom (pre-0.1.14) | Cause | Fix in 0.1.14+ |
| --- | --- | --- |
| **Hard reset…** click does nothing | Semantic UI modal inside jQuery `.load()` fragment | Native `confirm()` in [`box-state.html`](../../arozos/system-setting/box-state.html) |
| `EBUSY: rmdir '/root/.gbrain'` | Wiped Docker volume **mount root** | Wipe volume **contents** only; `stop-gbrain.sh` first |
| Composio still connected | `box-wipe-connectors.ts` imported missing `src/` on VPS | Loads `dist/boxHardResetHooks.js`; aborts if disconnect fails |
| Desktop missing shortcuts | Wipe removed Desktop; no post-restore install | `bootstrap-joshu-files.sh` + `install_all_joshu_desktop_shortcuts` |
| Agent skills survive reset | `~/.hermes/skills/` not wiped | Hard reset clears `skills/` and `cron/` |
| All bundled Hermes skills enabled (~170) after reset or image upgrade | `skills.disabled` empty or gateway not restarted | `resyncHermesAfterBoxHardReset()` on hard reset; VPS boot: `verify_hermes_skills_denylist` in `vps-start.sh`; start **new jChat** session |

**Manual Composio disconnect** (without full reset):

```bash
docker exec deploy-joshu-stack-1 bash -lc \
  'cd /opt/joshu && node -e "import(\"./dist/boxHardResetHooks.js\").then(m=>m.wipeConnectorCloudState(\"/opt/joshu\")).then(console.log)"'
```

---

## Cloud-init and `instance.env`

### DigitalOcean user_data

Sending cloud-config **base64-encoded** when the API expects plain `#cloud-config` YAML caused:

```text
Unhandled non-multipart userdata …
```

Bootstrap never ran → no `/etc/joshu/instance.env` → manual recovery often copied `deploy/.env.vps.example` (**`JOSHU_IMAGE_REF=...:0.1.0`**).

**Fix:** Plain `user_data` in `digitalocean.ts` (see commit on `main`).

### Missing `instance.env` on host

| Symptom | Check |
|---------|--------|
| `grep instance.env` fails **inside** container | Expected — file is host-mounted; check **on host**: `cat /etc/joshu/instance.env` |
| Host file missing | Cloud-init failed or manual stack start without provision |

Compose must mount the file (bootstrap greps for this):

```yaml
- /etc/joshu/instance.env:/etc/joshu/instance.env:ro
```

Set `JOSHU_COMPOSE_ENV_FILE=/etc/joshu/instance.env` in generated `instance.env` so container `env_file` is not the template alone.

---

## Image tag vs release version

Easy to confuse:

| Field | Meaning | Typical mistake |
|-------|---------|-----------------|
| `JOSHU_IMAGE_REF` | Docker image pulled from GHCR | Assumed `0.1.1` local build == what's on the box |
| `JOSHU_RELEASE_VERSION` | Label in health JSON | Saw `0.1.0` and thought image was `0.1.0` |

**Truth on the box:** `grep JOSHU_IMAGE_REF /etc/joshu/instance.env` and `curl …/api/instance/version | jq .imageRef`.

**Local provision only:** Value comes from `apps/control-plane/.env.local` at the moment `provisionQueuedInstance` runs. Restart `pnpm dev` after env edits. Avoid duplicate `JOSHU_IMAGE_REF` lines in the same file.

**Admin upgrade dropdown:** `/admin` and `GET /api/admin/releases` auto-sync a `Release` row from [`deploy/RELEASE.json`](../../deploy/RELEASE.json) (or `DEFAULT_JOSHU_RELEASE_VERSION` on Vercel) via `syncDeployRelease.ts` — so a new local build tag appears without manual `db:seed` if the pin file is updated.

Building `docker buildx -t …:0.1.1` does **not** change already-provisioned instances.

---

## noVNC / Camofox browser pane

### Architecture (VPS stack)

```text
Browser (jWeb / camofox-viewer.html)
  └─ wss://<host>/joshu/novnc/websockify
        └─ Joshu Express (PUBLIC_BASE_PATH=/joshu) upgrades WS → rewrites path → :6080
              └─ websockify (Camofox image, ENABLE_VNC=1)
                    └─ 127.0.0.1:5900 (x11vnc on Xvfb :99)
                          └─ Firefox (Camoufox) — only after POST /tabs succeeds

Joshu fit-viewport chain:
  POST /joshu/api/camofox/fit-viewport  (dist/server.js — needs image rebuild)
    └─ bootstrapCamofoxStartUrl + ensureTab if needed
          └─ POST http://127.0.0.1:9377/tabs/:tabId/viewport  (patched /app/server.js)
                └─ __hitlFitBrowserWindow(page, { width, height })
```

**Lesson:** A “connect then instant disconnect” is often **not** a noVNC client bug. Check whether **x11vnc is listening on 5900** before blaming the UI or reconnect logic.

### Symptoms

| What you see | Likely layer |
|--------------|----------------|
| `Failed to fetch …/joshu/novnc/core/rfb.js` or proxy **504** | websockify / `:6080` not up (`ENABLE_VNC` missing) |
| **502** right after `docker compose … --force-recreate` | Caddy → Joshu `:8788` not ready yet; wait for health |
| WebSocket **101** then console: `code: 1011, reason: Failed to connect to downstream server` | websockify up, **x11vnc not on :5900** (browser never launched) |
| `GET /joshu/api/status` → `browserRunning: false`, `activeTabs: 0` | Camofox tab create failed (see `/tabs` 500 below) |
| `POST /joshu/api/camofox/fit-viewport` → **404** on old image | Route missing in `dist/server.js` — upgrade image |
| `POST /joshu/api/camofox/fit-viewport` → **404** “No Camofox tab” on `0.1.5` | Route existed but did not bootstrap tab — fixed in **`0.1.6`** |
| VNC **connected** `1024×768` but Firefox small with black margins | Framebuffer OK; **window not fitted** — `fit-viewport` + `launchOptions` `window:` + patch |
| Debug `fb: 1920×1080` while target `1024×768` | `VNC_RESOLUTION` unset at container create — **recreate** stack |
| Camofox container **Exited (1)**; logs: `Camofox viewport route must call __hitlFitBrowserWindow with width/height` | **Stale hybrid patch** in `/app/server.js` (old viewport route + old `__hitlFitBrowserWindow(page)`). Re-patch cannot upgrade in place — **remove and recreate** the container (local) or rebuild/re-patch the image (VPS). See [Patch pitfalls](#patch-pitfalls-maintainers) below. |

### noVNC static assets (504 / failed import)

`deploy/scripts/vps-start.sh` used to start Camofox **without** `ENABLE_VNC=1`. The `camofox-browser` image only binds noVNC on `127.0.0.1:6080` when VNC is enabled. Joshu proxies `/joshu/novnc/*` → `:6080`; nothing listening → **504** on `rfb.js`.

VPS parity (`deploy/scripts/vps-start.sh`) exports `ENABLE_VNC` and `NOVNC_*`; VPS bootstrap and `sandboxEnv.ts` now match.

**Repair on a running droplet (env only, no image rebuild):**

```bash
ssh root@<slug>.box.joshu.me
grep -E '^(ENABLE_VNC|NOVNC_|VNC_RESOLUTION)' /etc/joshu/instance.env || true
cat >>/etc/joshu/instance.env <<'EOF'
ENABLE_VNC=1
NOVNC_URL=/novnc
NOVNC_PROXY_TARGET=http://127.0.0.1:6080
NOVNC_CLIENT_PATH=/novnc
VNC_RESOLUTION=1024x768
CAMOFOX_VIEWPORT_WIDTH=1024
CAMOFOX_VIEWPORT_HEIGHT=768
BROWSER_IDLE_TIMEOUT_MS=300000
CAMOFOX_START_URL=about:blank
JOSHU_WARM_CAMOFOX=false
EOF
docker compose -f /opt/joshu/deploy/docker-compose.yml --env-file /etc/joshu/instance.env up -d --force-recreate joshu-stack
```

### `camoufox-bin` at 100% CPU / box feels slow

**Typical cause:** Camofox runs **Firefox + Xvfb + x11vnc** for noVNC (`ENABLE_VNC=1`), warmed at boot to **`https://news.google.com/`** with **`BROWSER_IDLE_TIMEOUT_MS=0`** (browser never sleeps). On a **4 vCPU** DO droplet that also runs Joshu, Hermes, Hindsight Postgres, ArozOS, and gbrain, one core stays pegged.

**Quick relief on a running box (SSH):**

```bash
# Navigate the HITL tab to a light page (same session Joshu/Hermes use)
docker exec "$(docker ps -qf name=joshu-stack)" curl -fsS -m 60 -X POST http://127.0.0.1:9377/tabs \
  -H 'Content-Type: application/json' \
  -d '{"userId":"hitl-camofox","sessionKey":"hitl-main","url":"about:blank"}'
```

**Durable fix:** append to `/etc/joshu/instance.env` then recreate `joshu-stack`:

```bash
CAMOFOX_START_URL=about:blank
JOSHU_WARM_CAMOFOX=false
BROWSER_IDLE_TIMEOUT_MS=300000
```

New provisions from control plane use these defaults via `sandboxEnv.ts` (`DEFAULT_CAMOFOX_START_URL`, `DEFAULT_JOSHU_WARM_CAMOFOX=false`, `DEFAULT_BROWSER_IDLE_TIMEOUT_MS=300000`). Browser still works: first open of **Joshu Browser** / Hermes HITL launches a tab; VNC may take a few extra seconds on first connect.

After stack is healthy (~60–180s):

```bash
curl -fsS -o /dev/null -w 'loopback 6080=%{http_code}\n' http://127.0.0.1:6080/core/rfb.js
curl -fsS -o /dev/null -w 'joshu proxy=%{http_code}\n' http://127.0.0.1:8788/joshu/novnc/core/rfb.js
```

### Instant disconnect (1011 downstream)

**Validated on `5-22-4.box.joshu.me` (2026-05):**

1. Browser console: `Connection closed (code: 1011, reason: Failed to connect to downstream server)`.
2. Inside stack: `websockify` running, **`pgrep x11vnc` empty**, port **5900 closed**.
3. Camofox logs: `Version information not found at /root/.cache/camoufox/version.json` on every `POST /tabs`.
4. `GET :9377/health` can still show `ok: true` with `browserRunning: false`.

**Cause chain:** missing Camoufox browser cache → tab create **500** → no Firefox → no Xvfb/x11vnc → websockify accepts WebSocket then closes with 1011.

**Hotfix:**

```bash
docker exec deploy-joshu-stack-1 bash -lc 'cd /app && npx --yes camoufox-js fetch'
docker exec deploy-joshu-stack-1 test -f /root/.cache/camoufox/version.json && echo ok
docker exec deploy-joshu-stack-1 curl -fsS -m 120 -X POST http://127.0.0.1:9377/tabs \
  -H 'Content-Type: application/json' \
  -d '{"userId":"hitl-camofox","sessionKey":"hitl-main","url":"https://news.google.com/"}'
# Expect tab JSON; then pgrep -a x11vnc and Xvfb :99 -screen 0 1024x768x24
```

**Permanent (image `0.1.5+`):**

- `deploy/Dockerfile`: `rm -rf` only `/root/.cache/pip`, not all of `/root/.cache`; build fails if `version.json` missing after `npm ci`.
- `vps-start.sh`: `ensure_camoufox_browser_cache()` then `warm_camofox_browser()` before Joshu starts.

**Note:** `POST /tabs` requires **`userId` and `sessionKey`** (defaults `hitl-camofox` / `hitl-main`). Bare `{"url":…}` returns 400.

### `POST /tabs` returns 500

Camofox health (`GET :9377/health`) can be `ok: true` while tab creation fails — read **container logs** (`docker logs deploy-joshu-stack-1`) for `tab create failed` / `camoufox launch attempt failed`.

### Connect → disconnect loop (client-side)

| Cause | Fix |
|-------|-----|
| **1011 downstream** (above) | Fix Camoufox cache + tab; not a reconnect loop |
| **Status poll reconnects every 8s** | `public/app.js`: `vncAutoConnectDone` — one auto-connect; **Reload VNC** after drop; 60s backoff |
| **Two viewers kick each other** | noVNC `shared: false`; scope WS upgrades to `/joshu/novnc/*` only (`src/server.ts`) |
| **x11vnc restart on display change** | Camofox `vnc-watcher` restarts x11vnc when display changes; avoid rapid browser recycle |

### fit-viewport (`POST /joshu/api/camofox/fit-viewport`)

**Purpose:** After VNC connects, resize the **Firefox chrome window** on Xvfb to match `CAMOFOX_VIEWPORT_*` / `VNC_RESOLUTION` (not just scale the canvas in the browser).

**Two layers must both be present:**

| Layer | File | What it does |
|-------|------|----------------|
| Joshu API | `src/server.ts` → `dist/server.js` | Bootstraps tab if missing, calls `camofoxSession.fitViewport()` |
| Camofox patch | `scripts/patch-camofox-single-tab.mjs` → `/app/server.js` at image build | `__hitlFitBrowserWindow(page, override)`, `POST /tabs/:tabId/viewport`, `launchOptions({ window: [w,h] })`, `...__hitlFfLaunchOverrides()` (default `CAMOFOX_FF_VERSION=139`), Firefox single-tab prefs, **`__hitlPopupCoerceV2`** (Slack/OAuth magic-link popups) |

### Slack / “browser not supported” on sign-in

**Symptom:** `slack.com/signin` or `app.slack.com` shows *“Your browser is not supported”* / *“We are no longer supporting this version of your browser”* — not an OAuth or clipboard issue.

**Cause:** Camofox images ship **Firefox 135**. Slack (and some other sites) block that rv: in the user agent.

**Fix (v1):** Joshu’s Camofox patch sets `launchOptions({ ff_version: … })` from **`CAMOFOX_FF_VERSION`** (default **`139`**). This spoofs the fingerprint UA without upgrading the binary. Set `CAMOFOX_FF_VERSION=0` to disable and use the real binary version.

**Apply locally:** recreate Camofox so the patch runs and the browser relaunches:

```bash
docker rm -f camofox-hitl
bash scripts/ensure-camofox-container.sh
```

**Verify:**

```bash
curl -s 'http://127.0.0.1:9377/tabs?userId=hitl-camofox' | jq .
# evaluate on tab: navigator.userAgent should show rv:139.0
# slack.com/signin should show email / Google / Apple sign-in
```

**Long-term:** upgrade the Camoufox binary to Firefox 150+ (`camoufox-js` ≥ 0.11) when the base image catches up — then `CAMOFOX_FF_VERSION` can be unset.

### Slack “Access Denied” on VPS (datacenter IP)

**Symptom:** `slack.com/signin` returns a bare page with body text **`Access Denied`** (not “browser not supported”). `curl` from the box’s public IP may get **403** from Slack’s edge while other sites load fine.

**Cause:** Slack blocks many **datacenter** IPs. VPS egress is not residential.

**Fix:** Route Camofox through a **residential proxy** (e.g. Decodo endpoint:port dashboard style). Set in repo `.env` (see `.env.example`):

```bash
PROXY_STRATEGY=round_robin
PROXY_HOST=us.decodo.com
PROXY_PORTS=10001-10010
PROXY_USERNAME=...
PROXY_PASSWORD=...
```

**Local:** `bash scripts/ensure-camofox-container.sh` passes `PROXY_*` into the Camofox container and recreates it when proxy env changes.

**VPS box:** push creds and recreate the stack:

```bash
bash scripts/sync-camofox-proxy-to-vps.sh clara
```

Uses `SSH_HOST=${SYNC_BOX_SSH_HOST:-<slug>.box.joshu.me}` — **not** repo `HOST=` (often `127.0.0.1` for local Joshu).

**Verify:**

```bash
docker logs deploy-joshu-stack-1 2>&1 | grep -i 'proxy pool created'
curl -fsS http://127.0.0.1:9377/health | jq .
# slack.com/signin via browser should show real sign-in HTML (~100KB+), not Access Denied
```

### Slack 2FA / magic link → “Link Expired”

**Symptom:** Email or SSO 2FA opens a popup; noVNC ends on **`Link Expired | Slack`** at a `…/z-app-…` URL. Camofox logs may show `popup coerced into opener tab` then `popup same-tab navigation failed` (30s timeout).

**Cause:** HITL **single-tab popup coercion** (`patch-camofox-single-tab.mjs`) must wait for Slack’s one-time magic-link redirect chain before moving the URL into the opener tab. Legacy handler closed the popup first and burned the token.

**Fix (v2):** Patch includes `__hitlPopupCoerceV2` — waits for popup load/redirect, `location.assign` on opener, closes popup after, 90s timeout for `/z-app/` URLs. Idempotent upgrade from legacy handler on re-run.

**Apply on running VPS stack:**

```bash
docker cp scripts/patch-camofox-single-tab.mjs deploy-joshu-stack-1:/tmp/
docker exec deploy-joshu-stack-1 node /tmp/patch-camofox-single-tab.mjs /app/server.js
# Restart Camofox (port 9377) or force-recreate joshu-stack so server.js reloads
grep -c __hitlPopupCoerceV2 /app/server.js   # expect 1
```

**Workaround while logging in:** copy the verification link from email and **paste into the noVNC address bar** (do not click from mail on another device). Request a **fresh** link if one already hit “Link Expired”.

**Note:** Hermes **Composio Slack** (Connectors OAuth) is separate from logging into slack.com in the HITL browser.

**Image history:**

| Tag | fit-viewport notes |
|-----|------------------|
| `<0.1.5` | Joshu route often missing in `dist/`; Camofox patch incomplete |
| `0.1.5` | Cache + VNC env; Joshu route in dist; Firefox prefs needle failed; `fit-viewport` returned **404** if no tab |
| **`0.1.6`** | Joshu bootstraps tab on fit; `__hitlFitBrowserWindow(page, override)` uses POST body dimensions; Firefox prefs patch works |

**Build:**

```bash
npm run build:deploy
JOSHU_IMAGE_TAG=0.1.6 JOSHU_IMAGE_REPO=ghcr.io/db-aeon/joshu-sandbox JOSHU_IMAGE_PUSH=1 npm run vps:build-image
```

**Verify inside a new image:**

```bash
docker run --rm --platform linux/amd64 ghcr.io/db-aeon/joshu-sandbox:0.1.6 bash -lc '
  grep -c "fit-viewport" /opt/joshu/dist/server.js
  grep -c "__hitlFitBrowserWindow(page, override)" /app/server.js
  grep -c firefox_user_prefs /app/server.js
'
```

**On-box test (browser must be up):**

```bash
curl -fsS -X POST http://127.0.0.1:8788/joshu/api/camofox/fit-viewport | jq .
# Expect: ok, width, height, tab, metrics (innerWidth ~ 1024)
```

**Patch-only upgrade** on an old running stack:

```bash
docker exec deploy-joshu-stack-1 node /opt/joshu/scripts/patch-camofox-single-tab.mjs /app/server.js
# Recreate stack so Camofox reloads server.js
```

**Patch pitfalls (maintainers):**

- Firefox `firefox_user_prefs` must be inserted **after** the `window: [__hitlVp…]` line — a needle matching only `virtual_display: vdDisplay,\n      });` silently failed on `0.1.5`.
- The viewport route must call `__hitlFitBrowserWindow(found.tabState.page, { width: nextWidth, height: nextHeight })` — validating body dimensions but ignoring `setViewportSize` only left black margins.
- Re-running the patch on an **already-correct** `server.js` is supported (idempotent).
- **Stale hybrid patch (local `camofox-hitl`, May 2026):** `scripts/ensure-camofox-container.sh` runs `patch-camofox-single-tab.mjs` on **every container start** against `/app/server.js` in the container writable layer. An older patch left a hybrid file:
  - `async function __hitlFitBrowserWindow(page)` (no `override` arg), and/or
  - `POST /tabs/:tabId/viewport` that called `found.tabState.page.setViewportSize(...)` instead of `__hitlFitBrowserWindow(...)`.
  A later patch script saw `hitl viewport resized` (skipped route insert) but could not upgrade the handler. An early regex for the legacy function also stopped at the first `}` inside `page.evaluate`, which could corrupt the file on re-patch.
  **Current script behavior:** brace-balanced replacement of legacy `__hitlFitBrowserWindow(page)` and full replacement of a mismatched viewport route block.
  **Recovery (local):**
  ```bash
  docker rm -f camofox-hitl
  bash scripts/ensure-camofox-container.sh
  ```
  `docker start camofox-hitl` alone does **not** reset `/app/server.js` — you must remove the container so the next create starts from pristine `ghcr.io/jo-inc/camofox-browser` + patch.
  **Recovery (VPS stack):** re-run patch inside the image or running container, then recreate the stack so Camofox reloads `server.js`:
  ```bash
  docker exec deploy-joshu-stack-1 node /opt/joshu/scripts/patch-camofox-single-tab.mjs /app/server.js
  docker compose -f deploy/docker-compose.yml --env-file /etc/joshu/instance.env up -d --force-recreate joshu-stack
  ```
  **Verify patched server.js:**
  ```bash
  grep -c '__hitlFitBrowserWindow(page, override)' /app/server.js   # expect >= 1
  grep '__hitlFitBrowserWindow(found.tabState.page, { width: nextWidth, height: nextHeight })' /app/server.js
  ```

### VNC layout / black margins

| Symptom | Cause | Fix |
|---------|-------|-----|
| Letterboxed VNC in UI | Old `camofox-viewer.html` / `app.js` | Rebuild image or copy all of `public/` |
| Full fb, tiny Firefox | Window not maximized on Xvfb | `fit-viewport`, `launchOptions` `window:`, `VNC_RESOLUTION` at recreate |
| `fb: 1920×1080` in debug | Default Camofox VNC resolution | Set `VNC_RESOLUTION=1024x768` in `instance.env` and force-recreate |

See [hitl-camofox-notes.md](../hitl-camofox-notes.md) for VNC env table, debug overlay, and noVNC cursor pitfalls.

### Deploying UI fixes without a full image

Copying only `public/app.js` + `styles.css` fixes jWeb reconnect behavior but **not** `camofox-viewer.html` or `dist/server.js`. For standalone viewer and `fit-viewport`, use a **new image tag** or copy all three under `/opt/joshu/public/` plus upgrade `dist/`.

### Prevention checklist

- Provision: `sandboxEnv.ts` → `ENABLE_VNC`, `NOVNC_*`, `VNC_RESOLUTION`, `BROWSER_IDLE_TIMEOUT_MS=0`.
- Image: `deploy/Dockerfile` + `vps-start.sh` (`ensure_camoufox_browser_cache`, `warm_camofox_browser`).
- Patch: `patch-camofox-single-tab.mjs` at image build; build log should **not** warn on Firefox pref patch.
- Upgrade: bump `JOSHU_IMAGE_REF` on host **and** `docker pull` + `--force-recreate`.

---

## Chrome “Dangerous site” (Safe Browsing)

### Symptoms

- Chrome full-page red interstitial: **Dangerous site** on `https://<slug>.box.joshu.me/login.html`
- Server is healthy (`curl` returns 200); issue is the **browser blocklist**, not Joshu returning an error

### Common causes

| Cause | Notes |
|-------|--------|
| **Recycled VPS IP** | DigitalOcean reuses IPv4; previous tenant abuse can flag the IP. Visitors hit the raw droplet IP in DNS (grey-cloud A record). |
| **New host + login page** | Automated “deceptive site” heuristics on fresh subdomains with password forms (`login.html`) — often a false positive. |
| **Unrelated compromise** | Rare if the stack is clean; still run a quick sanity check before requesting review. |

[Google Transparency Report](https://transparencyreport.google.com/safe-browsing/search) may show **“No available data”** while Chrome still blocks.

### Prevention (recommended)

1. **`CLOUDFLARE_PROXIED=true`** in control-plane env — orange-cloud A records so browsers see **Cloudflare** edge IPs, not the droplet. See [provider-choices.md](provider-choices.md).
2. **Verify `box.joshu.me` in Google Search Console** (domain property) — security issues + review requests for any subdomain.
3. **IP reputation check** before publishing DNS (VirusTotal IP, MXToolbox) — destroy/recreate droplet if the IP is already listed.
4. Optional: **DigitalOcean reserved IPv4** pool used only for Joshu sandboxes.

### If already flagged

1. Search Console → **Security issues** → fix any real findings → **Request review**.
2. Enable **proxied** DNS for the hostname (or reprovision with `CLOUDFLARE_PROXIED=true`).
3. **Workaround for dev:** SSH tunnel `ssh -L 8787:127.0.0.1:8787 root@<ip>` → `http://127.0.0.1:8787/`, or try Safari/Firefox.

---

## Langfuse on VPS (no traces or Users)

**Validated (2026-05):** `voice-0531.box.joshu.me` on image `0.1.8` after fixing `instance.env` + gateway reload. Traces appear as **Hermes turn** (Sessions / Traces views). **Users** view only lists traces that carry a `userId` — see [Users vs jChat traces](#langfuse-users-vs-jchat-traces) below.

### Required in `/etc/joshu/instance.env`

All of these — **`HERMES_LANGFUSE_USER_ID` alone is not enough**:

```dotenv
JOSHU_HERMES_PLUGIN_NAMES=observability/langfuse
HERMES_LANGFUSE_PUBLIC_KEY=pk-lf-...
HERMES_LANGFUSE_SECRET_KEY=sk-lf-...
HERMES_LANGFUSE_BASE_URL=https://us.cloud.langfuse.com
HERMES_LANGFUSE_ENV=production
HERMES_LANGFUSE_USER_ID=<box-slug>
```

Control plane injects the full set on **new** provisions when `DEFAULT_HERMES_LANGFUSE_*` are set in `apps/control-plane/.env.local` (`sandboxEnv.ts` → `langfuseBootstrapEnv()`).

### Symptom → cause → fix

| Symptom | Cause | Fix |
| --- | --- | --- |
| Empty Langfuse UI, box “healthy” | Keys never in `instance.env` (provisioned before Langfuse defaults) | Append keys above; `docker compose … --force-recreate joshu-stack` |
| Only `HERMES_LANGFUSE_USER_ID` in `instance.env` | Partial manual edit | Add keys + `JOSHU_HERMES_PLUGIN_NAMES` |
| Keys present, still no traces | Gateway started **before** `observability/langfuse` in `config.yaml` | `hermes plugins enable observability/langfuse` then `hermes gateway stop`; or recreate stack after `git pull` (Joshu restarts gateway when plugins change) |
| OTLP **401** in `~/.hermes/logs/agent.log` | Wrong `HERMES_LANGFUSE_BASE_URL` for key region | US → `https://us.cloud.langfuse.com`; EU → `https://cloud.langfuse.com` |
| Health OK, no traces | Health does not emit Hermes turns | `hermes chat -q "hello"` or send jChat message; voice-only Realtime does not trace unless `think` hits Hermes |
| Hermes traces OK, no `joshu-app` | Joshu Langfuse not in image (`node_modules`) or keys missing | Image **0.1.18+** with `@langfuse/*` in `deploy/runtime/package.json`; keys in `instance.env`; grep `[joshu-langfuse] tracing enabled` in stack logs |
| Stack crash `Cannot find module '@langfuse/…'` | New `dist/` imports runtime dep not in image | Rebuild/push image after `deploy/runtime/package.json` change — dist-only hotpatch insufficient |

### Verify on the droplet

```bash
grep -E '^(JOSHU_HERMES_PLUGIN|HERMES_LANGFUSE)' /etc/joshu/instance.env
docker exec deploy-joshu-stack-1 grep HERMES_LANGFUSE /root/.hermes/.env
docker exec deploy-joshu-stack-1 grep -A5 '^plugins:' /root/.hermes/config.yaml
docker exec deploy-joshu-stack-1 bash -lc '
  set -a; source /etc/joshu/instance.env; set +a
  export HERMES_HOME=/root/.hermes
  /opt/hermes-agent/venv/bin/hermes chat -q "langfuse smoke test"
'
docker exec deploy-joshu-stack-1 tail -30 /root/.hermes/logs/agent.log | grep -i langfuse

# Joshu deterministic app (Day 0 / EA classifier) — separate from Hermes plugin
docker logs deploy-joshu-stack-1 2>&1 | grep joshu-langfuse
# Trigger: connector sync with new mail (classifier) or POST /joshu/api/day0/cold-start
# Langfuse UI: filter tag joshu-app or trace ea-scheduling-classifier | joshu-day0-infer
```

### Langfuse Users vs jChat traces

| What you see | Typical cause |
| --- | --- |
| **Traces** (Hermes turn) for jChat / desktop messaging | Langfuse plugin + keys OK — session grouped by `X-Hermes-Session-Id` |
| **Users** empty or only `joshu-smoke-test` (not box slug) | `userId` not on gateway/API traces |

**`joshu-smoke-test` is not in this repo.** It usually comes from a **one-off CLI smoke** (`hermes chat -q "…"`) using a Hermes **profile** of that name, or from **another machine** (local `npm run dev:arozos`) sending traces into the same Langfuse project. That path can differ from **jChat** (`POST /v1/chat/completions` via Joshu gateway), which does not send a profile header.

**Box slug (`voice-0531`) on every trace** requires all of:

1. `HERMES_LANGFUSE_USER_ID=voice-0531` in `/etc/joshu/instance.env` (control plane sets this on new boxes).
2. `scripts/hermes-langfuse-user-id.patch` applied on the Hermes plugin (`apply-hermes-langfuse-patches.sh` at image build + VPS boot).
3. **Hermes gateway restarted** after patch/keys so the plugin reads env (check gateway process, not only `~/.hermes/.env`):

```bash
docker exec deploy-joshu-stack-1 bash -lc '
  tr "\0" "\n" < /proc/$(pgrep -f "hermes gateway" | head -1)/environ | grep HERMES_LANGFUSE_USER_ID
  rg "trace_ctx\[\"user_id\"\]" /opt/hermes-agent/plugins/observability/langfuse/__init__.py || echo "patch missing — git pull + recreate stack"
'
```

Joshu (`src/hermesApi.ts`) passes `HERMES_LANGFUSE_USER_ID` into the gateway process,
syncs it to `~/.hermes/.env`, and derives the slug from `CUSTOMER_DOMAIN` when unset.
The user-id patch sets `trace_context["user_id"]` and `propagate_attributes(user_id=…)`.
Rebuild/push the sandbox image after Joshu or patch changes.

**Upstream note:** Newer Hermes may map **profile name** → Langfuse `userId` ([issue #26455](https://github.com/NousResearch/hermes-agent/issues/26455)). Our pin uses `HERMES_LANGFUSE_USER_ID` + `trace_context.user_id` instead so all gateway/jChat turns share one box slug.

### Code touchpoints

| File | Role |
| --- | --- |
| `apps/control-plane/src/lib/sandboxEnv.ts` | Provision Langfuse vars + `HERMES_LANGFUSE_USER_ID=<slug>` |
| `src/hermesApi.ts` | Plugins, Camofox, gbrain MCP, Langfuse env, gateway restart on plugin/user-id change |
| `src/observability/langfuse.ts`, `src/day0/llm.ts` | Joshu deterministic OpenRouter → Langfuse (Day 0, EA classifier) |
| `deploy/runtime/package.json` | VPS container `node_modules` (includes `@langfuse/tracing`, `@langfuse/otel`, `@opentelemetry/sdk-node`) |
| `src/hermesConfigSplit.ts` | Product vs personal config split; atomic merged writes; corrupt YAML auto-repair |
| `src/hermesSkillsConfig.ts` | Denylist-only runtime policy (`resolveHermesAgentRoot`, `loadProductSkillsPolicy`); audit via `npm run test:hermes-skills-policy` |
| `scripts/lib/hermes-gateway.sh` | `verify_hermes_skills_denylist`, gateway nudge after MCP boot |
| `integrations/hermes/skills-enabled.yaml` | Product skill allowlist; bundled denylist computed at gateway sync (image + git) |
| `packages/box-state/` | Hard factory reset (Composio, gbrain, desktop shortcuts, `~/.hermes/skills/`) |
| `deploy/scripts/vps-start.sh` | `hermes plugins enable`; sync Langfuse keys to `~/.hermes/.env`; apply Langfuse + content_filter patches |
| `deploy/Dockerfile` | Bake Langfuse + content_filter patches at image build |
| `scripts/apply-hermes-langfuse-patches.sh` | System prompt + `user_id` patches on Hermes plugin |
| `scripts/apply-hermes-content-filter-patch.sh` | Provider `content_filter` retry patch on `run_agent.py` |
| `scripts/sync-hermes-skills-policy.mjs` | `npm run hermes:sync-skills-policy` — regen bundled denylist after Hermes pin bump |

See [hermes-customizations.md](../hermes-customizations.md#langfuse-observability) and [Hermes runtime config](../hermes-customizations.md#hermes-runtime-config-local-hermes-vs-vps--image).

---

## Provider `content_filter` (Chinese moderation boilerplate)

**Symptom:** Patrick (or any Hermes surface) suddenly replies with Chinese text like
`你好，我无法给到相关内容。` instead of answering — often after long tool-heavy turns
(mail search, calendar, Reddit notes). Langfuse shows `finish_reason: content_filter`
and `input_tokens: 0` / `output_tokens: 0` on the final LLM call.

**Cause:** The model provider (common on **DeepSeek via OpenRouter**) blocked the
completion. Hermes upstream treats the refusal string as normal assistant content.

**Fix (Joshu patch):** [`scripts/apply-hermes-content-filter-patch.sh`](../scripts/apply-hermes-content-filter-patch.sh)
patches Hermes `run_agent.py` to retry with trimmed tool context, try
`fallback_providers`, and return English errors instead of surfacing boilerplate.
Applied at image build, VPS boot, `dev:arozos`, and `hermes:update`.

```bash
# Local verify
rg "_is_provider_content_filter_response" /path/to/hermes-agent/run_agent.py
hermes gateway stop   # reload run_agent.py after first apply
```

**Persistent blocks:** Configure `fallback_providers` in `$HERMES_HOME/config.yaml`
(e.g. OpenRouter `google/gemini-flash-latest`). Details:
[hermes-customizations — content_filter](../hermes-customizations.md#provider-content_filter-handling).

| File | Role |
| --- | --- |
| `scripts/hermes-content-filter.patch` | Patch source |
| `scripts/apply-hermes-content-filter-patch.sh` | Idempotent apply |
| `src/hermesApi.ts` | Applies on gateway warm-up; restarts gateway when newly patched |
| `deploy/Dockerfile`, `deploy/scripts/vps-start.sh` | Image build + VPS boot |

---

## Hermes `config.yaml` on VPS (not your laptop file)

Sandboxes do **not** receive a copy of developer `~/.hermes/config.yaml`. See
[hermes-customizations.md — Hermes runtime config](../hermes-customizations.md#hermes-runtime-config-local-hermes-vs-vps--image).

| Symptom | Cause | Fix |
| --- | --- | --- |
| Too many bundled skills on box | `skills.disabled` never merged or gateway stale | Image with `src/hermesSkillsConfig.ts` + `HERMES_DIR=/opt/hermes-agent`; restart stack; check boot log for `Hermes skills policy: … bundled disabled`; `verify_hermes_skills_denylist` in `vps-start.sh` |
| Bundled skills return after hard factory reset | Wiped `skills/` but gateway kept old catalog | Image with `resyncHermesAfterBoxHardReset()`; start **new jChat** session |
| Denylist out of date after Hermes pin bump | Allowlist YAML stale | `npm run hermes:sync-skills-policy`, `npm run test:hermes-skills-policy`, commit, rebuild image |
| Local dev: all bundled skills enabled | `HERMES_BIN` not set or denylist not synced | Set `HERMES_BIN` in `.env`; restart `dev:arozos`; `curl http://127.0.0.1:8788/joshu/api/hermes-chat/status` |
| Agent skills blocked after chat | Old allowlist policy (pre-0.1.14) | Image **0.1.14+** — denylist-only; `$HERMES_HOME/skills/` not auto-disabled |
| Local paths in `external_dirs` | Old volume from manual copy | Let Joshu rewrite to `/opt/joshu/integrations/hermes/skills`; avoid copying full local YAML |
| `Failed to parse config.yaml` / chat `No models provided`, health still green | Corrupt YAML on volume (often duplicate TTS tail); old code rewrote on every probe | Image with [`hermesConfigSplit.ts`](../../src/hermesConfigSplit.ts) fix; restart stack; Joshu auto-repairs or truncate garbage after first `personalities: {}` |
| Voice/TTS missing after migration | `config.user.yaml` exists but merge skipped (legacy bug) or corrupt managed slice | Ensure Joshu fix deployed; verify `config.user.yaml`; trigger `GET /joshu/api/hermes-chat/status` once |

`joshu_hermes` volume keeps prior `config.yaml` and `config.user.yaml`. Joshu **merges** product fields into `config.yaml` when they change; personal keys belong in `config.user.yaml` ([box-state.md](../box-state.md#hermes-config-split)). Instance health does **not** validate that Hermes can parse `config.yaml` — use `hermes --version` inside the container or a chat smoke test when debugging empty streams.

---

## Admin Create Sandbox — companion + boot pitfalls (2026-06)

| Symptom | Cause | Fix |
| --- | --- | --- |
| Portrait/soul missing; `identity.json` has name only | Admin create without portal draft sync | **Sync portal companion** on `/admin`, or re-create with matching email + slug so auto-sync runs — [portal doc](control-plane-portal.md#operator-admin-create-sandbox--portal-draft) |
| `companion-soul.md` exists but `SOUL.md` is default Hermes | Soul sync ran before `JOSHU_COMPANION_SOUL_FILE` in env, or gateway not restarted | `POST …/sync-companion-identity` `{"forceSoul":true}`; nudge gateway; new jChat session — [joshu-identity.md](../joshu-identity.md) |
| Stack restart loop: `instance.env: line N: Tabis: command not found` | `JOSHU_OWNER_NAME=First Last` unquoted (instance-agent pre-quote fix) | Quote value: `JOSHU_OWNER_NAME="Susan Paley"`; recreate stack. Image/agent with `formatEnvValue()` in `packages/instance-agent` |
| Joshu API crash: `Cannot find module …/email-signature/dist/index.js` | Host `git clone` bind-mounts `packages/email-signature` **source only** (no `dist/`) | Copy `dist/` from image: `docker cp $(docker create ghcr.io/…/joshu-sandbox:TAG):/opt/joshu/packages/email-signature/dist/. /opt/joshu/packages/email-signature/dist/` then recreate `joshu-stack` — [hotpatch-running-box.md](hotpatch-running-box.md) |

---

## Control plane operator checklist (recap)

1. One `JOSHU_IMAGE_REF` in `.env.local` (e.g. `0.1.7`); match `JOSHU_RELEASE_VERSION`.
2. **`DEFAULT_OPENROUTER_API_KEY`** and full Hindsight `DEFAULT_*` (or repo root `.env` hydration).
3. **`CLOUDFLARE_PROXIED=true`** for `*.box.joshu.me` (or equivalent) before customer-facing DNS.
4. **Push `main`**; build/push image when `src/` or `deploy/Dockerfile` changed; host clone must not lag `main`.
5. **Owner email** on Create Sandbox = exact ArozOS login email (`JOSHU_AROZ_USER`); **joshu name** = portal draft slug when owner completed `/setup`.
6. After admin create for a waitlist user, confirm **Companion** column shows **synced** (or click **Sync portal companion**).
7. Restart `pnpm dev` before provisioning (`.env.local` wins over stale shell exports).
7. **`DEFAULT_HERMES_LANGFUSE_*`** in `.env.local` if you want Langfuse on new boxes (see [Langfuse on VPS](#langfuse-on-vps-no-traces-or-users)).
8. Rebuild image after `integrations/hermes/skills-enabled.yaml` or `src/hermesSkillsConfig.ts` changes; run `npm run test:hermes-skills-policy` before push. After upgrade, verify `skills.disabled` count ~150+ on box — see [deploy/README.md](../deploy/README.md#hermes-skills-denylist-after-upgrade).
9. Verify without SSH: health (`imageRef`, `gbrain`), hermes-chat stream, desktop URL (allow 2–3 min on first boot).

---

## Browser voice WebSocket failed to connect (2026-06-24)

**Symptom:** jChat / jMail mic → `Voice connection failed: Voice WebSocket failed to connect`, while `GET /joshu/api/voice/status` returns `available: true` and `curl http://127.0.0.1:8792/health` is OK.

**Cause:** `/joshu/api/voice/session` returned a **loopback** `wsUrl` (`ws://127.0.0.1:8792/…`) to a **remote** browser. `JOSHU_VOICE_WSS_DIRECT=auto` used to treat any `VOICE_REALTIME_URL` on `127.0.0.1` as “local dev” — true on VPS boxes too (voice-realtime listens on loopback behind Caddy).

**Diagnose:**

```bash
curl -fsS -H "Host: ${CUSTOMER_DOMAIN}" -H "X-Forwarded-Proto: https" \
  "http://127.0.0.1:8788/joshu/api/voice/session?chatSessionId=probe" | jq '.wsUrl'
# bad:  "ws://127.0.0.1:8792/voice-rt/media?token=…"
# good: "wss://${CUSTOMER_DOMAIN}/voice-rt/media?token=…"
```

**Fix:**

1. **Image / dist** with [`src/voiceWebApi.ts`](../../src/voiceWebApi.ts) loopback-client guard (`auto` only bypasses Joshu when session `Host` is also loopback).
2. **Or env hotfix:** `JOSHU_VOICE_WSS_DIRECT=false` in `/etc/joshu/instance.env` → recreate `joshu-stack`.
3. New boxes: control-plane bootstrap sets `JOSHU_VOICE_WSS_DIRECT=false` in [`sandboxEnv.ts`](../../apps/control-plane/src/lib/sandboxEnv.ts).

See [web-voice.md — Browser WSS URL](web-voice.md#browser-wss-url-apivoicesession--wsurl).

**Related (jChat text, not voice):** Nylas profile `timezone: "PST"` breaks Temporal owner-time injection — use IANA (`America/Los_Angeles`). [`src/ianaTimezone.ts`](../../src/ianaTimezone.ts); [welcome-onboarding.md](../welcome-onboarding.md).

---

## Twilio phone voice (local + VPS)

Full runbook: [phone-voice-local-test.md](phone-voice-local-test.md). Validated legacy path locally with ngrok → Joshu `:8788`.

### Symptom → cause (quick reference)

| Symptom | Cause | Fix |
| --- | --- | --- |
| Webhook **404** via tunnel | ngrok on ArozOS `:8787` | `ngrok http 8788` |
| **403** on inbound | Wrong auth token or webhook URL | Primary Auth Token; URL must match Twilio console exactly |
| Inbound **200**, instant hangup | WSS auth failed | Media stream secret in **path** (`/media-stream/<hex>`), not `?token=` — ngrok strips query on WS upgrade |
| `bad token`, `tokenLen=0` | Same as above | Regenerate `openssl rand -hex 32`; restart Joshu |
| `decode` undefined on every media frame | `alawmulaw` is CJS under Node ESM | Use `src/audioMulawCodec.ts` (default import), not `import * as alawmulaw` |
| Call stays up, no transcript | VAD / short utterance | Tune `voice.silence_duration` in `~/.hermes/config.yaml` |
| **Speech-to-speech:** duplicate Hermes in Langfuse (browser), double spoken summary | Old web path fired Hermes on transcript + `ask_joshu`; double `response.create` | See [web-voice.md](web-voice.md) — one Hermes job per turn; grep `speech-instruct` |
| **Speech-to-speech:** choppy audio, brain 502, overlapping progress | Old voice-realtime paths | See [voice-realtime.md](voice-realtime.md) — native `audio/pcmu`, Hermes-only reads, response-aware progress |
| **Voice:** double “checking”, “no desktop access” then lookup, empty OpenAI Logs | Realtime vs `think`, ack paths, dashboard scope | [voice-think-speak.md](voice-think-speak.md) — grep `ANTIPATTERN spoke-before-think`, `THINK START`; Usage not Logs |

### Secrets split

- **Joshu `.env` / instance.env:** `TWILIO_AUTH_TOKEN`, `TWILIO_MEDIA_STREAM_SECRET`, `TWILIO_VOICE_WEBHOOK_URL` — PSTN wiring only.
- **`~/.hermes`:** STT/TTS/LLM keys — Hermes subprocess and gateway.
- `TWILIO_MEDIA_STREAM_SECRET` is self-generated per instance, not from Twilio console.

### Code touchpoints

| File | Notes |
| --- | --- |
| `src/twilioPhoneGateway.ts` | TwiML, WSS upgrade, path token, signature URL variants |
| `src/audioMulawCodec.ts` | μ-law codec wrapper |
| `apps/control-plane/src/lib/twilioProvisioner.ts` | Auto-buy number + path-style WSS URL on DO |

---

## Repo hardening index (where to look in code)

| Area | Files |
|------|--------|
| Provisioned env contract | `apps/control-plane/src/lib/sandboxEnv.ts`, `hindsightBootstrap.ts`, `customerOwner.ts` |
| Owner email → `JOSHU_AROZ_USER` | `apps/control-plane` admin UI + `buildSandboxBootstrapEnv()` |
| Preflight | `apps/control-plane/src/lib/sandboxBootstrapPreflight.ts` |
| Cloudflare DNS (proxied) | `apps/control-plane/src/lib/providers/cloudflare.ts`, `CLOUDFLARE_PROXIED` |
| Cloud-init | `apps/control-plane/src/lib/providers/cloudInit.ts`, `digitalocean.ts` |
| Runtime entry | `deploy/scripts/vps-start.sh` |
| Compose | `deploy/docker-compose.yml` |
| Hermes gateway + config | `src/hermesApi.ts`, `src/hermesConfigSplit.ts`, `src/hermesSkillsConfig.ts`, `integrations/hermes/skills-enabled.yaml`, `scripts/lib/hermes-gateway.sh` |
| Langfuse on VPS | `sandboxEnv.ts`, `scripts/apply-hermes-langfuse-patches.sh`, `deploy/Dockerfile`, `deploy/runtime/package.json`, `src/observability/langfuse.ts`, `src/day0/llm.ts`, `vps-start.sh` |
| File brain (gbrain) | `scripts/start-gbrain.sh`, `scripts/bootstrap-joshu-files.sh`, `scripts/rebind-gbrain-owner.sh`, `scripts/ensure-hermes-gbrain-mcp.mjs`, `src/joshuFilesPaths.ts`, `src/brainApi.ts` |
| Twilio phone voice | `src/twilioPhoneGateway.ts`, `src/audioMulawCodec.ts`, `apps/control-plane/src/lib/twilioProvisioner.ts` |
| Speech-to-speech voice | `packages/voice-realtime/`, `src/server.ts` (`/voice-rt` proxy), `src/voiceWebApi.ts` (`wsUrl`) |
| VNC / Camofox HITL | `public/app.js`, `public/camofox-viewer.html`, `src/server.ts`, `src/camofoxSession.ts`, `scripts/patch-camofox-single-tab.mjs` |
| VPS image build | `deploy/Dockerfile`, `scripts/vps-build-image.sh`, `deploy/RELEASE.json` |
| Repair | `scripts/sync-hermes-to-vps.sh`, `scripts/sync-hindsight-to-vps.sh`, `scripts/fix-hermes-gateway-on-vps.sh`, `scripts/repair-vps-admin-update.sh`, `scripts/repair-instance-env-drift.sh`, `scripts/sync-dist-from-image.sh` |

---

## Release pipeline & ops backlog (2026-06-12)

Notes from Patrick `0.1.19` rollout — incidents, fixes shipped, and what would make the system more reliable.

### Fixed / in flight

| Issue | Mitigation |
| --- | --- |
| Admin update `unauthorized` | Mount `/root/.docker` on `instance-agent`; cloud-init assert; agent preflight before pull |
| Stale admin `deployedImageRef` | Heartbeat sync from `host.imageRef` (control-plane deploy) |
| Vercel admin release pin stale | `sync-release-pin.mjs` bundles `deploy/RELEASE.json` at build |
| Gateway dead after recreate (health hangs, jChat stuck) | `vps-start.sh` no longer SIGTERM-kills the gateway while Joshu `HERMES_API_AUTO_START` owns it; use `reload_hermes_gateway_after_config_change` + `wait_for_hermes_gateway`. Health probes use `probeGatewayHealth()` (no 180s `ensureGatewayReady` on `/api/instance/health`). |
| Gateway misses connectors MCP at boot | `JOSHU_DEFER_HERMES_GATEWAY_WARM` + `after_mcp_boot=1` nudge; `mcpDependencyHealth.ts` probes; 30s watchdog reloads gateway; `components.connectorsMcp` in instance health |
| Instance health hid connectors MCP outage | `components.connectorsMcp` on `GET /joshu/api/instance/health` (2026-06) |
| Gateway partial MCP catalog persisted after `:8795` recovered | `prepareGatewayAfterMcpBoot()` + `syncGatewayWithMcpHealth()` in `hermesApi.ts`; vps-start nudge with `after_mcp_boot=1` |

### Open improvements (priority order)

1. **Rollback should prefer live `host.imageRef`** — Auto-rollback uses `rollbackImageRef`, which can be ancient (`0.1.13`) if `deployedImageRef` was never ack'd. On update failure, roll back to last known-good heartbeat image when newer than DB.

2. **Outbound mail routing in one place** — jChat `SYSTEM_PROMPT`, HERMES.md, skills, and REST action guard must stay aligned. Prefer server-side injection (gateway context files) over client-only SPA strings so Telegram/cron/API paths get the same rules.

3. **GHCR token rotation without SSH** — Wire `rotate_secrets` (or bootstrap refresh) to re-run `docker login` on the host when `GHCR_READ_TOKEN` rotates; report `registryAuthOk` in heartbeat.

4. **Admin Health column clarity** — When `deployedImageRef ≠ lastHealth.host.imageRef`, show both with a drift badge until heartbeat sync lands.

5. **Fleet rollout preflight** — Before queuing updates, optionally verify agent can pull (heartbeat field or one-shot `registryAuthOk` check) to avoid fleet-wide failed jobs.

6. **Composio policy for outbound mail** — Block Gmail send meta-tools when Nylas is the configured provider; reduces wrong-path sends when stale jChat bundles or agent improvisation bypass skills.

7. **Connectors MCP boot flake** — Rare race where connectors MCP flaps right after `vps-start` health check; first `after_mcp_boot` nudge may 503 until 30s watchdog recovers. Consider starting connectors MCP from Joshu `server.ts` after listen (optional `JOSHU_CONNECTORS_MCP_OPTIONAL`).

8. **Release update: skip host `npm` on VPS** — `buildHostInstanceAgent` should default to `docker compose build instance-agent` + copy `dist`/`node_modules` on boxes where `INSTALL_DIR=/opt/joshu` (no wasted `workspace:*` attempt each update).

9. **Agent self-restart without race** — `prepareAgentThenRestart` should use `compose up -d --no-deps instance-agent` or a host-side wrapper script so the new container always reaches `Started` and resumes `pending-release-update.json`.

10. **Duplicate `instance.env` keys at boot** — Startup check (agent or health) warns when multiple `JOSHU_RELEASE_VERSION` / `JOSHU_IMAGE_REF` lines exist.

11. **Drift visibility in agent logs** — When health returns 503, log `env=X dist=Y expected=Z` explicitly (not only `status=drift`).

12. **Stale provision jobs** — Auto-fail jobs `running` with no heartbeat progress for >15–30 min; allow re-queue without manual DB edit.

13. **Unified repair entrypoint** — Single script: GHCR login → detect drift direction → sync dist or env → build agent → recreate stack + agent → print health JSON (compose today of `repair-vps-admin-update.sh` + `repair-instance-env-drift.sh` + `sync-dist-from-image.sh`).

14. **Alerting** — Page or dashboard when `components.dist.status=drift` or `readyForUpdate=false` persists >5 min on any fleet box.

---

## Related docs

- [zero-touch-provisioning.md](zero-touch-provisioning.md) — preflight and verify commands
- [first-provisioning-notes.md](first-provisioning-notes.md) — first Hetzner/Vercel run
- [hermes-chat-arozos-app.md](../hermes-chat-arozos-app.md) — UI and SSE shape
- [hermes-customizations.md](../hermes-customizations.md) — Hermes config conventions
- [file-brain.md](../file-brain.md) — gbrain, `joshu's files`, slugs, PGLite locks
- [hitl-camofox-notes.md](../hitl-camofox-notes.md) — VNC viewer, fit-viewport, Camofox patch
- [phone-voice-local-test.md](phone-voice-local-test.md) — local PSTN E2E, ngrok, Media Stream auth
- [voice-realtime.md](voice-realtime.md) — OpenAI Realtime speech-to-speech, logging, dashboard observability
- [voice-think-speak.md](voice-think-speak.md) — think vs speak, desktop access, duplicate acks, phone turn control
- [control-plane-local-provisioning.md](control-plane-local-provisioning.md) — image tags vs running boxes
