# Joshu App SDK

Joshu desktop apps are **Vite applications** packaged as **ArozOS subservices**.
Each app ships with `moduleInfo.json` (ArozOS) and `joshu.app.json` (Joshu licensing).

---

## Layout

```text
apps/my-app/           # Vite source
arozos/subservice/my-app/
  moduleInfo.json      # ArozOS module registry
  joshu.app.json       # License + publisher metadata
  start.sh             # Launch script
  app/                 # Built static assets (dist output)
```

---

## Build pipeline

1. Develop in `apps/<name>/` with `npm run dev:<name>`
2. Build: `npm run build:<name>` → `dist/<name>/`
3. Rsync dist into `arozos/subservice/<name>/app/`
4. Register desktop shortcut in `scripts/lib/arozos-desktop-shortcuts.sh`

`npm run dev:arozos` and the Docker image build perform the rsync automatically.

---

## joshu.app.json

See [`joshu.app.schema.json`](joshu.app.schema.json).

Example (`hermes-chat`):

```json
{
  "id": "hermes-chat",
  "name": "jChat",
  "version": "0.1.0",
  "license": "AGPL-3.0",
  "publisher": "joshu",
  "entry": "hermes-chat/index.html",
  "apiPrefix": "/joshu/api/hermes-chat",
  "description": "Hermes chat stream via Joshu API"
}
```

| `license` | Meaning |
|-----------|---------|
| `AGPL-3.0` | Open source (default for Joshu apps today) |
| `MIT` | Permissive third-party app |
| `proprietary` | Fleet / paid apps in [`proprietary/`](../proprietary/README.md) — not in joshu-oss |

Extended manifest fields (catalog, binaries, pricing): [APP_STORE.md](APP_STORE.md).

---

## Proprietary apps (fleet only)

See [`proprietary/README.md`](../proprietary/README.md). Installed via `scripts/install-proprietary-apps.sh` during `dev:arozos` and fleet Docker builds.

---

## Sideload / marketplace

Phase 1–2: manual `.joshu-app` bundles and `scripts/install-joshu-app.sh` (planned).
Official catalog and paid entitlements: control plane (proprietary). Full policy:
[APP_STORE.md](APP_STORE.md).

---

## Related

- [APP_STORE.md](APP_STORE.md) — distribution tiers, binaries, legal boundaries, roadmap
- [ArozOS subservices](../arozos/subservice/)
- [Desktop shortcuts](arozos-desktop-shortcuts.md)
- [THIRD_PARTY.md](THIRD_PARTY.md)
