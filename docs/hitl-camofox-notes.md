# HITL Camofox Notes

Fleet topology: [`vps-sandbox/runtime-topology.md`](vps-sandbox/runtime-topology.md).

## Browser backend (local Chromium vs Browser Use Cloud)

Joshu supports two shared-browser backends. **Default is local Chromium** (OSS self-host, no browser-use.com subscription).

| Backend | When | Live view | Agent / handoff CDP |
|---------|------|-----------|---------------------|
| **Local Chromium** | Default; or Safety → **Local Chromium** | noVNC / CDP screencast (`:6080`, `:9222`) | Box `BROWSER_CDP_URL` |
| **Browser Use Cloud** | Fleet boxes; Safety → **Browser Use Cloud** | Browser Use iframe (`/api/browser/live-frame`) | CP-provisioned `cdpUrl` |

**Precedence:** Safety Settings (`.joshu/safety-settings/local-env.json`, keys `JOSHU_BROWSER_BACKEND` / `JOSHU_CLOUD_BROWSER`) overrides `instance.env`. Then `instance.env` / process env. Then default **local**.

**Toggle:** ArozOS desktop → **Safety** → *Browser backend (jWeb / handoff)*. After saving, **restart `joshu-stack`** so `vps-start.sh` starts the right browser process and Joshu attaches to the correct CDP endpoint.

**OSS self-host:** leave **Local Chromium**. Optional `PROXY_*` (Decodo) for residential egress — see below. Do not set `JOSHU_CLOUD_BROWSER=1` unless the box is enrolled on the Joshu control plane.

**Fleet boxes:** may ship with `JOSHU_CLOUD_BROWSER=1` in `instance.env`. Owners can switch back to local Chromium in Safety Settings; the saved choice wins on the next stack restart.

### Browser Use Cloud idle policy (fleet)

Browser Use Cloud sessions bill until stopped or Browser Use’s ~4h cap. Joshu stops them when idle so forgotten jWeb tabs and stack restarts do not leave paid orphans running.

**Design tradeoff:** optimize for **not paying for forgotten viewers and restart orphans**, not for keeping a warm session indefinitely. A stopped session is recoverable (`ensureCloudBrowser()` on the next need) but **in-tab state is lost** (cart, partial checkout, login cookies in that Browser Use profile).

#### Lifecycle signals

| Signal | Effect |
|--------|--------|
| **`CLOUD_BROWSER_IDLE_TIMEOUT_MS`** | Idle shutdown for cloud mode (default **300000** = 5 min). Falls back to `BROWSER_IDLE_TIMEOUT_MS` when unset. Timer resets on each qualifying **touch** (below). |
| **`busy()`** | Blocks stop while: local browser sidecar phase is `running` (local Chromium path), a **pending handoff** exists, or Hermes **`browser_*`** tools ran within the last **120s** (`hermesBrowserActivityRecent`). On fleet cloud boxes the sidecar is usually idle — **`browser_*` + handoff dominate**. |
| **Orphan reconcile** | On startup and every lifecycle tick (~30s), when in-memory session is null, Joshu **GET**s the control plane. If CP has an active browser and nothing is busy → **POST stop**. If busy → hydrate in-memory session so the normal idle timer applies. |
| **Live-frame touch** | `GET /api/browser/live-frame` resets idle only when the client passes **`?viewer=active`** (visible jWeb tab) or the request is a handoff viewer. Background/hidden tabs still get the cached iframe URL but **do not** keep the session alive. Implemented in [`cloud-live-frame.js`](../public/cloud-live-frame.js). |
| **Hermes ensure** | Patched `tools/browser_tool.py` POSTs **`/api/browser/ensure`** at the start of every `browser_*` call ([`patch-hermes-browser-cdp-guards.mjs`](../scripts/patch-hermes-browser-cdp-guards.mjs), marker `joshu_cloud_browser_ensure`) — see [Hermes self-heal](#hermes-browser-self-heal-cloud) below. Counts as Hermes activity (touch + 120s `busy()` grace). `retargetBrowserCdp()` in [`hermesApi.ts`](../src/hermesApi.ts) also notes activity. Requires gateway reload after patch. Older patches POST `/api/browser/touch` (idle timer only; still served). |
| **Handoff heartbeat** | While handoff status is **pending**, heartbeat (~20s) touches via [`browserHandoff/routes.ts`](../src/browserHandoff/routes.ts). Terminal handoffs stop touching. |
| **Kanban cancel** | Cancelling a realtime-goal kanban task cancels pending handoffs for that `kanbanTaskId` ([`broker.ts`](../src/realtimeGoals/broker.ts), kanban bridge), unblocking idle stop. |
| **SIGTERM / SIGINT** | `joshu-stack` shutdown POSTs cloud browser **stop** when cloud mode is enabled. |

**Stop rule (simplified):** stop when `now - lastTouch >= CLOUD_BROWSER_IDLE_TIMEOUT_MS` **and** `busy()` is false. Reconcile can stop sooner when the box restarted with no in-memory session but CP still holds a browser.

#### What keeps the session up (normal paths)

- Owner **watching jWeb** with the browser pane visible (poll + `viewer=active` every ~8s).
- Owner on a **pending handoff** page (heartbeat touches).
- **Kanban / Hermes worker** calling `browser_*` often enough that last touch stays within the idle window, or within the 120s `busy()` grace after each browser call.
- **Pending handoff** blocking stop even if touches pause briefly.

#### Premature-close risks (known)

| Scenario | Why it can stop early | Impact |
|----------|----------------------|--------|
| **Long gap between browser tools** | Fleet workers use Hermes `browser_*`, not the local `browser_task` sidecar. If a kanban run goes **>5 min** without a browser tool call (long LLM turn, email/calendar tools, etc.), idle wins even though the task is still “running”. The 120s `busy()` grace only extends **after** the last `browser_*` call, not across the whole run. | Next `browser_*` call re-provisions through `/api/browser/ensure` (same Browser Use profile, new `browserId`). **Open tabs, carts, and half-filled forms are gone**; logins saved to the profile usually survive. Main product risk for flight/booking flows. |
| **Background jWeb tab** | Pane open but tab/window **hidden** → no `viewer=active` touches. | Session stops after idle timeout. **Intentional** (cost control); can surprise someone who minimized the desktop. |
| **Kanban cancel while owner on handoff** | Cancel clears pending handoff → heartbeat returns 409, `busy()` clears. | Session can idle out within ~5 min even if the owner still has the handoff URL open. |
| **Stack restart** | In-memory session lost; orphan reconcile stops CP browser if nothing is busy. | Correct for orphans. Active work on the box dies with the restart anyway; CP stop prevents billing drift. |
| **Hermes ensure patch missing** | Image-baked patch older than the repo (the canary box on 2026-09-24 had the handoff lock only), or gateway not reloaded after patch. | No wake: after an idle stop every `browser_*` gets **CDP 502** from the dead Browser Use URL, and the worker starts debugging the box. `hotpatch-realtime-goals.sh` re-applies the current patch. |

**Not a risk:** SIGTERM on deploy (intentional); data corruption (stop is remote browser teardown only); local Chromium idle path (separate env / sidecar semantics).

#### After stop

- jWeb live-frame returns **`warming: true`** until a real viewer or agent calls ensure again (two consecutive visible polls for jWeb — see `noteLiveFramePoll()` in [`cloudBrowser.ts`](../src/cloudBrowser.ts)).
- Hermes / kanban **continues**; the next `browser_*` (via `/api/browser/ensure`) or explicit ensure starts a **new** Browser Use session (new `browserId`, same instance profile).
- Treat unexpected mid-task stops as **session loss**, not a retry of the same tab.

#### Hermes browser self-heal (cloud)

Trace `8a92b096` (canary box, 2026-09-24): after an idle stop, a kanban worker's `browser_navigate` hit **CDP 502** and the worker spent ~20 terminal calls reverse-engineering the box (ps/ss, grepping `dist/`, `hermes config set browser.cdp_url`) before driving Camofox REST by curl. Two causes: nothing on the Hermes path woke the browser, and Hermes resolves `BROWSER_CDP_URL` (process env, fixed at gateway/worker start) **before** `browser.cdp_url` in config.yaml — so even after Joshu rotated the session and rewrote config, running workers kept dialing the dead URL.

| Piece | Behavior |
|-------|----------|
| **`POST /api/browser/ensure`** ([`server.ts`](../src/server.ts), localhost only) | Cloud: `ensureLiveCloudBrowser()` in [`cloudBrowser.ts`](../src/cloudBrowser.ts) — trust a session that answered a CDP probe in the last **30s**; else probe `${cdpUrl}/json/version` (3s); if missing/dead → control-plane **ensure** (CP checks Browser Use, recreates on the same profile). Returns `{ ok, backend: "cloud", cdpUrl }`, or **502 `browser_unavailable`**. Local backends: `{ backend: "local", cdpUrl: "" }`. Concurrent calls share one round trip. |
| **Patched `browser_tool.py`** | Before every `browser_*` (navigate, snapshot, click, type, scroll, back, press, console, get_images, vision): call ensure; when `cdpUrl` changed, set `os.environ["BROWSER_CDP_URL"]` in-process and drop cached `_active_sessions` bound to the old host (marked expired so cleanup skips `agent-browser close`). On `browser_unavailable`, return a tool error telling the worker to retry once then `kanban_block("system: …")`. Falls back to `/api/browser/touch` on stacks without `/ensure`. |
| **Broker** | `kanban_block` reasons starting with **`system:`** classify as system blocks ([`blockCause.ts`](../src/realtimeGoals/blockCause.ts)) → bounded auto-recovery, never paged to the owner as a question. |
| **Skill** | [`joshu-browser-handoff`](../integrations/hermes/skills/browser/joshu-browser-handoff/SKILL.md) — *Browser down = system problem*: never inspect the box, change Hermes config, or curl local browser APIs. |
| **Terminal guard** | `hermes config set|edit|…` and writes to `~/.hermes/config.yaml` are blocked for the agent terminal ([`patch-hermes-terminal-secrets-guard.mjs`](../scripts/patch-hermes-terminal-secrets-guard.mjs)). |

The old touch patch inserted its call right after each `def` line — inside `browser_snapshot`'s multi-line signature, a Python syntax error. The ensure patch inserts after the signature and docstring and removes those legacy lines on upgrade. It also adds a module-level `import requests`: upstream imports it only lazily, so the handoff-lock helper's `requests.get` raised `NameError` (swallowed) and the lock was silently off.

#### Cloud handoff page (phone) — live view and form overlay

Fixes from the same canary-box session (AA passenger-details checkout, 2026-09-24):

| Symptom | Cause | Fix |
|---------|-------|-----|
| Live view says **"browser unavailable"** | [`cloud-live-frame.js`](../public/cloud-live-frame.js) built the poll URL with `new URL(path, location.origin)`, dropping the `/joshu/` base whenever the path had a query (the handoff token) → `/api/browser/live-frame` 404. jWeb's query-less path also never sent `viewer=active`. | Resolve against `document.baseURI`; always add `viewer=active` for visible/interactive viewers. |
| Live view **blanks and reloads every ~15s** | [`handoff.js`](../public/handoff.js) `maybeWarm()` judged readiness by Camofox health, which always reads "not running" on cloud boxes, so the 8s status loop re-called `connectLive()` → a new iframe (and a leaked poller) each time. | Skip Camofox warm in cloud mode; mount the cloud frame once (it reloads itself only when Browser Use starts a new `browserId`). |
| Overlay status shows **`handoff_token_required`** | `getJson()` appended `?t=…` to `form-fields?fast=1` → `?fast=1?t=…`, so the fast scan had no token. | `withToken()` appends with `&` when the path already has a query. |
| Overlay **dropdowns truncated** (DOB year stopped at 2004, countries at "Belgium") | Field catalog kept ≤24 `<option>`s per select ([`chromiumSession.ts`](../src/chromiumSession.ts) `scanFrame`, and the Camofox copy in `patch-camofox-single-tab.mjs`). | `MAX_SELECT_OPTIONS = 300` (the LLM labeler still trims to 12). Select fill uses the native `HTMLSelectElement` value setter so framework trackers see the change. |

**Native `<select>` in the live picture:** tapping a page dropdown inside the Browser Use iframe may show nothing — Chrome draws native select popups outside the streamed page surface. Owners pick values in the **form overlay** and tap **Fill**.

#### Tuning and ops

| Goal | Action |
|------|--------|
| More headroom for long runs | Raise **`CLOUD_BROWSER_IDLE_TIMEOUT_MS`** on the box (e.g. 600000–900000). Fleet default matches `BROWSER_IDLE_TIMEOUT_MS=300000` from control-plane provision. |
| Force stop now | Inside `joshu-stack`: `stopCloudBrowser()` (CP POST stop). Clear pending handoffs; close visible jWeb browser panes. |
| Verify CP state | CP GET `/api/instances/browser-use/browsers` → `404 browser_not_running` when stopped. |
| Patch drift | `bash scripts/hotpatch-realtime-goals.sh <slug>` copies the current browser + terminal patch scripts into the container, applies them, `py_compile`s both tools, and reloads the gateway. Manually: `docker cp` the script in, `node patch-hermes-browser-cdp-guards.mjs /opt/hermes-agent/tools/browser_tool.py`, reload gateway. Check: `grep joshu_cloud_browser_ensure /opt/hermes-agent/tools/browser_tool.py`. |
| Tests | `npm run test:cloud-browser-lifecycle`, `npm run test:browser-handoff`, `npm run test:hermes-tool-patches` |

#### Possible follow-ups (not implemented)

- Tie `busy()` to **active Hermes / kanban run** (not only last `browser_*` + 120s).
- Align Hermes activity grace with idle timeout (e.g. both 5–10 min).
- Touch on **any** tool during a browser-tagged kanban task, not only `browser_*`.
- Control-plane stop on deprovision / stale-browser cron (fleet-wide orphan sweep).

Legacy **Camofox (Firefox)** still boots on very old images without `/opt/browser/entrypoint.sh`; current images use **Chromium** for the local path.

## Chromium CDP (shared browser)

Local `scripts/ensure-camofox-container.sh` starts **one headed Chromium** (`joshu-chromium-cdp:local`) instead of Camofox. CDP is `http://127.0.0.1:9222` (published on localhost only). Chrome 136+ binds DevTools to container localhost, so the supervisor proxies `0.0.0.0:9222` to that socket. noVNC stays on `:6080`, and the control health port stays `:9377` so jWeb and handoff keep the same URLs.

Joshu drives that browser with Playwright `connectOverCDP` when `BROWSER_CDP_URL` is set (`scripts/dev-arozos.sh` exports it). Form scan, fill, and paste run in the page. Hermes attaches to the same CDP endpoint (`browser.cdp_url`) with `browser.backend: off`. See [Why Hermes `browser.backend` is off](#why-hermes-browserbackend-is-off).

Decodo is unchanged: the container gets `PROXY_*` (`PROXY_HOST=us.decodo.com`, `PROXY_PORTS=10001-10010`, country `us`). When credentials are set, `supervisor.mjs` runs a localhost auth-inject proxy (`127.0.0.1:8877`, [`localProxy.mjs`](../browser/chromium/localProxy.mjs)) and points Chromium at it with `--proxy-server`. Raw CDP clients never see Decodo's `Proxy-Authorization`. Health on `:9377` reports `proxyPort` and `localProxyPort`.

**Port rotation.** A CONNECT that is not HTTP 200, times out, or drops tries the next `PROXY_PORTS` entry before Chrome is told the tunnel failed. Chromium stays on `127.0.0.1:8877`, so the tab and its cookies survive the switch. A tab already showing Chrome's error page (`chrome-error://chromewebdata/`, body `ERR_TUNNEL_CONNECTION_FAILED` or "This site can't be reached") is reloaded on the next port, up to three times. `POST /rotate-proxy` only relaunches Chromium when the upstream address was passed straight to the browser. With the local proxy it only advances `proxyPort`. Joshu's own `goto` treats that error the same way and reloads instead of killing Chrome.

**Startup probe.** Before launch, the supervisor CONNECTs to `probe.example:443` on each port. Decodo often answers that name with `502`, so every port looks unhealthy, the log says `no healthy upstream port found; launching anyway`, and the browser still starts. The first real site CONNECT then rotates. `proxyPort` in `/health` is the port after that rotation, not proof that the probe passed.

**What a tunnel error costs.** The handoff viewer is the live tab. `ERR_TUNNEL_CONNECTION_FAILED` means the checkout never loaded; the address bar host is only Chrome's error title. After the proxy recovers, a reload requests that URL again. An airline cart does not come back; the site usually returns its search form. Restarting `supervisor.mjs` starts a new profile under `/tmp/playwright_chromiumdev_profile-*`, so cookies die even if the proxy is healthy.

These files live in the image's `/opt/browser` layer. A hotpatch there is lost when the container is recreated. `vps-start.sh` copies `/opt/joshu/hotfix/browser` only when `/opt/browser/entrypoint.sh` is missing, which it is not on a box that already booted Chromium. Image `0.1.46` does not contain the rotation above.

**Viewer shape.** CDP screencast is not locked to 4:3. jWeb fills its pane and the phone handoff fills the picture above the form. Each viewer sends that box over the screencast socket (`{type:"viewport"}`). [`viewportForBox`](../src/browserViewport.ts) turns it into a browser size whose area stays near **1024×768**. A tall phone becomes a portrait viewport; a wide jWeb pane becomes landscape. There is one Chromium, so the last viewer to resize wins. noVNC, when it is still the live path, stays letterboxed at 4:3. Default Xvfb is `1600x1600` when `VNC_RESOLUTION` is unset, so a portrait window has room; an existing box keeps the resolution it was created with until the browser process starts again.

**Browser agent Python.** `browser-use` is installed in the 3.12 venv (`/opt/browser/venv/lib/python3.12/site-packages`). The venv's plain `python` can be a 3.13 symlink, and that interpreter cannot import `browser-use` (`No module named 'browser_use'`, `browser_task` returns 502, agent phase `error`). [`entrypoint.sh`](../browser/chromium/entrypoint.sh) starts the sidecar with `python3.12` when that binary exists. A task error with that message means the running agent is on the wrong interpreter; restart it with `/opt/browser/venv/bin/python3.12`, not `python`.

**Handoff form fields.** The overlay scans inputs inside open shadow roots. A control that is 1×0 is still included when its custom-element host is visibly sized (Alaska `mbx-auro-input` / `mbx-auro-select`). Fill writes the host's `value` as well as the inner control, because the picture follows the host. The overlay does not rebuild while the owner has typed, so a page-key poll cannot wipe the form. "I'm done" marks the handoff complete and, if the record has no `sms:` session, continues on the owner phone from Telephone settings. A kanban worker often mints the handoff without `hermesSessionKey`.

Fleet images that do not yet contain `/usr/bin/chromium` and `/opt/browser/entrypoint.sh` still boot Camofox. Once the image has both, `vps-start.sh` starts the Chromium supervisor and exports `BROWSER_CDP_URL`.

Working notes for the jWeb (human-in-the-loop) browser stack: Joshu, Hermes,
Camofox, noVNC, and ArozOS subservices.

## Hermes vs VNC

Hermes and jWeb VNC are **parallel paths into the same Chromium page**, not the
same pipeline:

- **Hermes** attaches with `browser.cdp_url` and `browser.backend: off`. It does
  **not** go through VNC pixels. Why that backend is forced off is below.
- **jWeb / mobile handoff** is the human view: noVNC canvas → websockify →
  x11vnc → that same Chromium on Xvfb.
- Shared-tab contract: Joshu and Hermes both use the existing page. Extra tabs
  are closed unless they are an OAuth popup. Handoff lock and the browser write
  gate live in [`scripts/patch-hermes-browser-cdp-guards.mjs`](../scripts/patch-hermes-browser-cdp-guards.mjs).

Older notes below describe the Camofox HTTP path. Fleet images that do not yet
ship `/usr/bin/chromium` and `/opt/browser/entrypoint.sh` still boot that path.

Faster VNC redraw helps humans. It does not speed up Hermes tool calls.

## Why Hermes `browser.backend` is off

Hermes [Browser Use mode](https://hermes-agent.nousresearch.com/docs/user-guide/features/browser#browser-use-mode-default)
is one `browser_exec` tool: the Hermes model writes Python and the CLI runs it,
often in Hermes's own browser. Joshu does not use that mode and does not use
Browser Use Cloud's hosted Chromium.

When `BROWSER_CDP_URL` is set, Joshu still writes `browser.backend: "off"` and
drops the Hermes `browser` toolset. Web work is `browser_task`, which calls a
sidecar (`browser/chromium/agent-service.py`) running the browser-use **Agent**
class against that same CDP Chromium. The model is `ChatBrowserUse`. Fleet
boxes send those completions to the control-plane relay
(`BROWSER_USE_LLM_URL`); the `bu_` key stays on the control plane. jWeb and
handoff watch the tab with CDP screencast, not noVNC. Xvfb remains so Chromium
has a screen.

That Hermes default is the wrong driver for this stack:

- **One window.** With no cloud provider and no `/browser connect`, Browser Use
  mode launches Hermes's own Chromium and closes it after
  `browser.inactivity_timeout` (120s in the Joshu Hermes config). A `session`
  name starts another browser. The phone is noVNC of one long-lived headed
  Chromium, with Decodo set at launch. Hermes has to drive that process.
- **The lock is a split between tools.** While a handoff is pending,
  `browser_snapshot` still works and navigate, click, type, press, and back are
  refused. `browser_exec` is one Python call that can look and click, so the
  lock in [`scripts/patch-hermes-browser-cdp-guards.mjs`](../scripts/patch-hermes-browser-cdp-guards.mjs)
  cannot express that split.

Older Hermes checkouts ignore an unknown `backend` key and already expose the
built-in tools. Writing `off` keeps a newer Hermes on those tools.

## VNC stack versions

| Layer | Pin | Role |
|-------|-----|------|
| **noVNC client** | **1.7.0** in [`public/vendor/novnc/`](../public/vendor/novnc/) | JS RFB viewer (`core/rfb.js`); Joshu-served |
| **websockify** | Debian bookworm `python3-websockify` (~0.10.0) | WebSocket → TCP `:5900` |
| **x11vnc** | Debian bookworm `x11vnc` **0.9.16** | VNC server on Xvfb |
| **Camofox** | **1.16.0** (`camofoxBase` digest in [`deploy/RELEASE.json`](../deploy/RELEASE.json)) | Firefox + Playwright API + VNC plugin; 1.16 uses `buildLaunchOptionsWithGeoipFallback` + `attachPopupHandler` (HITL patch skips managed popups) |

`api/status` `novnc.clientBaseUrl` is `/joshu/vendor/novnc`. `novnc.websocketPath`
stays `/joshu/novnc/websockify` (proxied to Camofox `:6080`). Refresh the client
with `node scripts/sync-novnc-public.mjs --fetch`.

**Deploy note:** `public/vendor/novnc/` is vendored in git and baked into images
**0.1.45+**. On **0.1.44** boxes, hotpatch must sync `public/` (including
`vendor/novnc/`) — a restart without those files causes jWeb
`Failed to fetch dynamically imported module …/rfb.js`. Compose bind-mounts
`../public:/opt/joshu/public:ro` so host `git pull` + rsync survives recreate.

**Mobile pinch-zoom / pan / scroll:** stock noVNC 1.7 maps pinch to Ctrl+Scroll on
the remote. Joshu [`public/vnc-gestures.js`](../public/vnc-gestures.js) intercepts
two-finger gestures on coarse pointers:

| Gesture | At 1× | While zoomed |
| --- | --- | --- |
| Pinch (finger separation dominates) | Local zoom 1×–5× | Adjust zoom |
| Two-finger drag (midpoint travel dominates) | Remote scroll via [`vnc-scroll.js`](../public/vnc-scroll.js) → Playwright | Local pan |

Each two-finger touch **locks one mode** for that gesture (midpoint vs
separation dominance). A fixed 2% pinch threshold alone misclassified vertical
scroll drags as zoom — avoid reintroducing threshold-only classifiers.

One-finger taps while zoomed are inverse-mapped back into canvas layout coords
before noVNC sends VNC pointer events (CSS transform alone would miss buttons).
Handoff always attaches gestures; jWeb when `(pointer: coarse)`.
Upstream `RFB.trackpadMode` is still an unmerged PR
([novnc/noVNC#2065](https://github.com/novnc/noVNC/pull/2065)).
On fleet boxes, rsync host `public/` after image bake (bind-mount is `:ro`, so
`docker cp` into the container is not required). Self-host: rebuild or rsync
`public/` into the running stack's mounted public directory.

**x11vnc redraw knobs** (env → [`scripts/camofox-vnc-watcher.sh`](../scripts/camofox-vnc-watcher.sh)):

| Variable | Default | Notes |
|----------|---------|--------|
| `X11VNC_NOXDAMAGE` | `1` | Historical default. Set `0` to try X DAMAGE partial updates |
| `X11VNC_THREADS` | `1` | Pass `-threads` |
| `X11VNC_DEFER` | `10` | Batch screen updates (ms) |
| `X11VNC_WAIT` | `10` | Poll interval (ms) |
| `X11VNC_FRAMERATE` | unset | Optional cap |

## Current shape

- **`npm run dev:arozos`** mirrors production topology locally: Camofox, optional
  Hindsight, source-built ArozOS, Joshu on loopback at `/joshu`, ArozOS public on
  `127.0.0.1:8787`.
- **`arozos/subservice/joshu/`** — jWeb module; `start.sh` runs
  `scripts/aroz-subproxy.mjs` to reverse-proxy `/joshu/*` to Joshu on `8788`.
- **`scripts/patch-camofox-single-tab.mjs`** — applied at Docker image build and
  on local Camofox container create. Also re-applied at VPS boot when markers are
  missing (`deploy/scripts/vps-start.sh` → `repair_camfox_server_js`).
- Pins in [`deploy/RELEASE.json`](../deploy/RELEASE.json):
  - **`hermesRef`** — Hermes Agent git SHA
  - **`camofoxBase`** — `ghcr.io/jo-inc/camofox-browser@sha256:…` (digest; not `:latest`)
- Sync Dockerfile defaults: `npm run vps:sync-hermes-pin`, `npm run vps:sync-camofox-pin`
  (both run in `vps:predeploy` / `vps:build-image`).

### Bumping Camofox

1. `docker pull ghcr.io/jo-inc/camofox-browser:latest` and test the patch:
   `node scripts/patch-camofox-single-tab.mjs` against `/app/server.js` in the container.
2. Set `camofoxBase` in `deploy/RELEASE.json` to the image digest
   (`docker inspect --format='{{index .RepoDigests 0}}' …`).
3. `npm run vps:sync-camofox-pin` then rebuild (`npm run vps:build-image`).
4. Local dev: `docker rm -f camofox-hitl && bash scripts/ensure-camofox-container.sh`
   (reads `camofoxBase`; override with `CAMOFOX_BASE` for experiments).

Desktop shortcuts: [`arozos-desktop-shortcuts.md`](arozos-desktop-shortcuts.md).

### jWeb UI (URL bar + identity bubble)

jWeb is **browser-first**: full-width Camofox/noVNC, no legacy Hermes run sidebar.

| UI | Role |
| --- | --- |
| **URL bar** (browser chrome) | `POST /joshu/api/camofox/navigate` → Playwright `ensureTab(url, { navigateExisting: true })`. Use this for addresses — **not** Paste into field (that targets page inputs via insert-text, not Firefox chrome). |
| **Paste into field** | Page form fields only (`insert-text`). Clipboard bar hint explains the split. |
| **Identity bubble** (`public/jchat-bubble.js`) | Chat Head FAB from `GET /joshu/api/instance/identity`; click posts `joshu:toggle-jchat-docked` to the ArozOS desktop (same docked jChat as the taskbar avatar). Closed by default — no embedded iframe. |

Status poll updates the URL bar from `lastBrowserUrl` unless the owner is editing it.

## VNC clipboard (paste / copy)

**x11vnc does not reliably exchange clipboard with the Mac/host.** Braces and
JSON get mangled on keystroke paste; Cmd+C inside Camofox does not reach the
host clipboard.

## Mobile owner browser handoff

When the agent has **staged a sensitive or owner-only step** (payment, login, 2FA, irreversible
confirm, etc.) in the shared Camofox tab, use **`browser_handoff_request`** (Hermes plugin
`joshu-browser-handoff`) to share a link for the box owner to take over on their phone.

| Step | Who | Action |
|------|-----|--------|
| 1 | Agent | `browser_navigate` to the staged handoff page in shared tab |
| 2 | Agent | `browser_handoff_request(instructions=…)` → returns `https://{slug}.box.joshu.me/joshu/handoff/{id}` |
| 3 | Owner | Opens link on phone → **signs in with box username/password** (even if already on the desktop) → instructions + embedded noVNC. Password fields have a **show/hide** eye toggle ([`public/handoff-password-toggle.js`](../public/handoff-password-toggle.js)). |
| 4 | Owner | Types in native fields (Fill stays disabled until something is typed), or **More Options** for Scan / paste; taps **I'm done** when finished |
| 5 | Agent | Poll `browser_handoff_status` → `completed`, then `browser_snapshot` to verify |
| 5b (SMS) | Joshu | After **I'm done**, `deliverSmsHandoffContinuation` waits 20s, runs a Hermes turn on the same `sms:` session, texts the owner the assistant reply (never `nylas_send_message`) |

**Session continuity:** handoff pins the staged `pageUrl`, blocks `CAMOFOX_START_URL` bootstrap
while pending, and the handoff page sends **heartbeat** every 20s (Camofox tab keepalive +
extends expiry on owner activity). Do not navigate away or restart Camofox during pending handoff.

**Owner SMS:** any inbound owner text auto-completes a pending handoff for that SMS session before
the agent's turn (`ownerHandoffConfirm.ts`). **jChat/voice:** Hermes calls **`browser_handoff_complete`**.
The owner does not have to tap **I'm done** on the mobile link.

**SMS continuation:** [`src/browserHandoff/smsContinue.ts`](../src/browserHandoff/smsContinue.ts) must use the **Joshu process singleton** `HermesApiRunner` from [`src/server.ts`](../src/server.ts) (passed through [`registerBrowserHandoffRoutes`](../src/browserHandoff/routes.ts)). Do **not** construct a second `HermesApiRunner` in the handoff path — an orphan runner sees a healthy `:8642` but does not own `this.gateway`, so `ensureApiServer()` logs `replacing existing Hermes gateway with current process env`, SIGTERMs the live gateway, and the in-flight chat stream aborts with **`terminated`**.

Skill: [`integrations/hermes/skills/browser/joshu-browser-handoff/SKILL.md`](../integrations/hermes/skills/browser/joshu-browser-handoff/SKILL.md).

**Implementation:** [`src/browserHandoff/`](../src/browserHandoff/) (store + APIs), mobile shell [`public/handoff.js`](../public/handoff.js) + [`public/handoff-shell.css`](../public/handoff-shell.css) served at `GET /joshu/handoff/:id?t=&exp=`, Hermes plugin [`.hermes/plugins/joshu-browser-handoff/`](../.hermes/plugins/joshu-browser-handoff/), lock patch [`scripts/patch-hermes-camofox-handoff-lock.mjs`](../scripts/patch-hermes-camofox-handoff-lock.mjs) (via `scripts/apply-hermes-hitl-patch.sh`).

**Auth:** the signed `t`/`exp` query is a capability token (proves the SMS link). Opening the
link always shows a **Joshu sign-in gate** (box username + password checked against ArozOS
`/system/auth/login`). An existing desktop session cookie is **not** enough — HITL re-prompts
every time. Success sets an HttpOnly `joshu_handoff_auth` cookie for that handoff id. Direct
localhost (no proxy headers) skips the gate for Hermes/tests. Caddy `/joshu/*` does **not** go
through ArozOS auth, so Joshu must enforce this itself.

### Mobile overlay (native fields + VNC on top)

noVNC is a canvas, so the phone OS will not open a keyboard on remote inputs. The handoff page
puts **VNC in the remaining viewport** (header is a compact logo + brief) and a **native field
panel below**. Two fingers on the VNC pane: scroll the remote page at 1×, or
pinch/pan the picture when zoomed (`vnc-gestures.js`). Type in the native
fields, not the remote Firefox inputs.

1. Joshu scans Camofox with Playwright (`POST /tabs/:id/form-fields`) — frames + shadow DOM.
2. A Joshu-side JSON LLM call **labels fields and picks Continue / Sign in** from a **sanitized
   catalog** (ids, types, placeholders, button text). Live values and owner overlay input never
   go to the model, Hermes, or Langfuse.
3. The owner types in real `<input>`s (keyboard works). **Fill fields** stays disabled until
   they edit a field.
4. **Fill and continue** posts values to `POST /joshu/api/browser-handoff/:id/fill-form` → Camofox
   `fill-form` (native setter + click by catalog button id). No AI on this path.
5. The overlay **auto-rescans** when the remote URL or field shape changes (poll `page-key`, no LLM).
   **Scan fields** lives under **More Options** as a manual override. **I'm done** is bottom-right.

Fallback: **More Options** also has paste-into-focused-field for CAPTCHA / custom widgets. Heuristic labels
are used if OpenRouter is down.

Direct viewer (no instructions shell): `/joshu/camofox-viewer.html`.

Joshu bypasses VNC entirely. One visible buffer + two buttons:

| Action | UI | Joshu API | Camofox |
|--------|----|-----------|---------|
| Navigate to URL | **URL bar → Go** | `POST /joshu/api/camofox/navigate` | Playwright navigate on shared HITL tab |
| Paste into focused field | **Paste into field**, or **Cmd+V** on the page | `POST /joshu/api/camofox/insert-text` | HITL `POST /tabs/:id/insert-text` (DOM insert at caret) |
| Overlay scan (handoff) | **More Options → Scan fields** (auto on page change) | `GET /joshu/api/browser-handoff/:id/form-fields` | HITL `POST /tabs/:id/form-fields` + Joshu LLM labels |
| Overlay page watch | (poll) | `GET /joshu/api/browser-handoff/:id/page-key` | Playwright evaluate — URL + control shape, no stamps |
| Overlay fill (handoff) | **Fill and continue** | `POST /joshu/api/browser-handoff/:id/fill-form` | HITL `POST /tabs/:id/fill-form` (no LLM) |
| Copy selection / focused field | **Copy from browser**, or **Cmd+C** on the page | `POST /joshu/api/camofox/copy-selection` | `evaluate` + HITL `POST /tabs/:id/selection` |
| Wheel / arrow / Page keys | host bridge in jWeb | `POST /joshu/api/camofox/scroll` | Playwright `/scroll` or `/press` (VNC wheel often drops) |

Cmd+V on the VNC pane uses the browser **paste event** (`clipboardData`) so it
does not need clipboard-read permission inside the ArozOS iframe. The textarea
is a fallback when the Mac clipboard API is blocked: paste into the box, then
**Paste into field**.

Wiring: `public/vnc-clipboard.js` (`pasteViaApi` / `copyViaApi`) ← `public/app.js` /
`public/camofox-viewer.html`. Do **not** send VNC `clipboardPasteFrom` / Ctrl+V
keysyms — that path mangles `{`/`}` and is no longer used.

The Camofox **insert-text** and **selection** routes are not upstream — they are
injected by `scripts/patch-camofox-single-tab.mjs` (`HITL_INSERT_TEXT_ROUTE`,
`HITL_SELECTION_ROUTE`, `HITL_FORM_FIELDS_ROUTE`, `HITL_FILL_FORM_ROUTE`). `vps-start`
re-applies the patch when those markers are missing. Without insert-text, Joshu
falls back to `/evaluate`. Overlay scan/fill require the form HITL routes.

Live-box UI hotpatch: `public/` is image-baked — after recreate, `docker cp` the clipboard HTML/JS into `/opt/joshu/public/` or the next image bake. Lane table: [`vps-sandbox/hotpatch-running-box.md`](vps-sandbox/hotpatch-running-box.md).

## Tab reaper / blank-page resets

Upstream Camofox closes tabs idle for `TAB_INACTIVITY_MS` (default **5 minutes**),
using `toolCalls` as the activity signal. **VNC clicks do not increment
`toolCalls`**, so jWeb sessions look idle and get reaped even while a human is
using the browser.

HITL patch behavior:

- `TAB_INACTIVITY_MS` from env; **default `0` disables the reaper**
- `GET /tabs` touches `lastAccess` / reaper counters (**HITL keepalive** — Joshu
  status polls this path)
- Prefer a **timeout + warm-on-open** (default `BROWSER_IDLE_TIMEOUT_MS=300000`)
  over always-on Firefox; set `0` only if you need VNC to never go cold
  (CPU cost)

VPS start exports `TAB_INACTIVITY_MS="${TAB_INACTIVITY_MS:-0}"` and
`BROWSER_IDLE_TIMEOUT_MS="${BROWSER_IDLE_TIMEOUT_MS:-300000}"` (5 minutes).

### jWeb idle shutdown vs “crash”

**Intended lifecycle:** after ~5 minutes with no Camofox sessions, Firefox
idle-shutdowns (`browser idle shutdown`) to free CPU/RAM. Opening jWeb (or
`POST /joshu/api/camofox/fit-viewport`) creates a tab again and VNC reconnects.

**Bug (validated on patrick, 2026-08-21):** idle shutdown worked, but jWeb only
polled status and sat on “waiting for Camofox browser” — no warm path — so it
looked crashed for hours.

**Bug (validated on patrick, 2026-08-22):** warm-on-open relaunched Firefox, but
Camofox `vnc-watcher` only attaches x11vnc when the **Xvfb display number**
changes. Idle shutdown kills Xvfb; the next tab recreates **`:99`**, so the
watcher never starts x11vnc again. noVNC gets **1011** (`connection refused` on
`:5900`) — jWeb looks like it **instantly crashes**. Overlay:
`scripts/camofox-vnc-watcher.sh` via `scripts/patch-camofox-vnc-watcher.sh`
(image build + `vps-start`).

**Bug (validated on patrick, 2026-09-20, 0.1.46):** two independent launch
failures stacked after recreate. (1) camoufox-js saw an **empty**
`/root/.cache/camoufox/addons/UBO` (failed AMO download / mkdir race) and
treated it as extracted — every `POST /tabs` 500'd
(`manifest.json is missing`) so `fit-viewport` stayed **502**. Repair: delete
the empty dir (or wait for `HITL_ADDON_MANIFEST_REPAIR` in
`patch-camofox-single-tab.mjs`). (2) Camoufox 1.16 starts
`Xvfb -displayfd N` (no `:99` in argv). The watcher regex never found a
display, so x11vnc never bound `:5900` even after Firefox was up. Overlay
marker: `HITL_VNC_DISPLAYFD`.

**Hardening (keep the timeout; make start/stop clean):**

| Knob | Default | Why |
|------|---------|-----|
| `BROWSER_IDLE_TIMEOUT_MS` | `300000` (5m) | Shut Firefox down when unused |
| `CAMOFOX_START_URL` | `https://joshu.me/` | Default jWeb home on warm |
| jWeb UI | `fit-viewport` when browser down | Auto-warm + clear VNC backoff on open |
| Agent / EA | `POST /joshu/api/camofox/warm` | Same bootstrap as fit-viewport **without** viewport resize |

Set `BROWSER_IDLE_TIMEOUT_MS=0` only if you truly need always-on VNC (accepts the
CPU cost). Repair on a live box: update `/etc/joshu/instance.env`, recreate
`joshu-stack`, then open jWeb once to confirm warm.

### Cold-launch warm (Calendly-class SPAs)

**Problem:** After idle shutdown, the first `browser_navigate` / `open_url` straight
into a heavy SPA (Calendly booking, similar) often crashes or 500s the Camofox
session — cold Firefox + first paint of a large app is fragile.

**Fix (baked in `scripts/patch-camofox-single-tab.mjs`):** on a fresh Camoufox
launch (or within ~2m of `_lastBrowserRestartAt`), before navigating to a URL
that is **not** already `CAMOFOX_START_URL`, Camofox loads the start URL first
(`domcontentloaded`), then continues to the target. Logs:
`hitl cold launch warm before heavy nav`.

**Belt-and-suspenders for agents:** before the first navigate on a cold browser,
call `POST /joshu/api/camofox/warm` (alias of fit-viewport bootstrap without
resize). EA scheduling skill documents a **2-navigate retry budget** then email
fallback — do not loop Calendly submits.

### Browser recover + proxy tunnel (heavy SPAs, residential proxy)

**Problem:** Heavy OTAs and similar SPAs can wedge a Camofox tab (`navigate` HTTP
**404/500/502/503/504**) or load a **proxy/CDN tunnel failure page** (Cloudflare
**522**, “proxy server is refusing connections”) without throwing on `goto`. Agents
that keep hammering the same tab make it worse.

**Fix (generic, below the skill layer):**

| Layer | Script | Behavior |
|-------|--------|----------|
| **Hermes** | [`patch-hermes-camofox-browser-recover.mjs`](../scripts/patch-hermes-camofox-browser-recover.mjs) (via `apply-hermes-hitl-patch.sh`) | On recoverable navigate HTTP errors: `POST /joshu/api/camofox/warm`, drop stale `tab_id`, retry navigate once. On proxy-failure snapshot text: same warm + retry + refreshed snapshot (`proxy_recovered: true`). |
| **Camofox** | [`patch-camofox-single-tab.mjs`](../scripts/patch-camofox-single-tab.mjs) | After navigate/snapshot: detect 522-class HTML → rotate to a **fresh proxy context** and replay the last URL (max **2** retries via `proxyRetryCount`). Extends `isProxyError()` for thrown tunnel errors. |

Restart **Hermes gateway** after Hermes patch changes; restart **Camofox** (or
recreate stack) after Camofox patch changes. Marker strings: `hitl_browser_recover`,
`HITL_PROXY_TUNNEL_DETECT`.

## `CAMOFOX_START_URL` / `about:blank`

- VPS default is **`https://joshu.me/`**.
- Joshu `normalizeHttpUrl` accepts `about:blank`; bootstrap does **not** navigate
  an existing non-blank tab unless `navigateExisting` is set.
- Status polling must **not** call `ensureTab(START_URL)` on every tick (that
  used to reset users mid-session).
- Camofox patch `__hitlStartUrlFromEnv()` treats blank / empty as “no auto URL”
  (never coerces to a surprise site).
- Cold-launch warm (above) uses this URL as the light first paint before a
  different heavy target.

Per-box overrides (Slack apps URL, etc.) belong in `instance.env` — do not
hardcode customer sites in AGPL sources.

## VNC display routing and troubleshooting

Use the Camofox container logs and `CAMOFOX_URL` health check when the noVNC iframe is blank. See [`self-host.md`](self-host.md) for Camofox env vars.

### Ports and URLs (local `npm run dev:arozos`)

| URL | What it is |
|-----|------------|
| `http://127.0.0.1:8788/joshu/...` | Joshu Express **directly** (always works if Joshu is up) |
| `http://127.0.0.1:8787/...` | ArozOS public desktop only |
| `http://127.0.0.1:8787/joshu/...` | Joshu **only** when the **jWeb** subservice is registered and running |

If `8787/joshu/*` returns ArozOS **404**: check boot logs for
`[Subservice] Subservice Registered: jWeb`; remove
`.local/arozos-data/subservice/joshu/.disabled` if present.

### Hermes scroll / simple actions “reload” the browser

**Cause:** wrong Camofox identity (`user_id` / session mismatch) or over-aggressive
single-tab patch closing all tabs.

**Fix:** Joshu `ensureJoshuHermesConfig()` writes `browser.camofox.user_id`,
`session_key`, `adopt_existing_tab: true`. Recreate Camofox after patch changes.
Restart Hermes gateway after config changes.

### Google / GitHub OAuth popups look like a crash-reload

**Cause:** HITL single-tab used to coerce every popup into the opener (`location.assign`
the popup URL, then close the popup). Google and GitHub OAuth need the **opener**
(RapidAPI, etc.) to stay put while the IdP runs in `window.open`. Forcing the
identifier URL into the main tab drops the OAuth client, Playwright can lose the
page (`activeTabs: 0` while Firefox is still running), and the handoff overlay
spam-polls `page-key` as 502 — looks like the picture loaded and reloaded.

**Fix (v6):** `__hitlPopupCoerceV6` leaves Google / GitHub / Microsoft / Apple
popups on the IdP, then **assigns the app callback URL into the opener** (classic
OAuth `redirect_uri`). v5 bailed after 5m on the IdP (`still on IdP — leaving open`)
so late callbacks never coerced — v6 keeps polling + `framenavigated` listener up to
15m. Do **not** fullscreen-resize GIS windows. Camofox **`MAX_TABS_PER_SESSION`
default 4** so the opener is not recycled. Slack `/z-app/` magic links still coerce
after the redirect chain. Logs: `hitl oauth popup waiting for callback`.

**502 page-key loop:** when `activeTabs: 0` but `browserRunning: true`, handoff
`maybeWarm` + heartbeat recreate the pinned tab via `fit-viewport` / `ensureTab`.

### Environment and scripts

| Variable / script | Role |
|-------------------|------|
| `VNC_RESOLUTION`, `CAMOFOX_VIEWPORT_WIDTH`, `CAMOFOX_VIEWPORT_HEIGHT` | Xvfb + launch window (apply at **container create**). Unset `VNC_RESOLUTION` defaults to **1600×1600** so a portrait screencast fits. Live screencast size is `viewportForBox`, not this window |
| `ENABLE_VNC` + Camofox `plugins.vnc.enabled` | noVNC on `:6080` — Camofox **1.6+** requires both (see troubleshooting) |
| `CAMOFOX_START_URL` | Default tab URL when none exists (`https://joshu.me/`) |
| `TAB_INACTIVITY_MS` | Camofox tab reaper; **`0` for jWeb HITL** (default on VPS) |
| `MAX_TABS_PER_SESSION` / `CAMOFOX_MAX_TABS` | Default **4** so Google/GitHub OAuth popups are extra tabs, not a recycled opener |
| `BROWSER_IDLE_TIMEOUT_MS` | Firefox idle shutdown; default **`300000`** — jWeb warm-on-open relaunches |
| `PROXY_*` / `PROXY_COUNTRY` | Residential egress for Camofox (Decodo). Self-host: set in `.env` / `instance.env`. Fleet boxes: `DEFAULT_PROXY_*` at provision; existing: control-plane `pnpm enable:camofox-proxy` |
| `CAMOFOX_LOCALE` | Browser locale + `Accept-Language` (default **`en-US`**). With proxy + `geoip`, Camoufox otherwise picks language from regional distribution (US exits can skew Spanish). Set `false`/`off` to use geoip-derived locale. Requires **browser relaunch** (idle shutdown or stack restart). |
| `scripts/patch-camofox-single-tab.mjs` | Single tab, viewport, **OAuth popup v6**, **`CAMOFOX_LOCALE`**, insert-text + selection, form overlay scan/fill, reaper/keepalive, **cold-launch warm**, **proxy-tunnel rotate (522 HTML)** |
| `scripts/patch-hermes-camofox-browser-recover.mjs` | Hermes warm + tab recover on navigate 404/5xx and proxy-failure snapshots |
| `scripts/camofox-vnc-watcher.sh` | Reattach x11vnc after idle shutdown (same `:99`); `X11VNC_*` redraw knobs |
| `public/vendor/novnc/` | Vendored noVNC **1.7.0** client (`core/rfb.js`) |
| `public/vnc-gestures.js` | Mobile pinch / pan / scroll (dominance classifier; scroll at 1× via Playwright) |
| `scripts/ensure-camofox-container.sh` | Create/start container + wait for `/health` |
| `POST /joshu/api/camofox/fit-viewport` | Bootstrap tab → Camofox viewport route |
| `POST /joshu/api/camofox/warm` | Same bootstrap as fit-viewport **without** viewport resize (agent / EA) |
| `POST /joshu/api/camofox/navigate` | jWeb URL bar — explicit Playwright navigation (`navigateExisting: true`) |
| `POST /joshu/api/camofox/insert-text` | Playwright paste into focused control (HITL insert-text / evaluate) |
| `POST /joshu/api/camofox/copy-selection` | Read selection or focused field |
| `POST /joshu/api/camofox/scroll` | Wheel / Arrow / Page keys via Playwright (`public/vnc-scroll.js`; rate-limited) |
| `public/app.js` `layoutLetterboxedScreen` | noVNC stays **4:3** (1024×768). CDP screencast fills the jWeb pane or the phone picture and the browser viewport follows that shape at about **1024×768 pixels** (`viewportForBox`) |

**Requires:** Joshu `dist/server.js` from `npm run build:deploy` before
`vps:build-image`, plus patched Camofox `/app/server.js`.

### Soft-restart caution

Joshu listens on `:8788`; Docker healthchecks that endpoint. `vps-start.sh` ends in `wait "${JOSHU_PID}"` under `set -e`, so the node process exiting makes pid 1 exit and Docker restarts the whole stack. That drops the Chromium profile and any staged checkout. Killing only
`node dist/server.js` or Camofox `node server.js` without a fast relaunch can
also fail health → **stack recreate** (~5–7 min boot), which drops in-container Camofox
patches until `vps-start` / image rebuild re-applies them. Prefer image bake +
`repair_camfox_server_js` over ad-hoc hotpatches. **`vps-start.sh` does not
respawn** killed background node processes — wait for `healthy` or restart the
container once.

**Do not** start a second `node dist/server.js` while `vps-start.sh` is still
booting — you get `EADDRINUSE :8788`, health fails, and the stack restart-loops
(validated on patrick 2026-08-21). Wait for `healthy` or recreate once and let
`vps-start` own the listen.

**`public/` on fleet:** [`deploy/docker-compose.yml`](../deploy/docker-compose.yml)
bind-mounts `../public:/opt/joshu/public:ro` — `git pull` + rsync on the host
updates handoff/noVNC assets without an image rebuild. In-container `docker cp`
still works but is overwritten on recreate if the host tree is stale. Image bake
remains the durable path for boxes without the bind mount.

Wheel bridge (`vnc-scroll.js`) must stay **rate-limited** (coalesce + ≥180ms
between Camofox scroll calls). An unbounded queue flooded Camofox, stalled
health probes, and bounced the stack.

**jWeb Camofox restart must not leave Hermes down (validated patrick, 2026-08-22):**
`restartCamofox()` POSTs `/joshu/api/camofox/restart` then `/joshu/api/hermes/reset`.
Reset used to SIGTERM the gateway and return. Instance health only **probes**
`:8642` (no 180s `ensureApiServer` on that route), so jChat/Slack/cron/phone
stayed dead. `HermesRunner.reset()` now stops then starts when auto-start is on;
a 30s watchdog also respawns a dead gateway.

### Debug overlay (`?debugVnc=1`)

noVNC still targets 4:3:

- `screen` aspect ≈ **1.333** (4:3)
- `innerWidth` ≈ **1024**
- `fb: 1024×768`

If a noVNC pane looks stretched, confirm `layoutVncScreen()` still delegates to `layoutLetterboxedScreen` and that `/app/server.js` contains `window: [__hitlVp.width, __hitlVp.height]` (Camofox 1.6 `executable_path` needle must match the patch script).

CDP screencast does the opposite of that letterbox: the picture fills the pane, and the browser viewport follows it. A wide jWeb frame or a tall phone frame is expected. The JPEG stays near 1024×768 pixels.

**Chrome visible but no VNC canvas (zero-height black strip):** `.workspace` is a column flex; `.browser-column` must be `flex: 1` (and `min-height: 0`) so `#vnc-frame` has a definite height. Dropping the old two-column grid without that rule collapses the pane.

### ArozOS float window

[`arozos/subservice/joshu/moduleInfo.json`](../arozos/subservice/joshu/moduleInfo.json)
`InitFWSize: [1024, 768]` should match `VNC_RESOLUTION`.
