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
| **jWhiteboard** | [`jwhiteboard-user-guide.md`](jwhiteboard-user-guide.md) · [`jwhiteboard-developer-guide.md`](jwhiteboard-developer-guide.md) · [`excalidraw-sandbox.md`](excalidraw-sandbox.md) |
| **jNotes** | [`jnotes-arozos-app.md`](jnotes-arozos-app.md) |
| **Schedules** | [`schedules-arozos-app.md`](schedules-arozos-app.md) |
| **Welcome** | [`welcome-onboarding.md`](welcome-onboarding.md) |
| **jMovie** | [`jmovie-arozos-app.md`](jmovie-arozos-app.md) |
| **jTerm** | [`jterm-arozos-app.md`](jterm-arozos-app.md) |
| **Telephone** | [`telephone-arozos-app.md`](telephone-arozos-app.md) — box number, owner mobile, think passphrase |
| **Multiplayer** | [`teams.md`](teams.md#the-multiplayer-app) — teams of companions: a group chat of the team with team cards |
| **last30days** | [`last30days-user-guide.md`](last30days-user-guide.md) · [`last30days-arozos-app.md`](last30days-arozos-app.md) |

Shortcut format: [`arozos-desktop-shortcuts.md`](arozos-desktop-shortcuts.md).

## Start here

| Topic | Doc |
|-------|-----|
| Self-host (standalone Docker) | [`self-host.md`](self-host.md) |
| **User manual** (a guide for the owner of a self-hosted box: what to say to your companion and what it sends back) | [`user-manual/README.md`](user-manual/README.md) |
| **Technical reference** (how each subsystem works and why: architecture, theory of operation, design decisions) | [`technical-reference/README.md`](technical-reference/README.md) |
| **System overview** (how a box is built end to end and why the main boundaries exist; read first) | [`technical-reference/system-overview.md`](technical-reference/system-overview.md) |
| **Slack chat** (Connect Slack, the Slack app of a box, tokens, first direct message; how and why) | [`technical-reference/slack-chat.md`](technical-reference/slack-chat.md) |
| **Shared browser live view** (jWeb and the handoff page, active page, Browser Use tab strip; how and why) | [`technical-reference/shared-browser.md`](technical-reference/shared-browser.md) |
| **Voice agent tools** (native async tool path, the delivery claim guard and the work claim guard; how and why) | [`technical-reference/voice-agent-tools.md`](technical-reference/voice-agent-tools.md) |
| **Kanban boards** (every board, task kind, and file pointer; the Hermes dispatcher and the Joshu patches; with diagrams) | [`kanban/README.md`](kanban/README.md) |
| **Releases** | [GitHub Releases](https://github.com/db-aeon/joshu-oss/releases) |
| Box state / factory reset | [`box-state.md`](box-state.md) |
| Local dev install | [`local-installation.md`](local-installation.md) |
| Hermes integration (skills, gateway, env) | [`hermes-integration.md`](hermes-integration.md) |
| Connectors (mail, calendar, MCP) | [`connectors.md`](connectors.md) |
| **Paid MCP / metered fal** (self-host: paste your own key) | [`metered-providers.md`](metered-providers.md) · [`connectors-arozos-app.md`](connectors-arozos-app.md) |
| File index + search (gbrain) | [`file-brain.md`](file-brain.md) |
| Chat with shared files | [`share-chat.md`](share-chat.md) |
| **Runtime assets** (HTML/PNG the API reads — must land in `dist/`) | [`runtime-assets.md`](runtime-assets.md) |
| Agent write safety | [`agent-safety.md`](agent-safety.md) |
| **Deferred realtime goals** (SMS, voice, Slack, Telegram; jChat/AG-UI sync-only) | [`technical-reference/realtime-goals-theory-of-operation.md`](technical-reference/realtime-goals-theory-of-operation.md) · [`realtime-goals.md`](realtime-goals.md) |
| **Multiplayer teams** (companions of different owners in a team: team room, team stand-up, team cards, Multiplayer app) | [`teams.md`](teams.md) |
| Safety desktop app | [`safety-settings-arozos-app.md`](safety-settings-arozos-app.md) |
| Nylas agent inbox | [`nylas-agent-mailbox.md`](nylas-agent-mailbox.md) |
| **Executive assistant (GTD)** | [`executive-assistant.md`](executive-assistant.md) |
| App SDK + `joshu.app.json` | [`app-sdk.md`](app-sdk.md) |
| **Joshu app architecture (gentle intro)** — skills → GUI + voice | [`joshu-app-architecture-intro.md`](joshu-app-architecture-intro.md) |
| **Voice (S2S, think vs speak, instant ack, browser voice)** | [`vps-sandbox/voice-realtime.md`](vps-sandbox/voice-realtime.md) · [`vps-sandbox/voice-think-speak.md`](vps-sandbox/voice-think-speak.md) · [`vps-sandbox/web-voice.md`](vps-sandbox/web-voice.md) |
| **Twilio phone (self-host PSTN)** | [`vps-sandbox/twilio-self-host.md`](vps-sandbox/twilio-self-host.md) · [`telephone-arozos-app.md`](telephone-arozos-app.md) |
| Platform architecture + `@joshu/platform-data` | [`platform-architecture.md`](platform-architecture.md) · [`platform-data.md`](platform-data.md) |
| jWhiteboard user guide (how to run a session) | [`jwhiteboard-user-guide.md`](jwhiteboard-user-guide.md) |
| jWhiteboard developer guide (architecture, code map, runtime, debugging) | [`jwhiteboard-developer-guide.md`](jwhiteboard-developer-guide.md) |
| Curatorial Whiteboard model (CWM, authority, pointer, sidecars) | [`curatorial-whiteboard.md`](curatorial-whiteboard.md) |
| Unit tests (`npm test`) and what CI runs | [`local-installation.md` — Unit tests](local-installation.md#unit-tests) |
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
