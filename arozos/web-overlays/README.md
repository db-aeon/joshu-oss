# Branded shell overlays (JDL)

The **paper-shell** theme and Joshu-branded shell assets live in the private
**`joshu-design`** repository.

OSS builds use `arozos/web-overlays-vanilla/` by default.

Fleet / local branded builds:

```bash
export JOSHU_DESIGN_PACK=/path/to/joshu-design
python3 scripts/apply_arozos_joshu_theme.py /path/to/arozos/web
```
