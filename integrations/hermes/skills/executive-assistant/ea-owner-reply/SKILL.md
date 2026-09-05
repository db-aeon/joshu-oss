---
name: ea-owner-reply
description: Do the owner's ask then reply on that Nylas thread. Board ea-owner-reply.
metadata:
  hermes:
    category: executive-assistant
    version: "1.1.0"
---

# EA Owner Reply

**Owner mailed the companion** (agent Nylas). Board **`ea-owner-reply`**, `kind: owner_reply`. Ingress already **filed**; your job is **do the ask** then **`nylas_send_message`** on that thread.

| Board | `kind:` | Job |
|-------|---------|-----|
| **`ea-owner-reply`** | `owner_reply` | Research / tools as needed → reply on thread → `kanban_complete` or `kanban_block("awaiting owner")` |
| **`ea-mail-ingress`** | `mail_ingress` | File only — **never** send from ingress |
| **`project-*`** | `mail_track` | File / wait — **must not** send owner replies |

Spawned after filing via **`owner_reply_*` MCP**. Hermes `kanban_create` cannot cross boards.

---

## Detect mode

```
kanban_show()
```

`kind: owner_reply` → [Worker](#worker).

## Worker

1. **`skill_view("ea-owner-reply")`** if not already loaded.
2. **`coordination_list_active`** with task `thread_id` + `source_path` — if open **`meeting_negotiation`** on scope, **hand off** to that task (`scheduling_handoff_meeting_task` via ingress playbook); **never** browser-book or offer slots on this card.
3. **`kanban_show`** — `source_paths`, `thread_id`, `message_id`, `provider`, subject.
3. **`read_file`** the mail mirror at `${JOSHU_FILES_ROOT}/<source_path>` (once).
4. **Do the ask** — gbrain, mail mirrors, **`web_search` / Exa** when the owner asked for research. File notes under `Projects/<slug>/` if ingress already created a folder (link; do not paste mail bodies).
5. **`nylas_send_message`** on **this thread**:
   - `replyToMessageId` = ingress `message_id`
   - parent **subject** (must match or Joshu returns `reply_subject_mismatch`)
   - `sourcePath` = mirror path
   - Owner-only recipients bypass action guard; mixed threads may prompt SMS.
6. **`kanban_complete`** if the deliverable was emailed. **`kanban_block("awaiting owner")`** only if the reply asked a **real** question the owner must answer.
7. Never **delete/trash** Gmail or Nylas. Never send **scheduling slots** — `scheduling_list_meeting_tasks` / hand off to **`ea-scheduling`**.

### Forbidden

- `kanban_create` (lands on this board only; do not spawn project-* senders)
- Shell `nylas email send` / `curl` (bypasses action guard)
- Composio `GMAIL_SEND_*` / `GMAIL_REPLY_*`
- Meeting negotiation (`find_free_slots`, slot offers)
- Deleting or trashing owner mail

### MCP (Joshu connectors)

- **`owner_reply_list_tasks`** — optional `threadId`
- **`coordination_scope_resolve`** / **`coordination_list_active`** — preflight before create or browser book
- **`owner_reply_create_task`** — ingress only; returns `existing_thread` or `existing_coordination` if open card on same scope
- **`owner_reply_handoff_task`** — later mail on the same thread (ingress)

Call **`mcp_joshu_connectors_owner_reply_*`**.
