# Finding user notes & reminders sent via email

The user often captures thoughts by emailing themselves (to their `owner work email` inbox). When they ask "remember those notes I sent" or "organize the things I jotted down", use this pattern.

## Pattern: gbrain-first, Gmail-second

```
1. mcp_gbrain_query(query="<topic>", recency="on", limit=20)
   → Already has mirrored email content. Catches body text via semantic search
   → Source slugs like: joshus-files/connectors/mail/gmail/db_at_project-aeon_com/threads/<thread_id>

2. For anything gbrain missed, use Gmail API:
   COMPOSIO_SEARCH_TOOLS → GMAIL_FETCH_EMAILS(from:owner work email, after:YYYY/MM/DD)
   → owner's "notes to self" come FROM owner work email
```

## Why gbrain first

- Mirrored emails are indexed in gbrain within seconds of sync
- Semantic search catches notes even when you don't know the exact subject line or keywords
- Gmail API's `subject: (note OR reminder OR idea)` query syntax is strict and often misses; gbrain doesn't have that limitation
- Common subject patterns for user notes: "Another note to file", "Another idea to jot down", "Top things to sort out", (no subject)

## What to look for

Self-sent notes tend to be:
- Short, bullet-point style
- Subject: "Another note to file", "Another idea to jot down", "Top things to sort out", or blank
- Sent TO the user's own principal email (`owner work email`)
- Mix of reminders, to-dos, and larger project ideas in a single email
