# Connectors (ArozOS desktop app)

**Connectors** is the app-wide place to manage OAuth connections, Gmail accounts, and connector sync health. jMail, jChat, Hermes, and cron all read the same backend via `GET /joshu/api/connectors/status`.

## What ships in this repo

| Layer | Location |
|-------|----------|
| Desktop UI | `apps/connectors/` → `dist/connectors-app/` → `arozos/subservice/connectors/app/` |
| Composio OAuth API | `src/connectors/composioRoutes.ts` → `/joshu/api/connectors/composio/*` |
| Connector status + Gmail sync | `src/connectors/routes.ts`, `src/connectors/composio/gmailAccounts.ts` |
| Registry snapshot | `.joshu/connectors-registry.json` (per sandbox user) |
| Multi-Gmail mirrors | `connectors/mail/gmail/{account_key}/threads/` under `JOSHU_FILES_ROOT` |
| jMail | One sidebar tab per `status.gmail.accounts[]` entry |
| jChat | **Open Connectors** only (no inline OAuth modal) |
| Hermes MCP | `mcp-joshu-connectors` — `connectors_sync_now` accepts optional `connectedAccountId` |
| Cron | `poll-nylas` + `sync-gmail` jobs sync agent inbox and **all** enabled Gmail accounts every **10m** |

## Desktop

| Field | Value |
|-------|--------|
| Module name | `Connectors` |
| Subservice dir | `arozos/subservice/connectors/` |
| URL | `/connectors/index.html` |
| Shortcut | `Connectors.shortcut` |

## Dev

```bash
npm run dev:connectors   # Vite :3009, proxies /joshu → :8788
npm run build:connectors
```

Bundled into ArozOS template by `scripts/dev-arozos.sh` and VPS Docker image.

**Build note:** Vite outputs to `dist/connectors-app/` (not `dist/connectors/` — that path is reserved for Joshu API modules from `tsc`).

## VPS provisioning

| `instance.env` key | Source | Notes |
|------------------|--------|--------|
| `COMPOSIO_API_KEY` | `DEFAULT_COMPOSIO_API_KEY` in control plane | Required for Connect tab |
| `COMPOSIO_USER_ID` | Customer slug at provision | Composio OAuth **per box**; ArozOS login unchanged |
| `NYLAS_API_KEY` | `DEFAULT_NYLAS_API_KEY` in control plane | Agent mailbox row in Connectors overview |

If Connectors shows **NYLAS_API_KEY not configured** or Gmail accounts from another sandbox, see [vps-sandbox/troubleshooting — Connectors](vps-sandbox/troubleshooting-and-lessons.md#connectors-nylas-and-composio-on-vps).

## API (Composio)

Base: `/joshu/api/connectors/composio/`

| Method | Path | Purpose |
|--------|------|---------|
| GET | `status` | `{ enabled, userId? }` |
| GET | `toolkits` | List/search providers |
| GET | `gmail/accounts` | All connected Gmail accounts |
| POST | `connect` | `{ toolkit, callbackUrl? }` → OAuth popup |
| POST | `disconnect` | `{ connectedAccountId }` |
| POST | `sync` | Refresh Hermes MCP config |
| POST | `post-connect` | After OAuth: registry + seed Gmail `historyId` (no mail backfill) |

Legacy jChat paths under `/joshu/api/hermes-chat/composio/*` still work (same handlers).

## Multi-Gmail (and multi-account OAuth)

1. Open **Connect apps** and connect Gmail (or Google Calendar, Drive, etc.) via Composio OAuth.
2. Use **Connect another account** on the same provider row for additional inboxes or Google identities.
3. Each Gmail account mirrors to `connectors/mail/gmail/{account_key}/threads/`.
4. **jMail** shows one inbox tab per connected Gmail address.
5. **Day 0 setup** — after at least one Gmail account is connected, use **Analyze mail for setup (Day 0)** at the bottom of **Connect apps** to sync 30 days of mail + calendar and pre-fill the Welcome onboarding draft. See [`docs/day0-cold-start.md`](day0-cold-start.md).

## Owner 1:1 channel (Overview)

**Connectors → Overview → Owner 1:1 channel** links Telegram or Slack for HITL write approvals. OAuth for Slack uses the same Composio connection flow as other toolkits.

| Provider | Setup |
|----------|--------|
| **Telegram** | Paste chat ID or send `/start` to the action-guard bot |
| **Slack** | Connect Slack in **Connect apps**, then paste channel ID — self-DM (`D…`) or private channel (`C…`, e.g. `#patrick-approvals`) |

Slack approvals use **Y/N replies** in that channel (not interactive Block Kit buttons). Approval messages show companion **avatar + name** in the message body via Block Kit. Full flow: [`agent-safety.md` — Slack approval flow](agent-safety.md#slack-approval-flow-v1).

**Hermes Slack chat** (full agent DM/@mention) is separate — configure in **Safety → Hermes Slack chat**, not Connectors. See [hermes-customizations — Slack chat](hermes-customizations.md#slack-chat-hermes-messaging-gateway).

For policy tiers, bypass rules, browser gate, and the **Safety** desktop app, see [`agent-safety.md`](agent-safety.md).

## Related

- [`docs/agent-safety.md`](agent-safety.md) — write policy, HITL, hard blocks
- [`docs/safety-settings-arozos-app.md`](safety-settings-arozos-app.md) — Safety desktop app
- [`docs/connectors.md`](connectors.md) — mirror layout and REST API
- [`docs/day0-cold-start.md`](day0-cold-start.md) — Day 0 cold-start pipeline
- [`docs/arozos-desktop-shortcuts.md`](arozos-desktop-shortcuts.md) — shortcut format
