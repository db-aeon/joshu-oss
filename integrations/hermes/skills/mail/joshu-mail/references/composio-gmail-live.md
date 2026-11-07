# Owner Gmail: do not search with the Composio Tool Router

To search the owner's Gmail on Gmail itself, use **`mcp_joshu_connectors_gmail_search_live`**, and read a hit with **`mcp_joshu_connectors_gmail_get_message`**. See step 4 of [`mail-search-order.md`](mail-search-order.md).

Do not search the owner's Gmail with the Composio Tool Router (`COMPOSIO_SEARCH_TOOLS`, `COMPOSIO_MULTI_EXECUTE_TOOL` with `GMAIL_FETCH_EMAILS`, the workbench). The Tool Router chooses the Gmail connection itself, and `GMAIL_FETCH_EMAILS` has no argument for the owner Gmail account. When the owner has more than one owner Gmail account (for example a personal account and a work account), the Tool Router can search the wrong mailbox, and a call with `user_id` set to an email address fails with "Delegation denied". `gmail_search_live` searches each owner Gmail account with its own connection.

Composio stays the right first hop for toolkits without a Joshu tool, for example Slack, GitHub, or Notion.

The Composio workbench (`COMPOSIO_REMOTE_WORKBENCH`, `COMPOSIO_REMOTE_BASH_TOOL`) is read-only. Code in it can call Composio tools that read, but Composio refuses each send, delete, or other write there.
