# Joshu App SDK

Joshu desktop apps are **Vite applications** packaged as **ArozOS subservices**.
Each app ships with `moduleInfo.json` (ArozOS) and `joshu.app.json` (Joshu licensing).

**Platform architecture:** [`platform-architecture.md`](platform-architecture.md) · **Data SDK:** [`platform-data.md`](platform-data.md)

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

### Schema v2 — `data` and `agent`

Optional blocks declare platform dependencies and agent integration:

```json
{
  "data": {
    "uses": ["mail", "calendar", "files", "memory"],
    "mail": { "accounts": "any" }
  },
  "agent": {
    "skill": "my-app",
    "usesSkills": ["joshu-mail", "joshu-brain"],
    "headless": false,
    "intents": [{ "phrase": "open compose", "action": "openCompose" }],
    "actions": [{ "name": "syncMirror", "description": "Refresh local mail cache" }]
  }
}
```

| Field | Meaning |
|-------|---------|
| `data.uses[]` | Platform domains consumed — use `@joshu/platform-data`, not raw REST |
| `agent.usesSkills[]` | Shared Hermes skills (platform-owned) |
| `agent.skill` | App-bundled skill name (sideload → `$HERMES_HOME/skills/apps/<id>/`) |
| `agent.actions[]` | Headless handlers → `POST /joshu/api/apps/:id/invoke` |

**Platform skills** (`joshu-mail`, `joshu-brain`, EA suite) live in `integrations/hermes/skills/`.
**App skills** ship in the `.joshu-app` bundle under `skills/<name>/SKILL.md`.

Example (jMail reference):

```json
{
  "id": "jmail",
  "data": { "uses": ["mail", "connections"], "mail": { "accounts": "any" } },
  "agent": {
    "usesSkills": ["joshu-mail"],
    "actions": [
      { "name": "connectorsStatus" },
      { "name": "syncMirror" }
    ]
  }
}
```

Validate: `node packages/app-sdk/dist/cli.js validate path/to/joshu.app.json`

---

## `@joshu/app-sdk`

Manifest validation for schema v2. Built with root `npm run build`.

| | |
|-|-|
| Package | [`packages/app-sdk/`](../packages/app-sdk/) |
| CLI | `node packages/app-sdk/dist/cli.js validate <path>` |

```bash
node packages/app-sdk/dist/cli.js validate arozos/subservice/jmail/joshu.app.json
# OK arozos/subservice/jmail/joshu.app.json (jmail@0.1.0)
```

Programmatic use:

```typescript
import { validateJoshuAppManifest } from "@joshu/app-sdk";
const result = validateJoshuAppManifest(JSON.parse(raw));
```

---

## Sideload with `install-joshu-app.sh`

Install a `.joshu-app` bundle (directory or zip) into `arozos/subservice/<id>/`:

```bash
scripts/install-joshu-app.sh /path/to/my-app-bundle
```

**Bundle layout:**

```text
my-app/
  joshu.app.json
  moduleInfo.json
  start.sh
  app/                 # built static assets
  skills/              # optional: my-skill/SKILL.md
    my-skill/
      SKILL.md
```

The script:

1. Rsyncs into `arozos/subservice/<id>/` (or `JOSHU_AROZ_SUBSERVICE`)
2. Validates manifest via `@joshu/app-sdk` when built
3. Copies `skills/` → `$HERMES_HOME/skills/apps/<id>/`
4. Registers `agent.skill` in `.joshu/app-skills.json` (merged at Hermes gateway sync)

After install, refresh desktop shortcuts manually or restart `npm run dev:arozos`.

**MCP tool stubs** from manifest actions:

```bash
node scripts/generate-app-mcp-tools.mjs
```

See [`platform-architecture.md`](platform-architecture.md#app-invoke-api).

---

## Proprietary apps (fleet only)

See [`proprietary/README.md`](../proprietary/README.md). Installed via `scripts/install-proprietary-apps.sh` during `dev:arozos` and fleet Docker builds.

---

## Sideload / marketplace

Manual `.joshu-app` bundles: [`scripts/install-joshu-app.sh`](../scripts/install-joshu-app.sh) (see [Sideload](#sideload-with-install-joshu-appsh) above).
Official catalog and paid entitlements: control plane (proprietary). Full policy:
[APP_STORE.md](APP_STORE.md).

---

## Related

- [platform-architecture.md](platform-architecture.md) — three-layer model, invoke + AG-UI
- [platform-data.md](platform-data.md) — `@joshu/platform-data` SDK
- [APP_STORE.md](APP_STORE.md) — distribution tiers, binaries, legal boundaries, roadmap
- [ArozOS subservices](../arozos/subservice/)
- [Desktop shortcuts](arozos-desktop-shortcuts.md)
- [THIRD_PARTY.md](THIRD_PARTY.md)
