# Local Installation

This document captures the local Joshu/Hermes/Hindsight installation shape used
on this Mac. It complements the shorter `README.md` local run notes and the more
detailed Hermes integration notes in `docs/hermes-integration.md`.

## Repository Layout

Joshu is checked out at:

```text
~/joshu-oss
```

Local development expects Hermes Agent to live in a separate checkout:

```text
~/hermes-agent
```

Joshu treats Hermes as an upstream dependency. Joshu-owned behavior should live
in this repo through skills, plugins, scripts, prompts, environment variables,
and generated config, rather than by editing Hermes core directly.

## Hermes Agent

The local Hermes binary is expected at:

```text
~/hermes-agent/venv/bin/hermes
```

Set this in `.env`:

```dotenv
HERMES_BIN=~/hermes-agent/venv/bin/hermes
HERMES_API_BASE_URL=http://127.0.0.1:8642
HERMES_API_KEY=change-me-local-dev
HERMES_API_AUTO_START=true
# LLM via OpenRouter (verified local default — see docs/hermes-integration.md)
JOSHU_HERMES_PROVIDER=openrouter
JOSHU_HERMES_MODEL=deepseek/deepseek-v4-flash
OPENROUTER_API_KEY=sk-or-...
```

Joshu writes `model.provider` / `model.default` from those vars into
`~/.hermes/config.yaml` on gateway start and syncs `OPENROUTER_API_KEY` into
`~/.hermes/.env`. VPS sandboxes use the same OpenRouter defaults via control-plane
`DEFAULT_OPENROUTER_API_KEY` and `DEFAULT_JOSHU_HERMES_*`.

When Hermes is needed, Joshu starts the gateway automatically with:

```bash
hermes gateway run --replace --quiet --accept-hooks
```

With the verified local setup, the live process should look like:

```text
~/hermes-agent/venv/bin/python3 \
  ~/hermes-agent/venv/bin/hermes \
  gateway run --replace --quiet --accept-hooks
```

### Voice (CLI STT / TTS)

Joshu’s [`scripts/update-hermes-agent.sh`](scripts/update-hermes-agent.sh) installs Hermes with the same **pip extras as the sandbox image** (`HERMES_IMAGE_EXTRAS`), including **`voice`** and **`messaging`** — full-turn CLI voice (`/voice on`, Ctrl+B), plus the gateway stack for Discord/Telegram when you enable it.

**macOS system packages** (Hermes [Voice Mode](https://hermes-agent.nousresearch.com/docs/user-guide/features/voice-mode) expects these):

```bash
brew install portaudio ffmpeg ripgrep
```

**ripgrep** (`rg`) is required for Hermes **`search_files`** on the local terminal backend. [`scripts/dev-arozos.sh`](scripts/dev-arozos.sh) checks for it at startup.

**Without a GPU**, use **`stt.provider: local`** with Whisper **`tiny`** or **`base`** in `~/.hermes/config.yaml` for free on-device STT (slower on CPU), or set **`stt.provider: groq`** and put **`GROQ_API_KEY`** in `~/.hermes/.env` for faster cloud STT.

Default **TTS** is **Edge** (`tts.provider: edge`) — no API key; requires network access.

**Sandbox image:** Prefer Groq (or another cloud STT) on CPU workers instead of heavy local Whisper. Put keys in the sandbox image’s secret and load them into `/root/.hermes/.env` via **`HERMES_ENV_B64`** (see [`deploy/scripts/vps-start.sh`](deploy/scripts/vps-start.sh)) — do not commit secrets into the repo-tracked [`.hermes/`](.hermes) snapshot. Override **`stt.provider`** for the container in that env-backed config if needed.

### Hermes Chat (browser voice)

The ArozOS **Hermes Chat** app can use the same Hermes STT/TTS stack as the CLI (not browser `speechSynthesis`):

- Turn **Mic** on for a hot microphone: the browser segments audio with VAD aligned to Hermes **`voice_mode.AudioRecorder`**, POSTs mono WAV to Joshu **`/api/hermes-chat/transcribe`**, and **auto-sends** each non-empty transcript into the chat stream.
- Turn **Speech** on so assistant replies are spoken via **`POST /api/hermes-chat/tts`** (Hermes `text_to_speech_tool`); the mic is paused during playback to reduce echo.

Joshu runs Hermes Python in a subprocess (`HERMES_BIN`, `[voice]` extras, `HERMES_HOME` / `config.yaml` for STT/TTS). See [`docs/hermes-chat-arozos-app.md`](hermes-chat-arozos-app.md) for chat API paths; [`docs/connectors-arozos-app.md`](connectors-arozos-app.md) for **Connectors** (Composio OAuth, multi-Gmail); [`docs/jmail-arozos-app.md`](jmail-arozos-app.md) for **jMail**.

**Broader local venv** (optional): set **`HERMES_LOCAL_EXTRAS`** when running the update script, e.g. `all,dev` for full upstream dev — default remains VPS parity.

### Langfuse observability (optional)

Full setup, env keys, and trace verification live in
[`docs/hermes-integration.md`](hermes-integration.md) (**Langfuse observability**).

Local checklist:

1. In the Hermes venv: `pip install langfuse` and `hermes plugins enable observability/langfuse`.
2. Put `HERMES_LANGFUSE_*` in Joshu `.env` (or `~/.hermes/.env`); Joshu syncs them on gateway start.
3. Match **`HERMES_LANGFUSE_BASE_URL`** to your Langfuse project region (US vs EU) — wrong host often shows as OTLP **401** in `~/.hermes/logs/agent.log` even when `/api/public/health` succeeds.
4. Set `JOSHU_HERMES_PLUGIN_NAMES=observability/langfuse` (default in `.env.example`).
5. Start via `npm run dev:arozos` (applies the Langfuse system-prompt patch when needed) or restart Joshu after changing keys so the gateway reloads env.

**Joshu deterministic traces:** Day 0 and the EA scheduling classifier (OpenRouter in `src/day0/llm.ts`) use the same `HERMES_LANGFUSE_*` keys via `src/observability/langfuse.ts` — tag **`joshu-app`**, trace names `joshu-day0-infer`, `joshu-day0-sweep`, `ea-scheduling-classifier`. Restart Joshu (`npm run dev` / `dev:arozos`); grep logs for `[joshu-langfuse] tracing enabled`. Details: [hermes-integration — Langfuse](hermes-integration.md#langfuse-observability).

**jChat traces:** Browser → ArozOS → Joshu `/api/hermes-chat/*` → Hermes gateway on `:8642`. Joshu owns the gateway process, not ArozOS.

**Langfuse Users vs traces:** Traces can show in the UI without a **Users** row until `HERMES_LANGFUSE_USER_ID`, the user-id patch, and gateway env are correct — see [troubleshooting — Users vs jChat](vps-sandbox/troubleshooting-and-lessons.md#langfuse-users-vs-jchat-traces).

**What copies to VPS:** Your full `~/.hermes/config.yaml` does **not** ship in the sandbox image. Product settings (`skills.disabled`, model, plugins, Langfuse) come from the repo and `instance.env` — [hermes-integration — runtime config](hermes-integration.md#hermes-runtime-config-local-hermes-vs-vps--image). The denylist is **computed** at gateway sync from `skills-enabled.yaml` + bundled Hermes discovery (`HERMES_DIR` on VPS, `HERMES_BIN` walk-up locally). Refresh the allowlist with `npm run hermes:sync-skills-policy` after bumping the Hermes pin; verify with `npm run test:hermes-skills-policy`.

**Troubleshooting:**

| Symptom | Likely cause | Fix |
|--------|----------------|-----|
| No traces in Langfuse UI | Wrong `HERMES_LANGFUSE_BASE_URL` for your keys | Use `https://us.cloud.langfuse.com` or `https://cloud.langfuse.com` per project Settings |
| Still 401 after URL fix | Stale gateway on `:8642` with old env | `hermes gateway stop` or restart Joshu (`dev:arozos` replaces orphans when env changes) |
| `GET /hermes-chat/status` 503 ~30–90s | Gateway cold start | Wait for warm-up; Joshu allows up to ~90s on first start |
| System prompt missing in **LLM call** | Anthropic `system` not in `messages` | Apply `scripts/apply-hermes-langfuse-system-patch.sh` until [upstream PR #32175](https://github.com/NousResearch/hermes-agent/pull/32175) is in your Hermes pin |
| Hermes traces OK, no `joshu-app` traces | Joshu not restarted after keys; or VPS missing runtime Langfuse npm deps | Restart Joshu locally; on VPS cut image release after `deploy/runtime/package.json` bump — [hotpatch Lane C](vps-sandbox/hotpatch-running-box.md#lane-c--full-image-release-only) |
| Assistant replies in Chinese / `你好，我无法给到相关内容。` | OpenRouter `content_filter` from DeepSeek (or similar) with no Hermes retry | Ensure `scripts/apply-hermes-content-filter-patch.sh` ran (`_is_provider_content_filter_response` in Hermes `run_agent.py`); restart gateway — [content_filter handling](hermes-integration.md#provider-content_filter-handling) |
| `Files: command not found` on start | Unquoted path with apostrophe in `~/.hermes/.env` | Let Joshu re-sync from `.env` (quoted paths) or quote `Joshu's Files` manually |

## Updating Hermes Safely

Hermes changes quickly, so keep the local Hermes checkout as close to upstream as
possible. Do not put Joshu-owned behavior in `~/hermes-agent`;
keep it in this repo, `$HERMES_HOME`, generated config, skills, plugins, scripts,
or environment variables.

Integration policy and snapshot details live in
`docs/hermes-integration.md` (section **Updating Hermes**).

### Recommended: Joshu update script

From the Joshu repo, use the scripted path to promote the latest upstream **stable
release**, refresh the Hermes venv, update the deploy pin, and keep a local
rollback snapshot:

```bash
cd ~/joshu-oss
npm run hermes:status
npm run hermes:update
```

Snapshots are stored under `.local/hermes-update-snapshots/` (gitignored). If local
testing fails:

```bash
npm run hermes:rollback
# or a specific snapshot:
# bash scripts/update-hermes-agent.sh rollback 20260515T153316Z
```

Then restart the stack and re-run smoke tests:

```bash
npm run dev:arozos
npm run hindsight:smoke
npm run vps:build-image        # full in-image Node build (slow; good for CI parity)
npm run vps:build-image   # local dist + prebuilt dist/ (when only Joshu changed; see docs/hitl-camofox-notes.md)
```

The script expects a clean Hermes tree by default. Use `--force` or clean up
scratch files first:

```bash
cd ~/hermes-agent
git status
git branch --show-current
git rev-parse HEAD
```

```bash
cd ~/joshu-oss
bash scripts/update-hermes-agent.sh update --force
```

### Hermes runtime backup (`$HERMES_HOME`)

The Joshu script snapshots the **checkout**, **venv packages**, and **deploy pin**.
It does not copy `~/.hermes`. When you also need Hermes-managed runtime state
(config migrations, gateway backups), use Hermes's own updater in the checkout:

```bash
cd ~/hermes-agent
venv/bin/hermes update --check
venv/bin/hermes update --backup
```

Prefer that over a raw `git pull` when staying on Hermes's moving `main` branch.
For Joshu's normal flow, use `npm run hermes:update` to pin a **release tag** and
keep deploy/RELEASE.json in sync.

After updating, verify that the Hindsight packages still match the expected local
shape:

```bash
~/hermes-agent/venv/bin/python - <<'PY'
from importlib.metadata import distribution, PackageNotFoundError

for name in ["hindsight-api-slim", "hindsight-api", "hindsight-client", "pg0-embedded"]:
    try:
        dist = distribution(name)
    except PackageNotFoundError:
        print(f"{name}: not installed")
        continue

    installer = dist.read_text("INSTALLER") or "unknown"
    print(f"{name}: version={dist.version}")
    print(f"  location={dist.locate_file('')}")
    print(f"  installer={installer.strip()}")
PY
```

If Hermes's dependency refresh removes or changes the slim Hindsight install,
restore the known-good local packages:

```bash
cd ~/hermes-agent
venv/bin/pip install 'hindsight-api-slim[embedded-db]==0.7.2' \
  'hindsight-client==0.7.2' \
  'pg0-embedded==0.14.2'
```

For the lowest-risk update path, test against a canary Hermes checkout first:

```bash
cd ~/dev
git clone https://github.com/NousResearch/hermes-agent.git hermes-agent-next
cd hermes-agent-next
uv venv venv --python 3.11
VIRTUAL_ENV="$PWD/venv" uv pip install -e '.[all,dev]'
venv/bin/pip install 'hindsight-api-slim[embedded-db]==0.7.2' \
  'hindsight-client==0.7.2' \
  'pg0-embedded==0.14.2'
```

Then temporarily point Joshu's `.env` `HERMES_BIN` at:

```text
~/hermes-agent-next/venv/bin/hermes
```

Run the local stack and smoke tests. Promote the canary only after Hermes gateway,
HITL Camofox adoption, Hermes Chat, and Hindsight recall all pass.

## File Brain (gbrain)

File brain is **always enabled** on Joshu (local and VPS). It uses the same pinned
commit as production:

```text
deploy/RELEASE.json → gbrainRef
```

Install locally (via Bun, matches the sandbox image):

```bash
npm run gbrain:install
```

`npm run dev:arozos` runs install + `scripts/start-gbrain.sh` + `scripts/start-gbrain-mcp-http.sh` automatically. You need
embedding API keys in repo root `.env` (shared with Hindsight), for example
`HINDSIGHT_API_EMBEDDINGS_GEMINI_API_KEY` or `HINDSIGHT_API_EMBEDDINGS_OPENAI_API_KEY`.

Local PGLite data defaults to `.local/gbrain` (`GBRAIN_HOME` in `.env.example`). gbrain MCP HTTP listens on **`http://127.0.0.1:8794`** (`/mcp` for Hermes, REST for File Brain). Quick check: `curl -fsS http://127.0.0.1:8794/health`.

Set the opinionated folder explicitly (quote the apostrophe — `.env` is bash-sourced):

```bash
JOSHU_FILES_DIR_NAME="joshu's files"
```

See [`docs/file-brain.md`](file-brain.md) for Desktop layout, slug rules, write paths, connector mail indexing, **PDF knowledge base drop** (`research/kb/inbox/`), periodic reindex (`GBRAIN_REINDEX_INTERVAL_SEC`), PGLite locks, and bumping the pin.

**KB PDF ingest (local):** text PDFs dropped in `joshu's files/research/kb/inbox/` are auto-extracted when gbrain MCP HTTP is running. Install at least one extractor:

```bash
brew install poppler          # pdftotext (macOS)
pip install pypdf               # Python fallback
```

Manual ingest: `npm run kb:ingest-pdf`.

## Hindsight Memory

Hindsight is installed into the same Hermes virtualenv. This Mac uses the slim
API package with embedded database support:

```bash
cd ~/hermes-agent
venv/bin/pip install 'hindsight-api-slim[embedded-db]' hindsight-client
```

The verified installed packages are:

```text
hindsight-api-slim==0.7.2
hindsight-client==0.7.2
pg0-embedded==0.14.2
```

The full `hindsight-api` package is not installed. This is intentional for the
current local shape: Hindsight runs the API plus embedded PostgreSQL/pg0 storage,
while local embedding, reranker, and inference model bundles are avoided.

The Hindsight API binary is expected at:

```text
~/hermes-agent/venv/bin/hindsight-api
```

Set or leave these values in `.env`:

```dotenv
JOSHU_HINDSIGHT_ENABLED=auto
HINDSIGHT_API_URL=http://127.0.0.1:8888
# HINDSIGHT_API_BIN=~/hermes-agent/venv/bin/hindsight-api
```

In `auto` mode, Joshu starts Hindsight only when `HINDSIGHT_API_LLM_*`
configuration is present. Set `JOSHU_HINDSIGHT_ENABLED=true` when you want
startup to fail fast if Hindsight cannot become healthy.

With the verified local setup, the live process should look like:

```text
~/hermes-agent/venv/bin/python3 \
  ~/hermes-agent/venv/bin/hindsight-api \
  --host 127.0.0.1 --port 8888
```

## External ML Configuration

Because the slim Hindsight package does not bundle local embedding or reranker
models, configure hosted or OpenAI-compatible providers when memory extraction,
embedding, and ranking are needed:

```dotenv
HINDSIGHT_API_LLM_PROVIDER=openai
HINDSIGHT_API_LLM_API_KEY=your-key
HINDSIGHT_API_LLM_MODEL=gpt-4o-mini
HINDSIGHT_API_LLM_BASE_URL=https://api.openai.com/v1

HINDSIGHT_API_EMBEDDINGS_PROVIDER=openai
HINDSIGHT_API_EMBEDDINGS_OPENAI_MODEL=text-embedding-3-small
HINDSIGHT_API_EMBEDDINGS_OPENAI_API_KEY=your-key

HINDSIGHT_API_RERANKER_PROVIDER=cohere
HINDSIGHT_API_RERANKER_COHERE_MODEL=rerank-english-v3.0
HINDSIGHT_API_RERANKER_COHERE_API_KEY=your-key
```

For local smoke testing without an external reranker, Hindsight can use:

```dotenv
HINDSIGHT_API_RERANKER_PROVIDER=rrf
```

## Running Locally

Install Joshu dependencies and create a local environment file:

```bash
cd ~/joshu-oss
npm install
cp .env.example .env
```

Start the standalone Joshu Express app:

```bash
npm run dev
```

Open:

```text
http://127.0.0.1:8787
```

For the local ArozOS parity stack, run:

```bash
npm run dev:arozos
```

This starts or reuses Camofox, builds ArozOS, starts Joshu privately on
`127.0.0.1:8788` under `/joshu`, and exposes ArozOS at:

```text
http://127.0.0.1:8787
```

Launch **jWeb**, **jChat**, **Connectors**, **jMail**, **Memory**, **Schedules**, or **jMovie** from the ArozOS desktop to
exercise the same subservice paths used by the VPS sandbox stack. **Schedules** manages Hermes cron jobs (`/joshu/api/cron/*`); see [`docs/schedules-arozos-app.md`](schedules-arozos-app.md). **Hermes Admin** (Kanban, cron, skills, MCP) opens at `/joshu/hermes-admin/` — desktop shortcut or `http://127.0.0.1:8788/joshu/hermes-admin/`; requires `HERMES_BIN` in `.env` and dashboard on `:9119` ([hermes-integration — local dashboard](hermes-integration.md#local-dev-joshu-subpath-proxy)). Stock shortcuts use
friendly labels (**Files**, **Settings**, **Trash**) — see
[`docs/arozos-desktop-shortcuts.md`](arozos-desktop-shortcuts.md).

**Joshu URLs:** ArozOS on port `8787` only proxies `/joshu/*` when the **jWeb**
subservice is registered. Joshu Express is always available at
`http://127.0.0.1:8788/joshu/` (same machine, private port). If
`http://127.0.0.1:8787/joshu/...` returns ArozOS’s 404 page, check boot logs for
`Subservice Registered: jWeb` and remove
`.local/arozos-data/subservice/joshu/.disabled` if present, then restart
`npm run dev:arozos`.

**Stopping the stack:** **Ctrl+C** in the `dev:arozos` terminal stops Joshu, ArozOS, Hindsight, voice-realtime, and gbrain (see [`scripts/dev-arozos.sh`](../scripts/dev-arozos.sh) `cleanup` trap). Connectors MCP (`:8795`), Composio guard (`:8796`), Hermes gateway, and Camofox Docker may keep running — usually fine for `npm run dev:arozos` again. For a full local teardown (reclaim workers, stop gateway, kill connectors MCP), see [troubleshooting — stopping dev:arozos](vps-sandbox/troubleshooting-and-lessons.md#local-dev--stopping-npm-run-devarozos-2026-06-23).

**Camofox container:** `bash scripts/ensure-camofox-container.sh` creates or
starts `camofox-hitl` (see `CAMOFOX_CONTAINER` in `.env`). The script patches
`/app/server.js` on **every container start** (repo mounted at `/opt/joshu`).

Recreate the container (not just `docker start`) when changing `VNC_RESOLUTION`,
after updating `scripts/patch-camofox-single-tab.mjs`, or if Camofox exits with
`Camofox viewport route must call __hitlFitBrowserWindow with width/height` — that
indicates a stale hybrid patch in the container layer:

```bash
docker rm -f camofox-hitl
bash scripts/ensure-camofox-container.sh
```

Details: [`docs/vps-sandbox/troubleshooting-and-lessons.md`](vps-sandbox/troubleshooting-and-lessons.md#patch-pitfalls-maintainers).

Full VNC / aspect-ratio / fingerprint notes:
[`hitl-camofox-notes.md`](hitl-camofox-notes.md#vnc-display-routing-and-troubleshooting-resolved-may-2026).

### UI / design system

- In-app surfaces use [`packages/design-system`](../packages/design-system) via
  `@joshu/design-system` (tokens, typography, base CSS).
- ArozOS desktop chrome is overlaid by **`aroz-paper-shell.css`** from the private
  **`joshu-design`** pack when `JOSHU_DESIGN_PACK` is set (see below). OSS / missing
  design pack falls back to **`aroz-vanilla-shell.css`** (minimal chrome).
- `dev-arozos.sh` runs [`scripts/apply_arozos_joshu_theme.py`](../scripts/apply_arozos_joshu_theme.py)
  on the template `web/` tree after syncing upstream ArozOS, and again on
  `.local/arozos-data/web/` so `desktop.html` always links the shell stylesheet.
- **`JOSHU_DESIGN_PACK`:** fleet builds set this explicitly. Local dev **auto-detects**
  a sibling `../joshu-design` checkout when the env var is unset (`scripts/dev-arozos.sh`).
  Without the design pack, you get vanilla shell (black desktop, system fonts) — not a bug.
- Shell assets (branded): `joshu-design/arozos/web-overlays-vanilla/`; OSS fallback:
  `arozos/web-overlays-vanilla/`. Tango PNGs → `web/img/joshu/`, `web/img/desktop/`,
  `web/img/tango/`. Rebuild: [`docs/design/README.md`](design/README.md#tango-icon-pipeline).
- **Desktop stuck / “Initializing” splash** on login: see
  [`docs/design/README.md`](design/README.md#desktop-startup-splash) and
  [`docs/vps-sandbox/troubleshooting-and-lessons.md`](vps-sandbox/troubleshooting-and-lessons.md#desktop-ui--stuck-clicks-and-init-splash).
- **Video / mute issues** on the ArozOS desktop (Media Player vs Video app, autoplay
  policy, `global_volume`): see [`docs/arozos-media-player.md`](arozos-media-player.md).
- After editing tokens, overlay, or icons, see [`docs/design/README.md`](design/README.md) for
  sync/rebuild steps, icon inventory, desktop tooltip behavior, taskbar behavior, and troubleshooting
  (404 on `joshu-*.css`, chunky titles, title-bar borders).
- Renaming desktop apps or fixing shortcut launch: [`docs/arozos-desktop-shortcuts.md`](arozos-desktop-shortcuts.md).
- **jMovie** (Creatomate editor): [`docs/jmovie-arozos-app.md`](jmovie-arozos-app.md) — env vars, build, preview troubleshooting.

The VPS sandbox image differs in a few important ways: local PostgreSQL data lives under
ephemeral `/tmp` in the container, the web `serve` function uses a long timeout and
scaledown window (see `deploy/RELEASE.json`), and pgvector is built with portable compiler
flags. See `README.md` (VPS sandbox) and `docs/hitl-camofox-notes.md`
for details and debugging notes.

## Box state (personal snapshots)

Checkpoint and restore personal setup (Desktop files, Hindsight memory, Hermes user config, optional gbrain index):

```bash
npm run box -- status
npm run box -- snap --label before-change --include-gbrain
npm run box -- list
npm run box -- restore --id <snapshot-id>
npm run box -- factory-reset --mode hard --confirm   # wipe personal state (see below)
```

**Hard factory reset** clears Desktop files, Hermes user config (including **`~/.hermes/skills/`** and **`cron/`**), Hindsight memories, gbrain index contents, and **Composio OAuth connections** (cloud-side disconnect so mail cron cannot re-sync). Restores factory desktop shortcuts. Joshu then **re-seeds joshu skills and re-applies the bundled-skills denylist** via `resyncHermesAfterBoxHardReset()` — start a **new jChat** session. Companion persona is not restored automatically; run `configure identity in /etc/joshu/instance.env (see self-host.md)` locally. Details: [`docs/box-state.md`](box-state.md#hard-factory-reset), [`hermes-integration — Disabled skills`](hermes-integration.md#disabled-skills-product-denylist).

Factory vs personal layers, GCS durable storage (`aeon-joshu-box-snapshots`), VPS provision wiring, and Welcome onboarding: [`docs/box-state.md`](box-state.md), [`docs/welcome-onboarding.md`](welcome-onboarding.md). System Setting UI: **Settings → Joshu → Box State** (after `npm run dev:arozos`).

## Verification Commands

Confirm Hermes and Hindsight are running from the expected checkout:

```bash
ps -axo pid,ppid,user,command | rg -i '(~/hermes-agent|hermes gateway|hindsight-api)'
```

Confirm Hindsight was installed by pip into the Hermes virtualenv:

```bash
~/hermes-agent/venv/bin/python - <<'PY'
from importlib.metadata import distribution, PackageNotFoundError

for name in ["hindsight-api-slim", "hindsight-api", "hindsight-client", "pg0-embedded"]:
    try:
        dist = distribution(name)
    except PackageNotFoundError:
        print(f"{name}: not installed")
        continue

    installer = dist.read_text("INSTALLER") or "unknown"
    print(f"{name}: version={dist.version}")
    print(f"  location={dist.locate_file('')}")
    print(f"  installer={installer.strip()}")
PY
```

The expected result for this Mac is:

```text
hindsight-api-slim: installed by pip
hindsight-api: not installed
hindsight-client: installed by pip
pg0-embedded: installed by pip
```

Run the Hindsight smoke test after the local stack is healthy:

```bash
npm run hindsight:smoke
```

The smoke test writes a distinctive fact, polls recall, and prints the returned
memory text. Use Hindsight Viewer for a visual check of the memory graph.
