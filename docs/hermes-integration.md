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

**Telegram / Slack (optional):** configure bot tokens in `~/.hermes/.env`. Use a **separate** bot for write-approval (action guard) vs full agent chat — see [`connectors.md`](connectors.md) and [`safety-settings-arozos-app.md`](safety-settings-arozos-app.md).

## Hindsight memory

Hermes uses Hindsight for long-term memory. Viewer subservice: Memory app on the desktop. Index paths and MCP tools are documented in [`file-brain.md`](file-brain.md) and skill READMEs under `integrations/hermes/skills/`.

## Related docs

- [`hermes-chat-arozos-app.md`](hermes-chat-arozos-app.md) — jChat request path and voice
- [`connectors.md`](connectors.md) — Composio, mail mirrors, action guard
- [`agent-safety.md`](agent-safety.md) — write policy overview
