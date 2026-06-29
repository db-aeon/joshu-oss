---
name: jmail-gui
description: jMail desktop UI workflows — compose drafts, thread navigation, voice fast paths.
version: 0.1.0
metadata:
  hermes:
    category: mail
---

# jMail GUI skill

Use when the **jMail window is open** and the user is working in the desktop app (embedded chat or voice).

## Platform boundary (embedded — GUI first)

When jMail is open, treat the **on-screen inbox** as the source of truth for read/list questions.

| User intent | Do this | Do NOT |
|-------------|---------|--------|
| List recent subjects, “what’s in my inbox”, summarize visible mail | Read **`inboxPreview`** / **`openThread`** from the injected GUI snapshot | Composio `GMAIL_FETCH_*`, `joshu-mail`, gbrain |
| Snapshot empty or user says “refresh” | `app_gui_action` **`refreshInbox`** — use returned subject list | Composio |
| Search/filter in current tab | `app_gui_action` **`searchMail`** with query, then read snapshot | Composio first |
| Open a message / compose draft | `app_gui_action` **`openThread`** / **`openCompose`** | Paste-only in chat |
| Mail outside loaded list, other account, deep archive, “search live Gmail” | `skill_view('joshu-mail')` → gbrain → mirror → Composio | — |
| Headless mirror/connector checks | `POST /joshu/api/apps/jmail/invoke` | — |

**Never send mail** — draft via `openCompose` only; user sends in the UI.

## GUI snapshot fields

- **`activeView`**: `inbox_list` | `thread` | `compose` | `setup`
- **`inboxPreview`**: loaded rows in the sidebar (id, subject, from, date) — same data the user sees
- **`openThread`**: full detail when a message is open

When `activeView` is `thread`, describe **`openThread`**, not stale compose state.

## When jMail window is open (embedded chat)

- **Always call** `app_gui_action(appId="jmail", action=…, args=…)` for in-app UI changes.
- After drafting, **always call** `app_gui_action` with `action=openCompose` and `{ to, subject, body }` — never only paste the draft in chat.

## Chat-only / headless (no jMail UI)

- Follow `joshu-mail` search order (gbrain → mirror → Composio live Gmail).
- Invoke actions: `connectorsStatus`, `syncMirror`.
- MCP send rules unchanged (Nylas agent mailbox, action guard).

## Voice fast commands (no Hermes)

| User says | Tool / action |
|-----------|----------------|
| "new email", "compose" | `openCompose` via app voice tool |
| "search mail for …" | `searchMail({ query })` |
| Multi-step / ambiguous | `think` → Hermes + `jmail-gui` / `joshu-mail` |

## Frontend tools reference

Hermes tool: **`app_gui_action(appId, action, args?)`**. Manifest `guiActions` names:

| action | Effect |
|--------|--------|
| `openCompose` | Open compose pane; optional draft fields |
| `openThread` | Select message id and load detail |
| `searchMail` | Search and refresh inbox list |
| `startReply` | Reply to selected thread |
| `switchInbox` | Switch agent vs Gmail tab |
| `refreshInbox` | Reload list; returns subject lines for agent |
| `syncMirror` | Sync local mail mirror |
| `openSetup` | Open setup pane |
