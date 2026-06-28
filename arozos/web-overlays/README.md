# Branded shell overlays (JDL)

The **paper-shell** theme and Joshu-branded shell assets live in the private
**`joshu-design`** repository.

OSS builds use `arozos/web-overlays-vanilla/` by default.

## Local dev

`npm run dev:arozos` **auto-detects** a sibling `../joshu-design` checkout when
`JOSHU_DESIGN_PACK` is unset. Without it, the box applies **vanilla** shell
(black desktop, system fonts).

Explicit override:

```bash
export JOSHU_DESIGN_PACK=/path/to/joshu-design
npm run dev:arozos
```

Manual re-apply to a running data tree:

```bash
export JOSHU_DESIGN_PACK=/path/to/joshu-design
python3 scripts/apply_arozos_joshu_theme.py .local/arozos-data/web
```

Troubleshooting: [`docs/design/README.md`](../docs/design/README.md#verifying-the-shell-theme-in-the-browser).

## Fleet build

```bash
export JOSHU_DESIGN_PACK=/path/to/joshu-design
python3 scripts/apply_arozos_joshu_theme.py /path/to/arozos/web
```

See also [`scripts/fleet-build-env.example.sh`](../scripts/fleet-build-env.example.sh).
