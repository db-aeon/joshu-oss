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
  on local Camofox container create.
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
| `CAMOFOX_START_URL` | Default tab URL when none exists |
| `scripts/patch-camofox-single-tab.mjs` | Single tab, viewport route, launch window size |
| `scripts/ensure-camofox-container.sh` | Create/start container + wait for `/health` |
| `POST /joshu/api/camofox/fit-viewport` | Bootstrap tab → Camofox viewport route |

**Requires:** Joshu `dist/server.js` from `npm run build:deploy` before
`vps:build-image`, plus patched Camofox `/app/server.js`.

### Debug overlay (`?debugVnc=1`)

- `screen` aspect ≈ **1.333** (4:3)
- `innerWidth` ≈ **1024**
- `fb: 1024×768`

### ArozOS float window

[`arozos/subservice/joshu/moduleInfo.json`](../arozos/subservice/joshu/moduleInfo.json)
`InitFWSize: [1024, 768]` should match `VNC_RESOLUTION`.
