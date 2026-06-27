# Excalidraw ArozOS App

This repo includes a Joshu-owned **Excalidraw ArozOS app** (jWhiteboard) built from
a **forked Excalidraw monorepo** vendored at `vendor/excalidraw` (branch
`joshu-markdown-wysiwyg`). The fork adds native Markdown WYSIWYG text elements;
see [`excalidraw-markdown-wysiwyg.md`](excalidraw-markdown-wysiwyg.md).

## Why this shape?

- **Fork for product features**: Markdown WYSIWYG lives in the fork's element and
  excalidraw packages; Joshu compiles them from source via Vite aliases.
- **Joshu wrapper stays thin**: `apps/excalidraw/` owns files API, time-block
  auto-load, `joshu://` links, and toolbar — not the full `excalidraw-app`.
- **Register as its own desktop app**: ArozOS sees Excalidraw as a separate
  subservice under `arozos/subservice/excalidraw/`.
- **Package statically**: Vite builds `apps/excalidraw/` into `dist/excalidraw`,
  then the ArozOS subservice serves those assets from its private launch port.

## Layout

| Location | Purpose |
|----------|---------|
| `apps/excalidraw/` | Joshu React wrapper; Vite aliases compile fork packages from source. |
| `arozos/subservice/excalidraw/` | ArozOS app registration, launch script, and packaged static assets at runtime. |
| `scripts/excalidraw-vite-aliases.mjs` | Shared Vite resolve aliases for fork workspace packages. |
| `scripts/ensure-excalidraw-vendor.mjs` | Submodule guard + `yarn install` in `vendor/excalidraw` when needed. |
| `vendor/excalidraw/` | **Required** git submodule — db-aeon fork with markdown WYSIWYG. |
| `scripts/dev-excalidraw.sh` | Run the fork's full `excalidraw-app` dev server from `vendor/excalidraw`. |

## What was implemented

- Added `react`, `react-dom`, `@excalidraw/excalidraw`, Vite, and React type
  dependencies to the Joshu package.
- Added `apps/excalidraw/`, a standalone Vite app that renders Excalidraw with a
  small Joshu toolbar.
- Added local scene save to browser `localStorage`; this is convenience state,
  not durable project storage.
- Added Import and Export buttons for `.excalidraw` JSON files.
- Added `arozos/subservice/excalidraw/moduleInfo.json` so ArozOS registers
  **jWhiteboard** (subservice dir remains `excalidraw/`).
- Added `arozos/subservice/excalidraw/start.sh`, which launches the static app
  through `scripts/aroz-static-subservice.mjs`.
- Added `scripts/aroz-static-subservice.mjs`, a small static file server for
  ArozOS subservices that serve prebuilt assets.
- Updated `scripts/dev-arozos.sh` to build the Excalidraw bundle and copy it
  into the local ArozOS template/data tree.
- Updated `deploy/RELEASE.json` to copy the app source/subservice scripts, build the
  Excalidraw bundle during image build, and place it in the ArozOS template.
- Updated `deploy/scripts/vps-start.sh` to refresh the Excalidraw subservice into the
  persistent ArozOS data volume on every boot.
- Kept the upstream Excalidraw source sandbox as
  `npm run dev:excalidraw:upstream` for comparison/debugging.

## Prerequisites

Initialize the fork submodule before building jWhiteboard:

```bash
git submodule update --init --recursive vendor/excalidraw
```

The packaged Joshu app uses:

- **Node.js** + **npm** (Joshu root)
- **Yarn** or **Corepack** (fork dependency install in `vendor/excalidraw`)
- **Vite** to build the static bundle

The upstream source sandbox additionally expects:

- **Yarn** or Corepack
- **Git** for bootstrap cloning

The upstream dev server normally starts on `http://localhost:3000`. Joshu's
helper defaults to `http://127.0.0.1:3002` to avoid ArozOS/Logseq port overlap.

## Run as an ArozOS app

From the Joshu repo root:

```bash
npm run dev:arozos
```

That build path:

1. Builds ArozOS from source.
2. Builds `apps/excalidraw/` with Vite.
3. Copies the static bundle into `subservice/excalidraw/app/`.
4. Registers **jWhiteboard** on the ArozOS desktop.

Open `http://127.0.0.1:8787`, log into ArozOS, then launch **jWhiteboard** from
the desktop.

For standalone UI iteration without ArozOS:

```bash
npm run dev:excalidraw
```

Then open `http://127.0.0.1:3002`.

To build only the packaged app:

```bash
npm run build:excalidraw
```

## Upstream source sandbox

For a quick scratch checkout:

```bash
git submodule update --init --recursive vendor/excalidraw
npm run dev:excalidraw:upstream -- --bootstrap
```

Or after clone:

```bash
git submodule update --init --recursive vendor/excalidraw
npm run dev:excalidraw:upstream
```

Override remote/ref with `EXCALIDRAW_REPO` and `EXCALIDRAW_REF` when comparing
against upstream Excalidraw (defaults point at the db-aeon fork).

- First run installs dependencies when `node_modules` is missing.
- Force reinstall: `npm run dev:excalidraw:upstream -- --install` or
  `EXCALIDRAW_YARN_INSTALL=1 npm run dev:excalidraw:upstream`.

Environment variables:

| Variable | Default | Meaning |
|----------|---------|---------|
| `EXCALIDRAW_SOURCE_DIR` | `vendor/excalidraw` | Path to Excalidraw checkout (override only for experiments). |
| `EXCALIDRAW_REPO` | `https://github.com/db-aeon/excalidraw.git` | Clone URL for `--bootstrap`. |
| `EXCALIDRAW_REF` | `joshu-markdown-wysiwyg` | Branch or tag for bootstrap clone. |
| `EXCALIDRAW_BOOTSTRAP` | unset | Set to `1` to clone when source dir is missing. |
| `EXCALIDRAW_YARN_INSTALL` | unset | Set to `1` to force `yarn install` before start. |
| `EXCALIDRAW_HOST` | `127.0.0.1` | Host for the upstream dev server. |
| `EXCALIDRAW_PORT` | `3002` | Port for the upstream dev server. |

## Package Integration

jWhiteboard compiles the fork from source via Vite aliases
([`scripts/excalidraw-vite-aliases.mjs`](../scripts/excalidraw-vite-aliases.mjs)).
The npm `@excalidraw/excalidraw` package remains as a transitive-deps provider;
runtime code comes from `vendor/excalidraw/packages/*`.

Joshu wrapper entry:

```tsx
import { Excalidraw } from "@excalidraw/excalidraw";

export function ExcalidrawApp() {
  return (
    <div style={{ height: "100vh" }}>
      <Excalidraw />
    </div>
  );
}
```

Styles ship with the fork entry (`index.tsx` imports SCSS). Do not import
`@excalidraw/excalidraw/index.css` when compiling from source.

Scene persistence should use Excalidraw's package utilities instead of custom
JSON munging. The relevant APIs are `serializeAsJSON`, `restore`, `loadFromBlob`,
and the **`onExcalidrawAPI`** callback prop for reading and updating scenes.

**Important (fork vs npm):** the vendored fork renamed the imperative API prop from
`excalidrawAPI` to **`onExcalidrawAPI`**. jWhiteboard must use the new name or the
canvas never initializes and the toolbar stays on "Waiting for canvas…".

```tsx
<Excalidraw
  onExcalidrawAPI={(api) => { /* store api ref; load files via updateScene */ }}
  initialData={null}
  onLinkOpen={onLinkOpen}
/>
```

The first Joshu app implementation stores a working scene in browser
`localStorage` and exposes Import/Export for `.excalidraw` files.

## Docker image packaging

`deploy/RELEASE.json` copies `apps/`, `arozos/subservice/excalidraw/`, and
`scripts/aroz-static-subservice.mjs` into the image. During image build it runs:

```bash
npm run build:excalidraw
```

and copies `dist/excalidraw/` into the ArozOS template under:

```text
/opt/arozos-template/subservice/excalidraw/app/
```

`deploy/scripts/vps-start.sh` refreshes that subservice into the persistent ArozOS
volume on every boot, matching the existing Joshu Browser refresh behavior.

The Excalidraw-enabled VPS sandbox image was last deployed and verified on
2026-05-09:

```text
```

The public URL opens ArozOS first and should return the expected setup/login
redirect on a direct HTTP probe:

```text
307 Location: /login.html?redirect=/
```

## Non-goals (this phase)

- No collaboration backend.
- No save-back to original `.md` files on disk (markdown opens as canvas text elements only).

## Markdown WYSIWYG (2026-06)

Fork branch **`joshu-markdown-wysiwyg`** in [`vendor/excalidraw`](../vendor/excalidraw) treats
`.md` content as native Excalidraw text elements with canvas rendering when not
in edit mode. See [`excalidraw-markdown-wysiwyg.md`](excalidraw-markdown-wysiwyg.md).

**jWhiteboard markdown behavior:**

- Double-click `.md` in ArozOS Files → jWhiteboard (registered in `SupportedExt`)
- Toolbar **Open Markdown** + Import accepts `.md`
- Drag-and-drop `.md` onto the canvas
- `joshu://…` links to `.md` open jWhiteboard (not MDEditor)
- Task list checkboxes toggle on canvas without entering edit mode

### Opening files from ArozOS (2026-06-21)

When the user double-clicks a file, ArozOS desktop launches jWhiteboard with a
URL hash in the same format as MDEditor — see
[`ao_module_loadInputFiles()`](https://github.com/HeyArozOS/ArozOS/blob/master/src/web/script/ao_module.js):

```text
excalidraw/index.html#[{"filepath":"user:/Desktop/joshu's files/foo.md","filename":"foo.md"}]
```

jWhiteboard parses that hash in [`loadArozInputFiles()`](../apps/excalidraw/src/main.tsx)
(mirrors ArozOS) and loads content through **two paths**:

| Trigger | Load path | Notes |
|---------|-----------|-------|
| ArozOS double-click / desktop hash | `GET /media?file=…` (same-origin on `:8787`) | Same as MDEditor; works for any user file path ArozOS knows about |
| `?file=`, `#file=`, or Joshu-relative hash | `GET /joshu/api/files/read?path=…` on Joshu `:8788` | Paths under `joshu's files` only |
| App launch (no file hash) | Joshu files API → today's `Planning/time-block-YYYY-MM-DD.excalidraw` | Falls back to `localStorage` scene, then toolbar message |

**Cross-port Joshu API:** jWhiteboard runs as an ArozOS subservice at
`http://127.0.0.1:8787/excalidraw/` but Joshu's files API lives on **port 8788**.
[`resolveFilesApiBase()`](../apps/excalidraw/src/main.tsx) maps `:8787` →
`http://127.0.0.1:8788/joshu/api/files`. CORS for localhost origins is set in
[`src/filesApi.ts`](../src/filesApi.ts).

**Boot sequence:** mount Excalidraw with `initialData={null}` (empty canvas), then
load files in the **`onExcalidrawAPI`** callback via `updateScene` / `loadMarkdownDocument`.
Do not rely on React `api` state alone — the callback can fire before effects run.
When a file-open hash is present, skip auto-loading today's time-block and
`localStorage` until the requested file is handled.

**Toolbar status line** (diagnostics):

| Message | Meaning |
|---------|---------|
| `Waiting for canvas…` | `onExcalidrawAPI` not called yet (check prop name) |
| `Loading foo.md…` | Fetching from `/media` or Joshu files API |
| `Loaded: foo.md` | Success |
| `Could not load … (HTTP 404)` | File missing on disk or wrong path |
| `File open requested — could not parse ArozOS hash.` | Hash missing or malformed |
| `No diagram yet…` | No file hash; today's time-block not found |

After changing `apps/excalidraw/`, rebuild and refresh the running subservice:

```bash
npm run build:excalidraw
rsync -a --delete dist/excalidraw/ .local/arozos-data/subservice/excalidraw/app/
```

(`npm run dev:arozos` copies the bundle on startup; a running stack needs rsync or
restart to pick up UI fixes.)

## Time-block diagrams + `joshu://` links (2026-06)

EA skill **`ea-time-block`** (v1.3.0) runs a two-step pipeline:

1. **Gather** — [`scripts/gather-time-block-input.mjs`](../scripts/gather-time-block-input.mjs) (`npm run time-block:gather`) pre-fills meeting blocks, active projects, journal paths, and planning file pointers from live calendar API (when Joshu is up) or mirror frontmatter scan.
2. **Synthesize + render** — agent fills deep/shallow/buffer/carryover in plan JSON, then [`scripts/render-time-block-excalidraw.mjs`](../scripts/render-time-block-excalidraw.mjs) (`npm run time-block:render`) writes `Planning/time-block-YYYY-MM-DD.excalidraw` under `joshu's files`.

**VPS:** run gather/render at **`/opt/joshu/scripts/gather-time-block-input.mjs`** and **`/opt/joshu/scripts/render-time-block-excalidraw.mjs`** — not `scripts/…` relative to Hermes Desktop cwd ([time-block-planning.md](Joshu-SOP/time-block-planning.md)).

Bundled Hermes **`excalidraw`** skill supplies JSON envelope / container-label rules; **`ea-time-block`** owns the workflow. Calendar quirks (mirror UUID naming, FreeBusy calendar IDs): [`ea-time-block/references/calendar-api-quirks.md`](../integrations/hermes/skills/executive-assistant/ea-time-block/references/calendar-api-quirks.md).

**jWhiteboard** ([`apps/excalidraw/src/main.tsx`](../apps/excalidraw/src/main.tsx)):

- **Auto-load** — today's `Planning/time-block-YYYY-MM-DD.excalidraw` on startup (skipped when ArozOS opens a specific file)
- **Open from Files** — ArozOS hash `[{filepath, filename}]` → `/media`; also `?file=`, `#file=`, Joshu-relative paths → files API
- **Link clicks** — `onLinkOpen` on native Excalidraw `link`; `joshu://…` → ArozOS
  `newFloatWindow` (jWhiteboard for `.excalidraw` and `.md`; MDEditor for other types); `http(s)://` unchanged
- **Markdown fork** — WYSIWYG rendering via vendored Excalidraw source; **`onExcalidrawAPI`** (not `excalidrawAPI`) for scene control

**Joshu files API** ([`src/filesApi.ts`](../src/filesApi.ts)) — load diagrams and Joshu-relative paths; ArozOS file opens prefer `/media`:

- `GET /joshu/api/files/context` — `filesRoot`, `arozPathPrefix`, `joshuFilesDirName` (304 cached is normal)
- `GET /joshu/api/files/read?path=...` — localhost-only read under `joshu's files`
- CORS — localhost origins allowed so `:8787` subservices can call `:8788`

See [`docs/Joshu-SOP/time-block-planning.md`](Joshu-SOP/time-block-planning.md) and [`gtd-workspace-linking.md`](Joshu-SOP/gtd-workspace-linking.md).

Plan JSON may include **`taskGroups`** (numbered ① lists), **`blockRef`** on blocks, **`yesterdayPlan`** (link strip to prior day's diagram), and **`carryover[]`** (**From yesterday ☐** in the notes column). One `.excalidraw` per calendar day accumulates in `Planning/`; checkboxes live in **`Planning/daily-review-YYYY-MM-DD.md`** ([daily handoff](Joshu-SOP/time-block-planning.md#daily-handoff-morning-review)).

**Typography:** jWhiteboard bundles **Assistant** (brand) woff2 fonts from the design system sync (`npm run sync-design-system` → `build:excalidraw`).

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Toolbar stuck on **Waiting for canvas…** | Wrong Excalidraw API prop (`excalidrawAPI` vs `onExcalidrawAPI`) | Use `onExcalidrawAPI` in [`main.tsx`](../apps/excalidraw/src/main.tsx); rebuild bundle |
| Blank canvas, default subtitle, only `GET …/files/context 304` in Joshu logs | File load never started (API callback / hash parse) | Check toolbar status line; confirm URL has `#` hash after double-click; hard-refresh or close window and reopen file |
| **Could not reach Joshu files API** | Joshu not on `:8788` or CORS blocked | Ensure `npm run dev:arozos` is running; restart Joshu after `filesApi.ts` changes |
| **HTTP 404** on `/media` | File not on ArozOS user disk at that `user:/Desktop/…` path | Open from Files app; confirm path exists under `.local/arozos-data/files/users/…` |
| **HTTP 404** on `/files/read` | Path outside `joshu's files` or typo | Use `/media` path for ArozOS opens; files API only reads `joshu's files/` |
| Time-block shows instead of `.md` | Startup race before hash detected | Fixed: file-open hash skips time-block; ensure latest bundle deployed |
| Changes not visible after edit | Stale subservice bundle | `npm run build:excalidraw` + rsync to `.local/arozos-data/subservice/excalidraw/app/` or restart `dev:arozos` |

**Sanity-check file:** `joshu's files/research/kb/test-kb-doc.md` (create if missing).
Double-click from ArozOS Files; expect **Loaded: test-kb-doc.md** and markdown on canvas.

## Future work

1. **jMail for mail thread links** — open thread mirrors in jMail instead of MDEditor when available.
2. **Bundle size**: Excalidraw pulls in large optional chunks; revisit
   code-splitting if load time becomes painful in the sandbox image.
3. **Joshu pointer tool** — custom ephemeral pointer with path capture (see
   [Joshu pointer tool (future)](#joshu-pointer-tool-future) below).

Keep integration code and config in **this repo**; keep Excalidraw source in the
**`vendor/excalidraw`** git submodule only (not external local checkouts).

## Joshu pointer tool (future)

Research notes from 2026-06-18 on Excalidraw’s built-in laser pointer and a
Joshu-owned alternative. Intended as a future jWhiteboard feature — not
implemented yet.

### Built-in laser pointer — how it works

`@excalidraw/excalidraw` (v0.18.1) includes a **laser** tool (`ToolType: "laser"`).
It is **not a scene element**:

- Trails are rendered as ephemeral SVG overlays via an internal `LaserTrails`
  class.
- Stroke geometry comes from `@excalidraw/laser-pointer` (already a transitive
  dependency): points are `[x, y, timestamp]`, smoothed/simplified, then drawn as
  fading outlines.
- Trails decay and are **never** written to `.excalidraw` JSON or
  `getSceneElements()`.

Upstream discussion: [excalidraw#11073](https://github.com/excalidraw/excalidraw/discussions/11073)
— no public API to programmatically draw fading laser trails; only persistent
elements can be added via `updateScene()`.

### What the public API exposes today

| API | Laser-related capability |
|-----|--------------------------|
| `onPointerUpdate` | Scene coords + `pointer.tool` (`"pointer"` \| `"laser"`) + `button` (`"down"` \| `"up"`). Enough to **accumulate a raw path** while the built-in laser is active. |
| `onPointerDown` / `onPointerUp` | Stroke start/end boundaries; `PointerDownState` has `origin`, `lastCoords`. |
| `excalidrawAPI.setActiveTool({ type: "laser" })` | Activate built-in laser programmatically. |
| `isCollaborating` + `collaborators` | Remote collaborator laser cursors (collab feature). |
| `UIOptions` | Can hide `image` tool only — **no laser-specific config** (decay, color, trail length). |

**Cannot do without forking:** change trail appearance/decay, read internal
smoothed trail geometry, export laser strokes from Excalidraw’s overlay, or
replay fading trails via API.

### Recommended approach: Joshu-owned pointer tool

Rather than modifying the built-in laser, add a **Joshu pointer** in the
`apps/excalidraw/` wrapper. Fits the existing “no fork” policy.

```
jWhiteboard toolbar
  └── "Joshu Pointer" button
        └── activates custom tool OR local pointerMode flag

Excalidraw <Excalidraw />
  ├── onPointerDown / onPointerUpdate / onPointerUp  → path capture
  └── JoshuPointerOverlay (SVG sibling)              → trail rendering
        └── @excalidraw/laser-pointer                → same visual language
```

**Why this is better than hacking the built-in laser:**

| | Built-in laser | Joshu pointer |
|---|---|---|
| Path capture | `onPointerUpdate` workaround only | First-class owned buffer |
| Trail appearance | Fixed internally | Configurable via `@excalidraw/laser-pointer` |
| Persistence | Never in `.excalidraw` | Optional: sidecar JSON or convert to `freedraw` |
| Programmatic replay | Not supported | Feed saved points into overlay |
| Fork required | Yes, to change behavior | No |

### Implementation sketch (future)

Proposed files under `apps/excalidraw/src/`:

| File | Role |
|------|------|
| `useJoshuPointer.ts` | Stroke lifecycle: start on pointer-down, append on `onPointerUpdate` while `button === "down"`, finalize on pointer-up. Buffer: `{ x, y, t }[]` in **scene coordinates**. |
| `JoshuPointerOverlay.tsx` | SVG layer over `.excalidraw-canvas`; renders active + decaying trails via `LaserPointer` from `@excalidraw/laser-pointer`. |
| `main.tsx` | Toolbar toggle; wire `onPointerDown` / `onPointerUpdate` / `onPointerUp`; subscribe to `onScrollChange` + `getAppState()` for zoom/pan sync. |

**Activation — two flavors (pick one when implementing):**

1. **Local mode flag** (simpler): toolbar toggles `pointerMode` in React state;
   pointer hooks check the flag. Excalidraw can stay on `selection`.
2. **`custom` tool** (tighter integration):
   `api.setActiveTool({ type: "custom", customType: "joshu-pointer" })`.
   Excalidraw’s custom slot sets `appState.activeTool` but does **not** provide
   drawing logic — Joshu still owns capture + overlay. Check
   `activeTool.customType === "joshu-pointer"` in hooks.

**Viewport sync:** `onPointerUpdate` returns scene coords. The overlay must
transform scene → viewport using `zoom`, `scrollX`, `scrollY`, `offsetLeft`,
`offsetTop` from `getAppState()` (same pattern Excalidraw’s internal
`LaserTrails` uses).

**Dependency:** add `@excalidraw/laser-pointer` as a direct dependency in
`package.json` (already present transitively via `@excalidraw/excalidraw`).

### Open decisions (resolve before building)

1. **Trail behavior** — fade like stock laser, persist until mouse-up, or
   convert completed strokes to permanent `freedraw` elements?
2. **Persistence** — ephemeral only (presentation), sidecar JSON alongside
   `.excalidraw`, or embedded in scene via `freedraw`?
3. **Built-in laser** — keep both tools, or hide Excalidraw’s native laser via
   CSS (`.ToolIcon_type_laser`) so users have one pointer?
4. **Use case** — time-block walkthrough annotations, remote presentation sync,
   analytics (“where did the user point?”), or something else?

### Alternatives considered

| Approach | Verdict |
|----------|---------|
| Capture built-in laser via `onPointerUpdate` only | Works for raw paths; no control over trail rendering or replay. |
| Fork `vendor/excalidraw` to modify `LaserTrails` | Full control; use db-aeon fork for product changes like markdown WYSIWYG. |
| `setActiveTool({ type: "laser" })` + path logging | Minimal code; limited to what upstream exposes. |
| **Joshu pointer overlay** | **Recommended** — full path ownership, no fork, fits wrapper pattern. |
