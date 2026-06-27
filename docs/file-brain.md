# Joshu File Brain (gbrain)

Joshu indexes the user's **ArozOS Desktop** tree with [gbrain](https://github.com/garrytan/gbrain) (PGLite + hybrid search). Structured markdown lives in **`joshu's files`**; everything on Desktop is indexed.

**File brain is always on** — same on local dev and DO/VPS sandboxes. There is no `JOSHU_GBRAIN_ENABLED` toggle. We do **not** fork gbrain; integration is scripts, env, Hermes MCP, and docs. Pin: [`deploy/RELEASE.json`](../deploy/RELEASE.json) → `gbrainRef`.

## Architecture

```text
┌─────────────────┐     retain/recall      ┌──────────────┐
│ Hermes + user   │ ─────────────────────► │  Hindsight   │  chat memory
└────────┬────────┘                        └──────────────┘
         │ MCP gbrain (HTTP → Joshu gbrain-mcp-http-server → gbrain serve)
         ▼
┌─────────────────┐  sync.repo_path        ┌──────────────────────────────┐
│     gbrain      │  (JOSHU_FILES_ROOT)    │ joshu's files/ (filesystem)  │
│ PGLite @ GBRAIN │ ◄── auto sync ──────── │  journals/, research/, …      │
└────────┬────────┘                        └──────────────────────────────┘
         │ federated source (search)
         ▼
┌──────────────────────────────┐
│ ArozOS Desktop (full tree)   │
└──────────────────────────────┘
         ▲
         │ Hermes write/edit (hermes-cli) under JOSHU_FILES_ROOT
```

| Layer | Role |
|-------|------|
| **Hindsight** | Conversation memory — preferences, "weren't we talking about X?" |
| **gbrain** | File index + hybrid search over Desktop |
| **ArozOS Desktop** | System of record for user-visible files |
| **`joshu's files`** | Opinionated subfolder for journals, research, inbox, uploads (filesystem is source of record) |

Chats are **not** exported to gbrain. Do not duplicate chat logs into markdown for search.

## Why `joshu's files` (lowercase)

gbrain **lowercases all page slugs** in `validateSlug()` (upstream behavior; not configurable without forking). A folder named `Joshu's Files` becomes slug prefix `joshu's files`, which mismatches on-disk casing and breaks sync/slug alignment.

**Convention:** use on-disk folder name **`joshu's files`** everywhere (defaults, `JOSHU_FILES_DIR_NAME`, Hermes slugs, templates). Apostrophes and spaces in slugs are fine; **case** must match after gbrain normalization.

### `.env` quoting

Repo root `.env` is **sourced by bash** (`dev-arozos.sh`, `start-gbrain.sh`). Values with apostrophes must be quoted:

```bash
JOSHU_FILES_DIR_NAME="joshu's files"
```

Unquoted `joshu's files` causes: `unexpected EOF while looking for matching '''`.

## Layout

```text
${AROZ_DATA}/files/users/<user>/Desktop/
├── joshu's files/             ← empty at bootstrap; agents create subpaths as needed
│   └── (user/agent content)
├── user folders and files …   ← also indexed (full Desktop source)
└── *.shortcut                 ← skipped where possible
```

Common subfolders agents may create: `inbox/`, `journals/`, `research/`, `research/kb/` (PDF knowledge base — see [Knowledge base (PDF drop)](#knowledge-base-pdf-drop)), `uploads/`, `connectors/` (path prefix drives gbrain page type after sync). Synced mail/calendar mirrors live under `connectors/` — see [Connector mail in gbrain](#connector-mail-and-calendar-gbrain) and [`docs/connectors.md`](connectors.md).

**Local dev example:**

```text
.local/arozos-data/files/users/<user>/Desktop/joshu's files/
```

**Never** use macOS `~/Desktop` for Joshu file writes. Hermes and gbrain env point at the ArozOS tree under `AROZ_DATA`.

## Path resolution

| Variable | Default | Role |
|----------|---------|------|
| `AROZ_DATA` | `.local/arozos-data` (local), `/var/lib/arozos` (VPS) | ArozOS data root |
| `JOSHU_FILES_DIR_NAME` | `joshu's files` | Opinionated subfolder name |
| `JOSHU_DESKTOP_ROOT` | *(resolved)* | `…/files/users/<user>/Desktop` |
| `JOSHU_FILES_ROOT` | *(resolved)* | `JOSHU_DESKTOP_ROOT/joshu's files` |
| `JOSHU_AROZ_USER` | *(required on VPS)* owner email from control plane | ArozOS username + which Desktop tree |
| `JOSHU_OWNER_EMAIL` | same as `JOSHU_AROZ_USER` on provisioned sandboxes | Ops reference (duplicate of login email) |
| `GBRAIN_SOURCE` | `default` | gbrain source id for pages under `sync.repo_path` |
| `GBRAIN_HOME` | `.local/gbrain` / `/root/.gbrain` | PGLite + config |
| `GBRAIN_BIN` | `gbrain` | CLI on PATH |
| `GBRAIN_SEARCH_MODE` | `balanced` | Search mode |
| `GBRAIN_SYNC_WATCH` | `false` | Background `sync --watch` (disabled; use MCP proxy reindex instead) |
| `GBRAIN_REINDEX_DEBOUNCE_MS` | `3000` | Debounce before `sync_brain` after fs changes under Desktop |
| `GBRAIN_REINDEX_INTERVAL_SEC` | `900` | Periodic `git add -A` on `files/users/` + `sync_brain` (MCP HTTP server); `0` = event-driven only |
| `GBRAIN_MCP_HTTP_URL` | `http://127.0.0.1:8794` | Joshu-supervised gbrain MCP HTTP + REST inspect (Hermes + File Brain) |
| `GBRAIN_MCP_HTTP_PORT` | `8794` | Listen port for gbrain MCP HTTP server |
| `JOSHU_HERMES_TERMINAL_CWD` | *(resolved)* | Override Hermes `terminal.cwd` (default: `JOSHU_DESKTOP_ROOT`) |
| `JOSHU_HERMES_WRITE_SAFE_ROOT` | *(resolved)* | Override `HERMES_WRITE_SAFE_ROOT` (default: `JOSHU_DESKTOP_ROOT`) |

Hermes gateway startup (`src/hermesApi.ts`) sets **`terminal.cwd`** and **`HERMES_WRITE_SAFE_ROOT`** to the resolved ArozOS Desktop tree so `write_file` / `patch` cannot land on macOS `~/Desktop` or elsewhere on the host. Reads and shell commands outside Desktop are still possible on the local backend; use Hermes Docker terminal backend for stronger isolation.

**Hermes `search_files`** (built into `hermes-cli`, not Joshu MCP) shells out to **ripgrep** (`rg`), with `find` as a slower fallback. Local dev: `brew install ripgrep` (checked by [`scripts/dev-arozos.sh`](../scripts/dev-arozos.sh)). VPS sandbox image: `ripgrep` in [`deploy/Dockerfile`](../deploy/Dockerfile) runtime packages. Prefer **gbrain MCP `query`** with `source_id: "__all__"` for file-brain questions; use `search_files` for raw disk greps when MCP returns nothing useful.

Resolution: [`src/joshuFilesPaths.ts`](../src/joshuFilesPaths.ts), [`scripts/lib/joshu-files-paths.sh`](../scripts/lib/joshu-files-paths.sh).

### Single-owner sandboxes (VPS)

Each customer box has **one** ArozOS account. The control plane stores **owner email** on the customer and writes `JOSHU_AROZ_USER=<email>` into `/etc/joshu/instance.env` at provision. The customer must complete ArozOS first-time signup with **that exact email** so the Desktop path matches gbrain/Hermes.

- Provision: **joshu-control-plane** admin UI **Owner email** field → `buildSandboxBootstrapEnv()`.
- Boot: [`scripts/bootstrap-joshu-files.sh`](../scripts/bootstrap-joshu-files.sh) creates an empty `joshu's files` folder for `JOSHU_AROZ_USER` only (no silent `admin` user on VPS).
- Rebind after owner change: [`scripts/rebind-gbrain-owner.sh`](../scripts/rebind-gbrain-owner.sh).

On VPS (`AROZ_DATA=/var/lib/arozos`), path resolution **fails** without `JOSHU_AROZ_USER` so instance health reports `gbrain.ok: false` instead of indexing the wrong user.

On boot, [`scripts/start-gbrain.sh`](../scripts/start-gbrain.sh) writes:

- `sync.repo_path` → **`JOSHU_FILES_ROOT`** (not Desktop — slugs like `journals/foo` map to `joshu's files/journals/foo.md`)
- `${GBRAIN_HOME}/joshu-files-paths.env` — cached paths for debugging

Joshu runs [`scripts/gbrain-mcp-http-server.mjs`](../scripts/gbrain-mcp-http-server.mjs) on **`GBRAIN_MCP_HTTP_PORT`** (default **8794**): one `gbrain serve` child holds PGLite; Hermes connects via Streamable HTTP MCP at `/mcp`; File Brain and Joshu `brainApi` use REST routes on the same port. Read-only tool filter + debounced `sync_brain` on filesystem changes under **`JOSHU_DESKTOP_ROOT`** (full Desktop, not only `joshu's files`).

### gbrain MCP HTTP (recommended integration)

```text
Hermes / File Brain / brainApi
        │
        ▼
http://127.0.0.1:8794
  ├── /mcp          Streamable HTTP MCP (Hermes toolsets: mcp-gbrain)
  └── /health, /list, /search, /query, /get, /doctor   REST inspect (File Brain viewer, brainApi)
        │
        ▼
gbrain-mcp-http-server.mjs  →  one gbrain serve (stdio NDJSON)  →  PGLite @ GBRAIN_HOME
```

| Endpoint | Consumer | Notes |
|----------|----------|--------|
| `GET /health` | Ops, boot scripts | `session_ready` when MCP initialize succeeded |
| `GET /list` | File Brain Browse | Uses `get_recent_salience` (all sources); not `list_pages` (default source only) |
| `GET /search?q=` | File Brain Search, `brainApi` | Implemented as hybrid **`query`** with `source_id=__all__` (see below) |
| `GET /query?q=` | File Brain Query, `brainApi` | Hybrid search + expansion; pass `limit`; defaults to `source_id=__all__` |
| `GET /get?slug=` | File Brain detail | Raw `get_page` MCP call |
| `POST` `/mcp` | Hermes | Proxies read-only tools to the same `gbrain serve` session |

**Deprecated:** loopback inspect on **`:8793`** and Hermes-spawned stdio [`gbrain-mcp-readonly-proxy.mjs`](../scripts/gbrain-mcp-readonly-proxy.mjs). Do not run a second `gbrain serve`.

**Docker / VPS:** [`deploy/scripts/vps-start.sh`](../deploy/scripts/vps-start.sh) runs `start-gbrain.sh` then `start-gbrain-mcp-http.sh` before Hermes. Health check: `curl -fsS http://127.0.0.1:8794/health`.

### Multi-source indexing (full Desktop)

Boot [`scripts/start-gbrain.sh`](../scripts/start-gbrain.sh):

1. **`sync.repo_path`** → `JOSHU_FILES_ROOT` (default source: journals, research, … under `joshu's files`).
2. **Federated source** per user Desktop: `gbrain sources add j-<slugified-user> --path <Desktop> --federated`.
3. **`sync --apply --all`** + **`embed --stale`** across registered sources.
4. **Git at `files/users/`** — [`scripts/lib/ensure-gbrain-git.sh`](../scripts/lib/ensure-gbrain-git.sh) initializes a repo + baseline commit at **`${AROZ_DATA}/files/users/`** (gbrain sync requires committed user data). Before each debounced `sync_brain`, [`scripts/lib/gbrain-desktop-git.mjs`](../scripts/lib/gbrain-desktop-git.mjs) runs **`git add -A`** there (covers all user Desktops, `joshu's files`, connectors, `.joshu/` metadata). **Never** the joshu app repo root — local dev data stays under `.local/` (gitignored). Optional override: `JOSHU_GBRAIN_GIT_ROOT`.

Pages outside `joshu's files` (e.g. `Desktop/Investors/foo.md`) appear with slugs like `investors/foo` and `source_id` `j-<user-slug>` (not `default`).

### Search vs query (important)

| Tool / route | Scope | Use for |
|--------------|--------|---------|
| MCP **`search`** | Default source only; FTS keyword | Narrow keyword scan inside `joshu's files` sync root |
| MCP **`query`** with **`source_id: "__all__"`** | All registered sources | Desktop-wide file brain questions (Hermes, recommended) |
| REST **`/search`**, **`/query`** on `:8794` | `__all__` unless `source_id` query param set | File Brain viewer + Joshu `brainApi` |
| `GET /joshu/api/brain/search` | Same as REST (via [`brainApi.ts`](../src/brainApi.ts)) | Voice-adjacent clients, automation |

**Hermes** calls MCP tools directly on `/mcp` (not the REST shim). If the model chooses MCP **`search`** alone, results may be empty or journal-only even when Browse lists federated Desktop pages. Prefer **`query`** with `source_id: "__all__"` and an explicit **`limit`** (e.g. 10–20). Skill: [`integrations/hermes/skills/brain/joshu-brain/`](../integrations/hermes/skills/brain/joshu-brain/SKILL.md).

**Recency filters:** `query` accepts `since` / `until` as ISO dates or relative durations (`7d`, `90d`, `2w`). The Joshu MCP bridge ([`scripts/lib/gbrain-query-args.mjs`](../scripts/lib/gbrain-query-args.mjs)) converts relative values to ISO-8601 before calling gbrain — upstream MCP may otherwise pass `90d` literally to PostgreSQL and fail.

**Mail vs Composio:** Hermes toolsets are ordered so **gbrain** and **mcp-joshu-connectors** precede **mcp-composio**; EA skills say to use gbrain/connectors first for mail recall, Composio as fallback. See [Connector mail in gbrain](#connector-mail-and-calendar-gbrain).

**Known limitation:** `get_page` for some federated slugs may return `page_not_found` while **`query`** / REST **`/search`** still return `chunk_text` for the same slug. Use the search hit snippet or read the file from disk under `JOSHU_DESKTOP_ROOT` until `get_page` is fixed upstream or Joshu adds a filesystem fallback.

While MCP HTTP is running, **gbrain CLI** commands that open PGLite directly may block or time out (~30s). Use REST/MCP on `:8794` or stop the HTTP server before CLI debugging.

## Writing files

### Filesystem only (Hermes tools)

**Agents do not use gbrain `put_page` or other gbrain write MCP tools.** Write and edit markdown with Hermes filesystem tools at absolute paths under `JOSHU_FILES_ROOT`:

```text
${JOSHU_FILES_ROOT}/journals/2026-05-24-slug.md
```

- **Path is identity** — folder prefix (`journals/`, `research/`, …) drives gbrain page type after sync; optional YAML frontmatter (`type`, `date`) is for humans but **path wins** for classification.
- Use **`.md`** for journals, research, and inbox (default sync imports `.md`/`.mdx` only). **PDFs** are not synced directly — drop them in `research/kb/inbox/` for automatic text extraction (see [Knowledge base (PDF drop)](#knowledge-base-pdf-drop)).
- **Do not** write to macOS `~/Desktop` or `Desktop/journals/` at the ArozOS Desktop root.
- **Do not** prefix paths with `joshu's files/` when the path is already inside that folder.

### Automatic indexing

After a filesystem write under `JOSHU_FILES_ROOT`, the gbrain MCP HTTP server runs **`sync_brain`** (debounced, default ~3s) in its supervised `gbrain serve` process. No agent action required.

**Periodic reindex:** While the MCP HTTP server runs, it also reindexes every **`GBRAIN_REINDEX_INTERVAL_SEC`** (default **900** = 15 minutes): `git add -A` on `files/users/`, commit if changed, `sync_brain`. Set `GBRAIN_REINDEX_INTERVAL_SEC=0` to disable the timer (fs watch + manual reindex only). On MCP startup, a catch-up reindex runs ~8s after boot.

**Connector mail mirrors:** Joshu-native cron (`JOSHU_CONNECTORS_CRON`, default on) polls **Nylas and Gmail every 10m** via `src/connectors/scheduler.ts`. Each run writes markdown and touches the reindex file. See [`docs/connectors.md`](connectors.md).

### Knowledge base (PDF drop)

Drop **text PDFs** in:

```text
${JOSHU_FILES_ROOT}/research/kb/inbox/
```

Joshu extracts plain text (no LLM), writes searchable markdown under `research/kb/<slug>.md`, archives the original in `research/kb/.raw/`, and triggers the normal gbrain reindex. Bootstrap seeds `research/kb/inbox/DROP_PDFS_HERE.md` as a user hint.

| Path | Role |
|------|------|
| `research/kb/inbox/` | Drop folder — PDFs only |
| `research/kb/*.md` | Extracted, indexed pages (gbrain type **`research`**) |
| `research/kb/.raw/` | Archived originals (not indexed) |

**Flow:** fs watch on inbox (~2.5s debounce) + 120s poll → [`scripts/ingest-pdf-kb.py`](../scripts/ingest-pdf-kb.py) via [`scripts/lib/kb-pdf-ingest.mjs`](../scripts/lib/kb-pdf-ingest.mjs) (started from [`scripts/gbrain-mcp-http-server.mjs`](../scripts/gbrain-mcp-http-server.mjs)) → markdown write → existing `.md` reindex.

**Extraction:** `pdftotext` (poppler) when available, else Python `pypdf`. VPS image includes both (`deploy/Dockerfile`). Local dev: `brew install poppler` and/or `pip install pypdf`.

**Manual one-shot:** `npm run kb:ingest-pdf` or `bash scripts/ingest-pdf-kb.sh`.

**Limits:** text-based PDFs only today (no OCR for scanned/image PDFs). Everything under `research/` shares the same gbrain page type — use slug path `research/kb/…` in queries to bias toward the knowledge base.

**Dedup:** Re-dropping the same PDF (matching `pdf_sha256` in frontmatter) is skipped; the inbox copy is removed without re-extracting.

### Indexing cadence (summary)

| Trigger | What runs | Default interval |
|---------|-----------|------------------|
| `.md` change under Desktop | fs watch → debounced git commit + `sync_brain` | ~3s debounce |
| PDF drop in `research/kb/inbox/` | extract → write `research/kb/*.md` → reindex | ~2.5s debounce + ingest |
| MCP HTTP timer | `git add -A` on `files/users/` + `sync_brain` | **`GBRAIN_REINDEX_INTERVAL_SEC`** = 900s (15m); `0` = off |
| MCP HTTP startup | Catch-up reindex | ~8s after boot |
| VPS boot (`vps-start.sh`) | `ensure-gbrain-indexed.sh --soft` | ~45s after stack start |
| VPS boot (`vps-start.sh`) | `ensure-gbrain-indexed.sh` (soft → full if still empty) | ~3m after stack start |
| VPS empty-index watchdog | `ensure-gbrain-indexed.sh --check-only` → auto recover | **`GBRAIN_EMPTY_INDEX_WATCHDOG_SEC`** = 300s |
| Connector cron | Mirror fetch → write `.md` → reindex touch | Nylas + Gmail **10m** |
| Boot (`start-gbrain.sh`) | One-shot `sync --apply --all` + schema | Once per stack start (**skipped when `GBRAIN_BOOT_QUICK=true`** — VPS default) |
| Manual | `POST /joshu/api/brain/reindex` | On demand |

Implementation: [`scripts/lib/gbrain-desktop-git.mjs`](../scripts/lib/gbrain-desktop-git.mjs), [`scripts/lib/gbrain-mcp-bridge.mjs`](../scripts/lib/gbrain-mcp-bridge.mjs), [`scripts/lib/kb-pdf-ingest.mjs`](../scripts/lib/kb-pdf-ingest.mjs), [`scripts/ingest-pdf-kb.py`](../scripts/ingest-pdf-kb.py), [`scripts/ensure-gbrain-indexed.sh`](../scripts/ensure-gbrain-indexed.sh), [`scripts/lib/gbrain-index-health.mjs`](../scripts/lib/gbrain-index-health.mjs), [`src/connectors/scheduler.ts`](../src/connectors/scheduler.ts).

**VPS auto-recovery:** `deploy/scripts/vps-start.sh` runs `scripts/ensure-gbrain-indexed.sh` at **45s** (soft reindex) and **3m** (auto: soft then full sync if still empty). A **5m watchdog** (`GBRAIN_EMPTY_INDEX_WATCHDOG_SEC`, default 300) re-checks disk vs index; the MCP bridge also flags `${GBRAIN_HOME}/.joshu-gbrain-needs-full-sync` after repeated empty syncs. Full sync uses `GBRAIN_BOOT_QUICK=false` (cooldown `GBRAIN_FULL_SYNC_COOLDOWN_SEC`, default 30m).

**VPS quick boot gap:** `deploy/scripts/vps-start.sh` sets `GBRAIN_BOOT_QUICK=true` by default so ArozOS listens before a full embed. On restart, File Brain can show **0 pages** until MCP background reindex or `ensure-gbrain-indexed.sh` succeeds — even when connector mirrors already exist on disk. Do not rely on `/joshu/api/instance/health` `gbrain.ok` alone; check **`gbrain.indexed_ok`** and **`page_count`**. See [Health vs indexed pages](#health-vs-indexed-pages-vps) and [troubleshooting incident](../vps-sandbox/troubleshooting-and-lessons.md#validated-incident-file-brain-zero-pages-2026-06-patrickboxjoshume).

### Deprecated: gbrain `put_page`

Not exposed to Hermes agents. Avoid dual-write (MCP + disk); it can diverge from the filesystem source of record.

### What agents should read first

1. Env: `JOSHU_FILES_ROOT`
2. **`FILING.md`** at `${JOSHU_FILES_ROOT}` (seeded from [`templates/ea/FILING.md`](../templates/ea/FILING.md) on factory boot / EA bootstrap)

Skill: [`integrations/hermes/skills/brain/joshu-brain/`](../integrations/hermes/skills/brain/joshu-brain/SKILL.md)

## Boot sequence

**Local:** `npm run dev:arozos` → `gbrain:install` + `start-gbrain.sh` + `start-gbrain-mcp-http.sh` + Joshu + Hermes gateway.

**VPS:** `bootstrap-joshu-files.sh` → `start-gbrain.sh` in container entry; PGLite volume `joshu_gbrain` → `/root/.gbrain`.

`start-gbrain.sh` (order matters):

1. `stop-gbrain.sh` — kill stale workers / MCP HTTP / free PGLite lock
2. `bootstrap-joshu-files.sh` — mkdir empty `joshu's files`
3. Repair PGLite config if `DATABASE_URL` leaked Postgres into `config.json`
4. `gbrain config set sync.repo_path` to `JOSHU_FILES_ROOT`
5. Register per-user Desktop sources (`j-<slugified-user>`, max 32 chars)
6. `sync --apply` + `embed --stale` (one-shot) — **skipped when `GBRAIN_BOOT_QUICK=true`** (VPS default; see `vps-start.sh`)
7. Optional `sync --watch` only if `GBRAIN_SYNC_WATCH=true`
8. `setup-gbrain-schema.sh` — journal, research, inbox, upload, **connector-mail**, **connector-calendar** types
9. `start-gbrain-mcp-http.sh` — one `gbrain serve` + HTTP MCP on `:8794` (periodic + fs-watch reindex + **KB PDF ingest**); on PGLite open failure runs [`scripts/repair-gbrain-pglite.sh`](../scripts/repair-gbrain-pglite.sh) when `GBRAIN_REPAIR_PGLITE=1` (also manual: backup + rebuild `brain.pglite` — [gbrain #223](https://github.com/garrytan/gbrain/issues/223))

Hermes connects via MCP URL: `http://127.0.0.1:8794/mcp`, toolset `mcp-gbrain`.

**MCP bridge logging:** default logs are quiet (`sync_brain completed` only with `GBRAIN_MCP_VERBOSE=1`). `gbrain serve` respawns on exit instead of killing the HTTP server (host bind-mount `scripts/lib/gbrain-mcp-bridge.mjs`).

### PGLite single-holder

PGLite allows **one** DB holder. Joshu runs **one** supervised `gbrain serve` via `gbrain-mcp-http-server.mjs`. Running **`sync --watch` at the same time** causes lock timeouts.

**Default:** `GBRAIN_SYNC_WATCH=false`. Boot runs one `sync --apply`; ongoing indexing uses MCP HTTP **fs watch**, **periodic reindex** (`GBRAIN_REINDEX_INTERVAL_SEC`), and connector cron mirror writes.

If you enable watch for experiments, stop it before debugging Hermes: `bash scripts/stop-gbrain.sh`.

### Health vs indexed pages (VPS)

| Signal | What it checks | Trust for “File Brain has files”? |
|--------|----------------|-----------------------------------|
| `GET /joshu/api/instance/health` → `components.gbrain.ok` | MCP session / `gbrain doctor` CLI (~15s) | **Partial** — process up, not page count |
| `GET /joshu/api/instance/health` → `components.gbrain.indexed_ok` | Compares disk `.md` count vs MCP page list | **Yes** — false when mirrors exist but index is empty |
| `GET http://127.0.0.1:8794/health` → `session_ready` + `page_count` | MCP initialize + salience sample | **Yes** for quick smoke |
| `GET /joshu/api/brain/pages` (Bearer when `JOSHU_READ_API_KEY` set) | MCP `get_recent_salience` via `:8794` | **Yes** — same as File Brain Browse |
| `GET http://127.0.0.1:8794/list?limit=5` | Same as Browse | **Yes** — use inside container |

**VPS smoke (inside `joshu-stack`):**

```bash
curl -fsS http://127.0.0.1:8788/joshu/api/instance/health | jq '.components.gbrain'
curl -fsS http://127.0.0.1:8794/health | jq '.session_ready,.page_count'
curl -fsS 'http://127.0.0.1:8794/list?limit=5' | jq '.raw' | head -c 400
tail -40 /root/.gbrain/gbrain-mcp-http.log
bash /opt/joshu/scripts/ensure-gbrain-indexed.sh --check-only && echo "index OK" || bash /opt/joshu/scripts/ensure-gbrain-indexed.sh
```

### `DATABASE_URL` trap

If `DATABASE_URL` is set in the shell, gbrain may treat the brain as **Postgres** and overwrite a PGLite `config.json`. All Joshu gbrain scripts **`unset DATABASE_URL`** before invoking the CLI. Do not export Postgres URLs in the same shell as local file-brain dev.

## Pin and install

| Environment | Install |
|-------------|---------|
| VPS image | `deploy/Dockerfile` — `github:garrytan/gbrain#${GBRAIN_REF}` via Bun |
| Local | `npm run gbrain:install` → [`scripts/install-gbrain.sh`](../scripts/install-gbrain.sh) |

Bump: edit `gbrainRef` in `deploy/RELEASE.json`, reinstall locally, rebuild sandbox image.

Embeddings reuse Hindsight keys: `HINDSIGHT_API_EMBEDDINGS_*` (required for init/sync).

## Schema pack

[`scripts/setup-gbrain-schema.sh`](../scripts/setup-gbrain-schema.sh) registers page types with prefixes under `joshu's files/`:

| Type | Slug prefix (under `JOSHU_FILES_ROOT`) | gbrain flags |
|------|------------------------------------------|--------------|
| journal | `journals/` | temporal, extractable |
| research | `research/` | annotation, extractable |
| inbox | `inbox/` | annotation |
| upload | `uploads/` | annotation |
| **connector-mail** | `connectors/mail/` | annotation, **extractable** |
| **connector-calendar** | `connectors/calendar/` | annotation, extractable |

**Path wins** over YAML frontmatter `type:`. Connector mirror frontmatter uses connector fields (`source`, `from`, `subject`, `date`, `thread_id`, …) — classification comes from the folder prefix, not a `type: connector-mail` line.

Idempotent: skips types already in `gbrain schema stats`. After renaming the folder from `Joshu's Files`, re-run setup or remove stale pack under `${GBRAIN_HOME}/.gbrain/schema-packs/joshu/` if prefixes no longer match.

## Connector mail and calendar (gbrain)

Synced connector markdown is **first-class gbrain content**, not a separate mail search engine.

### Classification

Files under `joshu's files/connectors/mail/` get gbrain page type **`connector-mail`**. Calendar events under `connectors/calendar/` get **`connector-calendar`**. Quick-capture mail notes in `inbox/` are type **`inbox`** — different from synced Gmail/Nylas threads.

After Desktop git sync, indexed slugs typically look like:

```text
joshus-files/connectors/mail/gmail/{account_key}/threads/<thread_id>
joshus-files/connectors/mail/nylas/threads/<thread_id>
```

(`joshus-files/` is the federated slug for the `joshu's files` folder on Desktop; `source_id` is `j-<user-slug>`, not `default`.)

List mail pages: `GET /joshu/api/brain/pages?type=connector-mail&limit=20`.

### What gets searched

Each thread mirror is one markdown file. Searchable body text includes **from**, **subject**, and **message bodies** (one `###` section per message in the thread). Example shape:

```markdown
---
source: composio:gmail
from: Alice <alice@example.com>
subject: Launching Joshu
date: 2026-06-02T18:30:00.000Z
thread_id: …
message_ids: [msg_1, msg_2]
message_count: 2
connected_account_id: ca_…
account_email: alice@example.com
account_key: alice_example_com
---

### Jun 2, 2026, 10:30 AM — Alice <alice@…>

**Subject:** Launching Joshu

<plain text body>

---

### Jun 3, 2026, 9:15 AM — Bob <bob@…>

**Subject:** Re: Launching Joshu

<latest reply — frontmatter date/from/subject reflect this message>
```

gbrain **`query`** uses **hybrid search** (embeddings + FTS) over extracted **`chunk_text`** — the same mechanism as journals and research. There is no dedicated “email-only” query mode in MCP today; Hermes skills use natural-language **`query`** with **`source_id: "__all__"`**, **`limit: 10–20`**, and **`recency: "on"`** + **`since: "90d"`** for mail recall.

**Recency:** mirror frontmatter includes `date:` (latest message). gbrain uses this for `since` / `until` filters when recency is enabled.

**Body extraction:** Gmail/Composio have no plaintext-only API. Joshu prefers MIME `text/plain`, then simplifies HTML ([`src/connectors/emailPlaintext.ts`](../src/connectors/emailPlaintext.ts)). See [`docs/connectors.md`](connectors.md).

### Git-aware sync (required)

gbrain `sync_brain` at **`JOSHU_DESKTOP_ROOT`** only indexes **git-committed** markdown. The MCP bridge runs **`git add -A`** on **`${AROZ_DATA}/files/users/`** before each reindex — no manual git steps. Uncommitted connector files will not appear in search until the next reindex pipeline runs.

### Hermes mail recall order

Skills (not gbrain types) define tool order:

1. **`mcp_gbrain_query`** — find mail in indexed mirrors
2. **`mcp_joshu_connectors_connectors_sync_now`** — refresh mirrors if empty/stale, then query again
3. **Composio Gmail** — live API fallback only

Docs: [`integrations/hermes/skills/executive-assistant/ea-playbook/`](../integrations/hermes/skills/executive-assistant/ea-playbook/), [`integrations/hermes/skills/brain/joshu-brain/`](../integrations/hermes/skills/brain/joshu-brain/SKILL.md).

### EA linking (projects ↔ connectors ↔ plans)

Joshu EA uses **filesystem markdown + links**, not gbrain `put_page`. When agents file mail or capture to `Projects/`, they should write **`joshu://`** or relative paths to `connectors/mail/…` in `todo.md` / journals so:

- Humans click links from time-block diagrams (`ea-time-block`)
- Agents use **`get_backlinks`** / **`traverse_graph`** (read-only MCP) after sync

Conventions: [`file-brain.md`](file-brain.md).

Optional (ops): `gbrain config set link_resolution.global_basename true` — resolves Obsidian-style `[[note-name]]` across folders after sync. Not required if paths are explicit.

## Joshu API

- `GET /joshu/api/brain/health`
- `GET /joshu/api/brain/status` — doctor JSON, paths, schema stats
- `GET /joshu/api/brain/pages?limit=&type=&sort=` — list indexed pages
- `GET /joshu/api/brain/pages/:slug` — full page content
- `GET /joshu/api/brain/search?q=...&limit=10`
- `GET /joshu/api/brain/query?q=...`
- `POST /joshu/api/brain/reindex` — touch debounced reindex (filesystem-first)

Desktop app: **File Brain** (`apps/file-brain-viewer`) — browse, search, and query the gbrain index from ArozOS.

When the gbrain MCP HTTP server is running, File Brain and `brainApi` use REST on **`GBRAIN_MCP_HTTP_URL`** (default `http://127.0.0.1:8794`) — same PGLite holder, no parallel CLI. When the HTTP server is not running, routes fall back to `gbrain` CLI directly (may fail if PGLite is locked).

After viewer or API changes, rebuild and refresh the ArozOS bundle:

```bash
npm run build:file-brain-viewer
# dev-arozos copies dist → .local/arozos-data/subservice/file-brain-viewer/app/
```

Implementation: [`src/brainApi.ts`](../src/brainApi.ts), [`src/gbrainMcpInspect.ts`](../src/gbrainMcpInspect.ts), [`scripts/lib/gbrain-mcp-rest.mjs`](../scripts/lib/gbrain-mcp-rest.mjs). Instance health includes `components.gbrain.ok`, **`indexed_ok`**, **`page_count`**, and **`disk_markdown`** when MCP HTTP is up.

## Local dev

```bash
npm run gbrain:install   # once, or when gbrainRef changes
npm run dev:arozos       # install + start-gbrain + stack
```

Manual start:

```bash
export APP_DIR="$(pwd)"
export AROZ_DATA=".local/arozos-data"
export GBRAIN_HOME=".local/gbrain"
# HINDSIGHT_API_EMBEDDINGS_* required in .env
bash scripts/start-gbrain.sh
bash scripts/start-gbrain-mcp-http.sh
```

See also [`docs/local-installation.md`](local-installation.md#file-brain-gbrain).

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|----------------|-----|
| `.env: unexpected EOF … matching '''` | Unquoted `JOSHU_FILES_DIR_NAME` | Use `JOSHU_FILES_DIR_NAME="joshu's files"` |
| Files appear on macOS `~/Desktop` | Agent used host path, not ArozOS | Set `JOSHU_FILES_ROOT`; read `LOCATION.md`; use skill |
| File wrote to `Desktop/journals/` not `joshu's files/` | Agent used wrong base path | Write under `JOSHU_FILES_ROOT`; read `LOCATION.md` |
| PGLite lock / timeout | Stale `gbrain serve` + `sync --watch` | `bash scripts/stop-gbrain.sh`; keep `GBRAIN_SYNC_WATCH=false` |
| gbrain doctor fails after Hindsight/Postgres work | `DATABASE_URL` corrupted config | `start-gbrain.sh` repair block; or delete config and re-init |
| `dev:arozos` gbrain exit early | Missing embeddings or `gbrain` not on PATH | Keys in `.env`; `npm run gbrain:install` |
| Search empty after filesystem write | Reindex not run yet or MCP HTTP off | Wait ~3s; `POST /joshu/api/brain/reindex`; check `curl http://127.0.0.1:8794/health` |
| PDF in `research/kb/inbox/` not indexed | MCP HTTP not running, or missing `pdftotext`/`pypdf` | Restart `start-gbrain-mcp-http.sh`; `npm run kb:ingest-pdf`; install poppler or `pip install pypdf`; check `${GBRAIN_HOME}/gbrain-mcp-http.log` for `[kb-pdf-ingest]` |
| PDF ingest error “extracted text too short” | Scanned/image PDF (no selectable text) | Re-OCR externally or transcribe manually to `research/kb/<slug>.md` |
| Connector mail on disk but gbrain empty | Local dev: gbrain git ran in joshu app repo instead of `.local/arozos-data/files/users/` | Ensure nested git at `files/users/`; `node scripts/lib/run-stage-desktop-git.mjs "$JOSHU_DESKTOP_ROOT"` then `POST /joshu/api/brain/reindex`; remove stray `Desktop/.git` |
| New Desktop folders not in gbrain | Git commit not run before sync | Automatic via MCP bridge (`git add -A` on `files/users/` before `sync_brain`); nudge with reindex or restart `start-gbrain-mcp-http.sh` |
| `gbrain desktop index` commits on `main` | Old bug: `git add -A` from Desktop cwd touched joshu root | Fix in `gbrain-desktop-git.mjs`; reword or drop mistaken commits before push |
| Mail query returns workspace not threads | Query too broad or mirrors stale | Use mail keywords + `since: 90d`; run connector sync; check `pages?type=connector-mail` |
| Browse shows Desktop files; Search/Query empty | Hermes or client used MCP **`search`** (default source only) | Use **`query`** with `source_id: "__all__"` + `limit`; or REST `/search` on `:8794` / Joshu `brainApi` |
| Search hit but Inspect “page not found” | Federated slug + `get_page` on default context | Read `chunk_text` from query hit; open file under `JOSHU_DESKTOP_ROOT`; slug is lowercase (`investors/…` vs `Investors/`) |
| File Brain stale after code changes | Old `dist/file-brain-viewer` in ArozOS data | `npm run build:file-brain-viewer`; restart `dev:arozos`; hard refresh browser |
| `gbrain MCP HTTP failed` on VPS boot | Script not executable or port in use | Image includes `start-gbrain-mcp-http.sh`; `bash scripts/stop-gbrain.sh` then restart stack |
| Two Desktop folders (`Joshu's Files` + `joshu's files`) | macOS case-insensitive FS | Two-step rename: `mv "Joshu's Files" tmp && mv tmp "joshu's files"` |
| VPS: `/usr/bin/env: bun: No such file` on boot | Stale `vps-start.sh` on host; Bun not on PATH before gbrain | `git pull` in `/opt/joshu`; image `0.1.7+`; see [troubleshooting](vps-sandbox/troubleshooting-and-lessons.md#host-clone-vs-image-critical) |
| VPS: files under `admin` | `JOSHU_AROZ_USER` ≠ login email | Owner email at provision; `rebind-gbrain-owner.sh` |
| `instance/health` `gbrain.ok: false` | 15s doctor timeout during boot | Wait; `gbrain doctor --fast` in container |
| **502** on `/joshu/api/brain/pages` after hard reset | `GBRAIN_HOME` wiped while MCP HTTP still held stale PGLite; or **`EBUSY`** if pre-0.1.14 tried to delete volume mount root | Image **0.1.14+** stops gbrain and wipes volume contents; or `stop-gbrain.sh` + `start-gbrain.sh` + `start-gbrain-mcp-http.sh`; restart stack |
| File Brain list error `rows.slice is not a function` | MCP `/list` got error JSON instead of array (corrupt/missing brain) | Same as above — re-init gbrain at `GBRAIN_HOME` |
| Mail mirrors return after “reset” | Composio OAuth still connected in cloud; cron re-synced | Use **hard** factory reset (disconnects Composio) — [`box-state.md`](box-state.md#hard-factory-reset) |
| **`gbrain.ok: true` but Browse shows 0 pages** | Quick boot skipped initial sync; `sync_brain` failed; or embedding key not mapped for MCP | Check `gbrain.indexed_ok`; tail `gbrain-mcp-http.log`; `bash scripts/ensure-gbrain-indexed.sh`; see [VPS incident](../vps-sandbox/troubleshooting-and-lessons.md#validated-incident-file-brain-zero-pages-2026-06-patrickboxjoshume) |
| Connectors show mail on disk; brain `page_count: 0` | Git stage / Desktop `.git` / silent `sync_brain` / missing **`GOOGLE_GENERATIVE_AI_API_KEY`** on MCP boot | Verify `files/users/.git` and `Desktop/.git`; `git pull` on host `/opt/joshu`; `GBRAIN_MCP_VERBOSE=1`; `bash scripts/ensure-gbrain-indexed.sh` |
| Sync log: `Google embedding requires GOOGLE_GENERATIVE_AI_API_KEY` | `HINDSIGHT_API_EMBEDDINGS_GEMINI_API_KEY` set in `instance.env` but not exported to gbrain MCP child | Image/script **0568cee+** maps Gemini key in `start-gbrain-mcp-http.sh`; restart MCP HTTP or run `ensure-gbrain-indexed.sh --full` |
| `/brain/pages` **502** after reindex | MCP `get_recent_salience` timed out (~30s) during heavy `sync_brain` | Retry; check MCP log for `sync_brain failed`; ensure single PGLite holder (no second `start-gbrain.sh`) |

**Logs:** `${GBRAIN_HOME}/gbrain-sync.log`, `${GBRAIN_HOME}/gbrain-mcp-http.log`, `${GBRAIN_HOME}/gbrain-full-boot.log` (VPS boot ensure-indexed), `${GBRAIN_HOME}/gbrain-ensure-indexed.log` (watchdog + manual recovery)

### VPS tuning (optional)

| Env | Default | Role |
|-----|---------|------|
| `GBRAIN_EMPTY_INDEX_WATCHDOG_SEC` | 300 | Empty-index poll interval in `vps-start.sh` |
| `GBRAIN_FULL_SYNC_COOLDOWN_SEC` | 1800 | Min seconds between `ensure-gbrain-indexed.sh` full syncs |
| `GBRAIN_ENSURE_SOFT_WAIT_SEC` | 45 | Wait after soft reindex before escalating to full sync |
| `GBRAIN_EMPTY_INDEX_CHECK_SEC` | 300 | MCP bridge empty-index watchdog interval |
| `GBRAIN_SYNC_RETRY_MAX` | 3 | MCP bridge `sync_brain` retries before flagging full sync |

**Stale source registration:** delete `${GBRAIN_HOME}/registered-sources.env` if `AROZ_DATA` moved.

## macOS rename note

APFS is often **case-insensitive**. Renaming `Joshu's Files` → `joshu's files` in one step may no-op. Use an intermediate name:

```bash
mv "Joshu's Files" joshu-files-tmp-rename
mv joshu-files-tmp-rename "joshu's files"
```

## HTTP read API (read lane)

Joshu exposes **read-only** brain routes on port **8788** (proxied when embedded in ArozOS). Prefer the gbrain MCP HTTP server on **8794** when debugging brain issues directly.

| Route | Role |
|-------|------|
| `GET /joshu/api/brain/search?q=` | Desktop-wide hybrid search (MCP `query`, `source_id=__all__`, via `:8794` when MCP HTTP is up) |
| `GET /joshu/api/brain/query?q=` | Hybrid Q&A (`source_id=__all__`, `limit=20`) |
| `GET /joshu/api/read/brain/*` | Same handlers (alias) |

When `JOSHU_READ_API_KEY` is set (VPS: same value as `HERMES_API_KEY` from control plane), pass `Authorization: Bearer <key>`. **File writes** use Hermes filesystem tools only; gbrain MCP is read-only for agents.

**Phone voice (`realtime_s2s`) does not use this API.** It routes all personal reads through Hermes → gbrain MCP via `ask_joshu`, avoiding PGLite lock contention with `gbrain serve`. See [vps-sandbox/voice-realtime.md](vps-sandbox/voice-realtime.md).

## Related

- [connectors.md](connectors.md) — mail/calendar mirrors, cron, body extraction, gbrain slugs, hard reset
- [box-state.md](box-state.md#hard-factory-reset) — personal wipe including Composio + gbrain reinit
- [vps-sandbox/voice-realtime.md](vps-sandbox/voice-realtime.md) — speech-to-speech phone voice
- [local-installation.md](local-installation.md)
- [vps-sandbox/troubleshooting-and-lessons.md](vps-sandbox/troubleshooting-and-lessons.md) — file-brain row in ops table
- [vps-sandbox/modal-to-vps-mapping.md](vps-sandbox/modal-to-vps-mapping.md)
- EA filing templates: [`templates/ea/`](../templates/ea/)
