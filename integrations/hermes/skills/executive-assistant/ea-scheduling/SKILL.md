---
name: ea-scheduling
description: Meeting-mail scheduling. Kanban ea-sched-*; Calendly fallback.
metadata:
  hermes:
    category: executive-assistant
    version: "4.22.0"
---

# EA Scheduling

**Meeting negotiation** on board **`ea-scheduling`**. Ingest no longer opens **`ea-sched-ingress`** — mail ingress workers file the email first, then spawn meeting tasks here via **`scheduling_*` MCP**.

| Board | `kind:` | Job |
|-------|---------|-----|
| **`ea-scheduling`** | `meeting` | Check **live owner Google** availability → book on **owner Google Calendar** (Composio) → `kanban_block` / `kanban_complete` |
| **`ea-sched-ingress`** | `ingress` | **Legacy** — no new ingest tasks. Existing cards: match/create on `ea-scheduling` → `kanban_complete` |

**Meeting workers never book from mail ingress alone — ingress filing + `scheduling_create_meeting_task` first.**

---

## Detect mode

```
kanban_show()
```

`kind: meeting` → [Meeting](#meeting). `kind: ingress` on **`ea-sched-ingress`** → [Legacy ingress](#legacy-ingress) only.

## jChat — meeting status / follow-up questions

When the owner asks in jChat (not a Kanban worker): "what meetings need follow-up?", "which threads are blocked?", "did we send yet?", "what's waiting on replies?" — you are answering **scheduling status**, not generic recall.

1. **`skill_view("ea-scheduling")`** if not already loaded.
2. **`scheduling_list_meeting_tasks`** — use **`block_reason`** and **`recent_comments`** on each task; do not infer from `body` alone.
3. Before saying outreach was **not sent**, read `source_paths` and verify the mail thread (see [Study the thread before sending](#study-the-thread-before-sending)).

## Spawned from mail ingress (2026-06)

When **`ea-mail-ingress`** filing is done and the ingress task has **`scheduling_eligible: true`**:

1. **`scheduling_list_meeting_tasks`** — match open/blocked meeting on **`ea-scheduling`** by `thread_id` / subject.
2. **Match** → **`scheduling_handoff_meeting_task`** with neutral summary of this mail.
3. **No match** → **`scheduling_create_meeting_task`** — always pass **`threadId`** + **`provider`** from the ingress body (Joshu dedupes: returns `action: existing_thread` if an open meeting already exists for that thread → then **`scheduling_handoff_meeting_task`** instead).
4. For **owner intro handoff** ("Copying [companion] to suggest times") you may offer slots + `nylas_send_message` **without** a meeting task — see [Owner self-introduction handoff](#owner-self-introduction-handoff-companion-intro-reply). **Study the thread first** — [Study the thread before sending](#study-the-thread-before-sending).

**Hard stop:** If ingress has **`agent_authorized: false`** or **`scheduling_eligible: false`** — do not create meeting tasks, do not send mail. File-only mail is not your job on that card.

**HITL defer at ingress:** If the mail ingress worker chose path **C** ([ea-playbook scheduling decision gate](../ea-playbook/SKILL.md#scheduling-decision-gate-mail-ingress-step-5)), there is **no meeting task** for you on this mail — owner review notes are in `Projects/<slug>/`. Do not create one retroactively unless the owner explicitly asks in jChat.

Call from **`ea-mail-ingress`** worker — Hermes `kanban_create` cannot cross to `ea-scheduling`; use **`scheduling_*` MCP** only.

---

## Legacy ingress

**Only for existing `ea-sched-ingress` cards** — no new ingest tasks.

### Why MCP, not `kanban_create`

Hermes pins ingress workers to **`ea-sched-ingress`**. Worker tools (`kanban_create`, `kanban_list`, `kanban_comment` on other ids) **cannot create or list on `ea-scheduling`**.  
CLI `--board ea-scheduling` from an ingress worker **still creates on ingress** (verified on patrick).

Use **`mcp_joshu_connectors_scheduling_*`** tools — Joshu writes to **`ea-scheduling`** via `hermes-kanban-bridge.py`.

### Steps

1. **`kanban_show()`** — read `source_path`, `message_id`, `ingress_id`, profile, `workspace_path`.

2. **`read_file`** — `<workspace_path>/<source_path>` (under `joshu's files`).

3. **`scheduling_list_meeting_tasks`** — open meetings on **`ea-scheduling`** (includes **blocked**).  
   Match on subject, participants, time hints — not `thread_id` alone. Prefer **match**, not a duplicate create.

4. **Match** → **`scheduling_handoff_meeting_task`** — neutral summary of **this** mail only:

```json
{
  "taskId": "<matched meeting task_id>",
  "sourcePath": "<source_path from ingress body>",
  "messageId": "<message_id from ingress body>",
  "from": "info@joshu.me",
  "summary": "info@joshu.me replied: offered Thursday noon PT for in-person meet."
}
```

Do **not** judge whether waiting is over — the **meeting worker** decides.  
Then **`kanban_complete`** with `metadata={"action":"matched","matched_meeting_task":"<id>"}`.

5. **No match** → **`scheduling_create_meeting_task`**:

```json
{
  "messageId": "<message_id from ingress body>",
  "sourcePath": "<source_path>",
  "subject": "Change tires",
  "from": "the owner <owner work email>",
  "timezone": "America/Los_Angeles"
}
```

Response includes `task_id` on board **`ea-scheduling`**.  
`scheduling_comment_meeting_task` to link ingress.  
`kanban_complete(summary=…, metadata={"action":"new_meeting","new_meeting_task":"<task_id>"})`.

### Ingress — forbidden

- `kanban_create` for meetings (lands on **ingress**)
- `kanban_list` (orchestrator-only)
- `hermes kanban` CLI / `execute_code` / SQLite
- **`terminal` / `nylas email send`** (or any shell path to outbound mail — bypasses action guard; use MCP only)
- `nylas_send_message`, `nylas_list_events`, any Nylas calendar write (`nylas_create_event` is **hard-blocked**)
- Composio `GMAIL_SEND_*` / `GMAIL_REPLY_*` (use `nylas_send_message` for outbound mail)
- `scheduling_unblock_meeting_task`
- `mark_scheduling_ingress_processed` (legacy JSONL)
- `todo` lists

---

## Meeting

**Job:** check owner availability, book or negotiate.

### Calendar source of truth

| Use | Tool | Notes |
|-----|------|-------|
| **Owner busy/free** | **`google_calendar_find_free_slots`** (Joshu connectors MCP) | **Live FreeBusy API** — omit `items` (default: `primary` + owner personal Gmail) or pass explicit calendar ids. Use **`calendars.combined.free`** for slot picking (union of busy across all queried calendars). Respects Google **Show as free** (transparent) events. |
| **Event details (conflict explanation)** | `google_calendar_list_events` | Titles + `blocksAvailability` / `transparency` only — **never** treat every event title as busy. |
| **Agent ledger (read-only)** | `nylas_list_events` | Historical holds only — **do not create** on Nylas (hard-blocked) |
| **Stale fallback** | gbrain / `connectors/calendar/google/` mirrors | Only if live Composio fails — mirrors lag; owner may have edited calendar since sync |

Owner can delete or move events on their real Google calendar. **Never** infer owner availability from Nylas alone, from agent calendar mirrors, or from event titles on `list_events`.

**Wrong calendar scope:** `items: ["primary"]` alone checks only the work calendar (`owner work email`). Owner meetings often live on a personal Gmail calendar — FreeBusy returns `busy: []` on primary while the personal calendar is blocked. **Omit `items`** or include personal Gmail; always schedule from **`calendars.combined.free`**, not `primary.free` alone.

**Transparent events:** Google events marked **Show as free** (`transparency: transparent`, `blocksAvailability: false`) — e.g. some recurring **Asteme** blocks — do **not** appear in FreeBusy `busy[]`. A visible calendar title does **not** mean the owner is unavailable. Only `google_calendar_find_free_slots` (or Composio `GOOGLECALENDAR_FIND_FREE_SLOTS` with the same args) determines bookable time.

External attendees (not connected on this box): no calendar read — email + `kanban_block`.

### Check availability (before proposing or booking)

1. `nylas_get_profile` — `timezone`, `primaryWorkEmail`, `personalEmail`, working hours (default: 9 AM - 7 PM PT).
2. **`google_calendar_find_free_slots`** — authoritative for busy/free. Prefer Joshu connectors MCP (wraps Composio `GOOGLECALENDAR_FIND_FREE_SLOTS`). **Omit `items`** so Joshu queries `primary` plus owner personal Gmail calendars (from profile + connected account). Or pass explicit ids, e.g. `["primary", "owner@gmail.com"]`. Time window in owner timezone:
   - `date` + `timezone` for one local day, **or** `timeMin` / `timeMax`
   - `time_min` style when using Composio directly: 7 AM local on the first day; `time_max` midnight local after the last day (exclusive)
   - Response includes per-calendar `busy[]` / `free[]` and **`calendars.combined`** (union busy — **schedule from `combined.free`**). Free intervals filtered to `minDurationMinutes` (default 30). Pick slots within working hours.
3. Optionally **`google_calendar_list_events`** same window only to name events on calendar — check `blocksAvailability` before mentioning a conflict:

```json
{ "date": "2026-06-11", "timezone": "America/Los_Angeles" }
```

Responses include **`timeAnchor`** (owner-local now) and per-event **`localDate`** / **`relativeDay`** (`today` | `tomorrow` | `yesterday` | null). Use those — not UTC server time or Composio `time_info` — when saying today/tomorrow in summaries.

### Temporal grounding (calendar summaries)

- **Authoritative now:** each Joshu chat turn injects the owner's local date/time in a system message. Trust that over UTC timestamps in traces, Langfuse, or Composio meta tools.
- **Never** label a day "today" because it is the first date in a query window (e.g. Wed when fetching "rest of this week" on Tuesday evening).
- When warning about overlaps, name the **weekday + date** (`Wed 6/17`) and use `relativeDay` when present (`tomorrow's wrap block`, not `today's` if `relativeDay` is `tomorrow`).
- **Do not** infer today from event ISO strings alone — convert to owner timezone and compare to `timeAnchor.ownerLocalDate`.

4. Optionally `nylas_list_events` same window — see holds the companion already placed (avoid double-booking ledger).
5. Pick slots that are **free on live Google FreeBusy** and fit working hours.

### Workflow

1. `kanban_show()` — `source_paths`, `ingress_handoff`, `state`, `timezone`, `calendar_event_id`.

2. **Verify task status against real data — never answer from memory alone.** The task body may say "agent needs to send times" even though you already sent them in a prior session, cron run, or different thread. Before reporting a task as "not yet done," read every `source_paths` entry and check the thread for your sent replies (look for agent mailbox messages in Nylas threads, or agent `from` in Gmail threads). Also check whether a `nylas_send_message` was logged in the thread's message_ids. If multiple threads exist for the same contact, read both — don't assume they're the same conversation.

3. `read_file` on every `source_paths` entry (and new paths from `ingress_handoff`).

### Study the thread before sending

**Do not pick recipients from the task title, subject line, or your memory of the thread.** Read the mail carefully — message by message — before any `nylas_send_message`.

1. **Read the full thread in order** — every message, not just the latest snippet. If the mirror truncates headers or bodies, fetch live metadata (`nylas_get_message`, or Composio `GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID` with `format: metadata`) until you have complete **To / CC / From** for each message that matters.

2. **Find the owner's latest outbound** (any mailbox they use — `primaryWorkEmail`, personal Gmail, etc.). Who did the **owner** put in **To:**? That is usually who expects the next action. **CC:** are observers (recruiters, coordinators, the agent mailbox) — not necessarily who you should address unless the owner's prose says otherwise.

3. **Map roles, don't guess from labels.** Recruiter ≠ scheduler ≠ hiring manager. The person who started the thread or appears most often is not automatically the right **`to`** for your reply. Example failure mode: owner replies **to the scheduler** with the recruiter only CC'd — emailing the recruiter as **`to`** misses the person actually booking the meeting.

4. **When the owner delegates to you** ("copying [companion] to coordinate", "please suggest times") — your job is to continue **their** addressing: reply to whoever **they** addressed, CC who **they** CC'd (owner addresses + thread participants as appropriate), use `replyToMessageId` on the message you're continuing. **Subject must be the parent message subject exactly** (only `Re:`/`Fwd:` prefix differences allowed). Do **not** append availability, names, or task-title decorations — that forks a new Gmail/Google thread. On `reply_subject_mismatch`, retry with `expectedSubject` from the error.

5. **Before send, state recipients explicitly** in your working summary (`to` / `cc`) and match them to what you read. Owner Telegram approval shows To/CC — if they don't match your reading of the thread, fix before the owner approves.

6. **Re-check sent mail** on this thread (Nylas + owner Gmail mirrors) so you don't duplicate outreach or report "not sent" when a prior session already emailed the wrong person.

4. **After ingress handoff**: **you** decide:
   - **Actionable** — confirmed slot → **`google_calendar_find_free_slots`** for that window → if free, book
   - **Still waiting** — "let me find a time", vague deferral → **`kanban_block`** (no book)
   - **Need outreach** — study the thread ([above](#study-the-thread-before-sending)), then `nylas_send_message`, then **`kanban_block`**
   - **Unsure / duplicate risk** — see [HITL defer on meeting tasks](#hitl-defer-on-meeting-tasks) (no book, no send)
5. **Book** (slot confirmed + owner free on live Google): **`mcp_composio_GOOGLECALENDAR_CREATE_EVENT`** on the owner's connected Google account — include owner `primaryWorkEmail` + attendees, local `start_datetime` + `timezone` + duration fields. Then `nylas_send_message` confirmation → `kanban_comment` → `kanban_complete`.
6. **Negotiate** when vague/conflict: study the thread, email proposal, `kanban_block`.

### Action guard + `nylas_send_message`

Outbound mail hits **owner-channel approval** (Slack or Telegram) when action guard is enabled. Joshu may block up to **30 minutes** waiting for the owner; Hermes MCP tool calls often **timeout around 120s** first.

**Always pass `kanbanTaskId`** (this meeting task id, e.g. `t_…`) and preferably `threadId` on `nylas_send_message`. Joshu rewrites this task's `block_reason` after approve/deny/timeout so status does not stay on "awaiting owner approval" after mail delivers (or after a denied/failed gate).

| Outcome | What it means | Your action |
|---------|---------------|-------------|
| **Timeout / `TimeoutError` on `nylas_send_message`** while guard is on | **Approval still pending** — not MCP down | **`kanban_block(reason="awaiting owner approval")`** — do **not** retry send from another task or board. Joshu will rewrite the reason after the owner decides. |
| **`503`** / `action_guard_unavailable` | Owner channel delivery failed or guard broken | **`kanban_block(reason="action-guard-unavailable: …")`** — not MCP down |
| **`ok: true`** with `messageId` starting **`blocked-`** | Owner denied or approval timed out at Joshu | **No mail sent** — do not treat as success; block or complete without re-send |
| **`ok: true`** with real UUID `messageId` | Mail sent | **`kanban_block`** waiting on reply (or book if confirmed). Prefer reason like `awaiting reply: …` — Joshu may already have rewritten it. |

**Before claiming "MCP down":** run **`connectors_status`**. A timeout on send alone is **not** connectors failure.

**Only `ea-scheduling` meeting workers** negotiate calendar mail on a thread. **`project-*` board workers** must **not** call `nylas_send_message` for meeting scheduling — see **`ea-playbook`**.

### MCP / Joshu API failures (meeting worker)

If **`connectors_status`**, **`scheduling_*`**, or **`google_calendar_*`** fail with HTML 404, connection refused, or explicit "Joshu API unreachable":

1. **`kanban_block(reason="connectors-mcp-down: …")`** — do **not** `kanban_complete`.
2. Do **not** work around with `terminal` / `nylas email send` / `curl`.
3. Do **not** confuse **action-guard send timeout** (above) with MCP down.

### HITL defer on meeting tasks

When working a **`kind: meeting`** card, **do not** book or send if you have **any doubt** that negotiation is still appropriate:

| Signal | Action |
|--------|--------|
| Thread shows meeting **already booked** (Calendly, confirmations, event on owner calendar) | **`kanban_comment`** + update project journal → **`kanban_complete`** with `scheduling_closed: true` — no outreach |
| Counterparty sent **status-only** mail ("confirmed", "see you then") | Same — close meeting task; do not re-offer slots |
| Ambiguous who to address, or sensitive thread where wrong mail would hurt | **`kanban_block(reason="owner review: scheduling judgment")`** — append project `journal_*` section **`## Scheduling — owner review needed`** (what you read, why you stopped, suggested owner action) |
| Calendar check inconclusive | Block for owner review — **never** guess with `find_free_slots` + send |

Owner clears blocked meeting tasks in jChat or morning review. **`ea-morning-review`** surfaces `owner_decisions_pending` projects and todo rows **Waiting on: owner review**.

**Never** `nylas_create_event` — Joshu MCP policy blocks Nylas calendar writes.

Example (`GOOGLECALENDAR_CREATE_EVENT` via Composio MCP):

```json
{
  "summary": "Change tires",
  "start_datetime": "2026-06-09T09:00:00",
  "timezone": "America/Los_Angeles",
  "event_duration_hour": 1,
  "event_duration_minutes": 0,
  "attendees": ["owner@example.com", "shop@example.com"]
}
```

### Meeting MCP tools

| Action | Tool |
|--------|------|
| **Owner availability (live)** | **`google_calendar_find_free_slots`** (Joshu connectors MCP) |
| Event titles / transparency | `google_calendar_list_events` |
| Agent ledger (read) | `nylas_list_events` / `nylas_get_event` |
| **Create on owner calendar** | **`mcp_composio_GOOGLECALENDAR_CREATE_EVENT`** |
| Reschedule | `mcp_composio_GOOGLECALENDAR_PATCH_EVENT` (no deletes — policy blocks `*_DELETE_*`) |
| Mail | `nylas_send_message` — always pass **`sourcePath`** from meeting `source_paths`, `replyToMessageId` on the message you are continuing, and the **exact parent `subject`** (no decorations) |
| Profile | `nylas_get_profile` / `nylas_update_profile` |

---

## Mail recall

`joshu-mail` (read/search only).

## Owner self-introduction handoff (companion intro reply)

The **owner** sometimes sends batch emails to multiple people (investors, partners) with the agent CC'd, and explicitly writes something like "[Companion], please introduce yourself, and share my availability." When this happens:

1. **Find the email in the agent Nylas inbox** — sent from an owner address with the agent CC'd. Use `nylas_get_message` with the message_id from the Nylas thread mirror if the body is truncated.

2. **Read the owner's exact instruction** in the body (e.g. "please introduce yourself and share my availability — 30 min is fine"). Follow that instruction literally — see [Study the thread before sending](#study-the-thread-before-sending) for who belongs in **To** vs **CC**.

3. **Check live owner calendar** — `google_calendar_find_free_slots` (omit `items` or include personal Gmail; multi-day window, owner timezone). Schedule from **`calendars.combined.free`**. Filter free intervals to at least 30 min within working hours. Offer 2-3 specific time windows across different days.

4. **Reply to the thread** — `nylas_send_message` with **`sourcePath`** from the meeting task `source_paths`, **`kanbanTaskId`** = this task id, optional **`threadId`**, `replyToMessageId` on the message you are continuing, and the **exact parent subject** from the thread mirror (no decorations). **To:** whoever the owner addressed; **CC:** owner (so they see the thread) plus anyone they CC'd. Introduce yourself as the owner's companion and offer the slots you found. Agent sends hit **action guard** (owner channel approval) when enabled — `kanban_block` until send succeeds; Joshu rewrites `block_reason` after approve/deny when `kanbanTaskId` was passed.

No kanban task is needed for this pattern — the owner's instruction is in the email body, not in a scheduling ingress workflow. Reply, wait for the counterparty, then proceed with standard meeting booking.

## Not for general multi-step / HITL projects

User-initiated **multi-step work** (drip campaigns, research pipelines, vendor chases, approval-heavy sends) belongs on a **`project-<slug>`** board via skill **`ea-project-kanban`**. Do not create triage cards on `ea-sched-*` boards for those workflows. This skill is only for **meeting-mail** scheduling negotiation.

---

## Counterparty Calendly booking

When you've offered slots and the other party replies with **their own Calendly link** (common for investors), you have two paths:

### Path A: Calendly Scheduling API (when owner is the Calendly host)

Calendly has a **REST API** for programmatic booking — no browser needed.

**Important caveat:** This API requires **the host's** Calendly credentials (Personal Access Token or OAuth). When a counterparty sends _their_ Calendly link, you generally cannot use this path because you don't have their account credentials. This path is viable when the **owner** is the Calendly host.

**Prerequisites:**
- Paid Calendly plan (Standard, Teams, or Enterprise)
- Personal Access Token from Settings → Integrations → API & Webhooks

**Booking flow:**
1. `GET https://api.calendly.com/event_types` — discover event type UUID
2. `GET https://api.calendly.com/event_type_available_times?event_type={uuid}&start_time=...&end_time=...` — query slots
3. `POST https://api.calendly.com/invitees` — book the slot

**MCP integration:** `github.com/mkimelblat/calendly-mcp-server` (Python, MIT). Box-only skill `calendly-agent-integration` may exist on learning repos for setup notes.

### Path B: Browser via Camoufox + email fallback (counterparty's Calendly)

When the counterparty sent their Calendly link and you don't have API access to their account:

**Failure mode observed:** Even with Camoufox (anti-detection browser), Calendly often blocks the final "Schedule Event" submit: *"This booking cannot be completed. For security reasons, we are not able to finalize this booking from your current session."* Do not retry repeatedly — the block is deterministic per-session.

**Email fallback (do this instead):**

1. Navigate to the Calendly link to **visually confirm** the agreed slot is available (date picker + time selector work fine)
2. **Email the counterparty directly** using `nylas_send_message` (reply-to-thread with the latest `message_id`):

```
Hi [Name],

I tried booking the [day] at [time] [TZ] slot through your Calendly link, but the booking platform isn't accepting my end. Could you send over a calendar invite directly for:

**[Day, Month Date, Year]**
**[Start time – End time] [TZ]**
**[Meeting format, e.g. FaceTime/Zoom/Phone]**

Looking forward to connecting!

Best,
[Companion name]
```

3. The meeting is **confirmed via email** — no further browser retries. Optional: `GOOGLECALENDAR_CREATE_EVENT` placeholder on owner calendar ("Awaiting [name]'s invite").

See also `references/investor-response-classification.md` (Calendly security blocks) in **`ea-playbook`**.
