# Share Chat (Chat with shared files)

Public Q&A scoped to one ArozOS share UUID. Answers come only from files under that shared path (File Brain + path filter). Full Hermes tools are **not** exposed to public users.

## User flow

1. In File Manager, choose **Share** → **Share To**.
2. Pick **Chat with files**.
3. The **Chat sharing** dialog (`chat_share.html`) creates/reuses an ArozOS anyone-with-link share and shows a **public chat URL** (`/joshu/share-chat/:shareUuid`) — copy or open it, like a download link.
4. Guests open that URL and ask questions; answers cite only in-scope sources.
5. **Remove Sharing** deletes the underlying ArozOS share (same as File sharing) and marks chat off — guests get “not available.” **Enable Sharing** creates a new share and a new URL.

The classic **File sharing page** destination is unchanged (`file_share.html`).

## Routes

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/joshu/share-chat/:shareUuid` | Lightweight public chat UI |
| `GET` | `/joshu/api/share-chat/:shareUuid/status` | Validate share + metadata |
| `POST` | `/joshu/api/share-chat/:shareUuid/message` | `{ message }` → grounded answer (JSON) |
| `POST` | `/joshu/api/share-chat/:shareUuid/message?stream=1` | Same, **SSE**: `status` → `evidence` → `delta`* → `done` |
| `POST` | `/joshu/api/share-chat/:shareUuid/enable` | Owner dialog: mark chat sharing on |
| `POST` | `/joshu/api/share-chat/:shareUuid/disable` | Owner dialog: mark chat sharing off |
| `POST` | `/joshu/api/share-chat/:shareUuid/slack/configure` | Register per-share Slack bot (admin) |
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
4. Always pack shared-disk windows for single-file shares (and when gbrain is thin), including large notebooks — keyword neighborhoods + document head.
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

## Per-share Slack bots

Each share can have its **own** Slack app credentials (not the main Hermes Slack bot):

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

## Code map

| Path | Role |
|------|------|
| `src/shareChat/shareScope.ts` | UUID → share scope |
| `src/shareChat/scopedBrain.ts` | Path-filtered retrieval |
| `src/shareChat/answer.ts` | Constrained RAG |
| `src/shareChat/routes.ts` | HTTP + UI |
| `src/shareChat/chatFlags.ts` | Per-UUID enable/disable flag |
| `src/shareChat/slackRegistry.ts` / `slackEvents.ts` | Per-share Slack |
| `apps/share-chat/index.html` | Public chat page |
| `arozos/web-overlays-vanilla/SystemAO/file_system/share_to.html` | Share To picker |
| `arozos/web-overlays-vanilla/SystemAO/file_system/chat_share.html` | Owner dialog (public URL + Remove Sharing) |

## Tests

```bash
npm run test:share-chat
```

See also [file-brain.md](file-brain.md) and [design/README.md](design/README.md) (File Share overlays).
