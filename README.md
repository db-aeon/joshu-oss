# Joshu (private fleet monorepo)

**Internal box stack + proprietary layer.** Public engine: [joshu-oss](https://github.com/db-aeon/joshu-oss).
Control plane: [joshu-control-plane](https://github.com/db-aeon/joshu-control-plane) (`hello.joshu.me`).
Brand pack: [joshu-design](https://github.com/db-aeon/joshu-design) (JDL).

| Repo | Role |
|------|------|
| **joshu** (this repo, private) | Fleet dev, engine changes, **`proprietary/`** paid/fleet-only apps |
| **joshu-oss** (public) | Community self-host snapshot — no CP, no proprietary apps, Vanilla theme |
| **joshu-control-plane** (private) | Portal, provisioning, admin |
| **joshu-design** (private) | Paper-shell, icons, design-system |

| | |
|--|--|
| **Engine license** | [AGPL-3.0 OR Commercial](LICENSE) — [COMMERCIAL_LICENSE.md](COMMERCIAL_LICENSE.md) notice; contact info@joshu.me |
| **Self-host (public)** | [joshu-oss](https://github.com/db-aeon/joshu-oss) · [docs/self-host.md](docs/self-host.md) |
| **Proprietary apps** | [`proprietary/README.md`](proprietary/README.md) |
| **Managed hosting** | [joshu.me](https://joshu.me) |

Joshu is a local-first app workspace packaged as a VPS sandbox Docker image for
always-on deployments. It ships ArozOS desktop apps for jWeb (HITL browser), jChat, jMail,
Connectors, Memory, File Brain, jWhiteboard, Schedules, Welcome, and jMovie.

The HITL browser is one Joshu app, not the whole repo. It owns one Camofox tab,
mirrors it through noVNC, and sends each prompt to Hermes through the gateway
`/v1/responses` API with a fresh accessibility snapshot of the shared tab.
jChat, jMail, Memory, jWhiteboard, and jMovie are packaged as separate
ArozOS apps alongside it.

Some existing technical identifiers still include `hitl` or `camofox`
(`joshu-hitl`, `joshu-hitl-secrets`, `HITL_CAMOFOX_*`) because they describe the
current browser integration and deployed resources. Joshu now also sets Hermes's
generic `CAMOFOX_*` controls when starting the gateway so newer Hermes builds can
adopt the visible browser tab without the legacy local patch.

## Apps

ArozOS desktop labels (May 2026) — full table in [`docs/arozos-desktop-shortcuts.md`](docs/arozos-desktop-shortcuts.md) and [`docs/README.md`](docs/README.md):

- **jWeb**: human-in-the-loop browser (Camofox + noVNC + Hermes on one shared tab).
- **jChat**: Hermes chat stream via Joshu (`/joshu/api/hermes-chat/*`); optional Realtime voice.
- **jMail**: Nylas agent inbox + one tab per Composio Gmail account.
- **Connectors**: Composio OAuth, multi-Gmail, sync health (shared by jMail, jChat, Hermes, cron).
- **Memory**: Hindsight constellation / entity graphs (`/joshu/api/hindsight/*`).
- **File Brain**: browse and query the gbrain index.
- **jWhiteboard**: Excalidraw (`@excalidraw/excalidraw`).
- **Schedules**: Hermes cron job UI.
- **Welcome**: Day-1 executive-assistant onboarding wizard.
- **jMovie**: Creatomate video editor — [`docs/jmovie-arozos-app.md`](docs/jmovie-arozos-app.md).

## Runtime Shape

Joshu can run in two common shapes:

- **Standalone local app**: `npm run dev` starts the Joshu Express app directly
  on `127.0.0.1:8787`. Use this for focused browser-app development when Camofox
  and Hermes are already available.
- **Local ArozOS parity stack**: `npm run dev:arozos` starts or reuses Camofox,
  builds ArozOS, runs Joshu privately on `127.0.0.1:8788` under `/joshu`, and
  exposes ArozOS on `127.0.0.1:8787`. Production VPS sandboxes use the same
  topology via Docker — see [`docs/vps-sandbox/README.md`](docs/vps-sandbox/README.md).

## Run Locally

```bash
npm install
cp .env.example .env
npm run dev
```

Open <http://127.0.0.1:8787>.

This starts the standalone Joshu Express app. Camofox must be reachable through
`CAMOFOX_URL`, and Hermes must be reachable through the configured gateway path
or auto-started from `HERMES_BIN`.

For local development that mirrors the VPS/ArozOS topology, run:

```bash
npm run dev:arozos
```

That starts or reuses a local Camofox Docker container, builds ArozOS from
source, starts Joshu privately on `127.0.0.1:8788` with
`PUBLIC_BASE_PATH=/joshu`, and exposes ArozOS at <http://127.0.0.1:8787>.
Launch **jWeb**, **jChat**, **Memory**, or other desktop apps from the ArozOS
desktop to exercise the same subservice paths used in production sandboxes.

Video playback on the ArozOS desktop (Media Player vs Video app, autoplay/mute):
see [`docs/arozos-media-player.md`](docs/arozos-media-player.md).

## Design system

jōshu v1 tokens and typography live in [`packages/design-system`](packages/design-system)
(`@joshu/design-system`). Hermes Chat, Hindsight Viewer, Excalidraw, and `public/`
HITL import that package; the ArozOS **desktop shell** (taskbar, float window chrome)
is themed separately via [`arozos/web-overlays/aroz-paper-shell.css`](arozos/web-overlays/aroz-paper-shell.css).
jMovie uses its own in-iframe styles, not `@joshu/design-system`.
See [`docs/design/README.md`](docs/design/README.md) for import order, `sync-design-system`,
ArozOS shell chrome (taskbar, Mac-style windows, Tango icons under `arozos/icons/`, `arozos/desktop-icons/`, and the full library in `arozos/tango-icons/`), and
verifying the theme after changes (including re-applying the shell link on
`.local/arozos-data/web/`).

If Hindsight memory is configured with `HINDSIGHT_API_LLM_*` env vars, the local
ArozOS runner also starts a private Hindsight API on `127.0.0.1:8888`. Hindsight
uses local PostgreSQL for memory storage; the LLM used for memory extraction can
be a hosted OpenAI-compatible provider. The VPS sandbox image builds pgvector
with portable compiler flags (`OPTFLAGS=""` in `deploy/Dockerfile`); configure
external embeddings and reranking with `HINDSIGHT_API_EMBEDDINGS_*` and
`HINDSIGHT_API_RERANKER_*` vars.
Set `JOSHU_HINDSIGHT_ENABLED=false` to skip this during local runs, or `true` to
fail fast when Hindsight cannot start.

To verify memory storage end-to-end, start the local stack and run:

```bash
npm run hindsight:smoke
```

The smoke test writes a distinctive fact through Hindsight, polls recall, and
prints the recalled memory text. It uses the Hindsight API/client rather than
reading Postgres files directly. Hindsight may normalize extracted facts, so an
exact random token is not always preserved even when retain/recall is working;
use the returned memories and Hindsight Viewer to confirm the semantic fact made
it into the bank.

To inspect the memory graph visually, launch **Hindsight Viewer** from ArozOS.
It calls Joshu's `/joshu/api/hindsight/*` proxy, which reads the local Hindsight
constellation graph and entity co-occurrence graph endpoints. The viewer includes
both graph and table modes. The constellation table is useful because Hindsight
can produce multiple typed edges between the same two memories, so a tiny bank may
show many raw edges but far fewer unique source/target pairs.

**File brain (gbrain):** `dev:arozos` also indexes the ArozOS Desktop (including
`joshu's files/` for journals and research). Drop text PDFs in `research/kb/inbox/` for automatic extraction and indexing. Chat memory stays in Hindsight; file
search uses gbrain via Hermes MCP. See [`docs/file-brain.md`](docs/file-brain.md).

The local ArozOS build uses the `go` available on your machine. The vendored
ArozOS source currently requires Go `1.24.x` (`toolchain go1.24.1` in
`vendor/arozos/src/go.mod`), so install a modern Go toolchain if local ArozOS
builds fail while parsing `go.mod`.

For product development, add your private ArozOS mirror as `vendor/arozos`:

```bash
git submodule add <your-private-arozos-mirror-url> vendor/arozos
git submodule update --init --recursive
npm run dev:arozos
```

`npm run dev:arozos` builds from `vendor/arozos` when it exists. For one-off
testing, you can override the source path or clone a specific fork/ref:

```bash
AROZOS_SOURCE_DIR=/path/to/arozos npm run dev:arozos
AROZOS_REPO=https://github.com/you/arozos.git AROZOS_REF=my-branch npm run dev:arozos
```

If another Camofox is already healthy on `127.0.0.1:9377`, the script reuses it.
Stop that container first if you want the dev runner to create its patched
`camofox-hitl-local` container.

## Joshu Browser App

The ArozOS **Joshu Browser** app is the human-in-the-loop browser surface. It
shares one Camofox tab between the human operator and Hermes, embeds noVNC for
manual control, and sends Hermes a fresh accessibility snapshot before each
prompt.

## Hermes Chat App

The ArozOS **jChat** (Hermes Chat) app is a separate chat surface for Hermes Agent. It
uses Joshu's backend to auto-start the Hermes gateway when needed, proxy
`/v1/chat/completions` streaming, and keep `HERMES_API_KEY` server-side. The UI
renders markdown, attachments, assistant media links, and Hermes tool-progress
cards. Optional **Mic** / **Speech** use Hermes STT/TTS through Joshu (not the
browser `speechSynthesis` API). With `COMPOSIO_API_KEY`, connect Gmail/GitHub/Slack/etc.
in the ArozOS **Connectors** app (jChat → **Open Connectors**); Hermes keeps using
those tools on the box afterward. See `docs/connectors-arozos-app.md` and
`docs/hermes-chat-arozos-app.md`.

## Connectors app (mail + OAuth)

The ArozOS **Connectors** desktop app is the single place to manage Composio OAuth,
**multiple Gmail accounts**, and connector sync health. Each Gmail account mirrors to
`joshu's files/connectors/mail/gmail/{account_key}/threads/` and gets its own tab in
**jMail**. All apps read the same state via `GET /joshu/api/connectors/status` and
`.joshu/connectors-registry.json`. See `docs/connectors.md`.

## Hindsight Viewer App

The ArozOS **Hindsight Viewer** app is a lightweight local inspection surface for
Hindsight memory. It is not the full Hindsight Control Plane; it uses Joshu's
server-side proxy to render the local Hindsight constellation and entity
co-occurrence endpoints.

Use graph mode for a quick topology view and table mode when raw counts look
surprising. The constellation endpoint can return parallel typed edges between
the same two memories, so table mode shows both raw edges and unique pairs.

## jWhiteboard (Excalidraw)

Joshu includes a separate ArozOS **jWhiteboard** app built from
`@excalidraw/excalidraw`. It is packaged under
`arozos/subservice/excalidraw/` and appears as **jWhiteboard** on the ArozOS
desktop when you run:

```bash
npm run dev:arozos
```

For quick standalone UI iteration without ArozOS:

```bash
npm run dev:excalidraw
```

Then open <http://127.0.0.1:3002>. The fork's full `excalidraw-app` dev server uses
`vendor/excalidraw` only (`git submodule update --init --recursive vendor/excalidraw`,
then `npm run dev:excalidraw:upstream`). See `docs/excalidraw-sandbox.md` for
the app packaging notes and `docs/Joshu-SOP/time-block-planning.md` for Cal Newport
time-block diagrams with `joshu://` links.

## Camofox

Start Camofox with VNC enabled:

```bash
docker run -d --name camofox-hitl \
  --restart unless-stopped \
  -p 127.0.0.1:9377:9377 \
  -p 127.0.0.1:6080:6080 \
  -e ENABLE_VNC=1 \
  -e VNC_BIND=0.0.0.0 \
  -e VNC_RESOLUTION=1024x768 \
  -e MAX_TABS_PER_SESSION=1 \
  -e MAX_TABS_GLOBAL=1 \
  -e CAMOFOX_MAX_TABS=1 \
  ghcr.io/jo-inc/camofox-browser:latest
```

Hermes must also have `CAMOFOX_URL=http://localhost:9377` available in
`~/.hermes/.env` or the gateway environment.

## Hermes Customizations

Hermes is installed outside this repo, but Joshu owns factory skills and plugins here:

- Factory skills: `integrations/hermes/skills/` (seeded to `$HERMES_HOME/skills/joshu/` at boot)
- Project plugins: `.hermes/plugins/`

When Joshu starts the Hermes gateway, it merges product config into `$HERMES_HOME/config.yaml`
(model from `JOSHU_HERMES_MODEL` / `JOSHU_HERMES_PROVIDER`, skill denylist, toolsets) and
starts Hermes with `HERMES_ENABLE_PROJECT_PLUGINS=true`. Local dev and **VPS sandboxes** route
the LLM through [OpenRouter](https://openrouter.ai) (`openrouter` + `deepseek/deepseek-v4-flash` by default).

Plugins are still opt-in in Hermes. Set `JOSHU_HERMES_PLUGIN_NAMES` to a comma-separated list
(for example `joshu-browser`) when a repo plugin should be added to `plugins.enabled` before
gateway startup.

See [`docs/hermes-customizations.md`](docs/hermes-customizations.md) for the full ownership
model — factory skills, agent learning loop, EA skills, VPS notes, and post-`hermes update` steps.

To promote a new upstream stable release to the external Hermes checkout and
deploy pin with rollback snapshots, use `npm run hermes:update` (see
`scripts/update-hermes-agent.sh` and `docs/local-installation.md`).

The sandbox image fetches a pinned Hermes checkout and verifies generic Camofox
tab adoption support. The legacy Hermes browser patch remains only for old local
checkouts.

### Browser resolution and “wide” display

Camofox uses a fixed virtual desktop (default **1024×768**). The remote session is
**not** resized at runtime (`resizeSession` is off).

**Two different “wide” issues:**

1. **Letterboxing in the Joshu UI** — the 4:3 VNC box centered in a wider pane or
   browser tab (black side bars). The stream is still 4:3. Use the ArozOS **Joshu
   Browser** window (`InitFWSize` 1024×768) or a 4:3-sized host window.
2. **Wide website layout inside Firefox** — `window.innerWidth` was ~1920 because
   Camoufox’s **launch fingerprint** defaulted to a 1080p screen. Joshu patches
   `launchOptions({ window: [1024, 768] })` in
   [`scripts/patch-camofox-single-tab.mjs`](scripts/patch-camofox-single-tab.mjs).
   **Restart or recreate** the Camofox container after changing this patch or env.

If **circles look round**, noVNC is not stretching. Check `?debugVnc=1`: `screen`
aspect ≈ 1.333 and `innerWidth` ≈ 1024.

**Local URLs:**

- Joshu direct: `http://127.0.0.1:8788/joshu/...` (port `8788`)
- Through ArozOS: `http://127.0.0.1:8787/joshu/...` only when the **Joshu Browser**
  subservice is running (not disabled). See
  [`docs/hitl-camofox-notes.md`](docs/hitl-camofox-notes.md#vnc-display-routing-and-troubleshooting).

Set before **creating** the Camofox container:

```bash
VNC_RESOLUTION=1024x768
CAMOFOX_VIEWPORT_WIDTH=1024
CAMOFOX_VIEWPORT_HEIGHT=768
CAMOFOX_START_URL=https://news.google.com/   # optional home page
```

Recreate after env or patch-script changes: `docker rm -f camofox-hitl && bash scripts/ensure-camofox-container.sh` (`docker start` alone does not reset a stale `/app/server.js` patch). If Camofox exits with `__hitlFitBrowserWindow with width/height`, see [`docs/vps-sandbox/troubleshooting-and-lessons.md`](docs/vps-sandbox/troubleshooting-and-lessons.md#patch-pitfalls-maintainers).

Match [`arozos/subservice/joshu/moduleInfo.json`](arozos/subservice/joshu/moduleInfo.json)
`InitFWSize` when you change resolution, then reopen the ArozOS float window.

## VPS Sandbox (production)

For **always-on, one-VPS-per-customer** deployments with a Vercel control plane, see
[`docs/vps-sandbox/README.md`](docs/vps-sandbox/README.md) and [`deploy/README.md`](deploy/README.md).

Self-host guide: [`docs/self-host.md`](docs/self-host.md).
Control plane (proprietary): [`docs/vps-sandbox/control-plane.md`](docs/vps-sandbox/control-plane.md).
Troubleshooting (Hermes empty stream, Hindsight, ArozOS, cloud-init, image tags):
[`docs/vps-sandbox/troubleshooting-and-lessons.md`](docs/vps-sandbox/troubleshooting-and-lessons.md).

Quick path: `npm run vps:predeploy` → `npm run vps:build-image` → `deploy/docker-compose.yml` on the VPS.

Camofox runtime patching and jWeb debugging notes: [`docs/hitl-camofox-notes.md`](docs/hitl-camofox-notes.md).

- `scripts/patch-camofox-single-tab.mjs`
