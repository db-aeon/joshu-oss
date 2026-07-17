# jōshu design assets

> **Repo split:** Branded fleet assets (paper shell, full Tango pipeline) live in the private
> **`joshu-design`** pack (`JOSHU_DESIGN_PACK`). OSS builds use **`arozos/web-overlays-vanilla/`**.
> ArozOS upstream changes go in **`patches/arozos/`**, applied at dev/build time — not as commits
> in `vendor/arozos`.

## Style guide

The UI board reference is checked in as [`joshu-style-guide-v1.png`](joshu-style-guide-v1.png) (jōshu v1 components and palette).

Core tokens: **PAPER** `#f5f0eb`, **INK** `#0d0d0d`, **ACTION** `#0057ff`, **PEACH** `#f2cbae` (title bars / highlights). Typography: **Work Sans** for UI, **Silkscreen** for sparse pixel labels. Surfaces are flat (no glass / heavy blur); borders are sharp 1px ink where the style guide calls for structure.

## Portrait direction (optional / later)

The Design Brief “jōshu portrait” track (faded drug-store print, grain, color cast) is **not** part of the core CSS token layer. When implemented, treat it as:

- Curated photography or illustration assets
- Light CSS overlays (grain opacity, warm/cool cast) scoped to avatar regions only

Do not use portrait treatment on dense tool UI or data tables.

## Shared CSS package (`@joshu/design-system`)

Canonical tokens and base styles live under [`packages/design-system/`](../../packages/design-system/):

| File | Role |
|------|------|
| `tokens.css` | Palette, semantic colors, layout variables (`--color-paper`, `--color-action`, borders, radii) |
| `typography.css` | Google Fonts import (Work Sans + Silkscreen), `--font-ui`, `--font-pixel` |
| `base.css` | Global resets and defaults that consume tokens |

**Vite apps** (Hermes Chat, Hindsight Viewer, Excalidraw; jMovie uses its own Tailwind bundle) import in this order in each design-system app’s `main.tsx`:

1. `@joshu/design-system/typography.css`
2. `@joshu/design-system/tokens.css`
3. `@joshu/design-system/base.css`
4. Local `styles.css` (app-specific layout only; prefer tokens over hard-coded colors)

**Express / static HITL** (`public/index.html`) loads the same CSS from `/design-system/*`. Those files are **not** edited by hand: `npm run sync-design-system` (also run on `npm install` via `prepare`) copies from `packages/design-system/` → `public/design-system/` using [`scripts/sync-design-system-public.mjs`](../../scripts/sync-design-system-public.mjs).

After changing tokens or typography in the package, run:

```bash
npm run sync-design-system
```

Then rebuild any Vite app you care about (`npm run build:hermes-chat`, etc.) or restart `npm run dev:arozos` so rsync’d subservices pick up fresh `dist/`.

## Typography notes (Work Sans)

- In CSS always use **`font-family: "Work Sans", …`** plus numeric **`font-weight`** (400–700). Do **not** use internal face names like `WorkSans-Bold` or `WorkSansRoman-Bold` as the family name.
- Chrome DevTools → **Rendered fonts** may still list an internal OpenType name (e.g. `WorkSansRoman-Bold`). That is normal for variable/static cuts from Google Fonts; it does not mean the stack is wrong.
- Google Fonts is loaded from `typography.css` with discrete weights:  
  `Work+Sans:ital,wght@0,400;0,500;0,600;0,700;1,400`

## ArozOS desktop shell

Joshu ships an overlay that restyles the ArozOS **desktop** (taskbar, start menu, float window chrome, desktop icons with visible labels and hover tooltips) to align with jōshu **without** forking all of `desktop.html`. A small set of **upstream patches** in [`vendor/arozos/src/web/desktop.html`](../../vendor/arozos/src/web/desktop.html) (init splash removal, interaction-layer cleanup, recovery hooks, **Tango folder paths**, **skip folder thumbnails**, icon `src` sync on noflash refresh) is rsync’d into `.local/arozos-template-source/web/` on each `dev-arozos` run and then into `.local/arozos-data/web/`.

| Artifact | Purpose |
|----------|---------|
| [`arozos/web-overlays/aroz-paper-shell.css`](../../arozos/web-overlays/aroz-paper-shell.css) | Shell theme (loaded from ArozOS `web/` root) |
| [`arozos/web-overlays/aroz-taskbar-focus.js`](../../arozos/web-overlays/aroz-taskbar-focus.js) | Syncs `.jp-fwb-active` onto the taskbar tab for the front float window (z-index 101 / 501) |
| [`arozos/web-overlays/aroz-desktop-icon-tooltips.js`](../../arozos/web-overlays/aroz-desktop-icon-tooltips.js) | Visible desktop labels (CSS); native `title` tooltips; keeps folder glyphs on Joshu Tango paths (guards against stale stock / thumbnail `src`) |
| [`arozos/web-overlays/aroz-desktop-overlay-guard.js`](../../arozos/web-overlays/aroz-desktop-overlay-guard.js) | Clears stuck notification/drag layers (skips mid move/resize); multi-tab stale-tab recovery; console helpers |
| [`arozos/web-overlays/init-black.jpg`](../../arozos/web-overlays/init-black.jpg) | Plain black tile copied over stock `img/desktop/bg/init.jpg` (see [startup splash](#desktop-startup-splash)) |
| [`scripts/apply_arozos_joshu_theme.py`](../../scripts/apply_arozos_joshu_theme.py) | Copies overlay CSS/JS; [`arozos/icons/`](../../arozos/icons/) → `web/img/joshu/`; [`arozos/desktop-icons/`](../../arozos/desktop-icons/) → `web/img/desktop/`; [`arozos/tango-icons/`](../../arozos/tango-icons/) → `web/img/tango/`; patches `file_explorer.html` + `desktop.html`; replaces `init.jpg`; injects versioned `<link>` / `<script defer>` |
| [`scripts/build-arozos-tango-icon-library.sh`](../../scripts/build-arozos-tango-icon-library.sh) | Import **all** 256×256 Tango PNGs from zip → `arozos/tango-icons/` + `manifest.json` |
| [`scripts/build-arozos-desktop-file-icons.sh`](../../scripts/build-arozos-desktop-file-icons.sh) | Runs library import, then rebuilds mapped **file/folder/module** PNGs (`arozos/desktop-icons/`, `arozos/icons/`) |
| [`arozos/icons/`](../../arozos/icons/) | Joshu **module + desktop wallpaper folder** assets served as `web/img/joshu/<name>.png` |
| [`arozos/desktop-icons/`](../../arozos/desktop-icons/) | Tango replacements for stock ArozOS **file-type** and **system_icon** glyphs under `web/img/desktop/` |
| [`arozos/tango-icons/`](../../arozos/tango-icons/) | Full Tango archive (**230** PNGs at 256×256, all categories) — served as `web/img/tango/<category>/<name>.png` |
| **OSS vanilla only** | |
| [`arozos/web-overlays-vanilla/login.html`](../../arozos/web-overlays-vanilla/login.html) | Sign-in (replaces stock ArozOS login) |
| [`arozos/web-overlays-vanilla/user.html`](../../arozos/web-overlays-vanilla/user.html) | First-account setup |
| [`arozos/web-overlays-vanilla/joshu-auth-pages.css`](../../arozos/web-overlays-vanilla/joshu-auth-pages.css) | Login / setup styling → `script/joshu-auth-pages.css` |
| [`arozos/icons/icon.svg`](../../arozos/icons/icon.svg) | Canonical favicon (vendored from `joshu-public/app/icon.svg`) → `img/public/joshu-icon.svg` |
| [`arozos/web-overlays-vanilla/SystemAO/info/`](../../arozos/web-overlays-vanilla/SystemAO/info/) | System Settings About + Overview (no imuslab vendor graphics) |
| [`arozos/web-overlays-vanilla/SystemAO/file_system/share_to.html`](../../arozos/web-overlays-vanilla/SystemAO/file_system/share_to.html) | Share To picker (File sharing page / Chat with files → `chat_share.html`) |
| [`arozos/web-overlays-vanilla/SystemAO/file_system/chat_share.html`](../../arozos/web-overlays-vanilla/SystemAO/file_system/chat_share.html) | Chat sharing dialog (public chat URL + Enable/Remove Sharing) |
| [`arozos/web-overlays-vanilla/SystemAO/file_system/file_share.html`](../../arozos/web-overlays-vanilla/SystemAO/file_system/file_share.html) | File Share dialog (Joshu-owned; link + permissions, no QR; refreshes File Manager on remove) |
| [`arozos/web-overlays-vanilla/SystemAO/locale/file_share.json`](../../arozos/web-overlays-vanilla/SystemAO/locale/file_share.json) | Locale for the File Share dialog |
| [`arozos/web-overlays-vanilla/system/share/`](../../arozos/web-overlays-vanilla/system/share/) | Public share pages (folder list fix, not-found without stock art, Joshu footer → joshu.me) |
| File Manager Share → Share To | `apply_arozos_joshu_theme.py` patches `file_explorer.html` `shareFile()` to open `share_to.html` via `parent.newFloatWindow` |

**When it runs**

- [`scripts/dev-arozos.sh`](../../scripts/dev-arozos.sh) — after syncing upstream `vendor/arozos` `web/` into `.local/arozos-template-source/web`, and again on **`.local/arozos-data/web/`** after each `prepare_arozos_data` rsync (so `desktop.html` keeps the `<link>` even if the data tree was partially updated)
- [`deploy/RELEASE.json`](../../deploy/RELEASE.json) — during image build on `/opt/arozos-template/web`
- **VPS (OSS + fleet)** — `deploy/docker-compose.yml` bind-mounts `arozos/web-overlays-vanilla/` and `scripts/apply_arozos_joshu_theme.py` so `git pull` + theme re-apply can refresh chrome without an image rebuild; `vps-start.sh` runs apply on boot

### Auth, favicon, and System Settings (vanilla / OSS)

[`apply_arozos_joshu_theme.py`](../../scripts/apply_arozos_joshu_theme.py) also patches:

- **Favicon** — `<link rel="icon" href="img/public/joshu-icon.svg">` on desktop, login, user setup, System Settings
- **System Settings** — Joshu wordmark in sidebar; About group labels; **Joshu** tab under About (box state); Vendor tab removed; locale overlay with `en-us` alias for `applocale`
- **Password reset templates** — `arozos/web-overlays-vanilla/system/reset/` → `system/reset/`
- **File Share** — Joshu-owned dialog + public `/share/*` pages (see [File Share overlays](#file-share-overlays))

After changing overlays, re-run theme apply and **close System Settings completely** before re-opening (iframe + locale cache). See [`docs/oss-fleet-sync.md`](../oss-fleet-sync.md).

### File Share overlays

Joshu owns the share UI instead of patching upstream ArozOS in `vendor/arozos`. Theme apply deploys overlays into the live ArozOS data tree (`web/` for the dialog; `system/share/` for public pages).

| Surface | Overlay | Behavior |
|---------|---------|----------|
| **Share To picker** | `SystemAO/file_system/share_to.html` | First float window from File Manager Share. Destinations: **File sharing page** (opens current share dialog) and **Chat with files** (opens Chat sharing dialog). |
| **Chat sharing** | `SystemAO/file_system/chat_share.html` | Public chat URL + Copy / Open / **Remove ↔ Enable Sharing** (same ArozOS share create/delete as File sharing). Guests use `/joshu/share-chat/:uuid`. |
| **Share dialog** | `SystemAO/file_system/file_share.html` (+ locale) | Link + permissions (no QR), Copy, **Remove ↔ Enable Sharing** toggle. Refreshes open File Manager windows after create/remove. |
| **File Manager wiring** | Patch in `apply_arozos_joshu_theme.py` | `shareFile()` opens cache-busted `share_to.html?v=…`; exposes `window.joshuRefreshFileManager()` (needed because `currentPath` is a scoped `let`). |
| **Public folder share** | `system/share/downloadPageFolder.html` | Fixes stock `convertToBytes` so sizes like `386.00Bytes` do not abort the file list (files were missing; folders still showed). Footer → Joshu. |
| **Not found / denied / index / file download** | `system/share/{notfound,permissionDenied,index,downloadPage}.html` | Not-found and permission-denied drop stock decorative artwork; all public pages use footer **File sharing by [Joshu](https://joshu.me)**. |

**Dev tip:** After changing share overlays, re-run theme apply, **close File Manager completely**, then reopen it (float iframes keep stale JS until closed). Share dialog URLs include `?v=` cache-bust so the dialog itself usually reloads cleanly.

Edit overlays under `arozos/web-overlays-vanilla/`, not `vendor/arozos`.

**`JOSHU_DESIGN_PACK` resolution**

| Context | Branded (`aroz-paper-shell.css`) | Vanilla (`aroz-vanilla-shell.css`) |
|---------|----------------------------------|-------------------------------------|
| Fleet Docker build | `JOSHU_DESIGN_PACK` set in build env | — |
| Local `dev:arozos` | Auto-detects `../joshu-design` sibling, or explicit env | When design pack missing |
| OSS self-host | — | Default |

If the desktop suddenly looks **stock** (black background, system serif fonts, plain taskbar) after restarting `dev:arozos`, check `desktop.html` for `aroz-vanilla-shell.css` vs `aroz-paper-shell.css`. Re-apply branded theme:

```bash
export JOSHU_DESIGN_PACK=/path/to/joshu-design   # or rely on sibling auto-detect
python3 scripts/apply_arozos_joshu_theme.py .local/arozos-data/web
```

Hard-refresh the desktop tab (`Cmd+Shift+R`).

Joshu subservices set `IconPath` in `moduleInfo.json` (e.g. `img/joshu/chat.png`). `scripts/dev-arozos.sh` and `deploy/scripts/vps-start.sh` also rewrite **stock** desktop shortcuts (File Manager, System Setting, Trash Bin) and Joshu app shortcuts to `img/joshu/*` on every data prepare. Stock ArozOS **file-type** icons under `vendor/arozos/src/web/img/desktop/` are **overridden at runtime** by [`arozos/desktop-icons/`](../../arozos/desktop-icons/) (see [Tango icon pipeline](#tango-icon-pipeline)).

### Taskbar, start menu, and context menus

`aroz-paper-shell.css` maps ArozOS chrome to **PAPER / INK / ACTION** (flat surfaces, no glass):

| Area | Behavior |
|------|----------|
| **`#navimenu`** | Paper background, ink top border; **hostname strip hidden** (ArozOS `-hostname` label, e.g. Joshu-HITL-Local) |
| **Start grid + tool panel** (bottom-left PNGs) | Recolored to **ink** via `filter: brightness(0)` so they match clock text; hover uses **action-soft** tile |
| **Open window tabs** | Ink labels; **`.jp-fwb-active`** on the tab for the front float window (see `aroz-taskbar-focus.js`) with a light inset highlight |
| **`#listMenu`**, **`#quickAccessPanel`**, **`#stackedWindowList`** | Paper panels, ink borders, peach hovers, **ACTION** search underline |
| **`.aroz.contextmenu`** | Paper + ink; peach row hover; **Work Sans** on menu text |

**Typography on shell UI:** `desktop.html` sets `* { font-family: … }` with a long system stack (including serif CJK fallbacks). The overlay forces **Work Sans** on shell regions with `#listMenu *`, `#navimenu *`, etc. (`!important`, excluding Semantic `i.icon` glyphs).

### CSS filename: do not use `joshu-*.css` on subserved paths

Static files under the Joshu subservice are served with a path prefix. A path like `/joshu/joshu-desktop-theme.css` is **normalized** and the second `joshu` segment is stripped, producing **`/joshu/-desktop-theme.css`** → **404**.

Use a neutral name such as **`aroz-paper-shell.css`**. The apply script also removes legacy `joshu-desktop-theme.css` if present.

### Float window chrome (upstream `ao.css` vs overlay)

ArozOS builds float windows in `desktop.html` roughly as:

```html
<div class="floatWindow …">
  <div class="controls fwdragger …">
    <img class="moduleicon" …>
    <div class="title">…</div>
    <div class="fwcontrol">
      <!-- optional dock buttons on touch builds -->
      <div class="buttons mintoggle">…</div>
      <div class="buttons maxtoggle">…</div>
      <div class="buttons closetoggle close">…</div>
    </div>
  </div>
  <div class="iframewrapper"> … iframe … </div>
</div>
```

**Classic Mac–style title bar (jōshu overlay):** pinstripe gray chrome, **close on the left**, **title centered** (Work Sans, **no border** on the title strip—only a flat plateau over the stripes), **minimize + zoom on the right**. Layout uses **`display: grid` on `.controls`** and **`display: contents` on `.fwcontrol`**. Chrome is **flat** (no inset bevels or gradients; solid fills and ink borders on controls). Stock `img/system/{min,max,close}.svg` stay in the DOM for ArozOS JS (e.g. max ↔ restore) but are **hidden**; control glyphs are **CSS-drawn**. Module icons in the title bar are **hidden** for this chrome style.

Upstream [`vendor/arozos/src/web/script/ao.css`](../../vendor/arozos/src/web/script/ao.css) behavior that the overlay corrects:

| Upstream rule | Problem | jōshu overlay fix |
|---------------|---------|-------------------|
| `.fwdragger { text-shadow: … }` (4-way faux outline) | **`text-shadow` inherits** onto `.title` → chunky title text | `text-shadow: none` on `.fwdragger` / `.controls` and `.title` |
| `.floatWindow.white .controls .title { font-weight: 130%; }` | Invalid weight; odd synthesis | `font-weight: 600`, `font-synthesis: none` |
| `.floatWindow .iframewrapper` only has left/right/bottom border | Title bar has **no** side/top ink frame | `border-top/left/right` on `.controls` + matching sides on `.iframewrapper`, `box-sizing: border-box` |
| `backdrop-filter: blur` on controls / iframe | Glass look | `backdrop-filter: none` |
| `.fwcontrol .buttons.close { border-top-right-radius: 6px }` | Rounded corner on old right-aligned close | Square **Mac-style** controls; close is grid column 1 |

The continuous **1px ink** outline is `var(--jp-border)` (`1px solid #0d0d0d`): top + sides on `.controls`, left + right + bottom on `.iframewrapper`, no bottom border on `.controls` (avoids a double line between title bar and body). Title bar height is **`--jp-fw-title-h`** (default `28px` in `:root`); `.iframewrapper` uses the same value for `top` / `height` so the iframe stays aligned with the shorter bar than stock ArozOS (30px).

### Verifying the shell theme in the browser

1. Restart `npm run dev:arozos` after editing `aroz-paper-shell.css`.
2. Hard-refresh the desktop (or disable cache in DevTools).
3. Confirm **`desktop.html`** includes  
   `<link rel="stylesheet" href="./aroz-paper-shell.css?v=…">` **after** `ao.css`  
   (the apply script adds a version query for cache-busting).
4. Confirm **`GET /aroz-paper-shell.css`** returns **200**, not 404.

If chrome still looks stock (system fonts, default ArozOS window chrome):

1. Confirm **`desktop.html`** includes  
   `<link rel="stylesheet" href="./aroz-paper-shell.css?v=…">` **after** `ao.css`  
   (the CSS file can exist on disk while the link is missing — a hard refresh will not load the theme until the link is injected).
2. Re-run the dev script or apply manually to the **live** data tree:

```bash
python3 scripts/apply_arozos_joshu_theme.py .local/arozos-data/web
```

Template-only repair (adjust paths if `AROZ_TEMPLATE` differs):

```bash
python3 scripts/apply_arozos_joshu_theme.py .local/arozos-template-source/web
```

Then hard-refresh the desktop.

### Desktop startup splash

Stock ArozOS sets `body { background-image: url('img/desktop/bg/init.jpg'); }`. That JPEG is a **static image** with white text **“Initializing / ArozOS Web Desktop Mode”** on black — not a live loading indicator. It stays visible until `system/desktop/theme` returns and `#bgwrapper` fades in the wallpaper (can feel “stuck” for tens of seconds on slow boots).

Joshu mitigations:

| Change | Where |
|--------|--------|
| Body uses plain black (`background-image: none`) | `vendor/arozos/src/web/desktop.html` |
| `clearDesktopInitSplash()` on load, init, and theme apply | same |
| Stock `init.jpg` replaced with plain black tile | `apply_arozos_joshu_theme.py` → `web/img/desktop/bg/init.jpg` |

After pulling these changes, **hard-refresh** the desktop (`Cmd+Shift+R`). If the splash text persists, the browser may be caching old `init.jpg` — re-run `python3 scripts/apply_arozos_joshu_theme.py .local/arozos-data/web` and refresh again.

### Desktop interaction recovery (stuck clicks)

Symptoms: logged in, icons or taskbar visible, but clicks do nothing; ESC/clock ineffective; `arozUnblockDesktop()` reports `killed: []` (no overlay found).

| Step | Action |
|------|--------|
| 1 | Hard-refresh (`Cmd+Shift+R`) |
| 2 | DevTools console: `arozRecoverDesktop()` — re-binds handlers and refreshes icons |
| 3 | Still dead? Close the tab; open a fresh `http://127.0.0.1:8787/desktop.html` (stale tab JS is often unrecoverable) |
| 4 | Diagnose: `__arozDesktopDiag()` — init flags, icon count, hit-test stacks |

Root causes addressed in-tree: notification shade `.cover` / `.notificationbar` capturing clicks during jQuery fade (`pointer-events: none` unless `.jp-notifications-open`); drag capture planes (`#fwdragpanel` / `#tfwdragpanel`); wedged init when two tabs load desktop concurrently (storage signal + optional reload).

### Float window move / resize glitches

Symptoms: fast drag or resize (especially with several windows open) jumps oddly, drops focus, or leaves the desktop half-wedged.

| Cause | Fix (in `joshu-core.patch` + overlay guard) |
|-------|-----------------------------------------------|
| Bring-to-front focuses the app iframe → desktop `window` blurs → Joshu recovery reset aborted the gesture | Do not reset interaction layers on focus/blur during move/resize; defer iframe focus until mouseup |
| Timed cleanup / overlay-guard retries cleared `#fwdragpanel` mid-gesture | Skip cleanup while `movingWindow` / `resizingWindow` / `multiSelecting` |
| Body `mouseup` ended resize only | End both move and resize (call `fwup` / `resizeUp`) when release lands off the title bar |
| Maximize-restore drag used `event.Y` (undefined) | Use `event.pageY` |
| Edge hover rewrote **every** `.iframewrapper` class | Scope cursor classes to the hovered window |

After pulling: hard-refresh `desktop.html`. Esc / `arozUnblockDesktop()` still clears stuck drag planes if needed.

### Shell vs in-app styling

- **`aroz-paper-shell.css`** — ArozOS desktop chrome only (windows, taskbar, icon grid).
- **`@joshu/design-system`** — Joshu-owned surfaces: Hermes Chat, Hindsight Viewer, Excalidraw bundles, `public/` HITL HTML.
- **jMovie** — Creatomate video editor (`apps/movie-editor/`); uses its own Tailwind/shadcn bundle inside the float window iframe, not `@joshu/design-system`. See [`docs/jmovie-arozos-app.md`](../jmovie-arozos-app.md).

Embedded apps inside float windows do **not** automatically inherit the design-system package unless their own bundle imports it.

### Desktop icons: labels, tooltips, and layout

- **Visible labels** — `.launchIconText` is shown (Work Sans, 13px, white type with a tight dark `text-shadow` for wallpaper contrast). See [`docs/arozos-desktop-shortcuts.md`](../arozos-desktop-shortcuts.md) for rename/shortcut format notes.
- **Names on hover** — `aroz-desktop-icon-tooltips.js` copies each label into the native `title` attribute (browser tooltip). A `MutationObserver` keeps upload/rename icons in sync and restores folder glyphs if `src` is overwritten.
- **Square glyph box** — `aroz-paper-shell.css` forces every `.launchIcon .launchIconImage` into a **1:1 box** with `object-fit: contain` (medium size ≈ 68×68 px). This applies to module PNGs, file-type PNGs, **and** `data:image/jpeg` thumbnails so tall launch slots do not stretch icons. Do **not** use `transform: scale` on desktop icons (distorts in non-square slots).

### Tango icon pipeline

Joshu desktop icons use the **[Tango Desktop Project](https://github.com/marcus105/tango-icons-for-windows)** set (256×256 PNG sources). Three output trees:

| Output dir | Served as | Canvas | Typical use |
|------------|-----------|--------|-------------|
| [`arozos/tango-icons/`](../../arozos/tango-icons/) | `web/img/tango/<category>/<name>.png` | 256×256 (source) | **Full library** — all Tango icons, wired or not |
| [`arozos/icons/`](../../arozos/icons/) | `web/img/joshu/<name>.png` | 800×800 (480 px glyph) | Module shortcuts, start menu, taskbar, **desktop wallpaper folders** |
| [`arozos/desktop-icons/`](../../arozos/desktop-icons/) | `web/img/desktop/<path>.png` | 128×128 (104 px glyph) | File Manager list view, desktop **file** icons (`files_icon/default/*`, `system_icon/*`) |

**Full library import** (230 icons — actions, apps, categories, devices, emblems, emotes, mimetypes, places, status):

```bash
TANGO_ICONS_ZIP=~/Downloads/tango-icons-for-windows-main.zip \
  bash scripts/build-arozos-tango-icon-library.sh
```

Index: [`arozos/tango-icons/manifest.json`](../../arozos/tango-icons/manifest.json). See [`arozos/tango-icons/README.md`](../../arozos/tango-icons/README.md).

**Rebuild mapped desktop icons + library** (defaults to `~/Downloads/tango-icons-for-windows-main.zip`):

```bash
TANGO_ICONS_ZIP=~/Downloads/tango-icons-for-windows-main.zip \
  bash scripts/build-arozos-desktop-file-icons.sh
python3 scripts/apply_arozos_joshu_theme.py .local/arozos-data/web
```

Then hard-refresh the desktop (`Cmd+Shift+R`).

**Module icon mapping** (256 px Tango → `arozos/icons/*.png`):

| File | Tango source |
|------|----------------|
| `browser.png` | `apps/internet-web-browser` |
| `chat.png` | `apps/internet-group-chat` |
| `whiteboard.png` | `mimetypes/x-office-drawing` |
| `movie.png` | `mimetypes/video-x-generic` |
| `mail.png` | `apps/internet-mail` |
| `file-manager.png` | `apps/system-file-manager` |
| `system-setting.png` | `categories/preferences-system` |
| `trash.png` | `places/user-trash` |
| `hindsight.png` | `places/folder-saved-search` |
| `pictures.png` | `mimetypes/image-x-generic` |
| `schedules.png` | `mimetypes/x-office-calendar` |
| `connectors.png` | `status/network-transmit-receive` |
| `icon-test.png` | `status/dialog-information` |
| `folder.png` / `folder-open.png` | `places/folder` / `status/folder-open` (desktop **user folders** only) |

**File-type replacements** (`arozos/desktop-icons/files_icon/default/` — all built by `build-arozos-desktop-file-icons.sh`):

| File | Tango source | Extensions / use (via `getIconFromExt` or ArozOS) |
|------|----------------|---------------------------------------------------|
| `file outline.png` | `mimetypes/text-x-generic` | default / unknown |
| `file text outline.png` | `mimetypes/x-office-document` | `.md`, `.txt`, `.rtf`, … |
| `file word outline.png` | `mimetypes/x-office-document-template` | `.doc`, `.docx`, `.odt` |
| `file pdf outline.png` | `mimetypes/application-certificate` | `.pdf` |
| `file excel outline.png` | `mimetypes/x-office-spreadsheet` | `.xlsx`, `.ods` |
| `file powerpoint outline.png` | `mimetypes/x-office-presentation` | `.ppt`, `.pptx`, `.odp` |
| `file image outline.png` | `mimetypes/image-x-generic` | `.jpg`, `.png`, `.gif`, `.psd`, … |
| `file archive outline.png` | `mimetypes/package-x-generic` | `.zip`, `.tar`, `.rar`, `.7z` |
| `file audio outline.png` | `mimetypes/audio-x-generic` | `.mp3`, `.wav`, `.flac`, … |
| `file video outline.png` | `mimetypes/video-x-generic` | `.mp4`, `.webm`, `.mkv`, … |
| `file code outline.png` | `mimetypes/text-x-script` | `.js`, `.html`, `.css`, `.json`, `.php`, … |
| `cube.png` | `mimetypes/package-x-generic` | `.stl`, `.obj`, `.fbx`, … (3D) |
| `cubes.png` | `mimetypes/x-office-drawing` | `.apscene`, multi-object 3D |
| `external square.png` | `emblems/emblem-symbolic-link` | URL shortcuts (`.shortcut` type `url`) |
| `file upload.png` | `status/folder-drag-accept` | Desktop drag-and-drop upload glyph |
| `folder.png` / `folder-with-content.png` | `places/folder` / `status/folder-open` | File Manager folders |
| `folder-shortcut.png` | `emblems/emblem-symbolic-link` | Folder shortcuts |
| `shared square.png` | `places/network-workgroup` | Shared-folder indicator |

**System icons** (`arozos/desktop-icons/system_icon/`):

| File | Tango source | Use |
|------|----------------|-----|
| `folder.png` / `folder-with-content.png` | `places/folder` / `status/folder-open` | Legacy folder paths |
| `folder-shortcut.png` | `emblems/emblem-symbolic-link` | Folder shortcut |
| `script.png` | `mimetypes/application-x-executable` | `.exe` / `.elf` on desktop |
| `shortcut.png` | `emblems/emblem-symbolic-link` | Shortcut creator / module shortcut |
| `bad_shortcut.png` | `status/dialog-error` | Broken shortcut |
| `shared.png` | `status/network-transmit-receive` | Shared-file badge overlay (64×64) |

**Desktop user folders** (e.g. `joshu's files` on the wallpaper) use **`img/joshu/folder.png`** (empty) and **`img/joshu/folder-open.png`** (has contents), patched in `desktop.html` + idempotently re-applied by `apply_arozos_joshu_theme.py`. Cache-bust query params (`?v=2`) avoid stale stock PNGs in the browser.

**Folder thumbnails:** ArozOS `startThumbnailLoader()` WebSocket replaces icon `<img src>` with JPEG previews. For folders those previews were the **old tan stock folder** — jōshu skips `type === "folder"` in both the WebSocket handler and `startFallbackThumbnailLoader()` (vendor patch + apply script).

**File Manager:** `apply_arozos_joshu_theme.py` patches `SystemAO/file_system/file_explorer.html` to use `img/joshu/folder.png` in list/details/grid instead of Semantic UI folder glyphs, and to open Share as a float window (see [File Share overlays](#file-share-overlays)).

### Module and desktop icons (PNG)

ArozOS uses normal **`<img src="…">`** paths for module icons (`IconPath` in `moduleInfo.json`, desktop shortcuts, start menu, taskbar). **One asset path per icon**; CSS scales it per surface (no `@2x` sets). Prefer **PNG** for module icons (SVG still works when under `web/`).

| Location | Served as | Notes |
|----------|-----------|--------|
| [`arozos/icons/*`](../../arozos/icons/) | `web/img/joshu/<file>` | Copied on every `apply_arozos_joshu_theme.py` run |
| `moduleInfo.json` → `"IconPath"` | e.g. `"img/joshu/chat.png"` | Relative to `web/` root |
| Desktop `.shortcut` files | Lines 1–3 = type / display name / module path; line 4 = icon | Installed by `dev-arozos.sh` / `vps-start.sh` — see [`docs/arozos-desktop-shortcuts.md`](../arozos-desktop-shortcuts.md) |

**Checked-in jōshu module icons** (800×800 RGBA PNG):

| File | Used for |
|------|----------|
| `browser.png` | jWeb |
| `chat.png` | jChat |
| `whiteboard.png` | jWhiteboard |
| `movie.png` | jMovie |
| `mail.png`, `pictures.png` | Placeholder Mail / Pictures apps |
| `file-manager.png`, `system-setting.png`, `trash.png` | Stock shortcuts (labels: Files, Settings, Trash) |
| `hindsight.png` | Memory |
| `schedules.png` | Schedules |
| `connectors.png` | Connectors |
| `icon-test.png` | Icon Test reference subservice |
| `folder.png`, `folder-open.png` | Desktop wallpaper user folders (not module shortcuts) |

**Asset guidance:** **800×800 square** alpha PNG for module icons. Center the glyph with modest transparent padding (~480 px painted glyph in the 800 px canvas from `build-arozos-desktop-file-icons.sh`). ArozOS displays desktop icons at roughly **48–82 px** (user `iconsize` preference), start menu at **26 px**, taskbar at **20 px** height.

**Layout in the UI:** `aroz-paper-shell.css` sets `aspect-ratio: 1 / 1`, `object-fit: contain`, and equal width/height on **all** `.launchIcon .launchIconImage` elements (including JPEG thumbnails).

**Transparent backgrounds:** If a traced SVG includes a full-page white rectangle (common from VTracer), remove that `<path>` from the asset—or the “icon” will look like a plate. CSS cannot ignore an opaque path inside the file.

**After changing icons locally:** run `bash scripts/build-arozos-desktop-file-icons.sh` (library import + mapped module/file/system icons), or `bash scripts/build-arozos-tango-icon-library.sh` for the full library only; then `python3 scripts/apply_arozos_joshu_theme.py .local/arozos-data/web` (or restart `npm run dev:arozos`) and hard-refresh the desktop.

**Icon troubleshooting**

| Symptom | Cause | Fix |
|---------|--------|-----|
| Blue Tango folder flashes, then old tan folder | Thumbnail WebSocket overwrote folder `src` | Fixed: folders skipped in thumbnail loader; hard-refresh |
| Module icon looks oval / stretched | Missing square box CSS or `transform: scale` | Confirm `aroz-paper-shell.css` loaded; use `object-fit: contain` |
| File icon stretched after a moment | Thumbnail `data:image/jpeg` lost src-scoped CSS | Fixed: rules apply to all `.launchIconImage` |
| Old folder PNG despite new `desktop.html` | Browser cache | Hard-refresh; folder URLs use `?v=2` cache-bust |

**Reference subservice:** [`arozos/subservice/icon-test/`](../../arozos/subservice/icon-test/) — minimal static app using `img/joshu/icon-test.png`; registered in `dev-arozos.sh` (not required for production VPS unless you add it to `deploy/RELEASE.json`).

## Dependencies (dev noise)

`http-proxy@1.18.1` (used by `http-proxy-middleware` and `scripts/aroz-subproxy.mjs`) historically called Node’s deprecated `util._extend`, which printed **`[DEP0060]`** in the terminal during proxied requests. Joshu applies [`patches/http-proxy+1.18.1.patch`](../../patches/http-proxy+1.18.1.patch) via **`patch-package`** on `npm install` / `pnpm install` (`prepare` script). Hermes-specific patches live under **`scripts/`** (not `patches/`) so `patch-package` does not warn about unrelated files — see [`scripts/apply-hermes-hitl-patch.sh`](../../scripts/apply-hermes-hitl-patch.sh).

## Related docs

- Local stack: [`docs/local-installation.md`](../local-installation.md) (`npm run dev:arozos`)
- VPS / ArozOS topology: [`docs/hitl-camofox-notes.md`](../hitl-camofox-notes.md)
- Desktop shortcuts / app rename process: [`docs/arozos-desktop-shortcuts.md`](../arozos-desktop-shortcuts.md)
- Hermes Chat app shell: [`docs/hermes-chat-arozos-app.md`](../hermes-chat-arozos-app.md)
- jMovie app shell: [`docs/jmovie-arozos-app.md`](../jmovie-arozos-app.md)
