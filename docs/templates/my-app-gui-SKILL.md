---
name: my-app-gui
description: <AppName> desktop UI — GUI-first agent rules when the app window is open.
version: 0.1.0
metadata:
  hermes:
    category: <category>
---

# <AppName> GUI skill

Use when the **<AppName> window is open** (embedded chat or voice).

Replace `<AppName>`, `<app-id>`, guiAction names, and platform skill references before shipping.

## Platform boundary (embedded — GUI first)

When this app is open, treat the **on-screen list/detail** as the source of truth for read/list questions.

| User intent | Do this | Do NOT |
|-------------|---------|--------|
| List / summarize visible items, “what’s open?” | Read **`listPreview`** / **`openDetail`** from injected GUI snapshot | Platform MCP / `agent.usesSkills` tools |
| Snapshot empty or user says “refresh” | `app_gui_action` **`refreshList`** (return rows in tool result) | MCP first |
| Filter/search in current view | `app_gui_action` **`searchList`** (or equivalent), then snapshot | MCP first |
| Open item / open editor with draft | `app_gui_action` **`openDetail`** / **`openEditor`** | Chat-only paste |
| Data outside loaded GUI, deep search, other tenant, headless | `skill_view('<platform-skill>')` → MCP / invoke | — |
| Cron / automation / no UI | `POST /joshu/api/apps/<app-id>/invoke` + platform skills | — |

**Never auto-submit** destructive actions (send, delete, pay, …) — user confirms in the UI.

## GUI snapshot fields (implement in `getGuiSnapshot`)

- **`activeView`**: `list` | `detail` | `editor` | `setup` (what the user sees)
- **`listPreview`**: loaded rows in the sidebar/list — same data as on screen
- **`openDetail`**: full record when one item is open
- **`editor`**: only when `activeView` is editor (do not leak when viewing list/detail)

## Embedded chat rules

- UI changes → **`app_gui_action(appId="<app-id>", action=…, args=…)`**
- After drafting content for the user to edit, open the editor via guiAction — do not only paste in chat.

## Headless (no app window)

- Follow platform skills in `agent.usesSkills` and invoke API actions in `joshu.app.json`.

## guiActions reference

Declare in `joshu.app.json` `agent.guiActions[]` and register matching `useJoshuGuiAction` handlers:

| action | Effect |
|--------|--------|
| `refreshList` | Reload visible list; return summary for agent |
| `searchList` | Filter list (`query` arg) |
| `openDetail` | Open item by id |
| `openEditor` | Open editor with optional draft fields |
| _(add app-specific actions)_ | |

## Voice fast path (optional)

Map manifest `guiActions[].voice` to the same handlers as `useJoshuGuiAction` (legacy `voiceCommands[]` still supported).
