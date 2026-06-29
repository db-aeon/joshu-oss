# Composio live Gmail — deep server-side search

**Do not start here.** This is **step 4** in [`mail-search-order.md`](mail-search-order.md): a **deep server-side search** against Gmail when the **local cache** (gbrain + mirror markdown on the box) did not hit. Use when steps 1–3 did not surface the thread, or the user explicitly asks to search live / bypass mirrors.

When the **local cache** misses (grep/`search_files` on `${JOSHU_FILES_ROOT}/connectors/mail/gmail/{account_key}/` returns nothing for the exact subject), **deep server-side search via Composio live Gmail is the correct path**. Commit to Composio’s full **dynamic session workflow** below — do not mix with local `terminal`/`search_files` after you enter Composio.

## When Composio Gmail is appropriate

| Situation | Use |
|-----------|-----|
| Find email about a topic (sent or received) | Local cache: gbrain + connectors — **not** Composio |
| Mirror has the thread | Read `connectors/mail/gmail/{account_key}/threads/*.md` — **not** Composio |
| Local cache miss after steps 1–3 | **Deep server-side search:** Composio session (this doc) |
| Mail never synced / pre-connect history | Deep server-side search (local cache will not help) |
| Send/reply principal Gmail from jMail / API | Joshu REST — **not** Composio unless those fail |
| Slack, GitHub, Notion, etc. | Composio (no local mirror) |

Confirm Gmail is **ACTIVE**: `mcp_joshu_connectors_connectors_status` or Connectors desktop app. Scope to the account the user named (`account_key` / email).

## Multi-Gmail accounts (critical)

Joshu often has **multiple** Gmail OAuth connections. **`connectors_status`** returns `gmail.accounts[]` with `email`, `accountKey`, `connectedAccountId`.

Before live search:

1. Match the user’s inbox (e.g. `owner work email` → `db_at_project_aeon_com`).
2. Put **`connected_account_id: ca_…`** in `COMPOSIO_SEARCH_TOOLS` `known_fields`.
3. **`GMAIL_FETCH_EMAILS`:** **`user_id` must be `"me"`** — **never** an email address (`user_id: db@…` → delegation denied).
4. Scope the Composio session to the correct connected account per `connection_details` / plan from `SEARCH_TOOLS`.
5. Do **not** assume `user_id: me` searches principal mail if the active Composio connection is another account (e.g. personal Gmail).

When **`MULTI_EXECUTE`** returns an empty or terse inline preview, use **`COMPOSIO_REMOTE_BASH`** or **`COMPOSIO_REMOTE_WORKBENCH`** to inspect the response JSON — that is **not** proof the mail does not exist.

## Composio dynamic workflow (overview)

Composio exposes **meta-tools**, not raw Gmail tools in context. Once you go live Gmail, run the full loop:

```text
COMPOSIO_SEARCH_TOOLS     → session_id, plan, tool schemas, workbench snippets
        ↓
COMPOSIO_MULTI_EXECUTE_TOOL   → GMAIL_FETCH_EMAILS (one precise query first)
        ↓
  small inline preview?  → answer the user
  remote_file_info?      → COMPOSIO_REMOTE_BASH_TOOL or COMPOSIO_REMOTE_WORKBENCH (mandatory)
  empty/ambiguous?       → WORKBENCH/BASH to parse — do not grep local disk
        ↓
Report to user (subject, from, date, body preview / list)
```

Pass the same **`session_id`** on every meta-tool call in the workflow.

Meta-tool names in Hermes MCP are prefixed, e.g. `mcp_composio_COMPOSIO_SEARCH_TOOLS`, `mcp_composio_COMPOSIO_MULTI_EXECUTE_TOOL`, `mcp_composio_COMPOSIO_REMOTE_WORKBENCH`, `mcp_composio_COMPOSIO_REMOTE_BASH_TOOL`.

## Session playbook

### 1. Search and plan

```text
mcp_composio_COMPOSIO_SEARCH_TOOLS
  queries: [{ use_case: "search Gmail for …", known_fields: "subject:…, connected_account_id: ca_…" }]
  session: { generate_id: true }
```

- Save **`session.id`** from the response — required on all later Composio meta-tools.
- Read **`execution_guidance`**, **`known_pitfalls`**, and **`reference_workbench_snippets`** if present; use snippets in the workbench step verbatim when offered.

### 2. Execute — one precise query first

```text
mcp_composio_COMPOSIO_MULTI_EXECUTE_TOOL
  session_id: <from step 1>
  current_step: SEARCHING_GMAIL
  current_step_metric: "0/1 queries"
  sync_response_to_workbench: true    # when include_payload true OR >10 messages expected
  tools:
    - tool_slug: GMAIL_FETCH_EMAILS
      arguments:
        user_id: me
        query: subject:"Exact Subject Here"    # Gmail search syntax; quote phrases
        max_results: 10
        include_payload: false                 # true only when user needs full bodies
        include_spam_trash: true               # when mail may be filtered
        verbose: true
```

Rules:

- **One query per user intent** — parse results before broadening (`subject:waitlist`, etc.).
- **`max_results` defaults to 1** in Composio — never call with empty `{}`.
- Prefer **`include_payload: false`** first (subject, from, snippet). Set `true` only when the user needs message bodies or a list of signups inside the mail.
- Set **`sync_response_to_workbench: true`** when payloads may be large — Composio returns an inline preview plus a full file in the remote sandbox.

Example when mirrors miss:

```json
{
  "user_id": "me",
  "query": "subject:\"New submission from Joshu Waitlist\"",
  "max_results": 10,
  "include_payload": false,
  "include_spam_trash": true,
  "verbose": true
}
```

If `success_count >= 1`, **stop and process** — do not fire a second `MULTI_EXECUTE` with broader queries until you have parsed the first result.

### 3. Mandatory branch: `remote_file_info`

If **`COMPOSIO_MULTI_EXECUTE_TOOL`** returns **`remote_file_info`** (large response saved to e.g. `/mnt/files/mex/pick.json`):

**Your next tool call MUST be one of:**

| Tool | When |
|------|------|
| `mcp_composio_COMPOSIO_REMOTE_BASH_TOOL` | Quick extract with `jq` / `grep` |
| `mcp_composio_COMPOSIO_REMOTE_WORKBENCH` | Parse JSON, filter rows, summarize with `invoke_llm`, or use `reference_workbench_snippets` |

Always pass the same **`session_id`**.

**Bash example** (paths are in Composio’s remote sandbox, not on the Joshu box):

```bash
jq '.results[0].response.data.messages[] | {subject, from, date: .internalDate}' /mnt/files/mex/pick.json | head -20
```

**Workbench example** (use `structure_info` / `data_preview` from the MULTI_EXECUTE inline result to locate fields — do not guess schema):

```python
import json
file_data = json.load(open("/mnt/files/mex/pick.json"))
msgs = file_data["results"][0]["response"]["data"]["messages"]
for m in msgs[:20]:
    print(m.get("subject"), m.get("from"), m.get("snippet", "")[:120])
```

Do **not** use Hermes **`terminal`**, **`read_file`**, or **`search_files`** for `/mnt/files/…` paths — those tools run on the **Joshu ArozOS filesystem**, not Composio’s sandbox.

### 4. Report before expanding

Tell the user what you found (sender, subject, time, snippet or extracted list) **before** any second Gmail query or unrelated local disk search.

For one thread’s full bodies after you have a `threadId`, use **`GMAIL_FETCH_MESSAGE_BY_THREAD_ID`** via another `MULTI_EXECUTE` — not repeated broad list fetches.

Sort list results by `internalDate` or `messageTimestamp` (order is **not** guaranteed recency-sorted).

### 5. Optional: hydrate mirror for next time

After a successful live find, optional `POST /joshu/api/connectors/mail/gmail/sync` with `{"days":7,"limit":100}` so the thread appears under `connectors/mail/` for future gbrain recall.

## Sandbox boundaries (critical)

| Path | Machine | Access with |
|------|---------|-------------|
| `${JOSHU_FILES_ROOT}/connectors/mail/…` | Joshu box | gbrain, `search_files`, local `terminal` |
| `/mnt/files/…`, `/home/user/…` in Composio responses | **Composio remote sandbox** | `COMPOSIO_REMOTE_BASH_TOOL` or `COMPOSIO_REMOTE_WORKBENCH` only |

Confusing the two sandboxes causes silent failure: the agent searches the box while the Gmail payload sits in Composio’s workbench.

## Pitfalls

| Pitfall | Fix |
|---------|-----|
| `user_id: user@domain.com` on GMAIL_FETCH | Always `user_id: me` + correct `connectedAccountId` / session |
| Second broad `MULTI_EXECUTE` after first query succeeded | Parse step 2 (or workbench) first; one intent → one query |
| Empty inline preview → “mail doesn’t exist” | WORKBENCH/BASH to parse response |
| 64k-token inline blob + no workbench | Set `sync_response_to_workbench: true`; next call = BASH or WORKBENCH |
| Local `grep` / `search_files` after Composio offload | Use Composio meta-tools for `/mnt/files/` paths |
| Nylas / drip mail mistaken for principal Gmail | User asked `owner work email` → principal Gmail only, not agent Nylas mirrors |
| `COMPOSIO_SEARCH_TOOLS` twice in one task | Reuse `session_id` and plan from first search |
| Skipping `session_id` on follow-up meta-tools | Pass `session_id` from step 1 on every Composio meta-tool call |
| Mark read / archive / send without ask | Report only unless user requested an action |

## Related

- Canonical order + MCP map: [`mail-search-order.md`](mail-search-order.md)
- Skill overview: [`../SKILL.md`](../SKILL.md)
- Composio meta-tool reference: https://docs.composio.dev/toolkits/composio
