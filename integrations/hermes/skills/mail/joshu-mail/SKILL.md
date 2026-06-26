---
name: joshu-mail
description: Find/search mail; local cache first, deep server Gmail.
version: 1.2.0
metadata:
  hermes:
    category: mail
---

# Joshu mail — find, search, recall

General-purpose mail **read/search** on the Joshu box. Not triage (`ea-playbook`), not meeting scheduling (`ea-scheduling`), not multi-step campaigns (`ea-project-kanban`).

## When to use (load this skill first)

**`skill_view('joshu-mail')`** when the user asks to:

- **Find / search / recall** mail by subject, sender, topic, or date
- Read a thread, list signups, or “what did X email about Y?”
- Search a **specific inbox** (e.g. `db@project-aeon.com` vs agent Nylas)
- Confirm whether a notification exists when mirrors may be stale or unsynced

Also load before **Composio live Gmail** — even if you already ran gbrain.

## When not to use

| Task | Skill |
|------|--------|
| Process `Triage/*.stub.md` into Projects | `ea-playbook` |
| Meeting-mail scheduling | `ea-scheduling` |
| Drip / Kanban / HITL project work | `ea-project-kanban` |
| Desktop files, journals (non-mail) | `joshu-brain` |

## Mailboxes on disk

```text
${JOSHU_FILES_ROOT}/connectors/mail/gmail/{account_key}/threads/   # owner Gmail (Composio)
${JOSHU_FILES_ROOT}/connectors/mail/nylas/threads/                 # agent inbox (Nylas)
```

Multiple Gmail accounts → match **`account_key`** / **`account_email`** in frontmatter to the inbox the user named. Agent Nylas mail ≠ principal Gmail unless they asked for it.

## Two tiers: local cache vs deep server search

| Tier | What | When |
|------|------|------|
| **Local cache** (fast) | Synced mirror markdown on the box + gbrain | Always start here — steps 1–4 below |
| **Deep server-side search** | Composio **live Gmail** against Google’s servers | Only when the local cache does not hit (miss after 1–4, pre-connect mail never mirrored, or user asks to search live) |

Do not treat Composio as “another local grep.” It is a **remote** search path — heavier, session-based, and correct when mirrors lag or never backfilled.

## Search order (summary)

1. **`mcp_gbrain_query`** — `source_id: "__all__"`, `recency: "on"`, `since: "90d"`, mail keywords  
2. **`mcp_joshu_connectors_connectors_status`** — which accounts exist; mirror counts  
3. Optional **`connectors_sync_now`** (`provider: "gmail"`) then re-query — not on every turn  
4. **Disk** — `search_files` / `grep` on `connectors/mail/gmail/{account_key}/` for exact subject  
5. **Deep server-side search (Composio live Gmail)** — only if local cache steps 1–4 miss; full playbook in **`references/composio-gmail-live.md`**

Details + MCP tables: **`references/mail-search-order.md`**

## Deep server-side search (Composio live Gmail)

When the **local cache** does not hit: mirrors can lag, omit pre-connect history, or simply not contain the thread yet. **Deep server-side search via Composio is then correct** — not more local grep or another sync loop.

**Commit to the dynamic session loop** (do not mix with box `terminal` after step 5):

```text
COMPOSIO_SEARCH_TOOLS        → session_id, plan, workbench snippets
COMPOSIO_MULTI_EXECUTE_TOOL  → one precise GMAIL_FETCH_EMAILS first
  → inline preview OK?     answer user
  → remote_file_info?      COMPOSIO_REMOTE_BASH or COMPOSIO_REMOTE_WORKBENCH (mandatory, same session_id)
  → empty/ambiguous inline?  WORKBENCH/BASH to parse JSON — not proof mail is absent
```

Hermes tool names: `mcp_composio_COMPOSIO_*`.

### Multi-Gmail (critical)

1. **`connectors_status`** → `gmail.accounts[]` → `email`, `accountKey`, `connectedAccountId`  
2. Pick the account the user named (e.g. `db@project-aeon.com` → `db_at_project_aeon_com`)  
3. **`GMAIL_FETCH_EMAILS`:** always **`user_id: "me"`** — **never** an email address (delegation denied)  
4. Put **`connected_account_id: ca_…`** in `SEARCH_TOOLS` `known_fields`; scope OAuth to that account per Composio plan  
5. Do **not** assume `user_id: me` hits principal mail if the Composio session is bound to another account

### Workbench / sandbox

| Path | Where | Tool |
|------|--------|------|
| `${JOSHU_FILES_ROOT}/connectors/mail/…` | Joshu box | gbrain, `search_files`, local `terminal` |
| `/mnt/files/…` in Composio responses | **Remote sandbox** | `COMPOSIO_REMOTE_BASH` or `COMPOSIO_REMOTE_WORKBENCH` only |

After `remote_file_info`, the **next** tool call must be BASH or WORKBENCH — never local grep for `pick.json`.

Use **`sync_response_to_workbench: true`** when `include_payload: true` or many messages expected.

Full session steps, examples, pitfalls: **`references/composio-gmail-live.md`**

## Outbound send (agent mailbox)

When the user asks you to **send** (not find) mail:

- **`mcp_joshu_connectors_nylas_send_message`** from the agent Nylas mailbox  
- **`nylas_get_profile`** for timezone / `primaryWorkEmail`  
- Not Composio Gmail send, browser Gmail, or REST/curl to `POST /joshu/api/nylas/messages/send` (action-guard gated)

Principal Gmail send/reply: owner **jMail** only — agent blocked.

### Adding someone to an already-sent email

When the user says "add X to the email I just sent" or similar:

1. **Find your sent message** — list Nylas mirror files sorted by mtime:
   ```
   ls -lt ${JOSHU_FILES_ROOT}/connectors/mail/nylas/threads/ | head
   ```
   Read the newest threads; look for ones where `from:` matches the agent mailbox and the subject/tos match.

2. **Identify the sent message ID** — read the mirror file's frontmatter for the `external_id` (the Nylas message id). Or use `nylas_get_message()` with a known message id.

3. **Reply-all with the new person** — use `nylas_send_message` with:
   - `replyToMessageId`: the sent message's id from step 2
   - `cc`: include the original recipients PLUS the new person — replying with `replyToMessageId` threads into the same conversation but doesn't auto-populate the old CC list; you must re-list everyone
   - `to`: the original primary recipient
   - Body: brief explanation for the addition, plus a summary for context so the new person is caught up

   Pitfall: `replyToMessageId` only threads the reply — it does NOT preserve the previous To/CC list. You must manually repopulate the CC list with everyone for a true reply-all.

## Related

- File brain (non-mail): `joshu-brain`  
- Connectors layout: Joshu `docs/connectors.md`  
- Composio meta-tools: https://docs.composio.dev/toolkits/composio
