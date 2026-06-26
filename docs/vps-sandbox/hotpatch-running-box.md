# Hotpatching a Running VPS Box

Operator guide for updating a **live customer or test sandbox** without reprovisioning. Use this when you need to ship fixes to Patrick (or any box) between full release cuts.

Related:

- [control-plane-local-provisioning.md](control-plane-local-provisioning.md) — image vs `instance.env` vs host git
- [instance-agent-protocol.md](instance-agent-protocol.md) — automated release updates (`syncDistFromImage`)
- [troubleshooting-and-lessons.md](troubleshooting-and-lessons.md) — incidents, dist drift (#19b), **release update failure loop (#19f)**
- [`deploy/README.md`](../../deploy/README.md) — build image, compose layout

---

## One rule: match the lane to what you changed

Compose bind-mounts several paths from the **host** clone at `/opt/joshu`. A `docker compose pull` or `git pull` alone does **not** update everything. Pick the lane that owns the files you touched.

| You changed | Lane | Host path affected | Typical time |
| --- | --- | --- | --- |
| Hermes skills, MCP `.mjs`, boot scripts, `vps-start.sh`, `deploy/docker-compose.yml` bind mounts | **Git hotfix** | `integrations/hermes/skills/`, `scripts/` (incl. `composio-mcp-guard-proxy.mjs`, `joshu-connectors-mcp-http-server.mjs`), `deploy/scripts/vps-start.sh` | ~1 min |
| Joshu API / `src/` → compiled `dist/` (e.g. `src/actionGuard/`) | **Dist hotfix** | `/opt/joshu/dist/` | ~2–15 min |
| Hermes venv pin, Dockerfile, runtime npm deps | **Image release** | Inside GHCR image | ~10 min build + pull |

**Do not** ask the agent to patch `/opt/joshu/dist` — writes are blocked. **Do not** assume `git pull` updates the API — `dist/` is gitignored.

---

## Why `dist/` is special

`deploy/docker-compose.yml` bind-mounts:

```yaml
- ../dist:/opt/joshu/dist:ro
```

That mount **shadows** the image’s baked-in `dist/`. The running Joshu API (`node dist/server.js`) reads the **host** copy.

- `git pull` updates source and scripts, **not** `dist/`
- `docker compose pull` updates the image, but the mount still wins until you **sync** host `dist/` from the image (or rsync from your laptop)

Control-plane **Release updates** run `syncDistFromImage` automatically (default `true` in release manifest). Manual hotfixes use the same script below.

---

## Verify after any hotpatch

```bash
# Overall health (503 if dist drift when provenance exists)
curl -fsS http://127.0.0.1:8788/joshu/api/instance/health | jq '{healthy, releaseVersion, components: {dist, gbrain, hermes}}'

# Dist provenance — expect status "synced" when JOSHU_RELEASE_VERSION matches
cat /opt/joshu/dist/.release-provenance.json

# Connectors MCP (EA send / calendar tools)
curl -fsS http://127.0.0.1:8795/health
```

Recreate command used throughout:

```bash
cd /opt/joshu/deploy
docker compose -f docker-compose.yml --env-file /etc/joshu/instance.env up -d --force-recreate joshu-stack
```

---

## Lane A — Git hotfix (skills, MCP, boot scripts)

**When:** Changes under `integrations/hermes/skills/`, `scripts/joshu-connectors-mcp-http-server.mjs`, `scripts/gbrain-mcp-http-server.mjs`, `scripts/lib/`, `deploy/scripts/vps-start.sh`, templates, etc.

**On the box:**

```bash
ssh root@<hostname>
cd /opt/joshu && git pull
cd deploy && docker compose -f docker-compose.yml --env-file /etc/joshu/instance.env up -d --force-recreate joshu-stack
```

No image pull. No dist sync.

### Skills seed after `docker compose recreate` (gotcha)

`vps-start.sh` runs `bootstrap-hermes-learning-skills.sh`, which syncs factory skills into **`/root/.hermes/skills/joshu/`** when the factory **`release`** stamp in `factory/manifest.yaml` changes. Default mode is **LLM merge** per changed `SKILL.md` (see [Skills hotpatch on boxes with learning](#skills-hotpatch-on-boxes-with-learning-2026-06-12)).

**Compose (0.1.22+):** `deploy/docker-compose.yml` bind-mounts host **`../integrations/hermes/skills/`** and **`skills-enabled.yaml`** into the container — Lane A `git pull` + recreate updates the bootstrap **source** without a new GHCR tag. Hermes still reads **runtime** skills from the persisted **`joshu_hermes`** volume at `$HERMES_HOME/skills/joshu/` until bootstrap re-seeds or you patch that tree.

**Symptom:** Image updated to `0.1.22` but jChat lacks **`ea-time-block`**, **`ea-morning-review`**, **`excalidraw`** disabled, or agent says renderer script missing. Often **`skills-enabled.yaml` on host** is stale (11 skills vs ~15) and/or bootstrap stamp **`0.2.0`** skipped re-seed while runtime skill files are old.

**Fix (factory skills refresh):**

```bash
cd /opt/joshu && git pull   # updates integrations/hermes/skills/ + factory/manifest.yaml
CID=$(docker compose -f docker-compose.yml --env-file /etc/joshu/instance.env ps -q joshu-stack)

# Option A — release bump (default): LLM-merge factory into box skills
# Bump factory/manifest.yaml `release` in git pull, then nudge Joshu or run bootstrap:
docker exec "$CID" bash /opt/joshu/scripts/bootstrap-hermes-learning-skills.sh
# Requires OPENROUTER_API_KEY in instance.env / ~/.hermes/.env

# Option B — overwrite (hard reset only — wipes evolved skills):
# JOSHU_HERMES_SKILLS_SEED_MODE=overwrite docker exec -e JOSHU_HERMES_SKILLS_SEED_MODE=overwrite \
#   "$CID" bash /opt/joshu/scripts/bootstrap-hermes-learning-skills.sh

# Option C — manual single-file patch (emergency): docker cp one SKILL.md into runtime tree

cd deploy && docker compose -f docker-compose.yml --env-file /etc/joshu/instance.env up -d --force-recreate joshu-stack
```

**Verify:** `docker exec "$CID" ls /root/.hermes/skills/joshu/executive-assistant/` includes `ea-time-block`; `grep excalidraw /opt/joshu/integrations/hermes/skills-enabled.yaml`; bundled **`excalidraw`** must **not** appear under `skills.disabled` in `/root/.hermes/config.yaml` after gateway sync. **New chat** so `skill_view('ea-time-block')` loads updated `SKILL.md`.

**Time-block scripts on VPS:** Hermes `terminal.cwd` is the ArozOS **Desktop** folder — `node scripts/render-time-block-excalidraw.mjs` fails from there. Use **`/opt/joshu/scripts/render-time-block-excalidraw.mjs`** and **`/opt/joshu/scripts/gather-time-block-input.mjs`** (bind-mounted from host). Smoke: `docker exec "$CID" node /opt/joshu/scripts/render-time-block-excalidraw.mjs /tmp/plan.json -o /tmp/out.excalidraw` (see [time-block-planning.md](../Joshu-SOP/time-block-planning.md)).

### Skills hotpatch on boxes with learning (2026-06-12, merge default 2026-06)

Boxes with the Hermes **learning loop** keep evolved product skills in **`$HERMES_HOME/skills/joshu/`** (writable). Background review uses `skill_manage`; changes are logged in **`skills/.evolution.jsonl`** and backed up hourly to **`db-aeon/joshu-learning-{slug}`** (e.g. [`joshu-learning-patrick`](https://github.com/db-aeon/joshu-learning-patrick)).

**Routine factory rollout:** edit `integrations/hermes/skills/` in git, bump **`factory/manifest.yaml` `release`**, deploy (`git pull` on box). Bootstrap runs in **`merge`** mode — each box gets its own LLM-merged `SKILL.md` files via [`merge-hermes-factory-skill.mjs`](../../scripts/merge-hermes-factory-skill.mjs). No Cursor step; no per-box manual merge.

| Action | Effect |
| --- | --- |
| **`release` bump + bootstrap (default `merge`)** | LLM-merge each changed `SKILL.md` with **this box’s** copy; new skills copy as-is; **no tree delete** |
| **`JOSHU_HERMES_SKILLS_SEED_MODE=overwrite`** | **`rsync -a --delete`** from factory → `skills/joshu/` — **hard factory reset only** |
| `rm …/.joshu-seed-version` + bootstrap | Re-runs merge/seed for current `release` — use when you need to **re-apply** a release, not for routine edits |
| `.evolution.jsonl` | **Audit-only** — append log; **not replayed** after seed |
| `docker cp` one `SKILL.md` into runtime tree | **Emergency** single-file patch without bumping `release` |

**When to use `overwrite`:** hard factory reset (`resyncHermesAfterBoxHardReset()` sets this automatically). Not for Lane A deploys on learning boxes.

**If merge fails** (no `OPENROUTER_API_KEY`, OpenRouter error): bootstrap keeps the box `SKILL.md` and logs a warning. Check `hermes-learning-seed` logs; fix keys and re-run bootstrap after bumping stamp or deleting `.joshu-seed-version`.

**Legacy: surgical hotpatch (pre-merge or emergency)**

Use when you cannot bump `release` or need one file immediately:

1. **Check evolution backup** — `skills/.evolution.jsonl` or `db-aeon/joshu-learning-{slug}` on GitHub.
2. **Rsync factory paths** to host `/opt/joshu/integrations/hermes/skills/`.
3. **`docker cp`** into `/root/.hermes/skills/joshu/…` for specific files only.

   Example:

   ```bash
   # From laptop
   rsync -avz integrations/hermes/skills/executive-assistant/ea-playbook/SKILL.md \
     root@patrick.box.joshu.me:/tmp/ea-playbook-SKILL.md

   # On box — copy into live tree (does not run LLM merge)
   docker cp /tmp/ea-playbook-SKILL.md "$CID:/root/.hermes/skills/joshu/executive-assistant/ea-playbook/SKILL.md"
   ```

4. **If overwrite already wiped evolution** — restore from GitHub backup, then bump `release` and run merge bootstrap:

   ```bash
   gh api "repos/db-aeon/joshu-learning-patrick/contents/skills/joshu/executive-assistant/ea-project-kanban/SKILL.md?ref=main" \
     | python3 -c "import sys,json,base64; open('/tmp/kanban.md','wb').write(base64.b64decode(json.load(sys.stdin)['content']))"
   docker cp /tmp/kanban.md "$CID:/root/.hermes/skills/joshu/executive-assistant/ea-project-kanban/SKILL.md"
   docker exec "$CID" bash /opt/joshu/scripts/hermes-learning-github-sync.sh
   ```

5. **Restart gateway** — `hermes gateway stop` then nudge Joshu (`GET …/api/hermes-chat/status`). See [`scripts/lib/hermes-gateway.sh`](../../scripts/lib/hermes-gateway.sh).

**Validated incident (2026-06-12, Patrick):** Forced bootstrap with **`overwrite`** (delete `.joshu-seed-version` + old `rsync --delete`) reset **`ea-project-kanban`** evolution. Recovery: restore from `joshu-learning-patrick`, then factory deltas — [troubleshooting § skills evolution](troubleshooting-and-lessons.md#skills-bootstrap-overwrites-box-evolution-2026-06-12).

**EA project Kanban (2026-06) — typical B3 + A bundle:** rsync `dist/ea/triageRoutes.js`, `dist/hermesKanbanBridge.js`, `dist/hermesApi.js`, `dist/server.js`, `scripts/joshu-connectors-mcp-http-server.mjs`, `scripts/hermes-kanban-bridge.py`, `integrations/hermes/skills/`, `integrations/hermes/skills-enabled.yaml`, `templates/ea/`; then recreate and verify bootstrap (above). After recreate, confirm `:8795` lists `project_kanban_*` and **restart Hermes gateway** if jChat still shows a partial connectors catalog — [partial MCP catalog](troubleshooting-and-lessons.md#partial-mcp-tool-catalog-jchat--telegram). See [`ea-for-joshu.md`](../Joshu-SOP/ea-for-joshu.md#project-kanban-multi-step--hitl-2026-06).

**Gemini Live web voice — GHCR voice image:** Build/push `joshu-voice-realtime:<tag>` with `npm run vps:build-image` (`JOSHU_IMAGE_PUSH=1`). Admin **Update release** pulls `JOSHU_VOICE_IMAGE_REF` and recreates `voice-realtime`. Env: `JOSHU_VOICE_PROVIDER=gemini_live`, `GEMINI_API_KEY`, optional `GEMINI_LIVE_MODEL` / voice id via `JOSHU_VOICE_ID`. See [web-voice.md — VPS](web-voice.md#vps-production--test-box).

**Action guard REST gate (2026-06) — typical B3 + A bundle:** `sync-dist-from-image.sh` first (keeps `@joshu/email-signature` resolvable), then overlay `dist/actionGuard/nylasSendGate.js`, `dist/actionGuard/index.js`, `dist/nylas/routes.js`, `dist/hermesContextFile.js`, and **`dist/server.js`** (registers `/api/action-guard/*` — image `0.1.18` may lack it). Bind-mount `packages/email-signature` + `vps-start` copy hook (see `deploy/docker-compose.yml`). Rsync `scripts/joshu-connectors-mcp-http-server.mjs`, `integrations/hermes/skills/`; recreate; re-seed skills. **Smoke:** action guard `enabled` + `telegramLinked`; Hermes/`curl` POST to `/nylas/messages/send` blocks (Telegram or timeout); `gateNylasSendRequest` importable. jMail `X-Joshu-Mail-Client` header ships in next image (Lane C) — until then jMail may prompt Telegram too.

### Unified mail ingress (2026-06-17)

**When:** Collapse ingest routing to single **`ea-mail-ingress`** queue; scheduling as child after filing (`ea-playbook` v2.9.0, `ea-scheduling` v4.10.0).

**B3 dist overlay** (learning box — surgical, no full `dist/` delete):

```bash
rsync -avz \
  dist/ea/classifier.js dist/ea/triageStub.js dist/ea/mailCron.js \
  dist/ea/mailIngress.js dist/ea/schedulingIngress.js dist/ea/ingest.js \
  dist/ea/mailDedup.js dist/connectors/rfcMessageId.js \
  dist/onboarding/eaCronJobs.js \
  root@<host>:/opt/joshu/dist/ea/   # eaCronJobs → dist/onboarding/ separately
```

**Lane A skills** (surgical `docker cp` into `/root/.hermes/skills/joshu/` — **no bootstrap** on learning boxes):

- `executive-assistant/ea-playbook/` (v2.9.0)
- `executive-assistant/ea-scheduling/SKILL.md` (v4.10.0)

Recreate `joshu-stack`; restart Hermes gateway. **Smoke:** `normalizeForIngressRouting` in `dist/ea/classifier.js`; ingress task body contains `classifier_scheduling_hint`; `triageStub.js` has zero `forwardSchedulingMail` calls. **Patrick validated 2026-06-17.**

**Gotcha:** `triageStub.js` imports `prepareMailIngestDedup` from `mailDedup.js` — include **`mailDedup.js`** + **`rfcMessageId.js`** or stack fails to start.

**From laptop (push first):**

```bash
git push origin main
# then SSH commands above
```

### Calendar free/busy + transparent events (2026-06-17)

**When:** Agent treats Google **Show as free** events (e.g. Asteme) as busy because it used `google_calendar_list_events` titles instead of FreeBusy.

**B3 dist overlay** (learning box — surgical):

```bash
rsync -avz dist/connectors/composio/calendar.js root@<host>:/opt/joshu/dist/connectors/composio/
rsync -avz dist/connectors/routes.js root@<host>:/opt/joshu/dist/connectors/
rsync -avz dist/mcpToolPolicy.js root@<host>:/opt/joshu/dist/
```

**Lane A** (bind-mounted — `git pull` or rsync):

- `scripts/joshu-connectors-mcp-http-server.mjs` — adds **`google_calendar_find_free_slots`**; fixes `list_events` description
- `scripts/lib/mcp-tool-policy.mjs`

**Skills** (surgical `docker cp` into `/root/.hermes/skills/joshu/` — **no bootstrap** on learning boxes):

- `executive-assistant/ea-scheduling/SKILL.md` (v4.11.0)
- `executive-assistant/ea-playbook/SKILL.md` (pitfall line)

Recreate `joshu-stack`; nudge gateway (`GET …/hermes-chat/status?after_mcp_boot=1`); **new jChat session** for MCP catalog.

**Smoke:**

```bash
curl -fsS "http://127.0.0.1:8788/joshu/api/connectors/calendar/google/free-slots?date=2026-06-23&timezone=America/Los_Angeles&minDurationMinutes=30" \
  | jq '.calendars.primary'
# Transparent events → busy: [] for that day; free intervals cover working hours
```

**Patrick validated 2026-06-17** (Mara/Asteme trace).

### Calendar multi-calendar FreeBusy + `combined` (2026-06-24)

**When:** Scheduling offers slots while owner is busy (e.g. 3pm during Asteme wrap) because agent queried **`items: ["primary"]` only** — personal Gmail calendar events invisible.

**B3 dist overlay:**

```bash
rsync -avz dist/connectors/composio/calendar.js root@<host>:/opt/joshu/dist/connectors/composio/
rsync -avz dist/connectors/composio/calendarAvailability.js root@<host>:/opt/joshu/dist/connectors/composio/
rsync -avz dist/connectors/routes.js root@<host>:/opt/joshu/dist/connectors/
```

**Lane A:**

- `scripts/joshu-connectors-mcp-http-server.mjs` — `find_free_slots` description; omit `items` for default scope
- `integrations/hermes/skills/executive-assistant/ea-scheduling/SKILL.md` (v4.19.0)

**Skills (surgical `cp` — no full bootstrap unless intended):**

```bash
cp integrations/hermes/skills/executive-assistant/ea-scheduling/SKILL.md \
  ~/.hermes/skills/joshu/executive-assistant/ea-scheduling/SKILL.md
```

**Smoke:**

```bash
curl -fsS "http://127.0.0.1:8788/joshu/api/connectors/calendar/google/free-slots?date=2026-06-25&timezone=America/Los_Angeles&minDurationMinutes=15" \
  | jq '{items, combined: .calendars.combined}'
# items should include primary + dbenyamin@gmail.com; combined.busy should include afternoon wrap block
```

**Ops retry** after denied bad send: [`ea-for-joshu.md`](../Joshu-SOP/ea-for-joshu.md#ea-scheduling--ops-retry-denied-send--bad-slots).

---

## Lane B — Dist hotfix (Joshu API / `src/`)

**When:** Anything that compiles to `dist/` — Nylas routes, connectors API, `hermesApi.js`, EA backend, etc.

### B1 — Control-plane release update (production / test box)

Best when you cut a GHCR tag (e.g. `0.1.18`).

1. Laptop: `npm run modal:predeploy` → `JOSHU_IMAGE_TAG=0.1.18 JOSHU_IMAGE_PUSH=1 npm run vps:build-image`
2. Bump [`deploy/RELEASE.json`](../../deploy/RELEASE.json); open admin → **Update** on the instance (or fleet rollout)

The instance-agent will: snap (optional) → `git pull` → `docker compose pull` → **`syncDistFromImage`** → recreate → health gate on `components.dist`.

Release manifest defaults: `syncDistFromImage: true`, `hostGitRequired: true`.

### B2 — Sync dist from an existing image (on-box, no control plane)

Use when the image is already in GHCR (or locally loaded) but host `dist/` is stale.

```bash
ssh root@<hostname>
cd /opt/joshu && git pull   # gets scripts/sync-dist-from-image.sh + instance-agent

JOSHU_IMAGE_REF=ghcr.io/db-aeon/joshu-sandbox:0.1.17 \
JOSHU_RELEASE_VERSION=0.1.17 \
bash /opt/joshu/scripts/sync-dist-from-image.sh

cd deploy && docker compose -f docker-compose.yml --env-file /etc/joshu/instance.env up -d --force-recreate joshu-stack
```

Ensure `/etc/joshu/instance.env` has matching `JOSHU_IMAGE_REF` and `JOSHU_RELEASE_VERSION` so health `components.dist` stays `synced`.

### B3 — Laptop rsync (fastest for a **test box** while iterating)

Use when you are looping on `src/` and do not want a new GHCR tag every commit.

**Laptop:**

```bash
cd /path/to/joshu
npm run modal:predeploy
rsync -avz --delete dist/ root@<test-host>:/opt/joshu/dist/
rsync -avz --delete packages/box-state/dist/ root@<test-host>:/opt/joshu/packages/box-state/dist/
```

**Box — write provenance (pick a label you keep in `instance.env` while iterating):**

```bash
VERSION=dev-local
cat > /opt/joshu/dist/.release-provenance.json <<EOF
{
  "version": "${VERSION}",
  "imageRef": "manual-rsync",
  "distSource": "manual",
  "syncedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "gitRef": "$(git -C /opt/joshu rev-parse HEAD 2>/dev/null || echo unknown)"
}
EOF

# Match provenance — edit /etc/joshu/instance.env if needed:
# JOSHU_RELEASE_VERSION=dev-local

cd /opt/joshu/deploy && docker compose -f docker-compose.yml --env-file /etc/joshu/instance.env up -d --force-recreate joshu-stack
```

For a personal test box, `dev-local` + manual provenance is fine. Production boxes should use semver + image sync (B1/B2).

---

## Lane C — Full image release only

**When:** Hermes pin bump (`HERMES_AGENT_REF`), `deploy/Dockerfile`, `deploy/runtime/package.json`, Bun/gbrain in image, Camofox base, etc.

Examples: new npm deps in `deploy/runtime/package.json` (e.g. `@langfuse/tracing` for Joshu deterministic Langfuse), Hermes venv pin, Dockerfile base image.

Same as B1 — you need a new GHCR tag. Dist sync still runs so host mount matches the image.

**Not enough:** git hotfix or dist-only rsync when Hermes binary, **container `node_modules`**, or system packages inside the image changed. `node_modules` is baked in the image — only `dist/` is bind-mounted from the host.

---

## Recommended workflow for a test box

```text
Skill / ea-scheduling / MCP schema     →  Lane A (git pull + recreate)
API bugfix, same day                   →  Lane B3 (rsync dist) or B2 (sync from patch tag)
Checkpoint before demo / prod          →  Lane B1 (cut tag + control-plane Update)
Hermes version                         →  Lane C
```

Daily rhythm on **patrick** (or any test slug):

1. Push to `main`
2. Decide lane from the table above
3. SSH hotpatch
4. `curl …/instance/health | jq '.components.dist'`
5. Smoke the feature (e.g. scheduling send, connectors MCP health)

---

## Picking a lane (decision tree)

```text
Did you change src/*.ts or anything that npm run build compiles?
  yes → Did you also add/change deploy/runtime/package.json deps?
          yes → Lane C (image) — dist sync (B) ships the new JS; image ships node_modules
          no  → Lane B (dist)
  no  → Did you change deploy/Dockerfile, Hermes pin, or runtime deps?
          yes → Lane C (image)
          no  → Lane A (git)
```

---

## What runs where (reference)

| Artifact | Updated by git pull | Updated by image pull alone | Updated by syncDistFromImage / rsync |
| --- | --- | --- | --- |
| `scripts/*.mjs`, `vps-start.sh` | yes | no | no |
| `integrations/hermes/skills/` | yes | no (mount) | no |
| `dist/` (Joshu API) | **no** | **no** (mount shadows) | **yes** |
| Hermes venv in image | no | yes | no |
| ArozOS / user Desktop data | no | no | no (volumes) |

---

## Instance-agent

Automated release updates require a recent instance-agent (includes `syncDistFromImage`). **`instance-agent` must mount host GHCR creds** (`/root/.docker:/root/.docker:ro`) or admin pulls fail with `unauthorized` — see [instance-agent-protocol.md — GHCR pull auth](instance-agent-protocol.md#ghcr-pull-auth-instance-agent).

After pulling repo changes on the host:

```bash
cd /opt/joshu/deploy
docker compose -f docker-compose.yml --env-file /etc/joshu/instance.env build instance-agent
docker compose -f docker-compose.yml --env-file /etc/joshu/instance.env up -d --force-recreate instance-agent
# Verify GHCR from inside the agent (should succeed, not "unauthorized"):
docker exec deploy-instance-agent-1 docker pull "$JOSHU_IMAGE_REF"
```

One-time on boxes provisioned before this feature landed.

---

## Common mistakes

| Mistake | Symptom | Fix |
| --- | --- | --- |
| `git pull` only after `src/` change | API unchanged; old bugs persist | Lane B — sync or rsync `dist/` |
| Image pull only | `JOSHU_RELEASE_VERSION` bumped but API old | `bash scripts/sync-dist-from-image.sh` |
| MCP schema updated, API not | Tool accepts new args; API 400/502 | Lane B — API and MCP must ship together when routes change |
| Provenance / env version mismatch | `components.dist.status: "drift"`, health 503 | Align `JOSHU_RELEASE_VERSION` with `.release-provenance.json` |
| Agent patches `dist/` on box | Write denied; wasted iterations | Hotpatch from laptop or sync script — never via Hermes |
| **`rsync --delete dist/`** on a box with image-only packages | Missing modules (e.g. `@joshu/email-signature`); stack errors | **Selective file overlay** or `sync-dist-from-image.sh` then overlay changed `dist/*.js` only — see [session-2026-06-11](session-2026-06-11-learning-browser-sync.md#3-patrick-box-hotpatch-2026-06-11). Bind-mount `packages/email-signature` + `vps-start` npm install hook ships the dep before the next image cut. |
| Lane A recreate before image has new skills | `ea-project-kanban` (etc.) missing in Hermes | Bump `factory/manifest.yaml` `release` + bootstrap, or `docker cp` host skills → container — [skills seed gotcha](#skills-seed-after-docker-compose-recreate-gotcha) |
| **`JOSHU_HERMES_SKILLS_SEED_MODE=overwrite`** or pre-merge forced bootstrap | Box-specific skill edits gone; `.evolution.jsonl` still lists patches | Restore from `joshu-learning-{slug}`; use default **`merge`** on routine releases — [skills hotpatch](#skills-hotpatch-on-boxes-with-learning-2026-06-12) |
| `docker cp` skills without removing stale container paths | Old reference files remain (e.g. deleted `ea-playbook/references/`) | `docker exec … rm -rf /opt/joshu/integrations/hermes/skills` then recopy from host |
| Dist rsync after new runtime npm dep | `Cannot find module '@langfuse/…'` (or similar) on stack start | Lane C — bump `deploy/runtime/package.json`, rebuild image, Update |
| Admin **Update release** without `.docker` mount on `instance-agent` | `update / failed`, `unauthorized`; manual host pull works | Mount `/root/.docker:/root/.docker:ro`, recreate `instance-agent` — [§19c](troubleshooting-and-lessons.md) |
| Manual hotpatch after failed admin update | Admin shows stale `deployedImageRef` vs heartbeat version | Retry update after mount fix, or wait for heartbeat `deployedImageRef` sync — [§19d](troubleshooting-and-lessons.md) |

---

## Files

| Path | Role |
| --- | --- |
| [`scripts/sync-dist-from-image.sh`](../../scripts/sync-dist-from-image.sh) | Manual dist sync from GHCR image |
| [`packages/instance-agent/src/distSync.ts`](../../packages/instance-agent/src/distSync.ts) | Same logic in automated updates |
| [`src/distProvenance.ts`](../../src/distProvenance.ts) | Health check for `components.dist` |
| [`deploy/docker-compose.yml`](../../deploy/docker-compose.yml) | Bind-mount list |
