# last30days ArozOS app

Joshu desktop UI for the [last30days](https://github.com/mvanhorn/last30days-skill) research engine.

**Owner / operator UI walkthrough:** [`last30days-user-guide.md`](last30days-user-guide.md)

## Policy (hard)

- **ScrapeCreators** for YouTube + TikTok / Instagram / Threads / Pinterest / LinkedIn (via `INCLUDE_SOURCES`).
- **Web** = **Exa** when fleet `EXA_API_KEY` is present (`--web-backend=exa`); else keyless DuckDuckGo. Firecrawl/Brave/Serper stay scrubbed.
- **No yt-dlp** — runner strips PATH entries that contain a `yt-dlp` binary so the engine uses SC YouTube.
- **No browser cookies** — always `--no-browser-cookies`; `FROM_BROWSER` / `AUTH_TOKEN` / `CT0` are scrubbed and rejected in Settings.
- **X via xquik** — fleet boxes use CP relay (`JOSHU_XQUIK_MODE=relay`, no `XQUIK_API_KEY` on disk). Self-host pastes `XQUIK_API_KEY` in Settings. Cookies / XAI stay scrubbed. Runner pins `LAST30DAYS_X_BACKEND=xquik` when Xquik is available.

Free keyless sources still run: Reddit public, HN, Polymarket, GitHub (`gh`), StockTwits (ticker topics), Digg/arXiv/Techmeme when their CLIs are on PATH.

## Layout

| Path | Role |
|------|------|
| `apps/last30days/` | Vite/React GUI (`@joshu/design-system`) |
| `arozos/subservice/last30days/` | Manifest + static subservice |
| `src/last30days/` | Joshu REST + SSE runner (+ host-side QueryPlan in `queryPlan.ts`) |
| `integrations/last30days-skill/` | Vendored engine (gitignored snapshot) |
| `integrations/last30days-skill.pin` | Pinned commit SHA |
| `scripts/sync-last30days-skill.sh` | Fetch/refresh engine at pin |

## Sync engine

```bash
bash scripts/sync-last30days-skill.sh
```

Requires network once. Applies Joshu patches automatically:

- `scripts/patch-last30days-clustering.py` — softer clustering for social/opinion queries + engagement-sorted agent JSON
- `scripts/patch-last30days-sc-relay.py` — optional ScrapeCreators HTTP proxy (fleet relay installs)
- `scripts/patch-last30days-xquik-relay.py` — optional xquik.com HTTP proxy (fleet relay installs)
- `scripts/patch-last30days-watch-window.py` — watchlist companion uses `--days=7` (not 90d `--quick`)
- `scripts/patch-last30days-share-dir.py` — `store.py` honors `LAST30DAYS_SHARE_DIR` (Aroz user-tree DB)

Re-apply after manual skill sync:

```bash
bash scripts/apply-last30days-clustering-patch.sh
bash scripts/apply-last30days-sc-relay-patch.sh
bash scripts/apply-last30days-xquik-relay-patch.sh
```

Needs **Python ≥ 3.12** on PATH. Image **0.1.39+** ships `/opt/joshu/.local/python312/bin/python3.12` (uv) and sets `LAST30DAYS_PYTHON` in the container env.

## Config

Written to `{AROZ_DATA}/files/users/<user>/.joshu/last30days/config/.env` (mode `0600`) by the first-use setup dialog and the gear → Settings dialog (survives `joshu-stack` recreate). Legacy `~/.config/last30days` is migrated once and redirected via symlink:

- **ScrapeCreators** — set `SCRAPECREATORS_API_KEY` (your own key from [ScrapeCreators](https://scrapecreators.com/)) and `INCLUDE_SOURCES`. Fleet relay omits the key.
- **Xquik** — set `XQUIK_API_KEY` on self-host for X search. Fleet relay omits the key (`JOSHU_XQUIK_MODE=relay`).
- Optional **Perplexity** key (separate opt-in source — not a drop-in for engine `grounding`; stays in this file)

Self-host / OSS: paste ScrapeCreators and Xquik keys in the app Settings UI, or set them in `/etc/joshu/instance.env` / the last30days env file. No proxy or relay is required.

**LLM / reasoning (planner + rerank):** uses the **per-box OpenRouter key** — same resolution as Hermes (`/etc/joshu/instance.env`, Welcome → Connect AI, or `.joshu/box-secrets/local-env.json`). When OpenRouter is present the engine sets `LAST30DAYS_REASONING_PROVIDER=openrouter` and routes through OpenRouter. Joshu pins planner/rerank to `google/gemini-3.1-flash-lite` (the engine’s default OpenRouter slug `…-preview` returns HTTP 404). The runner does **not** inherit host-shell `GEMINI_API_KEY` / `OPENAI_API_KEY`; without OpenRouter, planner/rerank fall back to deterministic/local scoring.

Recommended `INCLUDE_SOURCES`:

```text
tiktok,instagram,youtube_comments,tiktok_comments,instagram_comments
```

## Local run

```bash
# packages + server
npm run build
npm run test:last30days-runner

# UI alone (Joshu on :8788)
npm run build:last30days   # → dist/last30days-app/
npm run dev:last30days     # :3013, proxies /joshu → :8788

# Or full desktop
npm run dev:arozos
```

Validate manifest:

```bash
node packages/app-sdk/dist/cli.js validate arozos/subservice/last30days/joshu.app.json
```

Smoke:

```bash
bash scripts/last30days-app-smoke.sh
```

Smoke uses `--mock` unless `LAST30DAYS_SMOKE_LIVE=1` and `SCRAPECREATORS_API_KEY` is set in `.joshu/last30days/config/.env`.

## API (prefix `/joshu/api/last30days`)

Status/config/setup/sources, research/drill/verify-freshness, runs + SSE events, doctor/preflight/diagnose, **watching JSON** (`GET/POST/DELETE /watching`, `/watching/run`, `/watching/report`) plus invoke aliases (`watchingList`, `watchingAdd`, `watchingRemove`, `watchingReport`, `watchingRun`, `watchingRunAll`, `watchlistRunAll`). Raw watchlist/store/briefings companions remain for power-user Settings. Discover/queue/library REST endpoints remain on the API for CLI/agents but are no longer exposed in the GUI.

## Hermes vs desktop app

Upstream [last30days SKILL.md](https://github.com/mvanhorn/last30days-skill) assumes a **two-layer** flow when run inside an agent (Hermes, Claude Code, …):

| Layer | Who | Web |
|-------|-----|-----|
| Engine subprocess | `last30days.py` | Social + structured sources |
| Host agent | Model **WebSearch** tool | General web (Step 0.55 pre-research + Step 2 supplements) |

Setting `LAST30DAYS_NATIVE_SEARCH=1` tells the engine to **skip** keyless `grounding` because the host model will search the web separately.

**Joshu desktop app:** subprocess only — no host WebSearch in the loop. The runner **clears** `LAST30DAYS_NATIVE_SEARCH` and passes `--web-backend=exa` when `EXA_API_KEY` is on the box, else `--web-backend=keyless`. Native search must stay off here; otherwise the engine would skip web with nothing to replace it.

**Joshu jChat / Telegram:** do **not** enable upstream’s `/last30days` skill (it assumes host WebSearch). Product path is the **`joshu-last30days` plugin** (callable tools) plus bundled skills **`last30days-chat`** (app closed) and **`last30days-gui`** (app window open). Hermes web browsing stays the **`browser` toolset** (Camofox).

| Layer | Role |
|-------|------|
| Plugin tools | `last30days_research`, `last30days_watch_*` — POST `/joshu/api/apps/last30days/invoke` |
| `last30days-chat` | When/why to call those tools from jChat |
| `last30days-gui` | GUI-first `app_gui_action` when the desktop window is open |
| Schedules cron | No-agent `watchlistRunAll` at 08:00 — not an LLM turn |

## QueryPlan (host-side — transparent to GUI / jChat)

Upstream [last30days SKILL.md](https://github.com/mvanhorn/last30days-skill/blob/main/skills/last30days/SKILL.md) expects the **host model** to write a JSON query plan and pass `--plan` (LAW 7). Joshu boxes do this **server-side** in [`src/last30days/queryPlan.ts`](../src/last30days/queryPlan.ts) before every research and watch run — callers (GUI, invoke, plugin tools, cron) only pass a **topic string**.

| Topic shape | Planning behavior |
|-------------|-------------------|
| **Named entity** (Google DeepMind, SpaceXAI) | **OpenRouter plan** (heuristics fallback): 2–4 angles; `--search=` pins social+web (no jobs); trailing `20xx` stripped from the primary quote |
| **Event** (LA Tech Week, SXSW, Web Summit) | **OpenRouter plan** (heuristics fallback): year-free primary + hosts/speakers/schedule fan-out; `--search=` excludes jobs; Simple/`--quick` forced off so X is not dropped |
| **Concept / industry phrase** (PE operating partners + AI in portcos) | **OpenRouter plan** (heuristics fallback): 3–5 keyword fan-out; `--search=` excludes TikTok/Instagram/Polymarket/jobs; optional `--subreddits=` (e.g. PE) |
| **Comparison** (`X vs Y`) | **OpenRouter plan** (heuristics fallback): per-entity + head-to-head subqueries |

Every topic class goes through OpenRouter when `OPENROUTER_API_KEY` is on the box. Deterministic post-sanitizers still strip `jobs` (unless hiring), strip trailing years from the primary subquery, pin `--search=`, and clear `--quick` so the engine cannot collapse a multi-angle plan.

**Hardening (event / jobs):** The engine’s `--quick` path collapses external plans to one subquery and can inject the `jobs` source when `--search=` is unset. City+tech topics (e.g. “LA Tech Week 2026”) then ranked Taskworks / county HR spam above LinkedIn event posts, and X never ran. Joshu classifies Tech Week / summit / conference topics as **event**, omits trailing calendar years from the primary search, always passes an allow-list without `jobs` (unless the topic is about hiring), and clears `--quick` for host-planned runs.

Plans are written under the Aroz user tree at `{AROZ_DATA}/files/users/<user>/.joshu/last30days/` (`plan-runtime/`, `query-plans/`, `runs/`, `watch-snapshots.json`, plus `config/`, `share/` for `research.db`, `memory/`) so they survive `joshu-stack` recreate / fleet updates. Legacy `/opt/joshu/.joshu/last30days` and classic XDG homes (`~/.config/last30days`, `~/.local/share/last30days`, `~/Documents/Last30Days`) are migrated once on boot. **Watching:** plan is built and **persisted** on `watchingAdd` under `query-plans/`; cron replays the same plan (no LLM). Removed on `watchingRemove`.

Skills `last30days-chat` / `last30days-gui` tell Hermes that planning is automatic — pass only `topic` (+ optional `days` / `depth`) to plugin tools; do not expose QueryPlan to the owner.

Engine internal planner (OpenRouter Gemini Flash Lite) still runs rerank; with `--plan` stderr shows `source=external`.

## Web / grounding

Engine **`grounding`** = general web. Joshu prefers **Exa** when `EXA_API_KEY` is set on the box. Without Exa, keyless DuckDuckGo → Startpage → optional SearXNG. Runner still strips Brave/Serper/Parallel/Firecrawl env keys.

On some networks (including many dev IPs), **keyless** providers return bot-challenge HTML → **`grounding: failed`** or thin web in Results. Exa avoids that path. Social sources (Reddit, HN, SC lanes) can still work either way.

**Not wired in Joshu yet:** `LAST30DAYS_SEARXNG_URL` (Settings UI + env). **Not the same as Perplexity:** adding Perplexity to `INCLUDE_SOURCES` enables a separate source; it does not replace Exa/`grounding`.

GUI research always uses **`emit=json`** / `jsonProfile=agent` for structured Results. Saved `research/last30days/*.md` applies **`--register`** (Writing style) for section order, cluster budget, and source emphasis — the engine itself ignores register on JSON emit.

## Deploy / image

Ships in `npm run build:deploy` → image includes `dist/last30days-app/` and `arozos/subservice/last30days/`. Desktop shortcut: `scripts/lib/arozos-desktop-shortcuts.sh`.

**ScrapeCreators (self-host):** owner pastes the key into the app Settings → `.joshu/last30days/config/.env`, or sets `SCRAPECREATORS_API_KEY` in instance env.

**Xquik (self-host):** paste `XQUIK_API_KEY` in Settings. Fleet: `JOSHU_XQUIK_MODE=relay` + `JOSHU_XQUIK_RELAY_URL` from CP; box engine needs `scripts/patch-last30days-xquik-relay.py`.

**Clustering / Results ordering:** Joshu patches `cluster.py` (lower similarity threshold for opinion/comparison). The GUI and saved brief sort cluster cards by **relevance** (engine `relevance_score`), then log-comparable native engagement. Items below a **0.45 relevance floor** are dropped when scores exist; event topics also drop other-city “Tech Week” hits (e.g. Colombia/Tokyo when the query is LA). Cards show per-source units (upvotes, views, points). Run history, Settings, watchlist DB, query plans, and watch snapshots live under the Aroz user `.joshu/last30days/` (persisted volume) — see `src/last30days/statePaths.ts` and `watchSnapshots.ts`. Engine `store.py` is patched (`patch-last30days-share-dir.py`) to honor `LAST30DAYS_SHARE_DIR`.

**Watching cron:** `joshu.app.json` `cron.jobs[]` is registered at Joshu boot via `syncAllAppManifestCronJobs` into Hermes (`~/.hermes/cron/jobs.json`). Scripts are written to `~/.hermes/scripts/` (`last30days-watchlist-run.sh` daily 08:00, `last30days-watchlist-weekly.sh` Mondays 08:00). They invoke `watchlistRunAll` with `cadence`. Not Linux crontab. See [`schedules-arozos-app.md`](schedules-arozos-app.md).

**Same as Hermes:** **OpenRouter** from `/etc/joshu/instance.env` or Welcome — planner/rerank; no host-shell Gemini/OpenAI inheritance. **Exa** from the same file (`EXA_API_KEY`) — web grounding; Hermes pins `web.backend: exa` and enables bundled plugin **`web-exa`** ([web search docs](https://hermes-agent.nousresearch.com/docs/user-guide/features/web-search)).

**Typical update bundle** (after `npm run build:deploy` locally or image pull):

- `dist/last30days/` (server routes + runner)
- Surgical **`server.js`** patch — add `registerLast30DaysRoutes` import + call (do **not** rsync a dev-built `server.js` over the whole host `dist/`)
- `dist/last30days-app/` → `arozos/subservice/last30days/app/` (built UI assets)
- `integrations/last30days-skill/` snapshot **baked into the image** (`vps:predeploy` runs `sync-last30days-skill.sh`). Compose does **not** bind-mount it — a gitignored empty host dir used to shadow the engine and 400 Research. A second copy lives at `/opt/joshu/.image/last30days-skill` as a fallback. If Research 400s `engine missing`, see [troubleshooting #19b3](vps-sandbox/troubleshooting-and-lessons.md).
- **`LAST30DAYS_PYTHON`** — engine requires **Python ≥ 3.12**. Image **0.1.39+** installs via `uv python install 3.12` at `/opt/joshu/.local/python312/bin/python3.12` (container `ENV`). Older boxes: set the same path in `/etc/joshu/instance.env` after manual uv install.
- Recreate `joshu-stack`; hard-refresh ArozOS desktop

**Smoke on box:**

```bash
bash scripts/last30days-app-smoke.sh
# optional live: LAST30DAYS_SMOKE_LIVE=1 with SCRAPECREATORS_API_KEY in .joshu/last30days/config/.env
curl -fsS https://<host>/joshu/api/last30days/status
```

**Verify reasoning:** `GET /joshu/api/last30days/status` → `config.reasoning.provider` should be `openrouter` when OpenRouter is configured. Settings → **Check connections** / preflight should show OpenRouter present, native search absent, `--web-backend=exa` when `EXA_API_KEY` is set (else `keyless`). Status `policy.web` and `policy.x` (`xquik` / `xquik-relay`) mirror that.

## Related

- Upstream skill: https://github.com/mvanhorn/last30days-skill
- App SDK: [`app-sdk.md`](app-sdk.md)
- Design tokens: [`design/README.md`](design/README.md)
