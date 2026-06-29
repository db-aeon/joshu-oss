# Nylas agent mailbox

Joshu can provision a **dedicated agent email address** via [Nylas Agent Accounts](https://developer.nylas.com/docs/v3/getting-started/agent-own-email/) — no Google Workspace OAuth. The grant is stored per sandbox user under `.joshu/nylas/`.

## Operator setup

1. [Nylas Dashboard](https://dashboard.nylas.com/) — create app, copy **API key** (region must match `NYLAS_API_URI`).
2. Register and verify a domain ([provisioning](https://developer.nylas.com/docs/v3/agent-accounts/provisioning/)).
3. Set credentials:

| Environment | Where | Keys |
|-------------|--------|------|
| Local dev | Repo root `.env` | `NYLAS_API_KEY`, `NYLAS_API_URI` |
| VPS provision | ``joshu-control-plane/joshu-control-plane/.env.local` or Vercel | `DEFAULT_NYLAS_API_KEY`, optional `DEFAULT_NYLAS_API_URI` → copied to `/etc/joshu/instance.env` |

```dotenv
NYLAS_API_KEY=nyk_v0_...
NYLAS_API_URI=https://api.us.nylas.com   # or https://api.eu.nylas.com
```

The operator laptop `.env` alone does **not** configure running VPS boxes. Patch existing droplets or reprovision — [troubleshooting — Connectors](vps-sandbox/troubleshooting-and-lessons.md#connectors-nylas-and-composio-on-vps).

### Create the `nylas` connector (one-time per app)

```bash
curl -s "${NYLAS_API_URI}/v3/connectors/nylas" \
  -H "Authorization: Bearer ${NYLAS_API_KEY}"
```

If you get `connector.not_found`:

```bash
curl -s -X POST "${NYLAS_API_URI}/v3/connectors" \
  -H "Authorization: Bearer ${NYLAS_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"provider":"nylas"}'
```

## jMail (desktop email client)

After `npm run dev:arozos` (rebuilds jMail on template refresh):

1. Open **jMail** on the ArozOS desktop
2. **Setup** (first run): **Create Agent Account** — e.g. `agent@yourdomain.com` (must match a verified Nylas domain)
3. **Inbox** — list, search, and read messages; opening a message marks it read
4. **Compose** / **Reply** — outbound mail from the agent address
5. **Setup** also has test send and agent profile (owner name, notify email, timezone → `.joshu/nylas/profile.json`)

Grant file: `${AROZ_DATA}/files/users/<user>/.joshu/nylas/agent.json` (`grantId`, `email`).

## Joshu API

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/joshu/api/nylas/status` | Configured + agent provisioned + profile |
| POST | `/joshu/api/nylas/agent` | `{ "email": "agent@…" }` create Agent Account |
| GET | `/joshu/api/nylas/messages` | List/search (`q`, `unread`, `limit`) |
| GET | `/joshu/api/nylas/messages/:id` | Full message (body, headers) |
| PATCH | `/joshu/api/nylas/messages/:id` | Update (`unread`, `starred`) |
| POST | `/joshu/api/nylas/messages/send` | Outbound mail (plain `body`; API appends HTML signature) |
| POST | `/joshu/api/nylas/test-send` | `{ "to": "you@…" }` smoke test |
| GET | `/joshu/api/nylas/profile` | Read agent profile |
| POST | `/joshu/api/nylas/profile` | Update agent profile (incl. EA dials: `spendingThreshold`, `urgentChannel`, `workingHoursStart`, `workingHoursEnd`) |
| GET | `/joshu/api/nylas/events` | List events — **`date` + `timezone`** (preferred) or unix `start`/`end`, optional `calendar_id`, `limit` |
| GET | `/joshu/api/nylas/events/:id` | Event detail (`calendar_id` query, default `primary`) |
| POST | `/joshu/api/nylas/events` | Create event — **`date`, `startLocal`, `endLocal`, `timezone`** or `startTime`/`endTime` epochs |
| PATCH | `/joshu/api/nylas/events/:id` | Update event (same slot fields as create) |
| DELETE | `/joshu/api/nylas/events/:id` | Delete/cancel event |

**Local slots:** pass wall-clock times; Joshu converts to unix epochs server-side ([`src/nylas/localSlot.ts`](../src/nylas/localSlot.ts), `@js-temporal/polyfill`). Example create body:

```json
{
  "title": "Lunch",
  "date": "2026-06-10",
  "startLocal": "12:00",
  "endLocal": "13:00",
  "timezone": "America/Los_Angeles",
  "participants": [{ "email": "owner@example.com" }]
}
```

**Multi-recipient send:** `to` accepts a string or array; use **`cc`** / **`bcc`** for additional guests — do not put `"a@x.com, b@y.com"` in a single `to` string ([`src/nylas/recipients.ts`](../src/nylas/recipients.ts)).

Outbound sends always use the provisioned agent address as `from`. The Joshu API **appends a branded HTML signature** on every send (companion name, `{owner}'s Joshu`, signup link) — built from instance identity at send time, inlined into the Nylas message `body`. See [control-plane-portal.md — Email signature](https://github.com/db-aeon/joshu-control-plane/blob/main/docs/control-plane-portal.md#email-signature-agent-outbound-mail).

**EA v2:** owner Gmail (Composio) and agent Nylas are **separate** polled mirrors — no forward-from-owner setup ([`ea-for-joshu.md`](executive-assistant.md)). Calendar CRUD uses the same Nylas grant as the agent mailbox.

## Connector mirror (gbrain)

Nylas threads are also mirrored to markdown for agent recall:

```text
joshu's files/connectors/mail/nylas/threads/{thread_id}.md
```

- **Sync:** `POST /joshu/api/connectors/mail/nylas/sync` or connector cron (**every 10m** when `JOSHU_CONNECTORS_CRON=true` — same tick as Gmail; see [`src/connectors/scheduler.ts`](../src/connectors/scheduler.ts)). Uses Nylas **Threads API** for discovery + full `message_ids`, then hydrates bodies via `messages.list?thread_id=…` (up to 50 messages per thread).
- **Status:** `GET /joshu/api/connectors/status` → `nylas.mirror`
- **Search (app-local):** `GET /joshu/api/connectors/mail/nylas/search?q=`
- **Hermes recall:** gbrain **`query`** over indexed mirrors — see [`docs/connectors.md`](connectors.md) and [`docs/file-brain.md`](file-brain.md#connector-mail-and-calendar-gbrain)

jMail shows mirror health on the agent tab; **jChat/Hermes** should prefer gbrain + `connectors_sync_now` over live Nylas list for “find that email” tasks.

## Smoke test (curl)

```bash
curl -s http://127.0.0.1:8788/joshu/api/nylas/status | jq .

curl -s -X POST http://127.0.0.1:8788/joshu/api/nylas/agent \
  -H "Content-Type: application/json" \
  -d '{"email":"agent@yourdomain.com"}'

curl -s -X POST http://127.0.0.1:8788/joshu/api/nylas/test-send \
  -H "Content-Type: application/json" \
  -d '{"to":"you@example.com"}'

# Calendar — next 7 days (unix timestamps)
START=$(date -u +%s)
END=$(date -u -v+7d +%s 2>/dev/null || date -u -d '+7 days' +%s)
curl -s "http://127.0.0.1:8788/joshu/api/nylas/events?start=${START}&end=${END}&limit=20" | jq .

curl -s -X POST http://127.0.0.1:8788/joshu/api/nylas/events \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Focus block",
    "startTime": '"${START}"',
    "endTime": '"$((START + 3600))"',
    "timezone": "America/New_York",
    "description": "Test event from Joshu API",
    "participants": [{ "email": "owner@example.com" }],
    "notifyParticipants": true
  }'
```

**EA scheduling:** events live on the **agent** calendar; always include the owner's `primaryWorkEmail` (and confirmed attendees) in `participants` so calendar invites reach real calendars. Hermes should use MCP `nylas_create_event` — see [`ea-scheduling`](../../integrations/hermes/skills/executive-assistant/ea-scheduling/SKILL.md).

## Troubleshooting

| Symptom | Likely cause | Fix |
|--------|----------------|-----|
| `502` `Connector not found` | No `nylas` connector on the Nylas app | Create connector (above) |
| `502` `Domain not found` | Email domain ≠ verified Nylas domain | Use an address on a registered domain |
| `503` on status/agent | `NYLAS_API_KEY` missing on Joshu process | Set in `.env`, restart dev stack |
| `[nylas] events.list failed: Cannot read properties of null (reading 'length')` | Nylas Node SDK crash on agent calendar `events.list` (often empty grant or odd API payload) | **Non-fatal** — [`listEvents`](../src/nylas/client.ts) catches and returns `[]`; mail sync continues. Check `GET /joshu/api/connectors/status` → `nylas.sync` has no `lastError`. If persistent, rebuild PGLite is unrelated; try `GET /events` with valid `start`/`end` or recreate events via `POST /events`. |
| Many `400` / `404` on `/joshu/api/nylas/*` in `docker logs` | Hermes **`ea-scheduling`** trial-and-error (wrong path or missing required fields) | Use routes in the table above only. **404** on `/calendars`, `/events/create`, `/events/delete` means wrong URL — use `POST /events`, `DELETE /events/:id`. **400** on `POST /events` → need `title` plus **`date`/`startLocal`/`endLocal`/`timezone`** or `startTime`/`endTime`; on `messages/send` → `to`, `subject`, `body` (use **`cc`** for guests — not comma-separated `to`). Success lines (`200`) mixed in = normal agent learning, not outage. |
| `connectors/status` shows stale `lastSyncAt` | Cron disabled or Joshu API down | `JOSHU_CONNECTORS_CRON=true`; `GET /joshu/api/connectors/cron/jobs`; manual `POST …/connectors/mail/nylas/sync` |

**Log hygiene:** Express logs every HTTP status. For sync health, prefer **`/joshu/api/connectors/status`** over counting yellow `400`/`404` lines in `docker logs`. EA ops detail: [`executive-assistant.md`](executive-assistant.md#operations--logs).
