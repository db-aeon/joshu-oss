# Mail search tool order (Hermes)

When the user asks to **find**, **search**, or **recall** email (sent or received, agent or principal Gmail). Load skill **`joshu-mail`** first.

**Local cache first, deep server search if the cache misses.** Steps 1–3 search synced mirror markdown on the box (fast). Step 4 is **Composio live Gmail** — a heavier **server-side** search against Google when the local cache does not surface the thread.

Synced mail and calendar live as **markdown** under:

```text
${JOSHU_FILES_ROOT}/connectors/mail/nylas/threads/
${JOSHU_FILES_ROOT}/connectors/mail/gmail/{account_key}/threads/
${JOSHU_FILES_ROOT}/connectors/calendar/
```

When multiple Gmail accounts are connected, use `account_email` / `account_key` in frontmatter to identify which inbox a hit belongs to.

## 1. gbrain (first)

```text
mcp_gbrain_query
  query: <user question + keywords>
  source_id: "__all__"
  limit: 10–20
  recency: "on"
  since: "90d"        # or 30d / 7d / tighter if user gives dates
  expand: true
```

Expect hits under `connectors/mail/gmail/{account_key}/` and/or `connectors/mail/nylas/`. Use `chunk_text` or read the `.md` path under `${JOSHU_FILES_ROOT}`.

Do **not** open with Composio Gmail list/search tools for routine recall.

Example: “email from Alice about budget” → gbrain query → `connectors/mail/gmail/{account_key}/threads/<id>.md`.

## 2. joshu-connectors (only if mirrors empty or user says mail is missing)

Joshu already polls Gmail + Nylas every **10 minutes** (`src/connectors/scheduler.ts`). Do not sync on every recall.

```text
mcp_joshu_connectors_connectors_status   # accounts, mirror counts, connectedAccountId
mcp_joshu_connectors_connectors_sync_now
  provider: "gmail" | "nylas" | "all"
  limit: 40–100       # optional
```

REST alternative (Gmail window): `POST /joshu/api/connectors/mail/gmail/sync` with `{"days":7,"limit":100}` (optional `connectedAccountId` for one account).

Then **repeat step 1**. Optional: `GET /joshu/api/connectors/mail/gmail/mirror` to confirm mirrors are non-empty.

## 3. Read from disk (if gbrain missed but mirrors exist)

`search_files` or `grep` on `connectors/mail/gmail/{account_key}/threads/` for exact subject or keywords under `${JOSHU_FILES_ROOT}`.

## 4. Deep server-side search — Composio Gmail (fallback only)

Only if **local cache** steps 1–3 did not surface the thread (including exact-subject grep on the **correct** `{account_key}` folder). This is **live Gmail on Google’s servers** via Composio — not another pass over box mirrors. Follow **`composio-gmail-live.md`** end-to-end: `COMPOSIO_SEARCH_TOOLS` → `COMPOSIO_MULTI_EXECUTE_TOOL` → **`COMPOSIO_REMOTE_WORKBENCH` or `COMPOSIO_REMOTE_BASH_TOOL`** when `remote_file_info` appears (or to parse empty/ambiguous inline previews). Do not mix Composio live search with local `terminal`/`search_files` for Composio sandbox paths (`/mnt/files/…`).

## 5. Live APIs (when you already have an id)

These are for **actions** or refreshing one message — not the first hop for “find my email about X”.

| Mailbox | Get detail | Send / reply |
|---------|------------|--------------|
| Principal Gmail | `GET .../gmail/messages/:id?connectedAccountId=` | **Agent blocked** — owner jMail only (`X-Joshu-Mail-Client: jmail`) |
| Agent (Nylas) | `GET .../nylas/messages/:id` or `nylas_get_message` | **`mcp_joshu_connectors_nylas_send_message`** only (Hermes) — not raw REST |

## Agent send (outbound)

| Step | Tool / route |
|------|----------------|
| Send from agent mailbox | **`mcp_joshu_connectors_nylas_send_message`** |
| Profile (TZ, owner work email) | `nylas_get_profile` |

When action guard is enabled, owner approves on Telegram before delivery. The REST route `POST /joshu/api/nylas/messages/send` runs the **same gate** — do not call it from `execute_code`, `curl`, or terminal.

**Pitfall (2026-06):** Agents that could not find the MCP tool sometimes read `joshu-connectors-mcp-http-server.mjs` and POSTed to REST directly, skipping Telegram. Use the MCP tool.

## MCP tools (`mcp-joshu-connectors`)

| Need | MCP tool | REST equivalent |
|------|----------|-----------------|
| Refresh mirrors | `connectors_sync_now` | `POST /joshu/api/connectors/mail/{nylas\|gmail}/sync` |
| Box status | `connectors_status` | `GET /joshu/api/connectors/status` |
| Agent mailbox send | `nylas_send_message` | `POST /joshu/api/nylas/messages/send` (**same gate** — Hermes must use MCP tool, not REST) |
| Agent message by id | `nylas_get_message` | `GET /joshu/api/nylas/messages/:id` |
| Agent profile (TZ, emails) | `nylas_get_profile` | `GET /joshu/api/nylas/profile` |
| Agent calendar (read only) | `nylas_list_events`, `nylas_get_event` | `GET …/nylas/events` — **writes blocked** |
| Owner calendar create | `mcp_composio_GOOGLECALENDAR_CREATE_EVENT` | Composio MCP — see **`ea-scheduling`** |
| Principal Gmail message | — | `GET /joshu/api/connectors/mail/gmail/messages/:id` |
| Principal Gmail send/reply | — | **Agent blocked** (jMail owner UI only) |

**Agent send signature:** Joshu appends a branded HTML signature server-side (companion name, `{owner}'s Joshu`, https://joshu.me). Pass plain message text in `body` — do not include signature markup.

Mail **search** is steps 1–3 (mirror + gbrain), not these tools — except live get-by-id when you already have a message id.

## Composio primary (non-mail)

Slack, GitHub, Notion, and other toolkits **without** a local connector mirror — Composio is the right first hop there.
