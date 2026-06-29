# Joshu documentation (open source)

Docs for **self-hosting** the Joshu box stack, building ArozOS apps, and integrating Hermes.

## Desktop apps

| Desktop label | Doc |
|---------------|-----|
| **jWeb** | [`hitl-camofox-notes.md`](hitl-camofox-notes.md) |
| **jChat** | [`hermes-chat-arozos-app.md`](hermes-chat-arozos-app.md) |
| **jMail** | [`jmail-arozos-app.md`](jmail-arozos-app.md) |
| **Connectors** | [`connectors-arozos-app.md`](connectors-arozos-app.md) |
| **Safety** | [`safety-settings-arozos-app.md`](safety-settings-arozos-app.md) |
| **Memory** | [`hermes-integration.md`](hermes-integration.md#hindsight-memory) |
| **File Brain** | [`file-brain.md`](file-brain.md) |
| **jWhiteboard** | [`excalidraw-sandbox.md`](excalidraw-sandbox.md) |
| **Schedules** | [`schedules-arozos-app.md`](schedules-arozos-app.md) |
| **Welcome** | [`welcome-onboarding.md`](welcome-onboarding.md) |
| **jMovie** | [`jmovie-arozos-app.md`](jmovie-arozos-app.md) |

Shortcut format: [`arozos-desktop-shortcuts.md`](arozos-desktop-shortcuts.md).

## Start here

| Topic | Doc |
|-------|-----|
| Self-host (standalone Docker) | [`self-host.md`](self-host.md) |
| Box state / factory reset | [`box-state.md`](box-state.md) |
| Local dev install | [`local-installation.md`](local-installation.md) |
| Hermes integration (skills, gateway, env) | [`hermes-integration.md`](hermes-integration.md) |
| Connectors (mail, calendar, MCP) | [`connectors.md`](connectors.md) |
| File index + search (gbrain) | [`file-brain.md`](file-brain.md) |
| Agent write safety | [`agent-safety.md`](agent-safety.md) |
| Safety desktop app | [`safety-settings-arozos-app.md`](safety-settings-arozos-app.md) |
| Nylas agent inbox | [`nylas-agent-mailbox.md`](nylas-agent-mailbox.md) |
| **Executive assistant (GTD)** | [`executive-assistant.md`](executive-assistant.md) |
| **Day 0 mail analysis** | [`day0-cold-start.md`](day0-cold-start.md) |
| App SDK + `joshu.app.json` | [`app-sdk.md`](app-sdk.md) |
| Platform architecture + `@joshu/platform-data` | [`platform-architecture.md`](platform-architecture.md) · [`platform-data.md`](platform-data.md) |
| Platform smoke test | `npm run test:platform-architecture` |
| App store / sideload / publishers | [`APP_STORE.md`](APP_STORE.md) |
| Third-party licenses | [`THIRD_PARTY.md`](THIRD_PARTY.md) |
| VPS / Docker architecture | [`vps-sandbox/README.md`](vps-sandbox/README.md) |
| Vanilla ArozOS theme | [`design/README.md`](design/README.md) |

## Managed hosting

Joshu-managed boxes with zero-touch provisioning use a **proprietary control plane** (`hello.joshu.me`). Self-hosters do not need it — see [`self-host.md`](self-host.md).

## Mail recall (agents)

Hermes skills define tool order:

1. **`mcp_gbrain_query`** over indexed `connectors/mail/` mirrors
2. **`mcp_joshu_connectors_connectors_sync_now`** to refresh mirrors
3. **Composio Gmail** as live API fallback

Details: [`connectors.md`](connectors.md), [`file-brain.md`](file-brain.md#connector-mail-and-calendar-gbrain).
