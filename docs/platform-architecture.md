# Joshu platform architecture

Single entry point for how Joshu apps, agents, and shared data fit together.

**Status:** Phases 1–4 shipped in the box stack (June 2026). New apps should follow this model; legacy REST/MCP routes remain under the hood.

## Three layers

```text
┌─────────────────────────────────────────────────────────────┐
│  App layer (per app)                                        │
│  joshu.app.json · Vite UI · optional app SKILL.md · actions │
└───────────────────────────┬─────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────┐
│  Platform data plane (shared)                                 │
│  connections · mail/calendar mirrors · files (gbrain) · memory│
└───────────────────────────┬─────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────┐
│  Runtime adapters (hidden from app devs)                    │
│  POST /api/apps/:id/invoke · POST /api/ag-ui/run · MCP codegen│
└───────────────────────────────────────────────────────────────┘
```

| Layer | You build | You do not learn |
|-------|-----------|------------------|
| App | UI + manifest + optional skill | Raw MCP ports, connector path layout |
| Platform data | `@joshu/platform-data` calls | `:8794` gbrain, `:8795` connectors MCP |
| Runtime | — (box provides) | Hermes gateway internals |

**Design rules**

- Platform owns connections, cache, and index. **Connectors** app = OAuth admin only.
- **Cache before live** — use `tier: cache | live | sync` in platform-data; skills say *when*, SDK says *how*.
- **One handler, many wires** — manifest `agent.actions` → invoke API → same code as MCP tools.
- **Skills = procedure, platform = mechanics** — `joshu-mail` / `joshu-brain` stay shared; app skills cover UX-only flows.

## Domains

| Domain | Store | App SDK | Implementation detail |
|--------|-------|---------|------------------------|
| Connections | Composio + Nylas registry | `connections.status()` | [`connectors.md`](connectors.md) |
| Mail / calendar | Mirror markdown + live APIs | `mail.*`, `calendar.*` | [`connectors.md`](connectors.md) |
| Files | gbrain index | `files.query()`, `files.getPage()` | [`file-brain.md`](file-brain.md) |
| Memory | Hindsight bank | `memory.status()`, `memory.recall()`, `memory.graph()` | [`hermes-integration.md`](hermes-integration.md#hindsight-memory) |

## Packages

| Package | Path | Role |
|---------|------|------|
| `@joshu/platform-data` | [`packages/platform-data/`](../packages/platform-data/) | Browser/Node client for platform data plane |
| `@joshu/app-sdk` | [`packages/app-sdk/`](../packages/app-sdk/) | Manifest validation CLI (`joshu-app validate`) |
| `@joshu/design-system` | [`packages/design-system/`](../packages/design-system/) | In-app UI tokens (separate from ArozOS shell) |

Build: `npm run build` (root) builds both platform packages. Smoke test: `npm run test:platform-architecture`.

## App developer checklist

1. Build UI in `apps/<name>/` with `@joshu/design-system`.
2. Add `joshu.app.json` with `data.uses[]` and optional `agent` block — see [`app-sdk.md`](app-sdk.md).
3. Use **`@joshu/platform-data`** for all domain I/O (reference: [`jmail-arozos-app.md`](jmail-arozos-app.md)).
4. Declare platform skills in `agent.usesSkills` (e.g. `joshu-mail`); bundle app-specific skills under `skills/` for sideload.
5. Optional headless actions → `agent.actions` → `POST /joshu/api/apps/:id/invoke`.

Validate manifests:

```bash
node packages/app-sdk/dist/cli.js validate arozos/subservice/my-app/joshu.app.json
```

### Vite alias pattern

Point `@joshu/platform-data` at package source during dev (see [`apps/jmail/vite.config.ts`](../apps/jmail/vite.config.ts)):

```typescript
resolve: {
  alias: {
    "@joshu/platform-data": path.resolve(appRoot, "../../packages/platform-data/src/index.ts"),
  },
},
```

Wrap the client in one module per app (e.g. [`apps/jmail/src/joshuData.ts`](../apps/jmail/src/joshuData.ts)):

```typescript
import { createJoshuPlatformData } from "@joshu/platform-data";
export const platform = createJoshuPlatformData({ apiBase: "/joshu/api" });
```

## Platform skills vs app skills

| Kind | Examples | Location |
|------|----------|----------|
| Platform | `joshu-mail`, `joshu-brain`, EA suite | `integrations/hermes/skills/` |
| App | `my-app-compose` (optional) | Bundle `skills/` → `$HERMES_HOME/skills/apps/<id>/` |

**Install:** [`scripts/install-joshu-app.sh`](../scripts/install-joshu-app.sh) copies bundle skills and registers `agent.skill` in `.joshu/app-skills.json`.

**Allowlist merge:** [`src/hermesSkillsConfig.ts`](../src/hermesSkillsConfig.ts) merges manifest skill names + registry into the effective Hermes allowlist at gateway sync. See [`hermes-integration.md`](hermes-integration.md#disabled-skills-product-denylist).

Platform skills (`joshu-mail`, `joshu-brain`) were slimmed to reference platform-data / invoke — workflow and escalation stay in the SKILL.md files.

## App invoke API

Unified entry for GUI hooks, cron, MCP tools, and future AG-UI tool wiring.

| Route | Purpose |
|-------|---------|
| `GET /joshu/api/apps` | List manifests (`id`, `data`, `agent`) |
| `POST /joshu/api/apps/:appId/invoke` | Run a declared action |

Request body:

```json
{ "action": "syncMirror", "args": { "provider": "nylas", "ifEmpty": true } }
```

Response:

```json
{ "ok": true, "appId": "jmail", "action": "syncMirror", "result": { "threadsWritten": 42 } }
```

**Server modules**

| File | Role |
|------|------|
| [`src/appRegistry.ts`](../src/appRegistry.ts) | Load `arozos/subservice/*/joshu.app.json`; action handler registry |
| [`src/appInvokeApi.ts`](../src/appInvokeApi.ts) | HTTP routes + built-in handlers |
| [`src/appSkillsRegistry.ts`](../src/appSkillsRegistry.ts) | `.joshu/app-skills.json` for sideloaded app skills |

**Built-in handlers (pilot)**

| App | Action | Handler |
|-----|--------|---------|
| `jmail` | `connectorsStatus` | `GET /connectors/status` |
| `jmail` | `syncMirror` | `POST /connectors/mail/{provider}/sync` |
| `schedules` | `listCronJobs` | `GET /cron/jobs` |

Register new handlers in `registerBuiltInAppActions()` or extend the registry at install time (future).

**MCP codegen:** emit tool stubs from manifest actions:

```bash
node scripts/generate-app-mcp-tools.mjs
```

Output JSON maps each `agent.actions[]` entry to `POST /joshu/api/apps/:id/invoke`.

## AG-UI interop

Thin adapter — **no CopilotKit runtime** on the box. CopilotKit `HttpAgent` can point at Joshu directly.

| Endpoint | Purpose |
|----------|---------|
| `GET /joshu/api/ag-ui/info` | Agent discovery (`hermes-default`) |
| `POST /joshu/api/ag-ui/run` | SSE stream of AG-UI BaseEvents |

**Supported events:** `RUN_STARTED`, `RUN_FINISHED`, `RUN_ERROR`, `TEXT_MESSAGE_START`, `TEXT_MESSAGE_CONTENT`, `TEXT_MESSAGE_END`, `TOOL_CALL_START`, `TOOL_CALL_END`, `CUSTOM` (`desktop_action` for `openModule`).

Implementation: [`src/agUiApi.ts`](../src/agUiApi.ts) — maps Hermes chat stream → AG-UI SSE.

Voice uses a separate Realtime wire — see [`vps-sandbox/web-voice.md`](vps-sandbox/web-voice.md).

## Memory recall (apps)

Apps can search Hindsight semantically without MCP:

| Client | Route |
|--------|-------|
| `platform.memory.recall({ q, limit })` | `GET /joshu/api/hindsight/recall` |

Server: [`src/hindsightRecallApi.ts`](../src/hindsightRecallApi.ts).

## Reference apps

| App | Platform-data | Manifest v2 | Invoke actions |
|-----|---------------|-------------|----------------|
| **jMail** | Full migration — [`jmail-arozos-app.md`](jmail-arozos-app.md) | `data.uses: mail, connections` | `connectorsStatus`, `syncMirror` |
| **Schedules** | UI still uses `/cron/*` REST | `data.uses: connections` | `listCronJobs` (headless pilot) |

## Testing

```bash
npm run test:platform-architecture
```

Covers tier URL routing, manifest validation, app registry load, and optional live `GET /api/apps` when Joshu is on `:8788`.

## Non-goals (current)

- A2UI generative UI trees
- CopilotKit as a box dependency
- Replacing existing REST/MCP/gbrain routes — consolidation is at the **developer boundary**

## OSS snapshot

Public docs: run [`scripts/prepare-oss-snapshot.sh`](../scripts/prepare-oss-snapshot.sh) after editing this file, [`platform-data.md`](platform-data.md), and [`app-sdk.md`](app-sdk.md).

## Related

- [`platform-data.md`](platform-data.md) — SDK reference
- [`app-sdk.md`](app-sdk.md) — manifest v2, sideload, build pipeline
- [`connectors.md`](connectors.md) — mail/calendar implementation
- [`file-brain.md`](file-brain.md) — gbrain implementation
- [`design/README.md`](design/README.md) — ArozOS shell theme (separate from platform-data)
