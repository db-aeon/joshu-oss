# Environment setup without the Welcome wizard

Configure API keys, identity, and optional onboarding **from the shell** instead of the desktop **Welcome** app. Use this for headless installs, automation, or when Welcome fails (e.g. [`draft path unavailable`](box-paths.md#troubleshooting) before paths are fixed).

Welcome remains the normal path for Day-1 EA setup — see [`welcome-onboarding.md`](welcome-onboarding.md).

---

## Secret resolution order

Joshu merges secrets in this priority (highest wins):

| Priority | Source | Typical use |
|----------|--------|-------------|
| 1 | `/etc/joshu/instance.env` | VPS / Docker self-host (recommended for manual setup) |
| 2 | Process environment | `docker compose` `environment:` overrides |
| 3 | `.joshu/box-secrets/local-env.json` | Welcome Connect AI (standalone only) |
| 4 | `~/.hermes/.env` | Hermes-native keys; Joshu **syncs into** this on gateway start |

Implementation: [`src/boxSecrets/resolve.ts`](../src/boxSecrets/resolve.ts).

On boot, [`deploy/scripts/vps-start.sh`](../deploy/scripts/vps-start.sh):

1. Loads `/etc/joshu/instance.env`
2. Loads box-secrets JSON from the first ArozOS user that has one
3. Writes LLM keys into `~/.hermes/.env` and restarts the Hermes gateway when OpenRouter changes

**Recommendation:** put all required keys in **`/etc/joshu/instance.env`** for self-host. You do not need Welcome if keys are already there.

---

## Minimal `instance.env` (standalone chat + file brain)

Edit on the VPS (mode `600`):

```bash
sudo nano /etc/joshu/instance.env
```

Add or uncomment:

```dotenv
# --- Standalone (no control plane) ---
JOSHU_STANDALONE=1

# --- Owner (must match ArozOS login email — see box-paths.md) ---
JOSHU_AROZ_USER=you@example.com
JOSHU_OWNER_EMAIL=you@example.com

# --- LLM (jChat + Hindsight) ---
OPENROUTER_API_KEY=sk-or-v1-...
JOSHU_HERMES_PROVIDER=openrouter
JOSHU_HERMES_MODEL=deepseek/deepseek-v4-flash
HINDSIGHT_API_LLM_API_KEY=          # optional; defaults from OPENROUTER_API_KEY when saved via Welcome API

# --- File brain + voice (Gemini) — required when voice image is enabled ---
GEMINI_API_KEY=AIza...
HINDSIGHT_API_EMBEDDINGS_PROVIDER=google
HINDSIGHT_API_EMBEDDINGS_GEMINI_API_KEY=   # optional; defaults from GEMINI_API_KEY
```

Gateway secrets (`HERMES_API_KEY`, `API_SERVER_KEY`, `JOSHU_HERMES_DASHBOARD_PASSWORD`) are **auto-generated** by [`deploy/scripts/ensure-instance-env-secrets.sh`](../deploy/scripts/ensure-instance-env-secrets.sh) during bootstrap — you do not need to set them manually.

Full template: [`deploy/.env.vps.example`](../deploy/.env.vps.example).

---

## Apply changes

Restart the stack so Joshu reloads env and syncs Hermes:

```bash
cd /opt/joshu/deploy
docker compose -f docker-compose.yml --env-file /etc/joshu/instance.env up -d --force-recreate
```

Verify:

```bash
curl -fsS http://127.0.0.1:8788/joshu/api/instance/health
curl -fsS http://127.0.0.1:8788/joshu/api/box-secrets/status
```

Expect `needsConnectAi: false` when OpenRouter (and Gemini, if voice is offered) are configured from `instance.env`.

---

## Required keys by feature

| Feature | Keys | Notes |
|---------|------|-------|
| jChat text (Hermes) | `OPENROUTER_API_KEY` | Also set `JOSHU_HERMES_PROVIDER=openrouter` |
| Hindsight memory LLM | `HINDSIGHT_API_LLM_API_KEY` or same OpenRouter key | `HINDSIGHT_API_LLM_PROVIDER=openrouter` in template |
| File Brain embeddings | `GEMINI_API_KEY` or `HINDSIGHT_API_EMBEDDINGS_GEMINI_API_KEY` | `HINDSIGHT_API_EMBEDDINGS_PROVIDER=google` |
| jChat microphone (voice) | `GEMINI_API_KEY` | Requires `JOSHU_VOICE_IMAGE_REF` + compose profile `voice-rt` |
| Connectors (Gmail, etc.) | `COMPOSIO_API_KEY` | Optional; OAuth in Composio cloud |
| Agent mailbox (jMail) | `NYLAS_API_KEY` | Optional |

Voice-off boxes can omit Gemini if you disable the voice sidecar and accept degraded file-brain / embedding health checks (`JOSHU_HINDSIGHT_OPTIONAL=true` in template).

---

## Alternative: `box-secrets/local-env.json`

Welcome writes here when Connect AI succeeds:

```text
/var/lib/arozos/files/users/<email>/.joshu/box-secrets/local-env.json
```

Example (mode `600`, directory `700`):

```json
{
  "OPENROUTER_API_KEY": "sk-or-v1-...",
  "GEMINI_API_KEY": "AIza..."
}
```

Allowed keys: `OPENROUTER_API_KEY`, `HINDSIGHT_API_LLM_API_KEY`, `GEMINI_API_KEY`, `HINDSIGHT_API_EMBEDDINGS_GEMINI_API_KEY` — see [`src/boxSecrets/localEnv.ts`](../src/boxSecrets/localEnv.ts).

**Caveat:** this path only works after [`box-paths.md`](box-paths.md) path resolution succeeds (ArozOS user + `JOSHU_AROZ_USER`). Prefer `instance.env` when Welcome is broken.

---

## Alternative: Hermes `~/.hermes/.env` only

You can set `OPENROUTER_API_KEY` directly in `/root/.hermes/.env` inside the container. Joshu overwrites/syncs keys from `instance.env` on gateway start, so **`instance.env` is the durable source of truth** on VPS.

Local dev: repo root `.env` is sourced by `npm run dev:arozos` — see [`local-installation.md`](local-installation.md).

---

## Skip Welcome persona wizard (optional)

Welcome does two jobs:

1. **Connect AI** — API keys (skip when keys are in `instance.env`)
2. **EA Day-1 intake** — owner name, priorities, crons, `Projects/` seeds

To skip (2) but still use the box:

**Option A — API** (paths must resolve):

```bash
curl -X POST http://127.0.0.1:8788/joshu/api/onboarding/complete \
  -H 'Content-Type: application/json' \
  -d '{
    "ownerName": "Alex",
    "assistantName": "Companion",
    "timezone": "America/Los_Angeles"
  }'
```

**Option B — mark complete manually** (minimal):

Write `/var/lib/arozos/files/users/<email>/.joshu/onboarding.json`:

```json
{
  "completed": true,
  "completedAt": "2026-07-06T00:00:00.000Z"
}
```

Without `POST /complete`, EA project folders and Hermes crons are **not** seeded — fine for chat-only experiments.

---

## Local dev (no Docker)

Copy [`.env.example`](../.env.example) to `.env` in the repo root:

```dotenv
HERMES_BIN=~/hermes-agent/venv/bin/hermes
OPENROUTER_API_KEY=sk-or-...
JOSHU_HERMES_PROVIDER=openrouter
JOSHU_HERMES_MODEL=deepseek/deepseek-v4-flash
GEMINI_API_KEY=AIza...
```

Run ArozOS + Joshu:

```bash
npm run dev:arozos
```

Path resolution uses `.local/arozos-data` and the first ArozOS user with a Desktop (no `JOSHU_AROZ_USER` required locally).

---

## Common problems

| Problem | Fix |
|---------|-----|
| Keys in `instance.env` but chat still empty | Restart stack; check `curl …/box-secrets/status` → `llmConfigured: true` |
| `403` saving keys in Welcome | Key is provision-locked in `instance.env` — edit file instead |
| Health false after adding Gemini | One full stack restart; recreate `voice-realtime` if you changed voice env |
| Welcome still prompts Connect AI | `needsConnectAi` true — missing OpenRouter or Gemini for your release's voice settings |

---

## Related docs

- [`box-paths.md`](box-paths.md) — ArozOS user paths (`JOSHU_AROZ_USER`, Desktop, `.joshu`)
- [`vps-quickstart.md`](vps-quickstart.md) — bootstrap and first login
- [`deploy/README.md`](../deploy/README.md) — full env reference
- [`hermes-integration.md`](hermes-integration.md) — gateway, skills, Langfuse
