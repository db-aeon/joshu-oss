---
name: ea-playbook
description: EA chat and crons. Mail workers use ea-mail-*.
metadata:
  hermes:
    category: executive-assistant
    version: "3.0.0"
---

# EA Playbook — chat and crons

Joshu mirrors mail every **10 minutes** (`connectors/mail/…`) and creates **`Triage/*.stub.md`** stubs plus one **`ea-mail-ingress`** Kanban task per actionable message. Mail ingress workers **file** each email — skill **`ea-mail-ingress`**. Mail track workers and the filing rules — skill **`ea-mail-track`**. **Scheduling** is a **child workflow** after filing (`ea-scheduling` + `scheduling_*` MCP). **Owner→agent asks** (non-meeting) spawn **`ea-owner-reply`** via **`owner_reply_*` MCP** — ingest no longer opens `ea-sched-ingress`.

Layout: `docs/executive-assistant.md` · `docs/executive-assistant.md#gtd-workspace` · `${JOSHU_FILES_ROOT}/FILING.md`

## Mail workers and filing rules (other skills)

These sections moved to other skills. The mail workers do not preload this skill. Load the skill that owns the work:

| Work | Skill |
|------|-------|
| Mail ingress (`kind: mail_ingress`): Required order, MCP failures, scheduling decision gate, core loop, classification guide | `skill_view('ea-mail-ingress')` |
| Mail track (`kind: mail_track`), Every run — read first, Project files, Link discipline, Mail attachments, Canonical project matching, Project reconcile, After a handoff to a track, Project boards — no scheduling sends | `skill_view('ea-mail-track')` |

**Old Kanban task:** when your Kanban task body has `kind: mail_ingress` or `kind: mail_track` and this skill is the preloaded one, the task was created before the split. Load `ea-mail-track` (and, for `kind: mail_ingress`, `ea-mail-ingress`) with `skill_view`, then follow them.

## Triggers (what starts work)

**Ingest (deterministic, every 10m):** Joshu mirrors, dedupes, classifies (`noise` / `info` / `track`), writes **Triage stub** + **`ea-mail-ingress`** task for actionable mail. Cron jobs send **summaries only** — they do not batch-drain Triage.

| Trigger | Source | This skill |
|---------|--------|------------|
| **Mail ingress Kanban** | `ea-mail-ingress` task (`kind: mail_ingress`) | Skill **`ea-mail-ingress`** (preloaded with `ea-mail-track`) |
| **Triage stub** | Thin stub (`source_path`, headers only) | Skill **`ea-mail-ingress`**, section Core loop |
| **Morning / evening / weekly cron** | Hermes jobs with `skills: ["ea-playbook"]` | Summary email + journals — **not** batch triage drain |
| **On demand** | jChat / SMS / voice | Rollup, situation report, in-chat capture, or Project reconcile (skill `ea-mail-track`) when the owner reports an outcome |
| **Multi-step / HITL project** | User asks for parallel steps, approvals, follow-ups | **Defer** to **`ea-project-kanban`** — **not** mail ingress |

More triggers will be added later as separate cron jobs or skills; do not invent them until documented here.

## In-chat idea capture (the owner riffing in conversation)

the owner often uses jChat (or voice) to dump ideas, follow-ups, and product thoughts in real-time — the conversational equivalent of "Another note to file." These are **not mail stubs**.

**Outcome vs note dump:** If the owner reports that an **existing project** is no longer waiting (“I just got off a call and they rejected me”, “the deal died”, “that role closed”), this is **not** capture. Match the slug and run Project reconcile (`skill_view('ea-mail-track')`) — close superseded tracks, update `about.md`. Do not only journal a sticky-note.

**Pattern signals (note dump):**
- Owner says "add to my list of follow-ups" or "jot this down"
- Stream of short messages: "I want to X" / "Also Y" / "And I need Z"
- "Riffing with you" or "while I think of it"
- Items added during another activity (pre-jog, between meetings)

**Capture workflow:**

**Pitfall — don't discuss, just save:** When the owner is dumping notes (vision, ideas, product thoughts), they want the note saved, not discussed. Do not philosophize, analyze, or respond with your own thoughts. Acknowledge briefly and move on. This is a storage action, not a conversation.

**Location transparency:** When acknowledging a saved note, include *where* it landed (the file path and section), not just "Saved". The owner will ask "where did you save this?" if you don't — and wants a concrete answer. Good: "Saved under `Projects/<slug>/about.md` → Vision & North Star." Bad: "Saved to your project files."

**Rapid-fire note sequences:** When the owner follows up with "another note" or "also" within 1–2 messages, it's a batch — don't read and write project files redundantly between each item. Collect all notes first, then do *one* read of the target files and *one* write. Acknowledge the batch once.

**Directive path (owner names the destination):** If the owner explicitly says where notes should go (e.g. "file in product development notes"), file directly to the specified project — **skip the Planning/capture-* step**. The owner told you exactly where it belongs.

**What to update in the project** (when filing past capture):
- **Vision / North Star / philosophy / requirements-level notes** → `Projects/<slug>/about.md`
- **Action items / tasks / follow-ups** → `Projects/<slug>/todo.md`
- **General notes / logging** → `Projects/<slug>/journal_YYYY-MM-DD.md`

Also save to **agent memory** (`memory()` tool) as a backup. The **project filesystem is the durable home**.

**Default path (no destination specified):**

1. **Append to today's capture file first** — `${JOSHU_FILES_ROOT}/Planning/capture-YYYY-MM-DD.md` (create from `Planning/` template if missing). Sections: **Tasks**, **Ideas**. One bullet per distinct item.
2. **Clarify** — same classification buckets as mail (skill `ea-mail-ingress`, Classification guide) (project, isolated todo, scheduling, info-only). If clearly belongs to one project, also patch `Projects/<slug>/todo.md` + journal with **links** (no stub to archive).
3. **Read before patch** — always read target files before updating so you don't clobber rows.
4. **Batch** — 3+ items in quick succession: one read, one capture append, then file to projects.

**Parallel to email:** Mail uses Triage stubs → filing. Chat uses **`Planning/capture-*`** → filing. Journal cites what was captured; do not paste full chat into markdown (Hindsight holds conversation context).

**Post-riff:** If the owner signals the riff is done ("prioritize later", "tomorrow"), acknowledge what landed in capture/projects. Do not time-block inline unless asked — defer to **`ea-time-block`**.

## On-demand situation report / agenda review

When the owner asks "what's on the agenda", "give me the rundown", "what's the big picture this week", or similar, **this is an EA function** — not triage, but a live multi-source pull to build a comprehensive picture. The agenda review is the starting gate for deciding which of the open loops to act on.

### Meeting follow-up in jChat (required skill load)

When the owner asks **meeting follow-up** questions in jChat — e.g. "what meetings need follow-up?", "which scheduling threads are blocked?", "did we email them yet?", "what's waiting on replies?" — **`skill_view("ea-scheduling")` first**, then:

1. **`scheduling_list_meeting_tasks`** — read `block_reason` and `recent_comments` on each open/blocked task (not just `body`).
2. **Do not claim outreach was not sent** from task body alone — comments and block reasons record sends, handoffs, and `awaiting owner approval`.
3. For any task still unclear, **`read_file`** on `source_paths` and verify the live thread (`nylas_*` / Gmail mirrors) per **ea-scheduling** "Study the thread before sending".

### Data sources (pull all)

| Source | Tool | What to extract |
|--------|------|-----------------|
| **Kanban scheduling** | `scheduling_list_meeting_tasks` | Blocked meeting tasks + `block_reason` + recent comments |
| **Live calendar** | `google_calendar_list_events` with timezone+window | Week ahead: events, conflicts, free pockets |
| **Project about.md files** | `terminal` with `head -30` per project | Title, urgency, status, active threads |
| **Session search** | `session_search` (no query = recent sessions) | What was worked on, what's in-flight |
| **Triage stubs** | `ls Triage/*.stub.md` | New unprocessed mail count |
| **Agent inbox** | `ls connectors/mail/nylas/threads/` + latest thread bodies | Unread Nylas messages needing reply |
| **Connector health** | `connectors_status` | Sync staleness (skip for speed if clear) |
| **Specific event details** | `google_calendar_get_event` with `eventId` + `calendarId` from `google_calendar_list_events` | Who a meeting is with (attendees), description, Meet link |

### Presentation structure

Organize the rundown into sections, always starting with **today's remaining window**:

```
TODAY — what's left
<time now, remaining events, free pockets>

THIS WEEK AT A GLANCE
<day-by-day with key events and free windows>

ACTIVE PROJECTS & OPEN LOOPS
<numbered list with urgency, current status, decision needed>

WHAT I'D PRIORITIZE
<2-4 highest-leverage items with your recommendation>
```

### "Answer your / my inbound mail" trigger

When the owner says "let's answer your inbound mail", "let's answer my mail", "capture all work streams", "make sure everything's accounted for", or similar:

**Goal:** Produce a comprehensive, categorized survey of everything in the agent's (the companion's) inbox, distinguishing live action items from historical noise.

#### Method: Systematic inbox audit

1. **Sync first** — Run `connectors_sync_now(provider: "nylas")` to pull the latest messages. Don't skip this — the mirror might be minutes stale and you need the full picture.

2. **Find all unread Nylas threads** — Use `search_files` with pattern `unread: true` across `connectors/mail/nylas/threads/`. This gives you every thread that arrived while you were looking elsewhere — both actionable replies and your own sent messages (which also carry `unread: true` in the mirror).

3. **Bulk-scan to build a roster** — Use a code block or `execute_code` to iterate over the thread files efficiently. Extract from each: thread_id, from, subject, date, latest_message_timestamp, unread flag, and a quick check for OOO/bounce markers. Sort by recency. This avoids 28 sequential `read_file` calls.

4. **Read actionable ones fully** — From the roster, identify threads that are:
   - **Incoming from real people** (not `agent mailbox` sends, not MAILER-DAEMON, not owner's already-filed notes)
   - **Recent** (within the last 1-3 days unless it's clearly unresolved)
   - Read the full body of each to understand the ask.

5. **Categorize every thread** into these buckets:

   | Bucket | Examples | Treatment |
   |--------|----------|-----------|
   | **Needs action** | Investor replied asking to schedule; waitlist user lost signup code | Handle or create kanban card. Present to the owner with next-step recommendation. |
   | **Already handled / waiting on reply** | You already replied, awaiting their response | Note the thread is in-flight. Create kanban card if it needs durable tracking. |
   | **Historical / already past** | Oil change from Jun 8, hair appointment from Jun 7, old scheduling requests | Acknowledge as done. No action. |
   | **Delivery failure / bounce** | MAILER-DAEMON, Nylas delivery failed | Note which recipient bounced. Group under the parent broadcast's journal entry. |
   | **OOO auto-reply** | Out-of-office autoreplies | Note return date if given. Add to project journal as related notification. |
   | **Owner notes (already filed)** | owner's "Another note to file", "Next steps", etc. | Already categorized in previous session. No duplicate work. |
   | **Own outbound / system** | agent mailbox sent messages, morning briefs, reminders | Skip — they're artifacts of your own activity, not new work. |

6. **Present the summary** — Organize into clear sections:
   ```
   **Needs action:**
   - [Person] — [one-line summary of ask]
   
   **Waiting on reply:**
   - [Person] — [status]
   
   **Historical (done):**
   - [list items]
   
   **⚠️ Delivery issues:**
   - [bounced addresses]
   ```

7. **For each "needs action" item**, either:
   - Handle it immediately (reply to the thread, schedule the call, etc.)
   - Or create a kanban card to track it and tell the owner what you've done

#### Deduplication notes

- **Your own sent messages** carry `unread: true` in the Nylas mirror. Skip them — they're not new mail.
- **owner's note-to-self emails** (`owner work email → agent mailbox`) that were already filed in a previous session don't need re-processing. The session where they were categorized is in session history — trust that it was handled.
- **Multiple copies of the same thread** (e.g. Gmail + Nylas mirrors of the same conversation) — process the Nylas copy (agent inbox), skip the Gmail one for inbox audit purposes. Triage handles the Gmail side.

#### Example output shape

```
**Needs action (2):**
• Richard Barry — wants me to use his Calendly to book before Jun 23
• Andra Izgarian — lost waitlist code, can't finish signup

**Waiting on reply (1):**
• Thierry Ho (Reitler) — offered Wed/Thu slots, awaiting pick

**Handled this session (3):**
• Jaclyn Clark — confirmed Wed @ 3 PM
• Noah/Elizabeth Yin — call Tue 11:30 AM phone
• Allen Hua — KB in Teams was today at 3 PM

**Delivery failures (2):**
• MAILER-DAEMON — one newsletter recipient bounced
```

## Hermes skill-backed crons

Welcome installs jobs in `~/.hermes/cron/jobs.json` with:

- `skills: ["ea-playbook"]` — Hermes loads **this** `SKILL.md` for the run ([skill-backed cron jobs](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron#skill-backed-cron-jobs))
- `deliver: local` — run in the gateway workspace

| Job name | Typical work after skill loads |
|----------|--------------------------------|
| `EA morning` | **`skill_view('ea-morning-review')`** — prep `Planning/daily-review-*.md`, pointer email; interactive review when owner opens jChat |
| `EA evening` | **`skill_view('ea-shutdown')`** — draft shutdown section, journals + evening pointer email |
| `EA weekly` | `Projects/other` hygiene, **`status: someday`** scan, archive `done`, chase Waiting on / Blocker, clarify stale `Planning/capture-*` |

Cron **prompt** text is a short headline; **this skill** is the procedure. When the prompt mentions triage, follow the Core loop of skill `ea-mail-ingress` first.

### EA weekly (procedure)

When the cron prompt mentions weekly review:

1. List `Projects/*/about.md` with `status: someday` — resurface or promote to `active` / archive noise.
2. **`Projects/other/`** — merge duplicates, promote to named slug, or set `status: done` → `_archive/`.
3. Chase overdue **Waiting on** / **Blocker** rows across active projects.
4. **`Planning/capture-*.md`** — file open bullets to projects or delete clarified lines; leave truly raw items for owner.
5. Confirm every **`status: active`** project has at least one open `todo.md` row or explicit "waiting on calendar" note in journal.
6. Send weekly summary if prompt requests (same template family as morning/evening).

Do **not** use Reference/Someday/Current folder moves — only `about.md` `status` + `_archive/`.

## Channels

| Role | Mail on disk |
|------|----------------|
| **Owner** | `connectors/mail/gmail/{account_key}/threads/` |
| **Agent** | `connectors/mail/nylas/threads/` |

Summaries: **agent Nylas** → `primaryWorkEmail` in `.joshu/nylas/profile.json`. No owner→agent forward.

## Mail find / search / send (on demand)

Not this skill’s job — load **`joshu-mail`** (`skill_view('joshu-mail')`). Triage crons read thread bodies from `source_path` on stubs; they do not run Composio live search.

## Summary email

When the cron prompt calls for a morning/evening summary, write it to `Projects/_system/summary-email.md` then send via Nylas to `primaryWorkEmail`.

### Morning (pointer — prefer daily review)

For **`EA morning`**, follow **`ea-morning-review`** **Morning prep** + **Email (morning pointer)**. The email is a **short pointer** to `Planning/daily-review-YYYY-MM-DD.md` and today's time block — not a standalone 500-word brief. Owner completes the plan in jChat ("morning review").

If daily-review prep fails, fall back to **Morning fallback** structure below.

### Evening (pointer + shutdown draft)

For **`EA evening`**, follow **`ea-shutdown`** **Evening prep**, append journals, then send summary with **shutdown pointer** (link to today's daily-review + time block). Condense stable sections.

### Fallback / weekly (full structure)

When the prompt calls for a full summary (weekly, or morning prep failed), use this structure:

```
📅 TODAY — what's on the calendar
<current time, remaining events, free pockets>

📬 NEW MAIL (N items)
<each new stub: who, what, project filed under, next step>

🔁 SCHEDULING STATUS
<open meeting tasks with blocker status>

📋 ACTIVE PROJECTS & OPEN LOOPS
<notable changes since last summary — skip stable items>

🎯 WHAT I'D PRIORITIZE
<2-4 top items with your recommendation>
```

### Data sources to pull (every summary)

| Data | Tool | Notes |
|------|------|-------|
| Today's calendar | `google_calendar_list_events(date=today, timezone=...)` | Remaining events + free pockets |
| Week ahead (next 5 days) | `google_calendar_list_events(daysForward=7)` | Morning AND evening. Catches next-week confirmations and scheduling conflicts. |
| Open meeting tasks | `scheduling_list_meeting_tasks()` | Blocked tasks + `block_reason` + recent comments |
| Recent project updates | Scan `Projects/*/todo.md` for rows with recent activity | Surface rows that moved status today |
| Nylas inbox (new mail) | `grep -l "unread: true" connectors/mail/nylas/threads/*.md` | Count and read latest thread bodies for `📬 NEW MAIL` section. **Pitfall**: `unread: true` includes sent messages (agent mailbox), old owner notes already filed, and calendar acceptances — filter out these artifacts. Focus on incoming from real people within 1–3 days. |

**Pitfall — volume of old unread Nylas threads**: The Nylas mirror accumulates many `unread: true` threads that are already handled (owner's old outbound messages, calendar acceptances, stale scheduling requests). When scanning for new mail, filter for recent incoming messages — don't report or re-process old unread artifacts that were already filed in prior sessions. A quick `head -6` on each candidate lets you decide: from=agent mailbox → skip (sent artifact); date > 3 days ago and from=owner → skip (filed previously); subject contains "Accepted:" or "Cancelled:" → skip (calendar artifact).

Keep it concise — 500–800 words max. Owner reads these on mobile. Surface only what changed since the last summary; stable items that haven't moved can stay off the email.

### Signature

The Nylas API appends the companion HTML signature automatically — pass message content only in `body`.

## Escalation

Surface: financial/legal, calendar you cannot place, sensitive sends (draft only), genuine uncertainty.

## New engagement

Gmail in **Connectors** → Welcome seeds `Projects/` + installs EA crons with `--skill ea-playbook`.
