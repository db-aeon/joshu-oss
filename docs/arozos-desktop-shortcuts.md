# ArozOS desktop shortcuts and app names

Joshu renames desktop labels and Joshu-owned subservices while keeping stock ArozOS modules working. This doc records **where names live**, the **`.shortcut` file format** (easy to get wrong), and how install scripts refresh icons on disk.

## Two sources of truth

| What | Where | Used for |
|------|--------|----------|
| **Module registry name** | `arozos/subservice/<id>/moduleInfo.json` → `"Name"` | Subservice registration, start menu, float window title, `openModule()` for Joshu apps |
| **Desktop label + launch target** | `.shortcut` files on the user desktop and `system/desktop/template/` | Icon text under the glyph (`ShortcutName`), which module opens (`ShortcutPath`) |

Stock ArozOS apps (File Manager, System Setting, Trash Bin) are **not** Joshu subservices. Only their **desktop shortcuts** and **glyph paths** are customized under `img/joshu/`. The built-in module names stay `File Manager`, `System Setting`, and `Trash Bin`.

Joshu-owned apps update **both** `moduleInfo.json` and shortcuts. Subservice directory names (`joshu/`, `hermes-chat/`, …) stay unchanged; only the registered `"Name"` and shortcut content change.

## Current jōshu display names (May 2026)

| Desktop label | `moduleInfo.json` `"Name"` | Shortcut filename (keep for layout) | Subservice dir |
|---------------|----------------------------|-------------------------------------|----------------|
| jWeb | jWeb | `jWeb.shortcut` | `arozos/subservice/joshu/` |
| jChat | jChat | `jChat.shortcut` | `arozos/subservice/hermes-chat/` |
| jWhiteboard | jWhiteboard | `jWhiteboard.shortcut` | `arozos/subservice/excalidraw/` |
| Memory | Memory | `Memory.shortcut` | `arozos/subservice/hindsight-viewer/` |
| File Brain | File Brain | `File Brain.shortcut` | `arozos/subservice/file-brain-viewer/` |
| jMovie | jMovie | `jMovie.shortcut` | `arozos/subservice/jmovie/` |
| jMail | jMail | `jMail.shortcut` | `arozos/subservice/jmail/` |
| Connectors | Connectors | `Connectors.shortcut` | `arozos/subservice/connectors/` |
| Safety | Safety | `Safety.shortcut` | `arozos/subservice/safety-settings/` |
| Schedules | Schedules | `Schedules.shortcut` | `arozos/subservice/schedules/` |
| Welcome | Welcome | `Welcome.shortcut` | `arozos/subservice/welcome/` |
| Hermes Admin | *(url shortcut)* | `Hermes Admin.shortcut` | VPS: `https://hermes-admin.<customer-domain>/`; local dev: Joshu proxy at `/joshu/hermes-admin/` |
| Files | *(stock)* `File Manager` | `File Manager.shortcut` | — |
| Settings | *(stock)* `System Setting` | `System Setting.shortcut` | — |
| Trash | *(stock)* `Trash Bin` | `Trash Bin.shortcut` | — |

In-app HTML titles (`apps/*/index.html`, shell `<h1>`) should match the desktop label where users see them.

## `.shortcut` file format (four lines)

Plain text, one field per line:

```text
<ShortcutType>
<ShortcutName>
<ShortcutPath>
<ShortcutImage>
```

Example — **jChat** (Joshu subservice; name and path are the same):

```text
module
jChat
jChat
img/joshu/chat.png
```

Example — **Files** (stock module; label differs from module name):

```text
module
Files
File Manager
img/joshu/file-manager.png
```

### Line order matters

ArozOS maps the file roughly as:

- **Line 2 → `ShortcutName`** — text under the icon (`.launchIconText`).
- **Line 3 → `ShortcutPath`** — passed to `openModule()` and matched against installed modules (`vendor/arozos/src/web/desktop.html`).

For Joshu apps, lines 2 and 3 are usually **identical** (the new `moduleInfo.json` name).

For **stock** shortcuts, line 2 is the **friendly label** (`Files`, `Settings`, `Trash`) and line 3 must remain the **stock module name** (`File Manager`, `System Setting`, `Trash Bin`). Swapping these lines breaks launch (e.g. `openModule("Files")`) while the old label can still appear if the desktop layout points at an old filename.

Reference templates upstream: `vendor/arozos/src/system/desktop/template/*.shortcut` (lines 2 and 3 were the same before jōshu relabeling).

## Where shortcuts are installed

| Path | Purpose |
|------|---------|
| `${AROZ_DATA}/system/desktop/template/*.shortcut` | New user desktops |
| `${AROZ_DATA}/files/users/*/Desktop/*.shortcut` | Existing users (refreshed every prepare) |

Local dev: `AROZ_DATA` defaults to `.local/arozos-data` (`scripts/dev-arozos.sh`). Sandbox image: `/var/lib/arozos` (`deploy/scripts/vps-start.sh`).

Install helpers live in `scripts/lib/arozos-desktop-shortcuts.sh` (`install_all_joshu_desktop_shortcuts`), sourced from:

- `scripts/dev-arozos.sh` — local prepare
- `deploy/scripts/vps-start.sh` — VPS container boot
- `deploy/scripts/vps-start.sh` — VPS / Docker boot (required; shortcuts are not baked into the image alone)

Each helper:

1. Writes the template shortcut.
2. Overwrites the same filename on every user `Desktop/`.
3. For renames, **`rm -f`** old `.shortcut` files (e.g. `Joshu Browser.shortcut` → `jWeb.shortcut`) so duplicates and broken layout entries do not linger.

## Desktop layout persistence

Icon **positions** are stored in ArozOS user data, keyed by **shortcut filename** (e.g. `File Manager.shortcut`). Renaming only the file to `Files.shortcut` without updating layout can leave ghosts or stale labels.

**Stock apps:** keep canonical filenames (`File Manager.shortcut`, …) and change **lines 2–4 inside the file** only.

**Joshu apps:** safe to rename the `.shortcut` file when install scripts remove the old name and rewrite all user desktops.

After shortcut changes: **hard-refresh** the desktop (Cmd+Shift+R) or re-login. Restart `npm run dev:arozos` so `prepare_arozos_data` runs install helpers and rsyncs `moduleInfo.json` into `.local/arozos-data/subservice/`.

## Checklist: rename a desktop app

1. **`moduleInfo.json`** — set `"Name"` (Joshu subservices only).
2. **`scripts/dev-arozos.sh` and `deploy/scripts/vps-start.sh`** — update `*_SHORTCUT_CONTENT` and the matching `install_*_shortcuts` function (path, `rm` old files).
3. **App bundle** — `apps/<app>/index.html` and in-app title if shown.
4. **Icons** — `arozos/icons/` → `web/img/joshu/` via `apply_arozos_joshu_theme.py` (required for Joshu desktop shortcuts). Full Tango library (unused icons included): `arozos/tango-icons/` → `web/img/tango/`. See [Tango icon pipeline](design/README.md#tango-icon-pipeline).
5. **Docs / README** — user-facing names.
6. **Restart** — `npm run dev:arozos`; confirm boot log `Subservice Registered: <Name>`.
7. **Verify** — double-click opens the app; label matches line 2 of the shortcut file on disk.

Quick local repair without full restart (stock shortcuts only):

```bash
AROZ_DATA=".local/arozos-data"
printf '%s' $'module\nFiles\nFile Manager\nimg/joshu/file-manager.png\n' \
  > "${AROZ_DATA}/files/users/<user>/Desktop/File Manager.shortcut"
```

## Desktop label typography

Visible labels are enabled in `arozos/web-overlays-vanilla/aroz-vanilla-shell.css` (`.launchIcon .launchIconText`):

- **Work Sans**, 13px, white text
- Tight dark edge via multi-offset `text-shadow` (macOS-style on wallpaper)
- Hover tooltips still sync via `aroz-desktop-icon-tooltips.js` (also guards folder glyph `src` against thumbnail overwrites)

Deploy overlay after CSS/JS edits:

```bash
python3 scripts/apply_arozos_joshu_theme.py .local/arozos-data/web
```

## Troubleshooting

| Symptom | Likely cause |
|---------|----------------|
| Stock icon shows old name, does not open | Lines 2/3 swapped in `.shortcut`, or desktop still has removed `Files.shortcut` while layout references `File Manager.shortcut` |
| Joshu app 404 under `/joshu/` | Subservice not registered; check `.local/arozos-data/subservice/<id>/.disabled` and `Subservice Registered:` in logs |
| Label unchanged after edit | Browser cache; shortcut not rewritten on user Desktop; refresh desktop |
| Duplicate icons | Old `.shortcut` not removed by install helper |
| Folder icon flashes blue then turns tan | Thumbnail loader overwrote folder `src` (fixed in vendor `desktop.html`; hard-refresh) |
| Icons look stretched / oval | Stale `aroz-paper-shell.css` or thumbnail without `object-fit: contain` — re-run apply script and hard-refresh |

## Related docs

- Doc index + naming table: [`docs/README.md`](README.md)
- Design / icons / theme: [`docs/design/README.md`](design/README.md)
- Local stack: [`docs/local-installation.md`](local-installation.md)
- jChat: [`docs/hermes-chat-arozos-app.md`](hermes-chat-arozos-app.md)
- jMail: [`docs/jmail-arozos-app.md`](jmail-arozos-app.md)
- Connectors (OAuth, multi-Gmail): [`docs/connectors-arozos-app.md`](connectors-arozos-app.md)
- Safety (action guard, owner channel): [`docs/safety-settings-arozos-app.md`](safety-settings-arozos-app.md)
- Schedules (Hermes cron): [`docs/schedules-arozos-app.md`](schedules-arozos-app.md)
- jMovie: [`docs/jmovie-arozos-app.md`](jmovie-arozos-app.md)
- VPS boot + shortcut refresh: [`docs/hitl-camofox-notes.md`](hitl-camofox-notes.md)
