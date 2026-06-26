---
name: joshu-brain
description: Search Desktop files via gbrain; mail use joshu-mail.
version: 1.8.0
metadata:
  hermes:
    category: brain
---

# Joshu File Brain

## When to Use

**Mail / email (find, search, recall, send):** Load skill **`joshu-mail`** — not this skill. gbrain is step 1 inside `joshu-mail`, but Composio workbench, multi-account routing, and send rules live there.

Use **gbrain** (read-only MCP tools from the `gbrain` server) when the user asks about:

- Files on their **Desktop** (including **joshu's files**)
- Journals, research notes, uploads, PDF knowledge base (`research/kb/`), or anything saved as files
- "What did I write about X?" when the answer should come from documents

Use **Hindsight memory** (Hermes memory provider) when the user asks about:

- Conversation history: "weren't we talking about X?"
- Preferences and facts from past chats
- Rambling recall without a specific file

Do **not** duplicate chats into markdown files for gbrain. Hindsight owns conversational memory.

### Finding user self-sent notes & reminders

When the user says "I sent some notes/reminders via email" or "remember those random things I jotted down":

1. **gbrain_query first** — the mirrored email content is already indexed. Semantic search catches notes even without exact subject keywords.
2. **Gmail API second** — only if gbrain misses something.

Common subject patterns on user notes: "Another note to file", "Another idea to jot down", "Top things to sort out", or blank. More detail in **`references/find-user-notes.md`**.

## Brain-first retrieval

1. For file/knowledge questions on the user's **Desktop** (any folder), call gbrain **`query`** with:
   - `query`: the user's question or keywords
   - `source_id`: `"__all__"` (cross-source; required for files outside `joshu's files`)
   - `limit`: 10–20
   - `recency`: `"on"` and `since`: `"90d"` (or `"30d"`, `"7d"`) for recent mail/journal questions — Joshu MCP normalizes these to ISO timestamps before SQL
2. Do **not** rely on MCP **`search`** alone for Desktop-wide lookup — `search` is keyword FTS on the **default** source (`joshu's files` / journals) and often returns empty for federated paths like `investors/…` or `joshus-files/workspace/…`.
3. Cite results with the **slug** from gbrain (lowercase; may not match on-disk folder casing).
4. Use `chunk_text` from `query` results when `get_page` returns `page_not_found` for a federated slug.
5. Use `hermes-cli` / `search_files` (ripgrep) on disk only when gbrain returns nothing relevant.

MCP server URL (Joshu-supervised): `http://127.0.0.1:8794/mcp` — one shared `gbrain serve` process; do not spawn a second gbrain.

## Writing structured files (critical)

**Do not use gbrain write tools** (`put_page`, `delete`, `sync_brain`, schema tools, etc.). They are not available on the Joshu MCP surface.

All user-visible files **must** land on disk under **`JOSHU_FILES_ROOT`** (the `joshu's files` folder on ArozOS Desktop) — **never** macOS `~/Desktop` and **never** `Desktop/journals/` at the Desktop root.

1. Read **`JOSHU_FILES_ROOT`** from the environment (absolute path). Joshu sets this to the **sandbox owner’s** ArozOS Desktop tree (`joshu's files`), not a path you invent in chat.
2. If unset, read **`LOCATION.md`** inside that folder.
3. **Do not** write to `~/Desktop`, paths outside `JOSHU_FILES_ROOT`, or sibling folders on Desktop.

Layout under `JOSHU_FILES_ROOT`:

```text
FILING.md
Planning/                      # capture-*, daily-review-*, time-block diagrams (one .excalidraw per day)
Triage/                          # work queue stubs → connector threads (mail only)
Projects/<slug>/                 # about.md, todo.md, journal_YYYY-MM-DD.md
connectors/mail/nylas/threads/              # agent inbox (Nylas)
connectors/mail/gmail/{account_key}/threads/  # principal Gmail (Composio, per account)
connectors/calendar/
connectors/_state/                          # sync cursors (machine)
journals/                        # optional personal capture (non-EA)
research/                        # notes and investigation
research/kb/inbox/               # drop PDFs here → auto-extracted to research/kb/*.md
research/kb/.raw/                # archived PDF originals (not indexed)
inbox/
uploads/
```

### PDF knowledge base

Users can drop **text PDFs** in **`${JOSHU_FILES_ROOT}/research/kb/inbox/`**. Joshu auto-extracts to **`research/kb/<slug>.md`** (gbrain type **`research`**); originals land in **`research/kb/.raw/`**. No agent action required beyond pointing users at the inbox path.

- Query with keywords + `research/kb` in the question to bias toward KB hits.
- Do **not** paste full PDF bodies into markdown — the ingest pipeline handles extraction.
- Scanned/image PDFs may fail ingest; suggest OCR or manual markdown if extraction errors.

Read **`FILING.md`** and **`docs/Joshu-SOP/gtd-workspace-linking.md`** before creating new pages. Connector layout and APIs: Joshu **`docs/connectors.md`**. PDF ingest details: **`docs/file-brain.md`** (Knowledge base section).

### Linking for recall (EA projects)

When writing or editing project markdown, **link — do not duplicate** mail bodies:

- `[subject](joshu://connectors/mail/…/threads/<id>.md)` or relative `../connectors/mail/…`
- gbrain sync extracts links and `[[wikilinks]]` → use **`get_backlinks`** / **`traverse_graph`** to find related pages
- Chat capture lives in **`Planning/capture-*.md`** first; Hindsight holds conversation — do not dump chat logs into files for gbrain

### Filesystem writes (only write path)

Write or edit **markdown** with Hermes filesystem tools at absolute paths, e.g.:

`${JOSHU_FILES_ROOT}/journals/2026-05-24-slug.md`

| Correct path | Wrong |
|--------------|-------|
| `${JOSHU_FILES_ROOT}/journals/2026-05-24-todo.md` | `~/Desktop/...` |
| `${JOSHU_FILES_ROOT}/research/my-topic.md` | `${JOSHU_FILES_ROOT}/joshu's files/journals/...` (double-nested) |
| `${JOSHU_FILES_ROOT}/journals/...` | `Desktop/journals/...` at ArozOS Desktop root |

- **Path is identity** — `journals/` → journal type, `research/` → research, etc. after gbrain indexes the file (automatic, ~few seconds).
- Prefer **`.md`** in journals/research/inbox (gbrain sync imports `.md`/`.mdx` by default).
- Optional YAML frontmatter (`type`, `date`) should match the folder; gbrain classifies primarily by **path prefix**.

Before creating a new journal, list `journals/` (filesystem or gbrain **`query`** with `source_id: "__all__"` and a journal keyword) and **update the existing file** instead of duplicating topics.

Full Desktop (shortcuts, other folders) is indexed via a **federated** gbrain source registered at boot; **writes** stay under `JOSHU_FILES_ROOT` only.

## Joshu API (optional)

When MCP is unavailable, the Joshu server on `:8788` exposes read-only routes (same cross-source behavior when MCP HTTP on `:8794` is up):

- `GET /joshu/api/brain/search?q=...`
- `GET /joshu/api/brain/query?q=...`
