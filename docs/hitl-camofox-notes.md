# HITL Camofox Notes

Working notes for the jWeb (human-in-the-loop) browser stack: Joshu, Hermes,
Camofox, noVNC, and ArozOS subservices.

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

## VNC clipboard (paste / copy)

**x11vnc does not reliably exchange clipboard with the Mac/host.** Braces and
JSON get mangled on keystroke paste; Cmd+C inside Camofox does not reach the
host clipboard.

Joshu bypasses VNC for clipboard:

| Action | UI | Joshu API | Camofox |
|--------|----|-----------|---------|
| Paste into focused field | **Paste into browser** | `POST /joshu/api/camofox/insert-text` | Playwright `/type` + `/press` (`insertText`) |
| Copy selection / focused token | **Copy from browser** | `POST /joshu/api/camofox/copy-selection` | `POST /tabs/:tabId/selection` (HITL patch) |

Wiring: `public/vnc-clipboard.js` (`pasteViaApi` / `copyViaApi`) ← `public/app.js` /
`public/camofox-viewer.html`.

The Camofox **selection** route is not upstream — it is injected by
`scripts/patch-camofox-single-tab.mjs` (`HITL_SELECTION_ROUTE`). Without that
patch, copy-selection returns **502**.

## Tab reaper / blank-page resets

Upstream Camofox closes tabs idle for `TAB_INACTIVITY_MS` (default **5 minutes**),
using `toolCalls` as the activity signal. **VNC clicks do not increment
`toolCalls`**, so jWeb sessions look idle and get reaped even while a human is
using the browser.

HITL patch behavior:

- `TAB_INACTIVITY_MS` from env; **default `0` disables the reaper**
- `GET /tabs` touches `lastAccess` / reaper counters (**HITL keepalive** — Joshu
  status polls this path)
- Prefer `BROWSER_IDLE_TIMEOUT_MS=0` on long HITL sessions if you also need the
  browser process itself to stay warm

VPS start exports `TAB_INACTIVITY_MS="${TAB_INACTIVITY_MS:-0}"`.

## `CAMOFOX_START_URL` / `about:blank`

- VPS default is **`about:blank`** (do not force news.google).
- Joshu `normalizeHttpUrl` accepts `about:blank`; bootstrap does **not** navigate
  an existing non-blank tab unless `navigateExisting` is set.
- Status polling must **not** call `ensureTab(START_URL)` on every tick (that
  used to reset users back to News / Slack apps mid-session).
- Camofox patch `__hitlStartUrlFromEnv()` treats blank / empty as “no auto URL”
  (never coerces to news.google).

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
`[Subservice] Subservice Registered: Joshu Browser`; remove
`.local/arozos-data/subservice/joshu/.disabled` if present.

### Hermes scroll / simple actions “reload” the browser

**Cause:** wrong Camofox identity (`user_id` / session mismatch) or over-aggressive
single-tab patch closing all tabs.

**Fix:** Joshu `ensureJoshuHermesConfig()` writes `browser.camofox.user_id`,
`session_key`, `adopt_existing_tab: true`. Recreate Camofox after patch changes.
Restart Hermes gateway after config changes.

### Environment and scripts

| Variable / script | Role |
|-------------------|------|
| `VNC_RESOLUTION`, `CAMOFOX_VIEWPORT_WIDTH`, `CAMOFOX_VIEWPORT_HEIGHT` | Xvfb + viewport (apply at **container create**) |
| `ENABLE_VNC` + Camofox `plugins.vnc.enabled` | noVNC on `:6080` — Camofox **1.6+** requires both (see troubleshooting) |
| `CAMOFOX_START_URL` | Default tab URL when none exists (`about:blank` OK) |
| `TAB_INACTIVITY_MS` | Camofox tab reaper; **`0` for jWeb HITL** (default on VPS) |
| `BROWSER_IDLE_TIMEOUT_MS` | Camofox process idle shutdown; often `0` with HITL |
| `PROXY_*` / `PROXY_COUNTRY` | Residential egress for Camofox (Decodo); geo optional |
| `scripts/patch-camofox-single-tab.mjs` | Single tab, viewport, **selection route**, reaper/keepalive |
| `scripts/ensure-camofox-container.sh` | Create/start container + wait for `/health` |
| `POST /joshu/api/camofox/fit-viewport` | Bootstrap tab → Camofox viewport route |
| `POST /joshu/api/camofox/insert-text` | Playwright paste into focused control |
| `POST /joshu/api/camofox/copy-selection` | Read selection / focused Slack token |
| `public/app.js` `layoutLetterboxedScreen` | Keep jWeb VNC pane at **4:3** (1024×768) inside the float window |

**Requires:** Joshu `dist/server.js` from `npm run build:deploy` before
`vps:build-image`, plus patched Camofox `/app/server.js`.

### Soft-restart caution

Joshu listens on `:8788`; Docker healthchecks that endpoint. Killing only
`node dist/server.js` without a fast relaunch can fail health → **stack recreate**,
which drops in-container Camofox patches until `vps-start` / image rebuild
re-applies them. Prefer image bake + `repair_camfox_server_js` over ad-hoc
hotpatches.

### Debug overlay (`?debugVnc=1`)

- `screen` aspect ≈ **1.333** (4:3)
- `innerWidth` ≈ **1024**
- `fb: 1024×768`

If the pane looks stretched/wide, confirm `layoutVncScreen()` still delegates to `layoutLetterboxedScreen` and that `/app/server.js` contains `window: [__hitlVp.width, __hitlVp.height]` (Camofox 1.6 `executable_path` needle must match the patch script).

### ArozOS float window

[`arozos/subservice/joshu/moduleInfo.json`](../arozos/subservice/joshu/moduleInfo.json)
`InitFWSize: [1024, 768]` should match `VNC_RESOLUTION`.
