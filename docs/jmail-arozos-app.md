# jMail ArozOS app

**jMail** is the desktop mail client for the agent **Nylas inbox** and **Composio Gmail** mirrors. One sidebar tab per inbox; sync health comes from the shared connectors backend.

## What ships in this repo

| Layer | Location |
|-------|----------|
| Desktop UI | `apps/jmail/` → `dist/jmail/` → `arozos/subservice/jmail/app/` |
| Nylas agent API | `src/nylas/routes.ts` → `/joshu/api/nylas/*` |
| Gmail + mirror status | `GET /joshu/api/connectors/status` |
| Mirror files | `joshu's files/connectors/mail/nylas/threads/`, `…/gmail/{account_key}/threads/` |
| Voice (optional) | Same Realtime S2S stack as jChat — see [`vps-sandbox/web-voice.md`](vps-sandbox/web-voice.md) |

## Inboxes

| Tab | Source | Setup |
|-----|--------|--------|
| **Agent** (Nylas) | Provisioned agent address | jMail **Setup** → Create Agent Account — see [`nylas-agent-mailbox.md`](nylas-agent-mailbox.md) |
| **Gmail** (one tab per account) | Composio OAuth | **Connectors** app → connect Gmail — see [`connectors-arozos-app.md`](connectors-arozos-app.md) |

jMail reads `status.gmail.accounts[]` from `GET /joshu/api/connectors/status` and shows mirror stats (`threadCount`, `empty`) for both Nylas and Gmail.

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

Bundled into ArozOS by `scripts/dev-arozos.sh` and the VPS Docker image (`modal:predeploy` includes `build:jmail`).

## Agent recall vs jMail UI

- **Humans** read/send in jMail (Nylas API + Gmail mirror search routes). Compose sends plain text; the Joshu API appends the companion HTML signature before Nylas delivery ([`src/nylas/routes.ts`](../src/nylas/routes.ts), [`@joshu/email-signature`](../packages/email-signature/)). jMail uses `POST …/nylas/messages/send` with `X-Joshu-Mail-Client: jmail` — **not** gated (owner browser UI; see [`connectors.md`](connectors.md#action-guard-owner-approval-for-writes)).
- **Hermes** sends via **`mcp_joshu_connectors_nylas_send_message`** (same REST route, gated). Do not use raw REST from agent code. Finds mail via **gbrain** over synced markdown mirrors first — not by listing Composio or Nylas in routine recall. See [`connectors.md`](connectors.md#hermes) and [`file-brain.md`](file-brain.md#connector-mail-and-calendar-gbrain).

Cron refreshes mirrors (Nylas + Gmail every **10m**) when `JOSHU_CONNECTORS_CRON=true` (default).

## Related

- [`docs/connectors.md`](connectors.md) — mirror layout, REST API, MCP
- [`docs/nylas-agent-mailbox.md`](nylas-agent-mailbox.md) — agent provisioning and Nylas API
- [`docs/arozos-desktop-shortcuts.md`](arozos-desktop-shortcuts.md)
