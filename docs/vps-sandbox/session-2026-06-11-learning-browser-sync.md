# Session notes — 2026-06-11: Hermes learning loop + tiered browser sync

Operator/engineering record for work shipped to **`main`** (merge commit **`8f23aee`**, [PR #1](https://github.com/db-aeon/joshu/pull/1)) and hotpatched on **`patrick.box.joshu.me`**.

Related docs:

- [Hermes learning loop & GitHub backup](../hermes-customizations.md#github-backup-per-box-learning-state)
- [Tiered Hermes Chat browser sync](../hermes-customizations.md#tiered-hermes-chat-browser-sync)
- [Hotpatching a running box](hotpatch-running-box.md)

---

## Summary

| Area | What shipped |
| --- | --- |
| **Learning loop** | Writable `$HERMES_HOME/skills/joshu/`, skill evolution ledger, hourly private GitHub backup per box |
| **Browser sync** | `auto` / `light` / `full` / `off` policy for `/api/hermes-chat/stream` — cuts ~11k+ token bloat on casual chat |
| **Control plane** | Auto-provision `db-aeon/joshu-learning-{slug}` + deploy key on box create |
| **Patrick box** | Learning GitHub wired, dist/host git synced to `8f23aee`, health `synced` at `0.1.18` |

---

## 1. Hermes continuous learning loop

### Goal

Let Hermes evolve skills in a **writable** tree, record changes, and back up procedural state to a **private per-box GitHub repo** (`db-aeon` org).

### Architecture

```text
integrations/hermes/skills/          (factory seed in Joshu image)
        ↓ bootstrap-hermes-learning-skills.sh (on factory release bump; default: LLM merge)
~/.hermes/skills/joshu/              (writable product skills)
        ↓ skill_manage + evolution patch
~/.hermes/skills/ + .evolution.jsonl
        ↓ hourly hermes-learning-github-sync.sh
github.com/db-aeon/joshu-learning-{slug}  (main)
```

### Key behaviors

- **Seed target:** `factory/manifest.yaml` → `skills_seed_target: skills/joshu`
- **No read-only `external_dirs`:** Joshu removes stale `skills.external_dirs` entries for the repo skills path so the agent can edit seeded skills in `$HERMES_HOME/skills/joshu/`
- **Skills denylist:** Bundled allowlist/denylist still applies to factory skills; agent skills under `$HERMES_HOME/skills/` are **not** auto-disabled. Optional `JOSHU_HERMES_SKILLS_DENYLIST_ENABLED=false`
- **Evolution ledger:** `scripts/hermes-skill-evolution.patch` appends to `~/.hermes/skills/.evolution.jsonl` on `skill_manage` (session id, origin, action, skill). **Audit-only** — not replayed when bootstrap re-seeds; on release bumps bootstrap **LLM-merges** factory into each box’s `SKILL.md` by default (`JOSHU_HERMES_SKILLS_SEED_MODE=merge`). Use GitHub backup to restore if merge fails or after accidental **`overwrite`** ([hotpatch 2026-06-12](hotpatch-running-box.md#skills-hotpatch-on-boxes-with-learning-2026-06-12)).
- **Git scope in `$HERMES_HOME`:** `.gitignore` tracks only `skills/`, `cron/`, `memories/`, `config.user.yaml` — not full Hermes config, sessions, or secrets
- **Single-flight bootstrap:** `HermesApiRunner.learningBootstrapPromise` runs learning seed + cron install once per Joshu process (avoids spam on every health heartbeat)

### GitHub (per box)

| Item | Value |
| --- | --- |
| Repo pattern | `db-aeon/joshu-learning-{slug}` |
| Patrick example | `db-aeon/joshu-learning-patrick` |
| Auth | Deploy key at `/etc/joshu/secrets/hermes-learning-github-deploy-key` |
| Env vars | `JOSHU_HERMES_LEARNING_GITHUB_REPO`, `JOSHU_HERMES_LEARNING_GITHUB_REMOTE`, `JOSHU_HERMES_LEARNING_DEPLOY_KEY` |
| Control plane | `GITHUB_LEARNING_REPO_TOKEN` + `DEFAULT_JOSHU_GITHUB_ORG=db-aeon` → [`learningRepoProvisioner.ts`](../../apps/control-plane/src/lib/learningRepoProvisioner.ts) |
| Cron | Hermes job **Hermes learning GitHub sync** — hourly `scripts/hermes-learning-github-sync.sh` |

### Operator: patch an existing box

```bash
# From laptop (after push to main)
ssh root@<slug>.box.joshu.me
bash /opt/joshu/scripts/patch-box-learning-github.sh <slug>
```

### Regression test

```bash
npm run test:hermes-skills-policy
```

---

## 2. Tiered Hermes Chat browser sync

### Problem

Every jChat turn injected a **full Camofox a11y snapshot** (~11k+ chars) via `buildBrowserSyncSystemMessage`, inflating Langfuse traces (~23k input tokens on a simple "hey").

### Solution

Policy module [`src/hermesBrowserSyncPolicy.ts`](../../src/hermesBrowserSyncPolicy.ts); wired in [`src/server.ts`](../../src/server.ts) `POST /api/hermes-chat/stream`.

| Mode | Behavior |
| --- | --- |
| `auto` (default) | **light** when tab exists, same URL, no browser intent; **full** when URL changed or user text implies browser work |
| `light` | URL + title only; no `observe()` |
| `full` | Full a11y snapshot before the turn |
| `off` | No browser system message |

Env: `JOSHU_HERMES_CHAT_BROWSER_SYNC=auto` (optional body override: `browserSync`).

**Unchanged:** `/api/runs` still uses full observe.

### Regression test

```bash
npm run test:hermes-browser-sync-policy
```

### Langfuse observations (Patrick, trace `cd72fa6a…`)

- Large input tokens were mostly system prompt + browser snapshot, not skills/learning
- Duplicate **LLM call 1** spans: Hermes retry loop fired `pre_api_request` twice before success (~4s wasted on first attempt)

---

## 3. Patrick box hotpatch (2026-06-11)

Validated host: **`patrick.box.joshu.me`**, git ref **`8f23aee`**, `JOSHU_RELEASE_VERSION=0.1.18`.

### Steps used

1. **Selective dist rsync** (never `rsync --delete dist/` on Patrick — broke `@joshu/email-signature` once):

   ```bash
   rsync -avz dist/hermesApi.js dist/hermesBrowserSyncPolicy.js dist/hermesCronBridge.js \
     dist/hermesLearning.js dist/hermesLearningGitCron.js dist/server.js \
     root@patrick.box.joshu.me:/opt/joshu/dist/
   ```

2. **Host git** — `git fetch && git reset --hard origin/main` (Patrick had local hotpatch drift on `docker-compose.yml`, `vps-start.sh`, etc.)

3. **Recreate stack:**

   ```bash
   cd /opt/joshu/deploy
   docker compose -f docker-compose.yml --env-file /etc/joshu/instance.env up -d --force-recreate joshu-stack
   ```

### Incidents fixed on Patrick during this work

| Issue | Cause | Fix |
| --- | --- | --- |
| Health `dist` drift | `JOSHU_RELEASE_VERSION=dev-action-guard` vs synced `0.1.18` dist | Align `instance.env` with image + provenance |
| Hindsight `fetch failed` | Learning patch set `/etc/joshu/secrets` to `chmod 700`; `hindsight` user (gid 1001) could not read Google SA key | Host: `chown 0:1001`, `chmod 750` dir, `chmod 640` SA key; `patch-box-learning-github.sh` uses `750` not `700` |
| Learning log spam | Concurrent health probes re-ran bootstrap | Single-flight `learningBootstrapPromise` + cron skip-if-unchanged |
| Full dist `--delete` rsync | Removed packages only present in image overlay | Recovery: `sync-dist-from-image.sh` + selective file overlay |

---

## 4. Key files (reference)

| Area | Paths |
| --- | --- |
| Learning bootstrap | `src/hermesLearning.ts`, `src/hermesApi.ts`, `deploy/scripts/vps-start.sh` |
| GitHub sync | `scripts/hermes-learning-github-sync.sh`, `scripts/lib/ensure-hermes-learning-git.sh` |
| Skill seed | `scripts/bootstrap-hermes-learning-skills.sh` |
| Evolution patch | `scripts/apply-hermes-skill-evolution-patch.sh`, `scripts/hermes-skill-evolution.patch` |
| Box patch script | `scripts/patch-box-learning-github.sh` |
| Control plane provision | `apps/control-plane/src/lib/learningRepoProvisioner.ts` |
| Browser policy | `src/hermesBrowserSyncPolicy.ts`, `src/server.ts`, `src/hermesApi.ts` `buildBrowserSyncSystemMessage` |
| Cron bridge types | `src/hermesCronBridge.ts` |
| Compose bind-mounts | `deploy/docker-compose.yml` (learning scripts) |

---

## 5. Verify on a box

```bash
# Health
curl -fsS http://127.0.0.1:8788/joshu/api/instance/health | jq '{healthy, releaseVersion, dist: .components.dist}'

# Learning git remote (inside container)
docker exec deploy-joshu-stack-1 git -C /root/.hermes remote -v

# Manual learning push
docker exec deploy-joshu-stack-1 bash /opt/joshu/scripts/hermes-learning-github-sync.sh

# Browser sync policy (laptop)
npm run test:hermes-browser-sync-policy
```

---

## 6. Not in this session / follow-ups

- New GHCR release tag cutting `0.1.19+` with baked-in `dist/` (Patrick still uses `0.1.18` image + host dist overlay)
- Fleet rollout via control-plane **Update** for non-test boxes
- Upstream Hermes fix for duplicate Langfuse LLM spans on retry
