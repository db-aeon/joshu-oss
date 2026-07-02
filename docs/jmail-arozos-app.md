# jMail ArozOS app

**jMail** is the desktop mail client for the agent **Nylas inbox** and **Composio Gmail** mirrors. One sidebar tab per inbox; sync health comes from the shared connectors backend.

**Reference implementation** for the Joshu platform stack:

| Piece | Doc / path |
|-------|------------|
| Platform data client | [`@joshu/platform-data`](platform-data.md) — `apps/jmail/src/joshuData.ts` |
| Manifest v2 | `arozos/subservice/jmail/joshu.app.json` |
| Architecture overview | [`platform-architecture.md`](platform-architecture.md) |

## What ships in this repo

| Layer | Location |
|-------|----------|
| Desktop UI | `apps/jmail/` → `dist/jmail/` → `arozos/subservice/jmail/app/` |
| Platform data wrapper | `apps/jmail/src/joshuData.ts` → `createJoshuPlatformData({ apiBase: "/joshu/api" })` |
| Nylas agent API | `src/nylas/routes.ts` → `/joshu/api/nylas/*` (via `platform.nylas.*`) |
| Gmail + mirror status | `platform.connections.status()`, `platform.mail.*` |
| Mirror files | `joshu's files/connectors/mail/nylas/threads/`, `…/gmail/{account_key}/threads/` |
| Headless actions | `POST /joshu/api/apps/jmail/invoke` — `connectorsStatus`, `syncMirror` |
| Embedded agent chat | `@joshu/app-agent` — expandable panel, GUI frontend tools — see [Agent chat panel](#agent-chat-panel) |
| Voice (optional) | Realtime S2S + manifest `voiceCommands` fast path — see [`app-agent.md`](app-agent.md) |

## Platform-data migration

jMail no longer calls `/joshu/api/connectors/*` or `/joshu/api/nylas/*` directly from UI code. All domain I/O goes through `@joshu/platform-data`:

| UI concern | SDK call |
|------------|----------|
| Connector + mirror health | `platform.connections.status()` |
| Mirror sync / empty check | `platform.mail.sync()`, `platform.mail.mirror()` |
| Gmail search / read / send | `platform.mail.search()`, `getGmailMessage()`, `sendGmail()`, `replyGmail()` |
| Nylas inbox | `platform.nylas.status()`, `listMessages()`, `getMessage()`, `sendMessage()`, … |
| Owner identity + profile | `platform.identity.get()`, `platform.nylas.getProfile()` / `saveProfile()` |

Vite alias: [`apps/jmail/vite.config.ts`](../apps/jmail/vite.config.ts).

## Inboxes

| Tab | Source | Setup |
|-----|--------|--------|
| **Agent** (Nylas) | Provisioned agent address | jMail **Setup** → Create Agent Account — see [`nylas-agent-mailbox.md`](nylas-agent-mailbox.md) |
| **Gmail** (one tab per account) | Composio OAuth | **Connectors** app → connect Gmail — see [`connectors-arozos-app.md`](connectors-arozos-app.md) |

jMail reads `status.gmail.accounts[]` from `platform.connections.status()` and shows mirror stats (`threadCount`, `empty`) for both Nylas and Gmail.

## Desktop

| Field | Value |
|-------|--------|
| Module name | `jMail` |
| Subservice dir | `arozos/subservice/jmail/` |
| URL | `/jmail/index.html` |
| Shortcut | `jMail.shortcut` |

## Dev

```bash
npm run dev:jmail    # Vite :3006, proxies /joshu → :8788
npm run build:jmail
```

Bundled into ArozOS by `scripts/dev-arozos.sh` and the VPS Docker image (`build:deploy` includes `build:jmail`).

## Agent recall vs jMail UI

- **Humans** read/send in jMail via platform-data (Nylas API + Gmail mirror routes). Compose sends plain text; the Joshu API appends the companion HTML signature before Nylas delivery ([`src/nylas/routes.ts`](../src/nylas/routes.ts), [`@joshu/email-signature`](../packages/email-signature/)). jMail uses `platform.nylas.sendMessage()` with `X-Joshu-Mail-Client: jmail` — **not** gated (owner browser UI; see [`connectors.md`](connectors.md#action-guard-owner-approval-for-writes)).
- **Hermes** sends via **`mcp_joshu_connectors_nylas_send_message`** (same REST route, gated). Finds mail via **gbrain** over synced markdown mirrors first — skill **`joshu-mail`**. See [`connectors.md`](connectors.md#hermes) and [`file-brain.md`](file-brain.md#connector-mail-and-calendar-gbrain).

Cron refreshes mirrors (Nylas + Gmail every **10m**) when `JOSHU_CONNECTORS_CRON=true` (default).

## Agent chat panel

jMail is the **reference app** for [`@joshu/app-agent`](app-agent.md). To build the same in your app, follow the [**developer guide**](app-agent.md#developer-guide--add-an-agent-to-your-app) (8 steps: manifest → bridge → skill → verify).

| Piece | Location |
|-------|----------|
| Embedded chat bridge | `apps/jmail/src/mailAgentBridge.tsx` — thin wrapper around `JoshuEmbeddedAppAgent` |
| GUI action handlers | `apps/jmail/src/mailGuiActions.ts` — `createJmailGuiActions(guiRef)` |
| Chat session hook | `useAppAgentChatSession({ appId: "jmail", scope: mailbox })` in `main.tsx` |
| Manifest (build-time) | `apps/jmail/src/mailAppManifest.ts` |
| Bundled GUI skill | `arozos/subservice/jmail/skills/jmail-gui/SKILL.md` |
| Server AG-UI + queue | `src/agUiAppContext.ts`, `src/agUiApi.ts`, `src/appGuiActionApi.ts` |
| Hermes tool | `.hermes/plugins/joshu-app-gui/` — **`app_gui_action`** |

**Behavior:**

- Expandable chat rail (`JoshuAgentChatPanel`) uses a **chat thread id** `jmail:{mailbox}:chat:{rev}` (distinct from voice `jmail:{mailbox}`). Use **New chat** in the panel or bump `sessionStorage` key `jmail-agent-chat-rev` to reset Langfuse/Hermes history (`DELETE /joshu/api/ag-ui/session` runs automatically).
- Hermes calls **`app_gui_action(appId="jmail", action=…)`** — not raw CopilotKit tools through chat/completions. AG-UI drains the queue and emits `CUSTOM app_action` + synthesized `TOOL_CALL` events; `@joshu/app-agent` handlers update `guiRef`.
- **Readables** expose current pane, inbox, selection, search, compose draft preview.
- **Frontend tools** mirror manifest `guiActions`: `openCompose`, `openThread`, `searchMail`, `switchInbox`, `startReply`, etc.
- **Send rule:** the agent may open compose with a draft; the user always confirms send in the compose pane.
- **Voice fast path:** phrases like “new email” / “search mail for …” hit `app_action` without a Hermes round-trip; complex work still uses `think` → Hermes + `joshu-mail`.
- Chat may show **`app_gui_action` → Running** alongside **`openCompose` → Done** — the pane update is driven by the client tool row; see [app-agent.md — Chat UI](app-agent.md#chat-ui--two-tool-rows).

Headless / cron / MCP flows unchanged — see [`joshu-mail`](../integrations/hermes/skills/mail/joshu-mail/SKILL.md) and the `jmail-gui` skill for when the GUI is open vs closed.

### Debugging compose / frontend tools

See [app-agent.md — How to confirm quickly](app-agent.md#how-to-confirm-quickly-without-code-changes). After server changes: `npm run build`, restart `dev:arozos`, `POST /joshu/api/safety-settings/restart-gateway`, rebuild jMail if needed, hard-reload the app.

## Related

- [`platform-architecture.md`](platform-architecture.md) — invoke API, skills split
- [`app-agent.md`](app-agent.md) — CopilotKit app chat SDK
- [`platform-data.md`](platform-data.md) — SDK reference
- [`docs/connectors.md`](connectors.md) — mirror layout, REST API, MCP
- [`docs/nylas-agent-mailbox.md`](nylas-agent-mailbox.md) — agent provisioning and Nylas API
- [`docs/arozos-desktop-shortcuts.md`](arozos-desktop-shortcuts.md)
