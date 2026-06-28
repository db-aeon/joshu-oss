# Design system (open source)

Joshu OSS ships a **Vanilla** ArozOS desktop theme and a shared CSS package for subservices. Branded fleet assets (JDL paper shell, custom icons) are **not** in this repository.

## Shared CSS (`@joshu/design-system`)

Tokens and base styles live under [`packages/design-system/`](../../packages/design-system/):

| File | Role |
|------|------|
| `tokens.css` | Palette and layout variables |
| `typography.css` | Work Sans + optional pixel labels |
| `base.css` | Resets and defaults |

Vite subservices import typography → tokens → base, then local `styles.css`.

After changing the package, run:

```bash
npm run sync-design-system
```

## Vanilla ArozOS shell

OSS default overlays (no proprietary brand pack):

| Artifact | Purpose |
|----------|---------|
| [`arozos/web-overlays-vanilla/aroz-vanilla-shell.css`](../../arozos/web-overlays-vanilla/aroz-vanilla-shell.css) | Desktop chrome |
| [`arozos/web-overlays-vanilla/aroz-taskbar-focus.js`](../../arozos/web-overlays-vanilla/aroz-taskbar-focus.js) | Taskbar focus sync |
| [`arozos/web-overlays-vanilla/aroz-jchat-tray.js`](../../arozos/web-overlays-vanilla/aroz-jchat-tray.js) | jChat tray hook |
| [`scripts/apply_arozos_joshu_theme.py`](../../scripts/apply_arozos_joshu_theme.py) | Applies overlays at dev/build time |

Set `JOSHU_DESIGN_PACK` when building with a **private** design pack checkout (fleet branded chrome). OSS builds omit it and use Vanilla only.

When developing from a full local folder layout, `npm run dev:arozos` in the private monorepo auto-detects a sibling `joshu-design` checkout if present. Self-hosters without the design pack always get Vanilla — see [`../platform-architecture.md`](../platform-architecture.md) for app/platform docs (separate from shell branding).

## Related docs

- [`../local-installation.md`](../local-installation.md) — `npm run dev:arozos`
- [`../arozos-desktop-shortcuts.md`](../arozos-desktop-shortcuts.md) — desktop shortcut format
- [`../hermes-chat-arozos-app.md`](../hermes-chat-arozos-app.md) — jChat shell
