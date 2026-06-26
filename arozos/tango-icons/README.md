# Tango icon library (full set)

Complete **[Tango Desktop Project](https://github.com/marcus105/tango-icons-for-windows)** **256×256 PNG** archive for jōshu / ArozOS (**230 icons**). Smaller sizes and SVG in the upstream zip are **not** imported — 256×256 is the source used for desktop scaling.

Most icons are **not wired into the desktop UI** yet; they are checked in so the box (and future apps/skills) can reference them without re-downloading the zip.

## Layout

```
arozos/tango-icons/
  manifest.json          # index of all icons (path, category, name)
  actions/               # e.g. document-save.png
  apps/
  categories/
  devices/
  emblems/
  emotes/
  mimetypes/
  places/
  status/
```

On a running ArozOS instance, `apply_arozos_joshu_theme.py` copies this tree to **`web/img/tango/`** (URL prefix `img/tango/…`).

Example: `img/tango/apps/internet-web-browser.png`

## Rebuild from zip

```bash
TANGO_ICONS_ZIP=~/Downloads/tango-icons-for-windows-main.zip \
  bash scripts/build-arozos-tango-icon-library.sh
```

Rebuild **library + mapped desktop icons** (128×128 file types, 800×800 module icons):

```bash
bash scripts/build-arozos-desktop-file-icons.sh
python3 scripts/apply_arozos_joshu_theme.py .local/arozos-data/web
```

## Related

- Active desktop/file mappings: [`scripts/build-arozos-desktop-file-icons.sh`](../../scripts/build-arozos-desktop-file-icons.sh) → `arozos/desktop-icons/`, `arozos/icons/`
- Design doc: [`docs/design/README.md`](../../docs/design/README.md#tango-icon-pipeline)
