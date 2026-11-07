# Excalidraw ArozOS App

This repo includes a Joshu-owned **Excalidraw ArozOS app** (jWhiteboard) built from
a **forked Excalidraw monorepo** vendored at `vendor/excalidraw` (branch
`joshu-markdown-wysiwyg`). The fork adds native Markdown WYSIWYG text elements;
see [`excalidraw-markdown-wysiwyg.md`](excalidraw-markdown-wysiwyg.md).

The completed local **Curatorial Whiteboard Model (CWM)** prototype adds durable
`.excalidraw` checkpoints, semantic sidecars, append-only events, explicit human
review, an embedded agent, bounded recall, and the Joshu Pointer. See
[`curatorial-whiteboard.md`](curatorial-whiteboard.md) for the canonical design,
API, persistence, authority, security, workflow, and prototype-status details.
Developers new to the complete app should start with
[`jwhiteboard-developer-guide.md`](jwhiteboard-developer-guide.md).

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
- Browser `localStorage` remains convenience recovery for ordinary canvas work.
  For eligible boards, CWM provides durable `.excalidraw` checkpoints plus
  sibling semantic and append-only event sidecars.
- Added **New Board** for exclusive blank-board creation under `Planning/`,
  alongside Import and Export buttons for `.excalidraw` JSON files.
- Added `arozos/subservice/excalidraw/moduleInfo.json` so ArozOS registers
  **jWhiteboard** (subservice dir remains `excalidraw/`).
- Added `arozos/subservice/excalidraw/start.sh`, which launches the static app
  through `scripts/aroz-static-subservice.mjs`.
- Added `scripts/aroz-static-subservice.mjs`, a small static file server for
  ArozOS subservices that serve prebuilt assets.
- Updated `scripts/dev-arozos.sh` to build the Excalidraw bundle and copy it
  into the local ArozOS template/data tree.
- The image build in `deploy/Dockerfile` copies the app source/subservice,
  builds the Excalidraw bundle, and places it in the ArozOS template.
- VPS startup refreshes registered Joshu subservices, including Excalidraw,
  from that template into the persistent ArozOS data volume.
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

There are now two persistence paths:

- **Convenience state:** browser `localStorage` supports startup fallback and
  ordinary unsaved canvas recovery. It is not durable project storage.
- **CWM durable state:** an eligible `.excalidraw` board under `joshu's files`
  can be explicitly checkpointed to disk. Its semantic workspace and event
  history live in exact sibling files named `<board>.cwm.json` and
  `<board>.cwm.events.jsonl`.

CWM checkpoints validate the complete Excalidraw envelope and atomically replace
the board file. They do not continuously autosave every visual edit. See
[`curatorial-whiteboard.md`](curatorial-whiteboard.md#exact-files-and-persistence-semantics).

## Docker image packaging

The builder stage in `deploy/Dockerfile` copies `apps/`,
`arozos/subservice/excalidraw/`, and
`scripts/aroz-static-subservice.mjs`. During image build it runs:

```bash
npm run build:excalidraw
```

and copies `dist/excalidraw/` into the ArozOS template under:

```text
/opt/arozos-template/subservice/excalidraw/app/
```

VPS startup uses the shared Joshu subservice synchronization helper to refresh
Excalidraw into the persistent ArozOS volume. `deploy/RELEASE.json` contains
release/version metadata; it is not the build recipe.

## Non-goals (this phase)

- No collaboration backend.
- No save-back to original `.md` files on disk (Markdown opens as canvas text
  elements only). CWM checkpointing saves the `.excalidraw` scene and CWM
  sidecars; it does not write the imported Markdown source.

## Markdown WYSIWYG (2026-06)

Fork branch **`joshu-markdown-wysiwyg`** in [`vendor/excalidraw`](../vendor/excalidraw) treats
`.md` content as native Excalidraw text elements with canvas rendering when not
in edit mode. See [`excalidraw-markdown-wysiwyg.md`](excalidraw-markdown-wysiwyg.md).

**jWhiteboard markdown behavior:**

- Toolbar **Open Markdown** + Import still accepts `.md` onto the canvas (import only — no save-back)
- Drag-and-drop `.md` onto the canvas
- Double-click `.md` in ArozOS Files → **jNotes** (Milkdown), not jWhiteboard
- `joshu://` links to `.md` open **jNotes**

See [`jnotes-arozos-app.md`](jnotes-arozos-app.md).

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

### CWM backend and eligibility (local prototype)

The local server exposes the CWM API at
`/joshu/api/excalidraw/cwm`. jWhiteboard maps ArozOS `:8787` to the Joshu
server on `:8788`; standalone frontend work may set
`VITE_JOSHU_CWM_API_BASE`.

CWM is enabled only for an existing, regular, lowercase `.excalidraw` file at a
clean relative path under the resolved `joshu's files` root. ArozOS `/media`
opens become eligible only when the original path proves that location.
Markdown, arbitrary Desktop files, absolute/traversing paths, imported local
files, and unverified paths remain ordinary in-memory/import workflows.

Backend routes:

| Method | Route | Purpose |
|--------|-------|---------|
| `POST` | `/create` | Exclusively create a blank board and initialize its sidecars. |
| `GET` | `/board` | Load/bootstrap the materialized workspace. |
| `GET` | `/events` | Read a bounded event tail. |
| `POST` | `/proposal` | Classify and apply or stage semantic operations. |
| `POST` | `/confirm`, `/reject` | Resolve a pending proposal through explicit review. |
| `POST` | `/compensate` | Append an inverse event. |
| `POST` | `/checkpoint` | Atomically persist a validated `.excalidraw` scene. |
| `POST` | `/consolidate` | Write a bounded Markdown handoff under `Planning/cwm-sessions/`. |

All mutations use optimistic `headSequence`; stale writers receive HTTP `409`.
The API is localhost-only and grants CORS only to local origins. Full request
and storage semantics: [`curatorial-whiteboard.md`](curatorial-whiteboard.md).

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

**VPS:** run gather/render at **`/opt/joshu/scripts/gather-time-block-input.mjs`** and **`/opt/joshu/scripts/render-time-block-excalidraw.mjs`** — not `scripts/…` relative to Hermes Desktop cwd ([time-block-planning.md](excalidraw-sandbox.md)).

Bundled Hermes **`excalidraw`** skill supplies JSON envelope / container-label rules; **`ea-time-block`** owns the workflow. Calendar quirks (mirror UUID naming, FreeBusy calendar IDs): [`ea-time-block/references/calendar-api-quirks.md`](../integrations/hermes/skills/executive-assistant/ea-time-block/references/calendar-api-quirks.md).

**jWhiteboard** ([`apps/excalidraw/src/main.tsx`](../apps/excalidraw/src/main.tsx)):

- **Auto-load** — today's `Planning/time-block-YYYY-MM-DD.excalidraw` on startup (skipped when ArozOS opens a specific file)
- **Open from Files** — ArozOS hash `[{filepath, filename}]` → `/media`; also `?file=`, `#file=`, Joshu-relative paths → files API
- **Link clicks** — `onLinkOpen` on native Excalidraw `link`; `joshu://…` → ArozOS
  `newFloatWindow` (jWhiteboard for `.excalidraw`; **jNotes** for `.md` / `.txt`; the PDF Viewer for `.pdf`; previously MDEditor)
- **Markdown fork** — WYSIWYG rendering via vendored Excalidraw source; **`onExcalidrawAPI`** (not `excalidrawAPI`) for scene control

**Joshu files API** ([`src/filesApi.ts`](../src/filesApi.ts)) — load diagrams and Joshu-relative paths; ArozOS file opens prefer `/media`:

- `GET /joshu/api/files/context` — `filesRoot`, `arozPathPrefix`, `joshuFilesDirName` (304 cached is normal)
- `GET /joshu/api/files/read?path=...` — localhost-only read under `joshu's files`
- CORS — localhost origins allowed so `:8787` subservices can call `:8788`

See [`jwhiteboard-developer-guide.md`](jwhiteboard-developer-guide.md) and [`gtd-workspace-linking.md`](file-brain.md).

Plan JSON may include **`taskGroups`** (numbered ① lists), **`blockRef`** on blocks, **`yesterdayPlan`** (link strip to prior day's diagram), and **`carryover[]`** (**From yesterday ☐** in the notes column). One `.excalidraw` per calendar day accumulates in `Planning/`; checkboxes live in **`Planning/daily-review-YYYY-MM-DD.md`** ([daily handoff](excalidraw-sandbox.md#daily-handoff-morning-review)).

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
| **CWM inactive / ineligible** | Board is Markdown, outside `joshu's files`, imported without a reliable path, or not lowercase `.excalidraw` | Open an existing `.excalidraw` board from inside `joshu's files` |
| **CWM unavailable — joshu files paths unavailable** | ArozOS user/files root has not been bootstrapped or cannot be resolved | Start the integrated ArozOS stack; check `AROZ_DATA`, `JOSHU_AROZ_USER`, and `JOSHU_FILES_DIR_NAME` |
| **CWM conflict** / HTTP `409` | Another mutation advanced `headSequence` | Let the UI refresh the board head, then retry the proposal or review action |
| CWM shows **offline** from standalone Vite | Frontend is calling `:3002` instead of the local API | Set `VITE_JOSHU_CWM_API_BASE=http://127.0.0.1:8788/joshu/api/excalidraw/cwm` and the corresponding files API override |
| Proposal preview remains after failure | Confirmation/checkpoint did not complete | Refresh the CWM workspace; accepted semantics are durable before scene materialization |

**Sanity-check file:** `joshu's files/research/kb/test-kb-doc.md` (create if missing).
Double-click from ArozOS Files; expect **Loaded: test-kb-doc.md** and markdown on canvas.

### CWM build and tests

From the repository root:

```bash
npm run build:excalidraw
npm test -w @joshu/whiteboard-cwm
npm run build
npm run test:excalidraw-cwm-backend
npx tsx --test apps/excalidraw/src/cwm/*.test.ts apps/excalidraw/src/agent/*.test.ts
```

For integrated local verification:

```bash
npm run dev:arozos
```

Open an existing `.excalidraw` file under `joshu's files`; expect **CWM ready**,
type a selected element, review its proposal, accept it, and use **Consolidate
Session**. The board should gain `.cwm.json` and `.cwm.events.jsonl` siblings,
and consolidation should create a handoff under `Planning/cwm-sessions/`.

## Future work

1. **jMail for mail thread links** — open thread mirrors in jMail instead of MDEditor when available.
2. **Bundle size**: Excalidraw pulls in large optional chunks; revisit
   code-splitting if load time becomes painful in the sandbox image.
3. **Collaboration and deployment** — CWM is a completed local prototype, not a
   real-time collaboration backend or deployment claim.

Keep integration code and config in **this repo**; keep Excalidraw source in the
**`vendor/excalidraw`** git submodule only (not external local checkouts).

## Joshu Pointer (implemented local prototype)

The June 2026 research compared Excalidraw's built-in laser with a wrapper-owned
pointer. The built-in laser is an internal ephemeral overlay: it is not a scene
element, does not appear in `getSceneElements()`, and exposes no public replay or
trail-customization API. That historical constraint led to the wrapper approach.

The implemented **Joshu Pointer** uses `useJoshuPointer.ts` for capture and
deictic resolution and `JoshuPointerOverlay.tsx` for rendering. It:

- captures scene-coordinate strokes while the toolbar mode is enabled;
- keeps at most 500 downsampled points from the latest 30 seconds;
- renders active and one-second fading traces outside the Excalidraw scene;
- resolves explicit selection, closed lasso, pass-through, or nearby sweep;
- maps at most 20 candidate elements to CWM objects;
- marks confidence below `0.7` as requiring visible grounding;
- aligns only a final transcript arriving within `1200 ms` after the trace.

Traces remain ephemeral: they are not scene elements and are not persisted to
the `.excalidraw` checkpoint or CWM sidecars. The bounded deictic result, rather
than raw points, enters the agent GUI snapshot. The `whiteboard-gui` skill must
call `showFocus` and ask for compact confirmation before a low-confidence
reference can drive a consequential proposal.

Exact behavior and voice authority are documented in
[`curatorial-whiteboard.md`](curatorial-whiteboard.md#joshu-pointer-voice-alignment-and-grounding).
