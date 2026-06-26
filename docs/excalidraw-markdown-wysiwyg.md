# Excalidraw Markdown WYSIWYG (jWhiteboard)

jWhiteboard uses a forked Excalidraw monorepo at [`vendor/excalidraw`](../vendor/excalidraw)
(branch **`joshu-markdown-wysiwyg`**, remote `https://github.com/db-aeon/excalidraw.git`).

The fork adds basic Markdown file support by treating an opened `.md` file as a
native Excalidraw text element. Editing uses the raw Markdown source; the element
renders formatted Markdown on the canvas when not actively being edited.

Canonical implementation notes live in the fork at
[`vendor/excalidraw/MARKDOWN_WYSIWYG_CHANGES.md`](../vendor/excalidraw/MARKDOWN_WYSIWYG_CHANGES.md).

## jWhiteboard integration

Joshu-specific wiring (not in the fork):

| Location | Role |
|----------|------|
| [`apps/excalidraw/src/markdown/`](../apps/excalidraw/src/markdown/) | File picker + `loadMarkdownDocument()` |
| [`apps/excalidraw/src/main.tsx`](../apps/excalidraw/src/main.tsx) | ArozOS hash parse, `/media` + files API load, drag-drop, toolbar, `joshu://` routing |
| [`scripts/excalidraw-vite-aliases.mjs`](../scripts/excalidraw-vite-aliases.mjs) | Vite aliases to fork packages |
| [`arozos/subservice/excalidraw/moduleInfo.json`](../arozos/subservice/excalidraw/moduleInfo.json) | Registers `.md` in `SupportedExt` |

### File loading (ArozOS double-click)

1. ArozOS desktop appends `#[{filepath, filename}]` to the jWhiteboard URL (same as MDEditor).
2. `loadArozInputFiles()` parses the hash (must match `ao_module_loadInputFiles()`).
3. Content is fetched via **`GET /media?file=user:/Desktop/…`** on the ArozOS origin (`:8787`).
4. `loadMarkdownDocument(api, { name, markdown }, { replace: true })` inserts a markdown text element and replaces the scene.

Alternative entry points (toolbar Import, Joshu-relative `?file=`, time-block auto-load) use
**`GET /joshu/api/files/read?path=…`** on port **8788** — see
[`docs/excalidraw-sandbox.md`](excalidraw-sandbox.md#opening-files-from-arozos-2026-06-21).

### Excalidraw API prop (fork)

The fork exposes **`onExcalidrawAPI`**, not the older npm `excalidrawAPI` prop name.
jWhiteboard stores the API in a ref and loads files inside that callback so the canvas
is ready before `updateScene`. Mount with `initialData={null}` and populate via API.

### `loadMarkdownDocument`

[`apps/excalidraw/src/markdown/loadMarkdownDocument.ts`](../apps/excalidraw/src/markdown/loadMarkdownDocument.ts)
creates a text element with `customData.markdownText: true` (via fork constant
`MARKDOWN_TEXT_ELEMENT_CUSTOM_DATA_KEY`). `{ replace: true }` clears existing elements
before inserting — used for ArozOS file opens so time-block or stale canvas state does not show through.

## User-facing behavior

- Double-click `.md` in ArozOS Files → jWhiteboard
- **Open Markdown** toolbar button + Import accepts `.md`
- Drag-and-drop `.md` onto the canvas
- `joshu://` links to `.md` open jWhiteboard
- Double-click/edit mode shows raw Markdown
- Task list checkboxes toggle on canvas without edit mode

## Supported Markdown rendering

- Headings: `#`, `##`, `###`
- Bold, italic, underline, inline code
- Fenced code blocks, lists, blockquotes
- Task lists: `- [ ]` / `- [x]`
- Basic pipe tables (see fork doc for details)

## Fork source files (core)

- `packages/element/src/markdownText.ts` — parser, layout cache, canvas render, checkbox hit-test
- `packages/element/src/renderElement.ts` — routes markdown text elements
- `packages/excalidraw/components/App.tsx` — checkbox click + hover cursor
- `packages/excalidraw/components/canvases/StaticCanvas.tsx` — editing state for renderer

## Rendering model

Markdown elements use `customData.markdownText: true` on normal text elements.
The renderer draws to the canvas (not an HTML overlay) so zoom, selection, and
transforms stay consistent.

## Limitations

- Not a full CommonMark implementation
- No save-back to the original `.md` file on disk from jWhiteboard yet
- Files API reads only under `joshu's files/`; ArozOS `/media` is required for arbitrary desktop paths
- See fork doc for full limitation list

## Troubleshooting

See the jWhiteboard troubleshooting table in
[`docs/excalidraw-sandbox.md`](excalidraw-sandbox.md#troubleshooting).

Quick checks for markdown opens:

1. Toolbar shows **Loaded: …** not **Waiting for canvas…**
2. Joshu log shows `/media?file=…` or `/joshu/api/files/read?path=…` — not just `/files/context 304`
3. Bundle is current: `npm run build:excalidraw` and sync to `.local/arozos-data/subservice/excalidraw/app/`

## Verification

Inside `vendor/excalidraw`:

```sh
yarn test:typecheck
./node_modules/.bin/eslint --ext .ts,.tsx packages/element/src/markdownText.ts packages/excalidraw/components/App.tsx
```

Joshu build:

```sh
git submodule update --init --recursive vendor/excalidraw
npm run build:excalidraw
```

End-to-end (local ArozOS):

```sh
npm run dev:arozos
# Double-click joshu's files/research/kb/test-kb-doc.md in Files → jWhiteboard
```
