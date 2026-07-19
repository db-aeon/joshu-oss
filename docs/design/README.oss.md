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
| [`arozos/web-overlays-vanilla/SystemAO/file_system/share_to.html`](../../arozos/web-overlays-vanilla/SystemAO/file_system/share_to.html) | Share To picker (File sharing page / Chat with files → chat_share.html) |
| [`arozos/web-overlays-vanilla/SystemAO/file_system/chat_share.html`](../../arozos/web-overlays-vanilla/SystemAO/file_system/chat_share.html) | Chat sharing dialog (public URL + Slack channel + Enable/Remove Sharing) |
| [`arozos/web-overlays-vanilla/SystemAO/file_system/file_share.html`](../../arozos/web-overlays-vanilla/SystemAO/file_system/file_share.html) | Share dialog (float window; link + permissions; remove/enable toggle) |
| [`arozos/web-overlays-vanilla/system/share/`](../../arozos/web-overlays-vanilla/system/share/) | Public `/share/*` pages (brandbar + identity; login-aligned `joshu-public-pages.css`) |
| [`arozos/web-overlays-vanilla/joshu-public-pages.css`](../../arozos/web-overlays-vanilla/joshu-public-pages.css) | Shared guest CSS for File Share + Share Chat |
| [`arozos/web-overlays-vanilla/joshu-public-identity.js`](../../arozos/web-overlays-vanilla/joshu-public-identity.js) | Client hydrator for companion portrait / `{owner}'s Joshu` on File Share |
| [`scripts/apply_arozos_joshu_theme.py`](../../scripts/apply_arozos_joshu_theme.py) | Applies overlays at dev/build time (also patches File Manager Share → Share To picker; writes `joshu-public-persona.json`) |

Set `JOSHU_DESIGN_PACK` when building with a **private** design pack checkout (fleet branded chrome). OSS builds omit it and use Vanilla only.

**File Share notes:** After changing share overlays, re-run theme apply and **close File Manager** before reopening (iframe JS stays stale until closed). Public share + share-chat pages use the same warm atmosphere / floating panel language as login, with a compact **joshu** wordmark + email-signature identity brandbar. Theme apply writes `web/script/joshu-public-persona.json` so identity still loads when `/joshu` is unreachable. Footers link to [joshu.me](https://joshu.me). Full fleet design doc: see private `joshu/docs/design/README.md` § File Share overlays and [`../share-chat.md`](../share-chat.md#public-guest-surfaces).

When developing from a full local folder layout, `npm run dev:arozos` in the private monorepo auto-detects a sibling `joshu-design` checkout if present. Self-hosters without the design pack always get Vanilla — see [`../platform-architecture.md`](../platform-architecture.md) for app/platform docs (separate from shell branding).

## Related docs

- [`../local-installation.md`](../local-installation.md) — `npm run dev:arozos`
- [`../arozos-desktop-shortcuts.md`](../arozos-desktop-shortcuts.md) — desktop shortcut format
- [`../hermes-chat-arozos-app.md`](../hermes-chat-arozos-app.md) — jChat shell
