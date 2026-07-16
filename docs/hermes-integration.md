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

**Telegram / Slack (optional):** configure bot tokens in `~/.hermes/.env` (Safety app syncs them on save). Use a **separate** bot for write-approval (action guard) vs full agent chat — see below and [`safety-settings-arozos-app.md`](safety-settings-arozos-app.md).

## Telegram 1:1 chat (Hermes messaging gateway)

Full owner ↔ agent chat on Telegram via the Hermes **telegram** platform (long polling). This is **not** the action-guard / approval bot.

| | Hermes chat bot | Action-guard bot |
|---|-----------------|------------------|
| Env | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USERS` | `JOSHU_ACTION_GUARD_TELEGRAM_BOT_TOKEN` |
| Purpose | Agent conversation | HITL Approve/Deny only |

**Setup:** Safety → Hermes Telegram (or paste tokens into `.env` / `.joshu/safety-settings/local-env.json`) → **Restart gateway**. DM the **chat** bot. Sessions use `agent:main:telegram:dm:<chat_id>`.

jChat uses the same gateway process but a different pipe (`api_server` / `joshu-hermes-chat:<sessionId>`). See [`hermes-chat-arozos-app.md`](hermes-chat-arozos-app.md#request-path-jchat-vs-telegram-vs-slack) and [`safety-settings-arozos-app.md`](safety-settings-arozos-app.md).

## Slack chat (Hermes messaging gateway)

Hermes Slack chat uses **Socket Mode** (`SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN`). Do not conflate with other Slack integrations:

| Integration | Config | Purpose |
|-------------|--------|---------|
| **Hermes Slack chat** | Safety → tokens + `SLACK_ALLOWED_USERS` | Full agent DM / channel `@mention` |
| **Owner 1:1 Slack** | Connectors → owner channel | Write approvals (Y/N) only |
| **Composio Slack** | Connectors OAuth | Agent MCP tools (`SLACK_SEND_MESSAGE`, …) |

**Setup (recommended):** Safety → **Hermes Slack chat** → Generate manifest → create app at [api.slack.com](https://api.slack.com/apps) → enable Socket Mode + Messages Tab → install → paste `xoxb-…` / `xapp-…` + your member ID (`U…`) → Save → **Restart gateway**. Invite the bot (`/invite @bot`) for channel `@mentions`.

**One Socket Mode connection per Slack app** — do not reuse the same `xapp-` token on two machines at once (only one receives messages).

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

**Verify:** DM the bot or `@mention` it; gateway log should show `inbound message: platform=slack` in `~/.hermes/logs/gateway.log`. UI details: [`safety-settings-arozos-app.md`](safety-settings-arozos-app.md#hermes-slack-chat).

## Hindsight memory

Hermes uses Hindsight for long-term memory. Viewer subservice: Memory app on the desktop. Index paths and MCP tools are documented in [`file-brain.md`](file-brain.md) and skill READMEs under `integrations/hermes/skills/`.

## Related docs

- [`hermes-chat-arozos-app.md`](hermes-chat-arozos-app.md) — jChat request path and voice
- [`safety-settings-arozos-app.md`](safety-settings-arozos-app.md) — Safety UI for messaging tokens
- [`connectors.md`](connectors.md) — Composio, mail mirrors, action guard
- [`agent-safety.md`](agent-safety.md) — write policy overview
