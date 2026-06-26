# jMovie ArozOS App (Creatomate editor)

Joshu includes **jMovie**, an ArozOS subservice that hosts a port of the Creatomate
video editor UI (timeline, property inspector, preview) backed by Joshu APIs for
project storage and media upload.

## Shape

| Piece | Path |
|-------|------|
| Vite/React app | `apps/movie-editor/` |
| ArozOS registration | `arozos/subservice/jmovie/` (`moduleInfo.json`, `start.sh`) |
| Built static assets | `dist/movie-editor/` → `arozos/subservice/jmovie/app/` |
| Joshu API | `src/movieEditorApi.ts` → routes under `/api/movie-editor/*` |
| Local data | `.local/movie-editor/projects/`, `.local/movie-editor/media/` |

The browser talks to Joshu for CRUD and uploads. **Creatomate Preview** runs in-page
via `@creatomate/preview` (not an iframe to creatomate.com). The public preview token
is baked into the Vite bundle at build time.

## Environment variables

Set these in the **repo root** `.env` (Vite reads the repo root via `envDir` in
`apps/movie-editor/vite.config.ts`):

| Variable | Required | Purpose |
|----------|----------|---------|
| `VITE_CREATOMATE_PUBLIC_TOKEN` | Yes (preview) | Creatomate **public** preview token; embedded at `npm run build:movie-editor` |
| `MOVIE_EDITOR_DEFAULT_SOURCE` | No | Filesystem path to a starter Creatomate JSON; seeds/reseeds the `default` project when empty |
| `VITE_MOVIE_EDITOR_API_BASE` | No | Override API base (default `/joshu/api/movie-editor`) |

Server-only (Joshu Express, not Vite):

- `MOVIE_EDITOR_DEFAULT_SOURCE` — same path; read when creating or reseeding `default.json`.

After changing `VITE_CREATOMATE_PUBLIC_TOKEN`, rebuild and refresh the subservice app:

```bash
npm run build:movie-editor
# dev-arozos rsyncs dist/ on next start; or manually:
rsync -a --delete dist/movie-editor/ .local/arozos-data/subservice/jmovie/app/
```

## API (Joshu)

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/movie-editor/projects` | List projects |
| `POST` | `/api/movie-editor/projects` | Create project |
| `GET` | `/api/movie-editor/projects/:id` | Load project + Creatomate `source` |
| `PUT` | `/api/movie-editor/projects/:id` | Save `source` |
| `DELETE` | `/api/movie-editor/projects/:id` | Delete project |
| `POST` | `/api/movie-editor/upload` | Upload media; returns URL under `/joshu/media/movie/...` |

## Local development

Full ArozOS stack:

```bash
npm run dev:arozos
```

Launch **jMovie** from the desktop. Joshu must be healthy on `127.0.0.1:8788` under `/joshu`.

Standalone editor (Vite on port 3005, proxies `/joshu/api` → Joshu):

```bash
npm run dev:movie-editor
```

Open `http://127.0.0.1:3005` with Joshu running separately.

## Desktop registration

- `arozos/subservice/jmovie/moduleInfo.json` — `"Name": "jMovie"`, `StartDir` / `LaunchFWDir`: `jmovie/index.html`
- Desktop shortcut installed by `install_jmovie_shortcuts` in `scripts/dev-arozos.sh` and `scripts/modal-start.sh`

See [`docs/arozos-desktop-shortcuts.md`](arozos-desktop-shortcuts.md) for the four-line `.shortcut` format.

## Creatomate preview notes

- **Fonts:** Only include entries in `source.fonts` when each has a **`source`** URL (font file). Text layers use `font_family` on elements; Google Fonts CSS is loaded in the iframe for preview only (`apps/movie-editor/src/lib/creatomate-source.ts`). Do not push `{ family, weight }` without `source` — Creatomate rejects `setSource` with  
  `Composition.fonts[0].source: Shouldn't be null or undefined`.
- **Blend mode:** `blend_mode: "normal"` is sanitized to `"none"` before preview.
- **Empty preview:** If the player area shows “Creatomate preview not configured”, the bundle was built without `VITE_CREATOMATE_PUBLIC_TOKEN` — set it in `.env` and run `npm run build:movie-editor`.

## Modal packaging

`modal_app.py` / `npm run modal:predeploy` run `npm run build:movie-editor` and rsync into
`/opt/arozos-template/subservice/jmovie/app/`. Ensure the Creatomate public token is available
in the build environment (image build args or embedded `.env` on the builder host).

## Troubleshooting

| Symptom | Likely cause |
|---------|----------------|
| Blank player, no error | Missing `VITE_CREATOMATE_PUBLIC_TOKEN` at build time |
| `Failed to set source: Composition.fonts[0].source` | Invalid `fonts[]` entries without `source` URL |
| Project empty | No `MOVIE_EDITOR_DEFAULT_SOURCE` or `default` project already has elements |
| API 404 on `:8787` | Call Joshu at `:8788/joshu/api/...` or open via ArozOS subservice (proxied) |
| Stale UI after edit | Rebuild `movie-editor` and rsync `dist/` into `subservice/jmovie/app/` |

## Related docs

- Desktop shortcuts: [`docs/arozos-desktop-shortcuts.md`](arozos-desktop-shortcuts.md)
- Shell theme (Work Sans on desktop chrome, not inside jMovie): [`docs/design/README.md`](design/README.md)
- Local stack: [`docs/local-installation.md`](local-installation.md)
