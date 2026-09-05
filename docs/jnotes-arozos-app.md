# jNotes (Milkdown markdown editor)

**jNotes** is Joshu’s WYSIWYG markdown editor. It replaces stock ArozOS **MDEditor**
for `.md` / `.markdown` / `.mdx` / `.txt` and takes over `.md` opens that previously
went to jWhiteboard.

| | |
|--|--|
| Vite app | [`apps/md-editor/`](../apps/md-editor/) |
| ArozOS module | [`arozos/subservice/md-editor/`](../arozos/subservice/md-editor/) |
| Editor | [Milkdown Crepe](https://milkdown.dev/) **7.22.1** (ProseMirror + remark) |
| Agent | `@joshu/app-agent` + `jnotes-gui` skill |

## Product intent

- Edit markdown on the Desktop / `joshu's files` with a Typora-like WYSIWYG surface.
- Let Hermes draft and revise via `app_gui_action` (replace / insert / append / save).
- Keep File Brain (gbrain) as the search index — jNotes does not replace gbrain.

## Architecture

```text
ArozOS Files double-click .md
        │
        ▼
jNotes subservice (static Vite) ── /media?file=… ──► load
        │
        ├── Milkdown Crepe (WYSIWYG features = plugins)
        ├── POST /joshu/api/files/write ──► persist under Desktop / joshu's files
        └── Embedded agent ── app_gui_action ──► replaceDocument / insertMarkdown / …
```

Milkdown’s Crepe layer exposes features (`Toolbar`, `BlockEdit`, `CodeMirror`, …)
as optional plugins. Programmatic edits use `crepe.editor.action(insert|replaceAll)`
from `@milkdown/kit/utils` — the same surface the LLM guiActions call.

## Dependency and build-artifact policy

Milkdown is installed from npm; its source is **not vendored** into this repository.
Both `@milkdown/crepe` and `@milkdown/kit` are pinned to exactly `7.22.1` in
`package.json`, and `package-lock.json` records the resolved tarballs and integrity
hashes. Upgrade both packages together and verify open, edit, save, contextual
toolbars, code blocks, and guiActions before changing the pin.

The maintained jNotes implementation is the small source tree in
`apps/md-editor/`. `npm run build:md-editor` generates `dist/md-editor/`; local
ArozOS setup then copies that output to
`arozos/subservice/md-editor/app/` or the live `.local/` tree. Those generated
directories can contain hundreds of hashed JavaScript, syntax-language, Mermaid,
and KaTeX assets because Crepe loads its rich editing features on demand. They are
required at runtime but are reproducible build output and are therefore ignored by
Git. Do not commit them.

Production image builds follow the same path: `build:deploy` creates
`dist/md-editor/`, then `deploy/Dockerfile` copies it into the ArozOS subservice.
Only the subservice metadata, launcher, app manifest, and skill under
`arozos/subservice/md-editor/` are source-controlled.

## Open / save paths

| Trigger | Load | Save |
|---------|------|------|
| ArozOS hash `#[{filepath,filename}]` | Prefer `/media?file=…`, else Joshu files API | `POST /joshu/api/files/write` (`root=files` or `desktop`) |
| `?file=` / `#file=` under joshu's files | Joshu `GET /api/files/read` | Same write API |
| Untitled buffer | In-memory | **Save note** opens a path dialog under `joshu's files`; `⌘⇧S` opens Save As |

The header contains document identity plus New, Open, and Save actions. Save state
(`Saving…`, `Unsaved changes`, `Not saved yet`, or saved) lives in the bottom
status bar beside word and character counts. Crepe contextual controls use the
jNotes neutral surface palette rather than Crepe’s peach default theme colors.

## Agent guiActions

Declared in `arozos/subservice/md-editor/joshu.app.json`:

| action | Effect |
|--------|--------|
| `replaceDocument` | Replace entire body |
| `insertMarkdown` | Insert at cursor |
| `appendMarkdown` | Append to end |
| `getDocument` | Return path + markdown |
| `saveDocument` | Persist; optional `path` saves an untitled note |
| `newDocument` | Blank untitled buffer |
| `openFile` | Open relative path under joshu's files |

Skill: `arozos/subservice/md-editor/skills/jnotes-gui/SKILL.md`.

## Local dev

```bash
npm run build:md-editor
npm run dev:md-editor          # Vite on :3014
npm run dev:arozos             # full stack — registers jNotes + hides MDEditor
```

After `dev:arozos`, double-click a `.md` on the Desktop — it should open **jNotes**, not MDEditor or jWhiteboard.

**Existing VPS boxes:** a `0.1.43` health pin is not enough. Host compose bind-mounts `scripts/lib/`; if that clone predates jNotes, the live ArozOS volume never gets `md-editor`. See [existing-box-image-vs-host.md](vps-sandbox/existing-box-image-vs-host.md).
The full-stack command builds from `apps/md-editor/` and syncs the generated bundle
into the live ArozOS data tree; no checked-in app bundle is needed.

## Related

- [`excalidraw-markdown-wysiwyg.md`](excalidraw-markdown-wysiwyg.md) — jWhiteboard still *can* import markdown onto the canvas; it no longer owns the `.md` file association.
- [`file-brain.md`](file-brain.md) — indexing / search.
- [`app-agent.md`](app-agent.md) — embedded agent cookbook.
