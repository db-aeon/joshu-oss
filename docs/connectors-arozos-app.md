# Connectors (ArozOS desktop app)

**Connectors** is the app-wide place to manage OAuth connections (Gmail, calendar, Slackbot, etc.). Owner SMS approval is configured via Twilio env (Safety app shows status). jMail, jChat, Hermes, and cron all read the same backend via `GET /joshu/api/connectors/status`.

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

### Slackbot (share-chat KB channels)

Featured toolkit **`slackbot`** is separate from user **`slack`** (approvals / agent tools) and Hermes Slack chat.

1. Open Connectors → Connect apps → **Slackbot** (or `/connectors/index.html#slackbot`).
2. Generate / copy the Slack app manifest → create the app at api.slack.com.
3. Paste Client ID, Client Secret, **Signing Secret**, and **App-Level Token (`xapp-`)** → **Save & Connect** (or **Save credentials** if already OAuth-connected).
4. Paste the shown Event Subscriptions URL into the Slack app. Already connected? Use **Configure Slack app** — do not disconnect.
5. Joshu creates/updates the Composio auth config + webhook endpoint (`ac_…` in `.joshu/composio-auth-configs.json`).

API: `GET/POST /joshu/api/connectors/composio/slackbot/setup`, `GET …/slackbot/manifest`.

### Teams bot (Share Chat, free Teams)

Sideloaded Azure Bot (not Composio). Works with free/personal Teams.

**Feature flag:** Connectors shows this card only when `JOSHU_TEAMS_BOT_UI_ENABLED=true` (default **off**). Backend messaging / bind APIs still work if credentials are already configured.

1. Set `JOSHU_TEAMS_BOT_UI_ENABLED=true`, then open Connectors → **Teams bot** (`#teams-bot`).
2. Create Azure Bot (F0) + Entra app; enable Teams channel; set Messaging endpoint to the URL Joshu shows.
3. Paste App ID + client secret → Save; download the app package zip → Teams → Upload a custom app.
4. From Chat sharing, copy `bind <uuid>` into a Teams chat with the bot.

API: `GET/POST /joshu/api/share-chat/teams/setup` (includes `uiEnabled`), `GET …/teams/manifest.zip`. See [share-chat.md](share-chat.md#microsoft-teams-bot-free--personal-teams).

## Dev

With `npm run dev:arozos` (or `:daemon`) already running:

```bash
# True Vite HMR — open this URL; no ArozOS rebuild needed
npm run dev:connectors   # http://127.0.0.1:3009  (proxies /joshu → :8788)

# Or keep editing in the ArozOS Connectors window: rebuild + sync only this app
npm run watch:connectors
# → writes dist/connectors-app/ and copies into .local/arozos-data/…/connectors/app/
# → refresh the Connectors window (no full stack rebuild)

npm run build:connectors  # one-shot production bundle
```

Backend API changes under `src/connectors/` / `src/meteredProviders/` are picked up by `tsx watch` in `dev:arozos` — restart Joshu only if the watcher missed a file.

Bundled into ArozOS template by `scripts/dev-arozos.sh` and VPS Docker image.

**Build note:** Vite outputs to `dist/connectors-app/` (not `dist/connectors/` — that path is reserved for Joshu API modules from `tsc`).

### Local laptop vs fleet box (Composio)

OAuth tokens live in **Composio cloud**, scoped by **`(COMPOSIO_API_KEY project, COMPOSIO_USER_ID)`** — not by hostname.

| Env | Typical value | Effect |
|-----|---------------|--------|
| `COMPOSIO_API_KEY` | Laptop `.env` vs VPS `/etc/joshu/instance.env` | **Different keys = different Composio projects.** Same `COMPOSIO_USER_ID` does **not** share connections across projects. |
| `COMPOSIO_USER_ID` | Customer slug (e.g. `acme`) | Isolates connections **within** one Composio project (per-box on fleet). |

**Validated (2026-08):** Local `dev:arozos` with a laptop Composio key showed no ACTIVE Gmail/Calendar, while `<slug>.box.joshu.me` (per-box key from `issue-composio-box-keys`) correctly showed ACTIVE accounts — both used `COMPOSIO_USER_ID=<slug>`.

Implications:

- Setting `COMPOSIO_USER_ID=<slug>` in local `.local/instance.env` for fleet relay parity does **not** import the VPS’s Gmail/Calendar unless the laptop also uses that box’s `COMPOSIO_API_KEY`.
- Connect / Disconnect on a shared key+userId mutates **that** Composio project (including the live box if keys match). Prefer a laptop-only key, or `COMPOSIO_USER_ID=<slug>-local`, for day-to-day local work.

### Toolkit list cache (stale “Connected”)

`GET /joshu/api/connectors/composio/toolkits` may serve toolkit **metadata** from disk (`.joshu/composio-toolkits-cache.json`, ~1h) for speed, but **connection state is always reconciled** from live Composio `connectedAccounts.list`. Disconnect / sync / post-connect clear that cache.

Symptoms of an older build without reconciliation: Connectors shows Connected, Disconnect returns **502** / Composio `ConnectedAccount_ResourceNotFound` (404) for ghost `ca_…` ids. Fix: upgrade Joshu, or delete `.joshu/composio-toolkits-cache.json` under the Aroz user and hard-refresh Connectors.

### Metered AI providers (fal.ai)

Connectors → **AI providers** manages fal MCP enablement and (self-host) your `FAL_KEY`. Modes, env, and Hermes gating: [`metered-providers.md`](metered-providers.md).

Self-host: set `JOSHU_FAL_MODE=direct` (or leave unset when no CP relay) and paste a fal key via **Setup**. Managed fleet boxes use prepaid wallet relay instead — no vendor key on the box.

## VPS / self-host provisioning

| `instance.env` key | Source | Notes |
|------------------|--------|--------|
| `COMPOSIO_API_KEY` | Your Composio project (or fleet per-box key) | Required for Connect tab; laptop vs VPS keys are separate projects |
| `COMPOSIO_USER_ID` | Stable user/slug | Composio OAuth isolation within that project; ArozOS login unchanged |
| `NYLAS_API_KEY` | Your Nylas key (or managed relay) | Agent mailbox (jMail Setup / Welcome) |
| `JOSHU_FAL_MODE` | `direct` (self-host) / `relay` (managed) / `off` | See [`metered-providers.md`](metered-providers.md) |
| `FAL_KEY` | Connectors setup (direct mode only) | Stored in `connectors-providers.env` in the Joshu state folder (`JOSHU_STATE_DIR`; `.joshu/` of the repository in local development, gitignored) |

If Connectors shows **NYLAS_API_KEY not configured** or Gmail accounts from another box, set keys in `/etc/joshu/instance.env` (or local `.env`) and recreate the stack — see [connectors.md](connectors.md).

## API (metered providers)

Base: `/joshu/api/connectors/`

| Method | Path | Purpose |
|--------|------|---------|
| GET | `providers` | Metered AI providers (fal.ai) — status + fleet balance |
| GET | `providers/:id/status` | Single provider status |
| POST | `providers/:id/setup` | OSS only — save provider API key |

## API (Composio)

Base: `/joshu/api/connectors/composio/`

| Method | Path | Purpose |
|--------|------|---------|
| GET | `status` | `{ enabled, userId? }` |
| GET | `toolkits` | List/search providers |
| GET | `gmail/accounts` | All connected Gmail accounts |
| POST | `connect` | `{ toolkit, callbackUrl? }` → OAuth popup; callback defaults to `/joshu/oauth-done.html` (“you can close this tab”) |
| POST | `disconnect` | `{ connectedAccountId }` |
| POST | `sync` | Refresh Hermes MCP config |
| POST | `post-connect` | After OAuth: registry + seed Gmail `historyId` (no mail backfill) |

Legacy jChat paths under `/joshu/api/hermes-chat/composio/*` still work (same handlers).

## Multi-Gmail (and multi-account OAuth)

1. Open **Connect apps** and connect Gmail (or Google Calendar, Drive, etc.) via Composio OAuth.
2. Use **Connect another account** on the same provider row for additional inboxes or Google identities.
3. Each Gmail account mirrors to `connectors/mail/gmail/{account_key}/threads/`.
4. **jMail** shows one inbox tab per connected Gmail address.
5. **Day 0 setup** — after at least one Gmail account is connected, use **Analyze mail for setup (Day 0)** at the bottom of **Connect apps** to sync 30 days of mail + calendar and pre-fill the Welcome onboarding draft. See `docs/day0-cold-start.md`.

## Owner SMS approval

Action-guard HITL is **owner SMS** (Telephone owner mobile or `TWILIO_OWNER_CALLER`) — not Connectors. Connect Slack for agent **tools** via **Connect apps** if needed.

**Hermes Slack chat** (full agent DM/@mention) is separate — connect it in **Safety → Slack chat with the companion** (**Connect Slack**). See [hermes-integration — Slack chat](hermes-integration.md#slack-chat-hermes-messaging-gateway).

For policy tiers, bypass rules, browser gate, and the **Safety** desktop app, see [`agent-safety.md`](agent-safety.md).

## Related

- [`docs/metered-providers.md`](metered-providers.md) — paid MCP / fal fleet relay (box)
- [`docs/agent-safety.md`](agent-safety.md) — write policy, HITL, hard blocks
- [`docs/safety-settings-arozos-app.md`](safety-settings-arozos-app.md) — Safety desktop app
- [`docs/connectors.md`](connectors.md) — mirror layout and REST API
- `docs/day0-cold-start.md` — Day 0 cold-start pipeline
- [`docs/arozos-desktop-shortcuts.md`](arozos-desktop-shortcuts.md) — shortcut format
