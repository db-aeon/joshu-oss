# Hermes integration

Joshu treats [Hermes](https://github.com/NousResearch/hermes-agent) as an **upstream dependency**. Customize via skills, plugins, environment variables, and Joshu startup scripts — not by forking Hermes.

## Where Hermes lives

**Local development:** separate Hermes checkout; point Joshu at the venv binary:

```bash
export HERMES_BIN=/path/to/hermes-agent/venv/bin/hermes
```

See [`local-installation.md`](local-installation.md) for full setup.

**Docker / VPS:** Hermes is installed inside the sandbox image (typically `/opt/hermes-agent`). Runtime state is under `$HERMES_HOME` (default `~/.hermes`).

**Pin:** Image builds pin `HERMES_AGENT_REF` in `deploy/Dockerfile` / `deploy/RELEASE.json`. Update the pin when upgrading Hermes.

## Customization points

| Layer | Location in this repo |
|-------|------------------------|
| Skills | `integrations/hermes/skills/` |
| Toolsets / MCP wiring | `src/hermes*.ts`, gateway sync scripts |
| Gateway env | `~/.hermes/.env`, synced from box `.env` on start |
| jChat / voice routes | `apps/hermes-chat/`, [`hermes-chat-arozos-app.md`](hermes-chat-arozos-app.md) |
| Action guard | [`connectors.md`](connectors.md#action-guard-owner-approval-for-writes) |

Install optional Hermes extras (`voice`, `messaging`, …) in the same venv/image as documented in `local-installation.md`.

## Gateway

Joshu runs `hermes gateway run` for jChat, optional Telegram/Slack messaging, and MCP tool hosting. Restart via `npm run dev:arozos` locally or `vps-start.sh` on a box.

**Telegram / Slack (optional):** configure bot tokens in `~/.hermes/.env` (Safety app syncs them on save). These are **agent chat** surfaces only — write-approval HITL is owner SMS. See [`safety-settings-arozos-app.md`](safety-settings-arozos-app.md) and [`agent-safety.md`](agent-safety.md#owner-approval-sms).

Deep customization (skills, plugins, Langfuse, patches): [`hermes-integration.md`](hermes-integration.md).

## Telegram 1:1 chat (Hermes messaging gateway)

Full owner ↔ agent chat on Telegram via the Hermes **telegram** platform (long polling). This is **not** action-guard HITL — approvals use owner SMS.

| | Hermes chat bot |
|---|-----------------|
| Env | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USERS` |
| Purpose | Agent conversation (jChat-equivalent on Telegram) |

**Setup:** Safety → Hermes Telegram (or paste tokens into `.env` / `local-env.json`) → **Restart gateway**. DM the **chat** bot. Sessions use `agent:main:telegram:dm:<chat_id>`.

jChat uses the same gateway process but a different pipe (`api_server` / `joshu-hermes-chat:<sessionId>`). See [`hermes-chat-arozos-app.md`](hermes-chat-arozos-app.md#request-path-jchat-vs-telegram-vs-slack). Full steps: [`hermes-integration.md` — Telegram](hermes-integration.md#telegram-11-chat-hermes-messaging-gateway).

## Slack chat (Hermes messaging gateway)

Hermes Slack chat uses **Socket Mode** (`SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN`). Do not conflate with other Slack integrations:

| Integration | Config | Purpose |
|-------------|--------|---------|
| **Hermes Slack chat** | Safety → tokens + `SLACK_ALLOWED_USERS` | Full agent DM / channel `@mention` |
| **Composio Slack** | Connectors OAuth | Agent MCP tools (`SLACK_SEND_MESSAGE`, …) |

**Setup (recommended):** Safety → **Hermes Slack chat** → Generate manifest → create app at [api.slack.com](https://api.slack.com/apps) → enable Socket Mode + Messages Tab → install → paste `xoxb-…` / `xapp-…` + your member ID (`U…`) → Save → **Restart gateway**. Invite the bot (`/invite @bot`) for channel `@mentions`.

**One Socket Mode connection per Slack app** — do not reuse the same `xapp-` token on local and a VPS box at once (only one machine receives messages).

**Channel replies vs threads:** Hermes defaults to replying in a Slack **thread** for channel `@mentions`. To reply in the main channel instead, set in `~/.hermes/config.yaml` then restart the gateway:

```yaml
platforms:
  slack:
    extra:
      reply_in_thread: false
      # Optional: keep threads but also post the first reply to the channel
      # reply_broadcast: true
```

Messages already inside a thread still get in-thread replies. Upstream: [Hermes Slack messaging](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/slack).

**Session timeout:** Joshu idle-resets Slack and Telegram after **30 minutes** (`JOSHU_HERMES_MESSAGING_IDLE_MINUTES`). jChat stays continuous. Past chats remain in `session_search`.

**Verify:** DM the bot or `@mention` it; gateway log should show `inbound message: platform=slack` in `~/.hermes/logs/gateway.log`. UI details: [`safety-settings-arozos-app.md`](safety-settings-arozos-app.md#hermes-slack-chat). Full steps: [`hermes-integration.md` — Slack](hermes-integration.md#slack-chat-hermes-messaging-gateway).

## Hindsight memory

Hermes uses Hindsight for long-term memory. Viewer subservice: Memory app on the desktop. Index paths and MCP tools are documented in [`file-brain.md`](file-brain.md) and skill READMEs under `integrations/hermes/skills/`.

## Coordination scope (multi-channel, 2026-09)

Executive Assistant mail can spawn **scheduling** (`ea-scheduling`) and **owner-reply** (`ea-owner-reply`) workers from the same owner-facing ask. **Coordination scope** mutexes those spawns across Kanban boards and mail provider thread aliases (Gmail vs Nylas, linked by RFC Message-ID).

| Layer | Path |
|-------|------|
| Core | [`src/coordination/`](../src/coordination/) |
| Mail adapter | [`src/coordination/adapters/mail.ts`](../src/coordination/adapters/mail.ts) |
| EA wrapper | [`src/ea/conversationScope.ts`](../src/ea/conversationScope.ts) |

**Workers:** preflight with connectors MCP **`coordination_list_active`** before `scheduling_create_meeting_task` / `owner_reply_create_task`. On conflict the API returns `action: existing_coordination` — hand off to the returned `task_id`.

**REST:** `GET /joshu/api/coordination/scope?channel=mail&threadId=…&sourcePath=…`

Mail is **phase 1**. SMS / Slack / voice adapters will use the same registry ([`executive-assistant.md`](executive-assistant.md#coordination-scope-2026-09)). Fleet-only SOP detail: `docs/hermes-integration.md` (not in OSS tree).

Tests: `npm run test:coordination-scope` · `npm run test:owner-reply`.

## Related docs

- [`hermes-integration.md`](hermes-integration.md) — skills, plugins, Slack/Telegram depth, Langfuse, patches
- [`hermes-chat-arozos-app.md`](hermes-chat-arozos-app.md) — jChat request path and voice
- [`safety-settings-arozos-app.md`](safety-settings-arozos-app.md) — Safety UI for messaging tokens
- [`connectors.md`](connectors.md) — Composio, mail mirrors, action guard
- [`agent-safety.md`](agent-safety.md) — write policy overview
