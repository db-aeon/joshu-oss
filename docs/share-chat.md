# Share Chat (Chat with shared files)

Public Q&A scoped to one ArozOS share UUID. Answers come only from files under that shared path (File Brain + path filter). Full Hermes tools are **not** exposed to public users.

## User flow

1. In File Manager or on the Desktop, choose **Share** → **Share To** (same picker).
2. Pick **Chat with files**.
3. The **Chat sharing** dialog (`chat_share.html`) creates/reuses an ArozOS anyone-with-link share and shows a **public chat URL** (`/joshu/share-chat/:shareUuid`) — copy or open it, like a download link.
4. Guests open that URL and ask questions; answers cite only in-scope sources.
5. **Remove Sharing** deletes the underlying ArozOS share (same as File sharing) and marks chat off — guests get “not available.” **Enable Sharing** creates a new share and a new URL.

The classic **File sharing page** destination is unchanged (`file_share.html`). Desktop **Share** uses the same Share To float as File Manager (patched in `apply_arozos_joshu_theme.py`).

**Public guest UI:** Share Chat and ArozOS File Share download pages share [`joshu-public-pages.css`](../arozos/web-overlays-vanilla/joshu-public-pages.css) — the same warm atmosphere + floating white panel language as login / system lock (not desktop window chrome). See [Public guest surfaces](#public-guest-surfaces) below and [design/README.md § File Share overlays](design/README.md#file-share-overlays).

## Public guest surfaces

Guest File Share (`/share/*`) and Share Chat (`/joshu/share-chat/:uuid`) share one visual system. **Do not** reuse desktop float-window chrome.

### Design language

| Token / cue | Value |
|-------------|--------|
| Atmosphere | Warm paper `#ece9e4` + soft blue gradient (aligned with `joshu-auth-pages.css`) |
| Type | Work Sans |
| Accent | `#2563eb` |
| Panel | White floating card, ~1em radius, soft shadow |
| Brand mark | Lowercase **joshu** wordmark SVG (`img/public/joshu-wordmark.svg` — Work Sans SemiBold, never “Joshu” as display text) |

### Header brandbar

One compact row on both surfaces:

- **Left:** large lowercase joshu wordmark
- **Right:** email-signature lockup — portrait (`imageUrl`, else `avatarUrl`), assistant name, role line `{owner.displayName}'s Joshu` (rose border / divider language from `@joshu/email-signature`)

Share Chat injects identity **server-side** in [`src/shareChat/routes.ts`](../src/shareChat/routes.ts) from `resolveJoshuIdentity()`. File Share pages hydrate **client-side** via [`joshu-public-identity.js`](../arozos/web-overlays-vanilla/joshu-public-identity.js):

1. `GET /joshu/api/instance/identity` (when ArozOS proxies `/joshu`)
2. Fallback `GET /script/joshu-public-persona.json` (written by theme apply from `.joshu/identity.json` / env — needed locally when `/joshu` is not guest-reachable)

### Footers

| Surface | Footer copy |
|---------|-------------|
| File Share | **Joshu** · File sharing by [joshu.me](https://joshu.me) |
| Share Chat | **Joshu** · File chat by [joshu.me](https://joshu.me) |

### Panel width

| Class | Max width | Used for |
|-------|-----------|----------|
| `.jp-public-panel` | 43.2rem (~+20% vs login-sized 36rem) | File / index / error share pages |
| `.jp-public-panel-wide` | 62.4rem | Folder share |
| `.jp-public-panel-chat` | 44rem | Share Chat (unchanged by the File Share width bump) |

### Assets (theme apply)

[`apply_arozos_joshu_theme.py`](../scripts/apply_arozos_joshu_theme.py) copies into the live ArozOS tree:

| Source | Dest |
|--------|------|
| `arozos/web-overlays-vanilla/joshu-public-pages.css` | `web/script/joshu-public-pages.css` |
| `arozos/web-overlays-vanilla/joshu-public-identity.js` | `web/script/joshu-public-identity.js` |
| (generated) persona snapshot | `web/script/joshu-public-persona.json` |
| `arozos/web-overlays-vanilla/system/share/*.html` | `system/share/` |

Share Chat also serves the CSS at `GET /joshu/share-chat/assets/joshu-public-pages.css`. After CSS/HTML changes: re-run theme apply and hard-refresh guest tabs (`?v=` overlay version cache-busts share HTML links).

## Routes

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/joshu/share-chat/:shareUuid` | Lightweight public chat UI |
| `GET` | `/joshu/api/share-chat/:shareUuid/status` | Validate share + metadata |
| `POST` | `/joshu/api/share-chat/:shareUuid/message` | `{ message }` → grounded answer (JSON) |
| `POST` | `/joshu/api/share-chat/:shareUuid/message?stream=1` | Same, **SSE**: `status` → `evidence` → `delta`* → `done` |
| `POST` | `/joshu/api/share-chat/:shareUuid/enable` | Owner dialog: mark chat sharing on |
| `POST` | `/joshu/api/share-chat/:shareUuid/disable` | Owner dialog: mark chat sharing off |
| `GET` / `POST` | `/joshu/api/share-chat/:shareUuid/slack/channel` | Composio Slackbot: status / create named channel |
| `POST` | `/joshu/api/share-chat/:shareUuid/slack/channel/unlink` | Drop channel mapping (+ disable trigger) |
| `POST` | `/joshu/api/share-chat/composio/triggers` | Composio webhook (raw body + signature) |
| `POST` | `/joshu/api/share-chat/:shareUuid/slack/configure` | Register per-share Slack bot (admin, legacy) |
| `GET` | `/joshu/api/share-chat/:shareUuid/slack/manifest` | Slack app manifest template |
| `POST` | `/joshu/api/share-chat/slack/events/:shareUuid` | Slack Events API (raw body + signature) |

`PUBLIC_BASE_PATH` (often `/joshu`) prefixes these on the box.

## Scope resolution

Share metadata is read from ArozOS `${AROZ_DATA}/system/ao.db` (ShareOption JSON). Joshu resolves:

- virtual + real path
- file vs folder
- permission (`anyone` required for public chat)
- path still exists on disk

Revoked or missing shares return **404** for both web and Slack answers. Explicit chat disable (owner **Remove Sharing**) also returns 404 / “chat sharing off” even if a stale UUID is guessed — flags live in `.joshu/share-chat/chat-flags.json`.

## Retrieval

1. Expand the question into several retrieval queries.
2. Query File Brain (`gbrain` MCP `/query`) for each variant.
3. Keep only hits whose slug/path falls under the shared root (slug matching normalizes spaces↔hyphens and strips `.md`).
4. Always pack shared-disk windows for **file and folder** shares (keyword neighborhoods + document head), then merge with gbrain hits and keep the top snippets by score. Folder shares previously skipped disk packing when gbrain already returned hits, which could miss exact phrases hybrid search ranked below other chunks.
5. RAG answerer uses the **same OpenRouter model as Hermes** (`JOSHU_HERMES_MODEL` / `deepseek/deepseek-v4-flash` by default) to reassemble snippets into an answer. Answers are rendered as **markdown** in the public UI (headings, lists, code, tables — sanitized/escape-first renderer, no external libs).

## Observability (Langfuse)

Each LLM answer is traced via the shared Joshu Langfuse pipeline (`src/observability/langfuse.ts`, reuses `HERMES_LANGFUSE_*` keys):

- trace `joshu-share-chat`, generation `share-chat-answer`
- user id = box attribution (`HERMES_LANGFUSE_USER_ID`, e.g. `patrick`, or derived from `CUSTOMER_DOMAIN`)
- tags: `joshu-app`, `share-chat`, `share-chat:web` / `share-chat:slack`
- metadata: share UUID, shared item name, evidence count/titles, channel
- token + cost usage from OpenRouter (`usage.include=true` on the stream)

Fail-open: without Langfuse keys, answering works untraced.

Hard contract: no tools, no writes, no owner/private Desktop metadata in answers.

## Slack channel via Composio Slackbot (preferred team surface)

From the Chat sharing dialog, the owner can create a **named private Slack channel** (1 channel ↔ 1 share UUID). Answers use the same scoped RAG as the public page — never Hermes tools.

| Piece | Detail |
|-------|--------|
| Toolkit | Composio **`slackbot`** (bot identity + triggers) — **not** user toolkit `slack`, not Hermes Patrick Socket Mode |
| Setup | **Connectors → Slackbot** wizard: Slack app manifest → Client ID/Secret, **Signing Secret**, **App-Level Token (`xapp-` + `authorizations:read`)** → Save & Connect (stores `ac_…` + creates Composio webhook endpoint). Paste the shown Event Subscriptions URL into the Slack app. |
| Create | `POST /joshu/api/share-chat/:uuid/slack/channel` with `{ "name": "my-kb" }` |
| Status / unlink | `GET …/slack/channel`, `POST …/slack/channel/unlink` |
| Registry | `.joshu/share-chat/slack-channels.json` (share ↔ channel + optional trigger id) |
| Messages | Composio trigger `SLACKBOT_CHANNEL_MESSAGE_RECEIVED` → webhook/Pusher → scoped answer → `SLACKBOT_SEND_MESSAGE` |
| Auth | Custom Slack app (no Composio managed app). Owners set this up in Connectors — no Composio dashboard. Optional operator override: `JOSHU_COMPOSIO_SLACKBOT_AUTH_CONFIG_ID`. |
| Local | Pusher subscribe (no public URL). Joshu patches `@composio/core@0.10` for `pusher-js@8` (`patches/@composio+core+0.10.0.patch`). Paste Composio Event Subscriptions URL into the Slack app. |
| Webhook | Point Composio project webhook URL at `https://<box>/joshu/api/share-chat/composio/triggers` and set `COMPOSIO_WEBHOOK_SECRET` (one-time box setup) |

Channel naming: owner chooses the name (Slack rules: lowercase, hyphens, ≤80). On `name_taken`, the API returns an error — no silent suffix. Default is private; invite teammates from Slack (no invite UI in v1).

Public chat URL remains available alongside the Slack channel.

## Per-share Slack bots (legacy / Events API)

Each share can still have its **own** Slack app credentials (not the main Hermes Slack bot):

- bot token + signing secret (+ optional app token)
- optional allowlists for user IDs / channel IDs
- stored under `.joshu/share-chat/slack-bots.json` (or `.local/share-chat/` when no ArozOS user dir)

Configure with admin key when set:

```bash
curl -X POST "$BASE/api/share-chat/$UUID/slack/configure" \
  -H "Authorization: Bearer $JOSHU_SHARE_CHAT_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"botToken":"xoxb-…","signingSecret":"…","botDisplayName":"Project Q&A"}'
```

If neither `JOSHU_SHARE_CHAT_ADMIN_KEY` nor `JOSHU_READ_API_KEY` is set (local dev), configure is open. Always set an admin key on VPS.

Event URL for the Slack app:

`https://<box>/joshu/api/share-chat/slack/events/<shareUuid>`

Fetch a starter manifest: `GET .../slack/manifest`.

## Safety

- Per-share (+ client) rate limits (web ~30/min, Slack ~20/min per channel)
- Max message length 4k; Slack body 256kb
- Invalid / non-`anyone` / deleted shares → not found
- Explicit chat disable (`POST …/disable` from Chat sharing dialog) → not found / chat_disabled
- Outside-scope File Brain hits discarded before answering

## Env

| Variable | Role |
|----------|------|
| `JOSHU_SHARE_CHAT_API_KEY` / `OPENROUTER_API_KEY` | LLM for answers (same OpenRouter key Hermes uses) |
| `JOSHU_SHARE_CHAT_MODEL` / `JOSHU_HERMES_MODEL` | Model (defaults to Hermes box model / `deepseek/deepseek-v4-flash`) |
| `JOSHU_SHARE_CHAT_ADMIN_KEY` | Protect Slack configure (falls back to `JOSHU_READ_API_KEY`) |
| `AROZ_DATA` | Locate `system/ao.db` + shared real paths |
| `GBRAIN_MCP_HTTP_URL` | File Brain inspect (default `http://127.0.0.1:8794`) |
| `COMPOSIO_API_KEY` | Required for Slackbot channel create / triggers |
| `JOSHU_COMPOSIO_SLACKBOT_AUTH_CONFIG_ID` | Optional operator override for Slackbot auth config id (`ac_…`); normally created via Connectors wizard |
| `COMPOSIO_WEBHOOK_SECRET` | Verify Composio trigger webhooks |
| `JOSHU_COMPOSIO_SLACKBOT_TOOLKIT_VERSION` | Optional toolkit version pin |

## Code map

| Path | Role |
|------|------|
| `src/shareChat/shareScope.ts` | UUID → share scope |
| `src/shareChat/scopedBrain.ts` | Path-filtered retrieval |
| `src/shareChat/answer.ts` | Constrained RAG |
| `src/shareChat/routes.ts` | HTTP + UI |
| `src/shareChat/chatFlags.ts` | Per-UUID enable/disable flag |
| `src/shareChat/slackChannels.ts` / `composioSlackbot.ts` / `composioTriggers.ts` | Composio Slackbot KB channels |
| `src/shareChat/slackRegistry.ts` / `slackEvents.ts` | Legacy per-share Events API bots |
| `apps/share-chat/index.html` | Public chat page (brandbar + server-injected identity) |
| `arozos/web-overlays-vanilla/joshu-public-pages.css` | Shared guest CSS (File Share + Share Chat) |
| `arozos/web-overlays-vanilla/joshu-public-identity.js` | Client identity hydrator for `/share/*` |
| `arozos/web-overlays-vanilla/SystemAO/file_system/share_to.html` | Share To picker |
| `arozos/web-overlays-vanilla/SystemAO/file_system/chat_share.html` | Owner dialog (public URL + Slack channel + Remove Sharing) |
| `arozos/web-overlays-vanilla/system/share/` | Public File Share pages |

## Tests

```bash
npm run test:share-chat
```

See also [file-brain.md](file-brain.md) and [design/README.md](design/README.md) (File Share overlays).
