# HITL Camofox Modal Notes

This document records what we changed while integrating Joshu, Hermes, Camofox,
noVNC, and Modal, plus what the debugging logs taught us. It is intentionally a
working note: some of the VNC resolution behavior is still unresolved.

## Current Shape

Joshu is the custom app layer. The goal has been to keep upstream repositories
clean and keep our integration code here.

- `modal_app.py` builds the Modal image (Camofox base image + Hermes + Joshu +
  source-built **ArozOS** from `vendor/arozos` when present; `AROZOS_REPO` /
  `AROZOS_REF` are bootstrap fallbacks).
- The Modal image installs Go `1.24.1` from `go.dev` before building ArozOS.
  Debian bookworm's `golang-go` package is currently Go 1.19, which cannot parse
  ArozOS's `go 1.24.0` / `toolchain go1.24.1` `go.mod`.
- `scripts/modal-start.sh` starts Camofox, noVNC, a local Hindsight API for
  Hermes memory when configured, Hermes gateway support, and the Joshu Express
  app on loopback, then starts **ArozOS** as the only public HTTP server on port
  `8787`.
- `arozos/subservice/joshu/` defines the ArozOS **Joshu Browser** module (see
  `moduleInfo.json`) plus `start.sh`, which runs `scripts/aroz-subproxy.mjs` to
  reverse-proxy `/joshu/*` to Joshu.
- `arozos/subservice/excalidraw/` defines the separate ArozOS **Excalidraw**
  module. It serves the Vite-built `apps/excalidraw/` bundle with
  `scripts/aroz-static-subservice.mjs`.
- `arozos/subservice/hermes-chat/` defines the separate ArozOS **Hermes Chat**
  module. It serves the Vite-built `apps/hermes-chat/` bundle with the same
  static subservice helper and streams Hermes chat-completions through Joshu.
- Static subservices need a `.startscript` marker beside `start.sh`; without it,
  ArozOS looks for a native binary named like `<service>_<os>_<arch>` and skips
  the app when that binary is absent.
- Desktop icons are persisted ArozOS `.shortcut` files, not only module
  metadata. `scripts/dev-arozos.sh` and `scripts/modal-start.sh` reinstall Joshu
  and stock shortcuts (with `img/joshu/*.png` paths) into the desktop template
  and any existing user desktops on each prepare. Format and rename rules:
  [`docs/arozos-desktop-shortcuts.md`](arozos-desktop-shortcuts.md).
- ArozOS strips the subservice prefix before forwarding (`/joshu/index.html`
  arrives at the subservice as `/index.html`), so `scripts/aroz-subproxy.mjs`
  adds `JOSHU_UPSTREAM_BASE_PATH` (default `/joshu`) before forwarding to the
  private Joshu Express app.
- Frontend calls within a subservice should be path-aware. The Joshu Browser app
  uses relative `api/...` URLs under `/joshu`; sibling apps that need the Joshu
  backend call the explicit `/joshu/api/...` route.
- Modal volume `joshu-hitl-arozos-data` mounts at `/var/lib/arozos` for durable
  ArozOS user/system state across container restarts. The first boot copies the
  built ArozOS template into the volume; later boots refresh web assets and app
  subservice bundles while preserving runtime state under `system/` and user
  files under `files/`.
- Modal installs `hindsight-api-slim[embedded-db]`, while embeddings and
  reranking are expected to be external services. Hindsight runs as an
  unprivileged `hindsight` user, and Modal starts a local PostgreSQL 15 service
  as the `postgres` user in the same container. The image builds pgvector from
  source against Debian's PostgreSQL development files with `OPTFLAGS=""` so the
  extension is portable (avoids `-march=native` illegal-instruction crashes on
  some Modal runtime CPUs). This also avoids pg0's precompiled pgvector/glibc mismatch.
  Volumes `joshu-hitl-hindsight-home` and
  `joshu-hitl-hindsight-cache` persist Hindsight profile/log state and
  lightweight cache state. PostgreSQL data currently lives in ephemeral
  `/tmp/hindsight-postgres/data` because earlier Modal Volume attempts rejected
  PostgreSQL `initdb` permission changes; use an external PostgreSQL service
  before relying on durable Modal memory.
- ArozOS `-tmp` must be the **parent** of its runtime `tmp/` folder (it appends
  `tmp/` internally). Passing `${AROZ_DATA}/tmp` caused `${AROZ_DATA}/tmp/tmp/`
  and a startup panic; use `-tmp=${AROZ_DATA}`.
- Modal `serve` uses `timeout=24h` (platform max) and `scaledown_window=30m` so
  long sessions are not cut off hourly and brief idle periods do not immediately
  cold-start a new container. Redeploys still replace containers; local Postgres
  under `/tmp` is always ephemeral on a new machine.
- `scripts/dev-arozos.sh` mirrors the Modal topology locally: local Camofox,
  optional local Hindsight API, source-built ArozOS (from `vendor/arozos`,
  `.local/arozos-source`, or `AROZOS_SOURCE_DIR`), Joshu on loopback at
  `/joshu`, the static Excalidraw app as an ArozOS subservice, and ArozOS public
  on `127.0.0.1:8787` with state under `.local/arozos-data`.
- `scripts/patch-camofox-single-tab.mjs` patches Camofox at Modal image build
  time.
- Modal fetches a pinned Hermes checkout and verifies that it has generic
  Camofox `adopt_existing_tab` support. Modal no longer applies
  `scripts/hermes-browser-camofox-hitl.patch`; that patch remains only as a
  legacy local fallback for old Hermes checkouts.
- Joshu-owned Hermes skills live under `integrations/hermes/skills/`, and
  project-local Hermes plugins live under `.hermes/plugins/`.
- Before starting the Hermes gateway, `src/hermesApi.ts` ensures
  `$HERMES_HOME/config.yaml` includes the Joshu skill directory in
  `skills.external_dirs`; project plugin discovery is enabled with
  `HERMES_ENABLE_PROJECT_PLUGINS=true`.
- When Hindsight is enabled, `src/hermesApi.ts` also sets
  `memory.provider: hindsight` and writes `$HERMES_HOME/hindsight/config.json`
  for Hermes's native Hindsight provider in `local_external` mode.
- See `docs/hermes-customizations.md` for the canonical Hermes ownership,
  patch-lifecycle, and config rules.
- `src/server.ts`, `src/camofoxSession.ts`, and `public/app.js` coordinate the
  shared browser session from Joshu.

The Modal build verifies that the Camofox patch markers exist before deployment
continues. This caught earlier cases where the image looked deployed but Camofox
was missing the dynamic viewport route.

The last confirmed working Modal deployment, including the separate ArozOS
Excalidraw app, exposed:

```text
https://db-58636--joshu-hitl-serve.modal.run
```

The endpoint returned ArozOS's expected first-hop redirect:

```text
307 Location: /login.html?redirect=/
```

## What Was Added

### Modal Deployment

We added an optional Modal target that builds a single image containing:

- Camofox plus noVNC from `ghcr.io/jo-inc/camofox-browser:latest`.
- A pinned Hermes checkout at `/opt/hermes-agent`.
- The Joshu app at `/opt/joshu`.
- ArozOS built from source into `/opt/arozos-template`.
- A runtime patch for Camofox.

Modal exposes ArozOS as the only public HTTP server on port `8787`. Camofox,
Hermes, noVNC, and Joshu stay on localhost inside the container. Joshu listens
privately at `127.0.0.1:8788` with `PUBLIC_BASE_PATH=/joshu`; ArozOS launches the
`joshu` subservice and reverse-proxies the desktop app to that private server.

**Faster Modal rebuilds (Joshu iteration):**

| Command | Behavior |
|---------|----------|
| `npm run modal:deploy` | Full self-contained image: **`npm ci --include=dev`** on Modal plus **tsc** and **all Vite** app builds inside the builder. Slow when you touch only Joshu TS/React/`public` but safest when the CI host does not mirror your laptop. |
| `npm run modal:predeploy` | Locally: **`sync-design-system`**, **`npm run build`**, **`npm run build:excalidraw`**, **`npm run build:hermes-chat`**, **`npm run build:hindsight-viewer`**, **`npm run build:movie-editor`**. Produces **`dist/`** (gitignored) including **`dist/server.js`**. |
| `npm run modal:deploy:fast` | Runs **`modal:predeploy`**, then deploys with **`MODAL_EMBED_LOCAL_DIST=1`**. Modal **copies `dist/`** from your checkout, runs **`npm ci --omit=dev --ignore-scripts`**, applies **`patches/http-proxy+1.18.1.patch`** with **`patch`**, and runs **`scripts/sync-design-system-public.mjs`**. Skips installing Vite/TypeScript DevDependencies **on Modal** — large time savings when lower layers cache. |

**Important:** **`modal:deploy:fast` only shrinks the Joshu/Node slice** of the image — not the whole deploy. Modal still builds (or restores from cache) earlier layers: **Hermes `pip install`**, **`hindsight-api-slim`**, **pgvector `make`**, **`go build` for ArozOS**, and many **`COPY`/mount steps**. Your terminal showing **Step ~12 Hermes**, **Step ~13 Hindsight**, **Step ~14 pgvector**, then **`go build`** means that **bottom chunk either cache-missed or changed** (e.g. **`HERMES_AGENT_REF`**, **`modal_app.py`/`package-lock.json`**, first deploy on this machine/account, or Modal invalidated that layer). **Those steps alone can dominate wall time** (often several minutes).

You still win on fast mode when the **cached** flow reaches the Joshu layer quickly: in-image **`npm ci --include=dev`** + **three Vite builds** is replaced by **`npm ci --omit=dev`** plus copying **`dist/`**.

**Environment:** **`MODAL_EMBED_LOCAL_DIST=1`** gates the embed path (`modal_app.py`). If `dist/` files are missing, **`modal deploy` fails immediately** with directions to run **`modal:predeploy`**.

**What stays slow:** Changing **Hermes pin**, **Camofox base**, **pgvector**/Postgres/apt layers, **`vendor/arozos`**, or **`package-lock.json`** still reruns downstream image steps. **`modal_app.py`** itself changing can also invalidate overlays.

**Hermes Chat / Joshu Browser voice:** Requires **`scripts/hermes-chat-transcribe.py`**, **`scripts/hermes-chat-tts.py`**, and **`[voice]`** in the Hermes venv (`docs/hermes-chat-arozos-app.md`).

### ArozOS Source And Persistence

The product workflow keeps ArozOS source in this repo at `vendor/arozos`,
intended to be a submodule pointing at the private Joshu mirror. This keeps the
main `joshu` repo as the product repo while allowing local ArozOS changes,
private mirror maintenance, and upstream contributions for generic fixes.

The expected source layout is:

```text
vendor/arozos/src/go.mod
vendor/arozos/src/web/
vendor/arozos/src/system/
```

If `vendor/arozos` is missing, Modal and local parity dev can clone
`AROZOS_REPO` at `AROZOS_REF` as a bootstrap fallback. Product builds should use
the checked-out submodule for reproducibility.

ArozOS persistence is intentionally split from the image:

- `/opt/arozos-template` is immutable image content built from source.
- `/var/lib/arozos` is the Modal volume mounted at runtime.
- First boot copies the template into `/var/lib/arozos`.
- Every boot refreshes `/var/lib/arozos/web/` from the image template (includes
  `aroz-paper-shell.css` and the `desktop.html` link applied at image build),
  `/var/lib/arozos/subservice/joshu/`,
  `/var/lib/arozos/subservice/excalidraw/`,
  `/var/lib/arozos/subservice/hermes-chat/`,
  `/var/lib/arozos/subservice/hindsight-viewer/`, and
  `/var/lib/arozos/subservice/jmovie/`.
- Image build applies the jōshu desktop shell overlay (`aroz-paper-shell.css`,
  `aroz-taskbar-focus.js`, `aroz-desktop-icon-tooltips.js`, `arozos/icons/`
  → `web/img/joshu/`, `arozos/desktop-icons/` → `web/img/desktop/`, and
  `arozos/tango-icons/` → `web/img/tango/` via `scripts/apply_arozos_joshu_theme.py`
  on `/opt/arozos-template/web`). See
  [`docs/design/README.md`](design/README.md#tango-icon-pipeline).
- Every boot also refreshes desktop `.shortcut` files (Joshu apps + File Manager,
  System Setting, Trash Bin, etc.) into the template and user desktops, because
  desktop contents live in persisted runtime state.
- Runtime state, login/session material, system settings, and user files remain
  in the volume.

### URL Routing

The public Modal URL opens ArozOS, not Joshu directly. ArozOS handles login and
desktop state, then the user launches **Joshu Browser** from the desktop.

Joshu is path-mounted at `/joshu`:

- Browser page: `/joshu/index.html`
- API calls from the frontend: relative `api/...`, resolving under `/joshu/`
- noVNC client/proxy: `/joshu/novnc`

ArozOS strips the subservice path before forwarding, so the request that began
as `/joshu/index.html` can reach the subservice as `/index.html`.
`scripts/aroz-subproxy.mjs` adds `/joshu` back before forwarding to the private
Joshu Express app.

Hermes Chat, Hindsight Viewer, Excalidraw, and jMovie use
`scripts/aroz-static-subservice.mjs` instead of the Joshu reverse proxy (jMovie
still calls Joshu `/api/movie-editor/*` from the browser). ArozOS
still strips the public subservice prefix before proxying, so a healthy static
app should be reachable through the desktop launcher even though direct
assumptions about `/hermes-chat/index.html` can be misleading while debugging
permissions or route rewrites.

### Hermes Chat Desktop Hiccup

After the Hermes Chat app was first added, `npm run dev:arozos` copied the
subservice files into `.local/arozos-data`, but the app still did not appear on
`http://127.0.0.1:8787/desktop.html`.

The investigation found two ArozOS-specific requirements:

- `arozos/subservice/hermes-chat/.startscript` was missing. ArozOS therefore did
  not run `start.sh`, did not start `scripts/aroz-static-subservice.mjs`, and did
  not register the `Hermes Chat` module.
- The existing local ArozOS user's desktop only had the older shortcut files
  (`Joshu Browser`, `File Manager`, etc.). Since desktops are persisted in
  `.local/arozos-data/files/users/<user>/Desktop`, adding a module did not add a
  visible icon for that existing user.

The fix was:

- Add `.startscript` to `arozos/subservice/hermes-chat/`.
- Install `Hermes Chat.shortcut` into the local ArozOS desktop template and
  existing user desktops.
- Teach both `scripts/dev-arozos.sh` and `scripts/modal-start.sh` to repeat that
  shortcut install when preparing ArozOS data.
- Restart the local `npm run dev:arozos` process so ArozOS rescanned subservices.

Successful startup logs showed:

```text
[Subservice] Subservice Registered: Hermes Chat
[joshu-hermes-chat] serving .../subservice/hermes-chat/app on 127.0.0.1:<port>
```

### Hermes HITL Adoption

Hermes needs the same Camofox identity as the visible Joshu browser so the
browser tool shares the human operator's tab instead of creating a separate
invisible one. Joshu keeps the older env names for compatibility:

- `HITL_CAMOFOX_USER_ID`
- `HITL_CAMOFOX_SESSION_KEY`

Joshu also maps those into the newer generic Hermes/Camofox controls:

- `CAMOFOX_USER_ID`
- `CAMOFOX_SESSION_KEY`
- `CAMOFOX_ADOPT_EXISTING_TAB`

Modal no longer applies `scripts/hermes-browser-camofox-hitl.patch`. The pinned
Hermes checkout must already have generic `adopt_existing_tab` support, and the
Modal build fails fast if it does not.

### Hermes Customization Layout

Hermes remains installed outside the Joshu repo so we can keep following
upstream Hermes changes. Joshu-specific extensions are versioned here and exposed
through Hermes's supported customization paths:

```text
integrations/hermes/skills/   # external read-only skill directory
.hermes/plugins/              # trusted project-local plugins
```

At gateway startup, Joshu updates `$HERMES_HOME/config.yaml` to include the
skills path. This is intentionally done at runtime so local dev and Modal use the
same repo-owned skill source even though `HERMES_HOME` differs:

- Local: usually `~/.hermes`
- Modal: `/root/.hermes`, backed by the `joshu-hitl-hermes-home` volume

Project plugin discovery is enabled by setting `HERMES_ENABLE_PROJECT_PLUGINS`.
Hermes still requires plugins to be enabled explicitly. Set
`JOSHU_HERMES_PLUGIN_NAMES` to a comma-separated list of repo plugin names when a
plugin should be added to `plugins.enabled` before the gateway starts.

Product-required Hermes config should be generated by Joshu startup code, not
maintained only as a local hand edit to `~/.hermes/config.yaml`. Local Hermes
YAML can hold personal defaults, but Modal will not reliably receive those
changes unless they are encoded in startup scripts or copied into a Modal secret.
For the durable policy, including what to do after `hermes update`, see
`docs/hermes-customizations.md`.

### Camofox Single-Tab Patch

The Camofox patch does several HITL-specific things:

- Coerces native popup pages back into the opener tab (`__hitlPopupCoerceV2`): waits for OAuth/magic-link redirects (e.g. Slack `/z-app/`), navigates the opener with `location.assign`, then closes the popup. Legacy v1 closed the popup first and broke Slack 2FA — see [troubleshooting § Slack 2FA](../vps-sandbox/troubleshooting-and-lessons.md#slack-2fa--magic-link--link-expired).
- Attempts to enforce a single visible Camofox page before creating a new tab.
- Reads startup viewport defaults from:
  - `VNC_RESOLUTION`
  - `CAMOFOX_VIEWPORT_WIDTH`
  - `CAMOFOX_VIEWPORT_HEIGHT`
- Adds `POST /tabs/:tabId/viewport` to set a Playwright page viewport dynamically.
- Verifies at Modal build time that the viewport route and single-tab patch were
  inserted.

### Frontend VNC Sizing

The frontend computes the actual browser pane size from `#vnc-screen`, for
example `930x725`, and posts it to:

```text
POST /api/camofox/viewport
```

Joshu forwards that size to Camofox, which should call Playwright
`page.setViewportSize({ width, height })`.

Static files are served with `Cache-Control: no-store`, and `index.html` uses a
cache-busted `app.js` URL so Modal/browser cache does not keep old resize logic.

## What We Learned

### Modal Deploy Needs The Right Network Path

The first deployment attempts built an image successfully but then stalled in
Modal client heartbeat timeouts:

```text
modal.exception.ConnectionError: Deadline exceeded
```

Running the deploy with full network access allowed the Modal CLI's gRPC
heartbeat/finalization path to complete. When a build appears complete but the
deploy hangs in heartbeat logs, treat it as a Modal client/network issue before
assuming the app code failed.

### Hindsight Retain Failures And Ephemeral Postgres On Modal

Symptoms included Hermes reporting 500s on `hindsight_retain` while
`/joshu/api/hindsight/status` and graph reads still returned 200. In the Modal
container, `/tmp/hindsight-postgres/postgres.log` showed Postgres backends
terminated by `signal 4: Illegal instruction` during retains. Root cause was
pgvector built with `-march=native` on a different CPU than the runtime worker.
The Modal image now builds pgvector with `OPTFLAGS=""` (see `modal_app.py`).

When debugging a running Modal container, `modal container exec` with `--no-pty`
can avoid stdin/socket issues. Hindsight API logs live at
`/home/hindsight/.hindsight/hindsight-api.log` on the `joshu-hitl-hindsight-home`
volume.

If logs show ArozOS `Shutting down auth gateway` around the same time Modal
starts a fresh `[modal-start]` sequence, the web-server function was likely
recycled (timeout, scaledown after idle, or redeploy). Container IDs change per
instance; Hermes and Hindsight **files** on volumes persist, but anything only in
local Postgres under `/tmp` is lost on that recycle.

### Inline Build Checks Should Use `sys.exit`

An inline Python validation originally used this shape:

```text
raise SystemExit(...) if missing else print(...)
```

That parsed as raising the result of the conditional expression. When `missing`
was empty, it printed success and then tried to `raise None`, producing:

```text
TypeError: exceptions must derive from BaseException
```

Use explicit `sys.exit(...) if missing else print(...)` in one-line Modal build
checks.

### ArozOS Requires A Modern Go Toolchain

The vendored ArozOS source currently has:

```text
go 1.24.0
toolchain go1.24.1
```

Installing Debian bookworm's `golang-go` package gave Go 1.19, which failed with:

```text
invalid go version '1.24.0': must match format 1.23
unknown directive: toolchain
```

The Modal image now installs Go `1.24.1` from `go.dev` and verifies `go version`
before building ArozOS.

### `1280x960x24` Is The Xvfb Size, Not The Computed Pane Size

The log line below is expected at Camofox startup:

```text
vnc plugin: overriding Xvfb resolution 1280x960x24
```

That is the fixed virtual framebuffer size. It appears before the web UI loads,
so it cannot reflect the computed pane size like `930x725`.

The dynamic resize path is separate and should show later logs like:

```text
[joshu] requested Camofox viewport 930x725
[joshu] applied Camofox viewport 930x725 to tab ...
```

### noVNC Scaling Is Not Enough

Setting noVNC `scaleViewport` and `resizeSession` can make the canvas fit the
pane, but it does not necessarily resize:

- Xvfb.
- x11vnc's framebuffer.
- The Firefox/Camoufox outer window.
- The Playwright page viewport.

That means noVNC can report `connected 930x725` while the visible browser still
looks too wide or otherwise mismatched.

### Creating Blank Tabs Caused Bad Feedback Loops

When Joshu created an `about:blank` tab just to apply viewport sizing, Camofox's
tab reaper could clean it up as inactive:

```text
session empty after tab reaper, closing
```

This produced loops where Joshu or the shim watchdog kept creating replacement
tabs. The browser visibly blinked with each cycle.

### The Shim Watchdog Was Too Aggressive

The shim endpoint installs single-tab popup behavior in the active tab (one
`evaluate` per VNC connect). Joshu no longer polls it on a timer; the in-page
shim is idempotent (`__hitlShimVersion`). The shim route must not spawn tabs.

### Patch Order Matters In Camofox

One failure was caused by cleanup happening after `getTabGroup(...)`.

The old patch flow effectively did this:

1. Get a `Map` for the tab group.
2. Run cleanup that deletes that group from `session.tabGroups`.
3. Add the new tab to the detached `Map`.

Camofox logged `tab created`, but immediate calls to `/tabs/:tabId/evaluate` and
`/tabs/:tabId/viewport` returned `404` because `findTab(...)` could not find the
detached tab.

The patch was changed so cleanup runs before `getTabGroup(...)`.

### Max Tab Limits Fire Before Late Cleanup

Another failure was:

```text
Maximum tabs per session reached
```

Camofox checks `MAX_TABS_PER_SESSION` and `MAX_TABS_GLOBAL` before tab creation.
If cleanup happens too late, the request can fail with `429` before our single
visible page logic has a chance to close older pages.

The patch now attempts cleanup immediately after `getSession(...)`, before
Camofox computes `totalTabs`.

### User IDs Must Be Aligned

We saw both `joshu-hitl-modal` and `hitl-camofox` in logs. That means Joshu and
Hermes could operate under different Camofox user/session identities, which
creates confusing tab ownership and max-tab behavior.

Modal now defaults to:

```text
HITL_CAMOFOX_USER_ID=hitl-camofox
CAMOFOX_USER_ID=hitl-camofox
CAMOFOX_ADOPT_EXISTING_TAB=true
```

The intent is that Joshu and Hermes both use one shared HITL Camofox identity.

### Hindsight Smoke Testing Needs Semantic Checks

The local Hindsight API can be healthy and connected to pg0/PostgreSQL while
retain/recall still fails because an external provider is misconfigured. We saw
three distinct states:

- Invalid LLM key: retain completed with `0 facts`.
- Google Discovery Engine reranker missing permissions: recall found candidates
  but returned a `403` from the ranking endpoint.
- Working LLM, embeddings, and reranker: recall returned relevant memories, but
  exact random marker strings were normalized out of the extracted fact text.

For smoke tests, treat the returned memories and Hindsight Viewer as the source
of truth. A semantic memory like "Joshu conducted a smoke test to verify
Hindsight memory" proves the local database path is working even if a random
marker token is not preserved literally.

### Hindsight Viewer Explains Graph Shape Better Than Raw Counts

The Hindsight constellation endpoint returns typed memory relationships, not just
one edge per visible pair of nodes. A pair of memory nodes can have separate
semantic, temporal, and entity edges, and entity edges can repeat once per shared
entity. In one small smoke-test bank, this produced `4` memory nodes and `43` raw
edges but only `15` unique directed pairs.

Joshu's Hindsight Viewer now includes both graph and table modes. Use the table
mode to inspect raw nodes/edges, edge types, entity names, weights, and IDs when a
graph looks denser than expected.

## VNC display, routing, and troubleshooting (resolved May 2026)

This section records what we learned fixing “wide” Camofox, 404s on `/joshu/*`,
and startup failures after container restarts.

### Two different “wide” problems

| Symptom | Cause | Fix |
|--------|--------|-----|
| Black bars around a 4:3 VNC box in the Joshu UI; debug shows `screen` aspect ≈ 1.333 | Joshu letterboxing a 4:3 box inside a wider pane or browser tab | Expected when the host window is not 4:3. Open the **Joshu Browser** float window (`InitFWSize` 1024×768) or use a 4:3-sized window. Optional: tune `--joshu-vnc-max-width` in `tokens.css`. |
| Google News / sites use a **desktop-wide** layout; `window.innerWidth` ≈ 1920 | Camoufox **fingerprint** at browser launch, not noVNC stretch | Patch `launchOptions({ window: [1024, 768] })` in `scripts/patch-camofox-single-tab.mjs`. **Recreate or restart** the Camofox container so the browser process relaunches. |

**Circles that look round** mean noVNC scaling is uniform. A wrong **layout width** is almost always the fingerprint or host window, not aspect-ratio stretch.

### What actually sets resolution (three layers)

1. **Xvfb** — VNC plugin reads `VNC_RESOLUTION` (default `1024x768`) and overrides the default 1×1 / 1920×1080 Xvfb. Verify with `docker exec <container> ps aux | grep Xvfb` → `-screen 0 1024x768x24`.
2. **Camoufox fingerprint** — `launchOptions()` generates a Firefox fingerprint unless `window: [w, h]` is passed. Without it, `window.innerWidth` can stay ~1920 even when Xvfb is 1024×768. Playwright `setViewportSize()` does **not** override this.
3. **Joshu UI** — `layoutLetterboxedScreen()` in `public/app.js` sizes `#vnc-screen` to 4:3 inside the pane; noVNC uses `scaleViewport: true` and a `resize` event (no private `Display.autoscale`).

After the fingerprint fix, check in the tab:

```javascript
// via POST /tabs/:id/evaluate
{ innerWidth, innerHeight, screen.width, screen.height }
```

`innerWidth` should be ~1024. `screen.width` in the fingerprint may still differ; sites mostly use `innerWidth`.

### Ports and URLs (local `npm run dev:arozos`)

| URL | What it is |
|-----|------------|
| `http://127.0.0.1:8788/joshu/...` | Joshu Express **directly** (always works if Joshu is up) |
| `http://127.0.0.1:8787/...` | ArozOS public desktop only |
| `http://127.0.0.1:8787/joshu/...` | Joshu **only** when the **Joshu Browser** subservice is registered and running |

ArozOS does **not** serve `/joshu` on port 8787 by itself. The path is reverse-proxied by the subservice started from `arozos/subservice/joshu/start.sh` → `scripts/aroz-subproxy.mjs` → Joshu on 8788.

If every `http://127.0.0.1:8787/joshu/*` request returns ArozOS’s generic **404** page:

1. Check boot logs for `[Subservice] Subservice Registered: Joshu Browser`.
2. If missing, look for `.local/arozos-data/subservice/joshu/.disabled` — ArozOS skips disabled subservices. Remove it or start the service from **System Setting → Subservices**. `dev-arozos.sh` now deletes `.disabled` on each prepare.

### Hermes scroll / simple actions “reload” the browser

**Symptom:** Asking Hermes to scroll (or similar) flashes Google News or resets the page.

**Cause (two parts):**

1. **Wrong Camofox identity** — `~/.hermes/config.yaml` had empty `browser.camofox.user_id`, so Hermes used `hermes_<digest>` instead of `hitl-camofox`. Tool calls created a second session and could not adopt the noVNC tab.
2. **Over-aggressive single-tab patch** — `__hitlCloseAllVisibleTabs` ran on every `POST /tabs` and closed **all** users’ tabs. When Hermes and Joshu fought over tab creation, each new tab loaded `CAMOFOX_START_URL` (Google News).

**Fix:**

- Joshu `ensureJoshuHermesConfig()` now writes `browser.camofox.user_id`, `session_key`, and `adopt_existing_tab: true`.
- Camofox patch now uses `__hitlCloseExistingTabsForSession` (per user only).
- Set `CAMOFOX_USER_ID` / `CAMOFOX_SESSION_KEY` in `.env` (see `.env.example`).
- **Restart the Hermes gateway** after config changes: `hermes gateway stop` then restart Joshu / `hermes gateway run`.
- Recreate Camofox after patch changes: `docker rm -f camofox-hitl && bash scripts/ensure-camofox-container.sh`.

**Verify in Camofox logs:** scroll should be `POST .../scroll` on the same `tabId` as Joshu’s tab, with `userId: hitl-camofox` — not `POST /tabs` with `userId: hermes_...`.

**Stale tab_id (Hermes vs noVNC out of sync):** Hermes cached `tab_id` after first adoption and skipped re-binding when Joshu recreated the tab or the user navigated via VNC. Joshu applies `scripts/patch-hermes-camofox-tab-resync.mjs` and `scripts/patch-hermes-camofox-ensure-tab.mjs` via `scripts/apply-hermes-hitl-patch.sh` so `_adopt_existing_tab` always re-reads Camofox’s tab list and `_ensure_tab` never `POST /tabs` when a visible tab already exists. Restart the Hermes gateway after these patches are first applied. jWeb also calls `POST /joshu/api/camofox/sync` before each chat run; Hermes Chat gets a live browser system message on every stream.

Standalone viewer:

- Through subservice: `http://127.0.0.1:8787/joshu/camofox-viewer.html?debugVnc=1`
- Direct to Joshu: `http://127.0.0.1:8788/joshu/camofox-viewer.html?debugVnc=1`

Do **not** use a separate `vnc-layout.mjs` import — ArozOS did not reliably serve it; layout code lives in `app.js` and inline in `camofox-viewer.html`.

### Environment and scripts

| Variable / script | Role |
|-------------------|------|
| `VNC_RESOLUTION`, `CAMOFOX_VIEWPORT_WIDTH`, `CAMOFOX_VIEWPORT_HEIGHT` | Xvfb + Playwright context viewport (apply at **container create**) |
| `CAMOFOX_START_URL` | Default tab URL when none exists (default `https://news.google.com/`) |
| `CAMOFOX_FF_VERSION` | Spoof Firefox rv: in fingerprint (default `139`; Slack blocks 135). Set `0` to disable. |
| `CAMOFOX_CONTAINER` | Docker name (default `camofox-hitl`; align with `.env`) |
| `scripts/patch-camofox-single-tab.mjs` | Single tab, `POST /tabs/:tabId/viewport`, start URL, `launchOptions` `window: [w,h]`, `__hitlFitBrowserWindow(page, override)`, Firefox single-tab prefs, popup coercion v2 |
| `scripts/sync-camofox-proxy-to-vps.sh` | Push `PROXY_*` from laptop `.env` → box `instance.env` + recreate `joshu-stack` |
| `scripts/ensure-camofox-container.sh` | Create/start container + wait for `/health`; passes `PROXY_*` when set |
| `POST /joshu/api/camofox/fit-viewport` | Joshu bootstraps tab if needed → Camofox viewport route → `setViewportSize` + `window.resizeTo` (see below) |

### fit-viewport (VPS and Modal)

The viewer (`camofox-viewer.html`, jWeb `app.js`) calls `POST /joshu/api/camofox/fit-viewport` on load and after VNC connect (with short delays). That endpoint:

1. Runs `bootstrapCamofoxStartUrl(true)` and opens a tab if none exists (`0.1.6+`).
2. Calls `camofoxSession.fitViewport(tabId)` → `POST http://127.0.0.1:9377/tabs/:tabId/viewport` with `{ userId, width, height }`.
3. Camofox patched `server.js` runs `__hitlFitBrowserWindow(page, { width, height })` — **must** use the POST body, not only env defaults.

**Requires both:**

- Joshu `dist/server.js` from image build (`npm run modal:predeploy` before `vps:build-image`).
- Camofox `/app/server.js` patched at image build (or re-run `node /opt/joshu/scripts/patch-camofox-single-tab.mjs /app/server.js` on a running VPS stack).

**VPS image tags:** use `ghcr.io/db-aeon/joshu-sandbox:0.1.6` or newer for the full chain. Older boxes may return **404** on fit-viewport (missing route or no tab) even when VNC connects.

**Diagnostics:**

```bash
curl -fsS -X POST http://127.0.0.1:8788/joshu/api/camofox/fit-viewport | jq .
curl -fsS http://127.0.0.1:9377/health | jq '{browserRunning,activeTabs}'
```

If VNC connects then drops immediately with `1011 Failed to connect to downstream server`, the browser never started — see [vps-sandbox/troubleshooting-and-lessons.md](vps-sandbox/troubleshooting-and-lessons.md) (Camoufox cache / x11vnc).

**Recreate** the Camofox container when changing `VNC_RESOLUTION`, after updating `scripts/patch-camofox-single-tab.mjs`, or when the container exits on startup with:

```text
Error: Camofox viewport route must call __hitlFitBrowserWindow with width/height in /app/server.js
```

That error means `/app/server.js` in the container layer is a **stale hybrid patch** (old viewport handler and/or legacy `__hitlFitBrowserWindow(page)` without `override`). `ensure-camofox-container.sh` re-patches on every start, but it cannot repair a badly corrupted file from an older script version — remove the container so the next create copies fresh upstream `server.js` and applies the current patch:

```bash
docker rm -f camofox-hitl
bash scripts/ensure-camofox-container.sh
```

`docker start` alone does not re-read env vars or reset `/app/server.js` inside an existing container layer.

Joshu `CAMOFOX_AUTO_RESTART=true` calls `docker restart` on health failure. If the container was **removed**, use `ensure-camofox-container.sh` (Joshu will also attempt create when the container is missing).

### Debug overlay (`?debugVnc=1`)

Shows frame vs screen vs target aspect vs framebuffer scale. Useful checks:

- `screen` width×height aspect ≈ **1.333** (4:3) — UI box is correct.
- `innerWidth` ≈ **1024** — site layout width is correct.
- `fb: 1024×768` — remote desktop resolution.

### noVNC cursor / scale pitfalls (do not repeat)

- Do not CSS-scale the canvas without updating noVNC’s internal `display.scale` (red dot drift). Use `scaleViewport: true` + `window.dispatchEvent(new Event('resize'))`.
- Do not call private `rfb._display.autoscale()`; it was removed for that reason.

### ArozOS float window

[`arozos/subservice/joshu/moduleInfo.json`](../arozos/subservice/joshu/moduleInfo.json) `InitFWSize: [1024, 768]` should match `VNC_RESOLUTION`. Reopen the float window after changing either.

