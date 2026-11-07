# Finding user notes & reminders (multi-channel)

The user often captures thoughts by emailing themselves, sending Slack DMs, or voice notes. Notes can arrive via **multiple channels** (email + Slack) for the same item — you must dedup, not double-track.

When they ask about finding notes, use this pattern.

## Pattern: gbrain-first, Gmail-second

```
1. mcp_gbrain_query(query="<topic>", recency="on", limit=20)
   → Already has mirrored email content. Catches body text via semantic search
   → Source slugs like: joshus-files/connectors/mail/gmail/{account_key}/threads/<thread_id>

2. For anything gbrain missed, run a live Gmail search (each owner Gmail account):
   mcp_joshu_connectors_gmail_search_live(q="from:<owner work email> after:YYYY/MM/DD")
   → Owner's "notes to self" come FROM owner work email
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

## Cross-channel dedup — Slack re-iterations

When a note arrives via **Slack DM** (or other non-email channel) that appears related to something already tracked:

1. **gbrain_query first** — search the project's journal pages and `todo.md` for matching items. Use `recency="on"` and `since="90d"` to catch recent entries.
2. If found **already tracked in todo.md** with same/similar wording:
   - Do NOT add a new todo row
   - Write a **journal entry** on the new date with `(re-up)` in the section title, noting the original source date and cross-referencing the existing todo row
   - This gives a timestamped record of the reprioritization signal without duplicating work items
3. If NOT found in gbrain: file as a new note following the same pattern as email-sourced notes.

Slack DM source format:
`Source: Slack DM (thread <thread_id>)`

The key rule: **one todo row per unique intent**, regardless of channel. Journal pages capture timing signals; todo rows capture what needs doing.
