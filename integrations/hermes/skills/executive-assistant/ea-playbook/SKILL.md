---
name: ea-playbook
description: Triage mail to Projects. Not drips—use ea-project-kanban.
metadata:
  hermes:
    category: executive-assistant
    version: "2.17.0"
---

# EA Playbook — Triage & rollups

Joshu mirrors mail every **10 minutes** (`connectors/mail/…`) and creates **`Triage/*.stub.md`** stubs plus one **`ea-mail-ingress`** Kanban task per actionable message. Your job on ingress is **filing** — match or create `Projects/<slug>/`, update docs, project track via `mail_*` MCP. **Scheduling** is a **child workflow** after filing (`ea-scheduling` + `scheduling_*` MCP on board `ea-scheduling`) — ingest no longer opens `ea-sched-ingress`.

Layout: `docs/executive-assistant.md` · `docs/executive-assistant.md#gtd-workspace` · `${JOSHU_FILES_ROOT}/FILING.md`

## Triggers (what starts work)

**Ingest (deterministic, every 10m):** Joshu mirrors, dedupes, classifies (`noise` / `info` / `track`), writes **Triage stub** + **`ea-mail-ingress`** task for actionable mail. Cron jobs send **summaries only** — they do not batch-drain Triage.

| Trigger | Source | This skill |
|---------|--------|------------|
| **Mail ingress Kanban** | `ea-mail-ingress` task (`kind: mail_ingress`) | **MAIL INGRESS mode** — file to `Projects/<slug>/`, `mail_*` track, optional scheduling child |
| **Triage stub** | Thin stub (`source_path`, headers only) | Same filing loop; policy flags on ingress Kanban task |
| **Morning / evening / weekly cron** | Hermes jobs with `skills: ["ea-playbook"]` | Summary email + journals — **not** batch triage drain |
| **On demand** | jChat user message | Rollup, situation report, or in-chat capture |
| **Multi-step / HITL project** | User asks for parallel steps, approvals, follow-ups | **Defer** to **`ea-project-kanban`** — **not** mail ingress |

More triggers will be added later as separate cron jobs or skills; do not invent them until documented here.

## Core loop: one Triage stub → one project

For **each** stub in the active snapshot:

1. Read stub frontmatter (`source_path`, `subject`, `from`) — **do not** copy the email body into the stub.
2. Read the thread at `${JOSHU_FILES_ROOT}/<source_path>`.
3. **Choose or create** `Projects/<slug>/` (existing project from `about.md` title/outcome, or `Projects/other/`, or new folder from `_template/`).
4. **Update project docs** (filesystem writes only):
   - `about.md` — urgency/importance, deadline, `status` if changing lifecycle, `owner_decisions_pending` if principal must decide
   - `todo.md` — add/refresh rows (**Waiting on** / **Blocker** columns); **link** to thread via `source_path` (see Link discipline)
   - `journal_YYYY-MM-DD.md` — append what you did; cite `joshu://<source_path>` or relative path — **do not paste** mail body
5. Mark stub `state: done` (delete or move to `Triage/_done/`).

That is the default outcome of triage: **mail pointer → project truth**, not “leave mail in a queue.”

## Link discipline (required)

**One fact, one home — link everywhere else.** Mail bodies live in `connectors/mail/…` only.

When filing from a stub or capture item:

```markdown
→ [Re: subject](joshu://connectors/mail/gmail/.../threads/<id>.md)
```

Use the stub's `source_path` (relative to `${JOSHU_FILES_ROOT}`). Relative markdown links also work and gbrain indexes them on sync.

| Write in | Link to |
|----------|---------|
| `todo.md` row / note | Mail thread, calendar event, or `Projects/<slug>/about.md` |
| `journal_*.md` | Same + what changed (status, Waiting on) |
| `Planning/capture-*.md` | Raw capture only — link when moved to project |

Do **not** duplicate thread bodies, Kanban card bodies, or chat transcripts into project files. Hindsight owns chat recall; connectors own mail.

## Mail ingress (ea-mail-ingress)

When your Kanban task body includes `kind: mail_ingress`:

1. **`skill_view('ea-playbook')`** — MAIL INGRESS mode (required; do not load `ea-project-kanban`).
2. Read the ingress task body for **`agent_authorized`**, **`scheduling_eligible`**, **`allowed_actions`**, and mail mirror at `source_path`. Triage stub is a pointer only — no classifier hints.
3. **File:** match existing project (thread, gbrain, `Projects/`) or create minimal `about.md` / `todo.md` / `journal_*` from `_template/` when new.
4. **`mail_list_track_tasks`** on `project-<slug>` → **match** → `mail_handoff_track_task` | **no match** → `mail_create_track_task` (**blocked**).
5. **Scheduling decision** — only when **`scheduling_eligible: true`** (see [Scheduling decision gate](#scheduling-decision-gate-mail-ingress-step-5)). If **`agent_authorized: false`** or **`allowed_actions: file`** — **stop after step 4**; no scheduling child, no outbound mail, no calendar probes.
6. Mark stub `state: done` → `Triage/_done/`.
7. `kanban_complete` the ingress card.

### MCP / Joshu API failures

If **`connectors_status`**, **`mail_*`**, or **`scheduling_*`** MCP calls fail (HTML 404, "Joshu API unreachable", or "MCP server unreachable"):

1. **`kanban_block(reason="connectors-mcp-down: …")`** — do **not** `kanban_complete`.
2. You may still file project docs from the mail mirror (`read_file` on `source_path`) if not done yet.
3. Do **not** mark the triage stub `done` if a required **`mail_*` track** or **`scheduling_create_meeting_task`** was not created.
4. Do **not** work around MCP with `terminal` / `nylas email send` / `curl` — those paths are blocked.

**Exception — action guard on send:** If **`nylas_send_message`** fails with **timeout** (~120s) while action guard is enabled, that is **owner approval pending**, not MCP down. On **`ea-mail-ingress`**, you normally do not send mail yourself — if you did attempt send, **`kanban_block(reason="awaiting owner approval")`**. On **`project-*`** boards, **never** send scheduling mail (see below).

The dispatcher will retry after Joshu/MCP recovers (supervisor + gateway reload).

Use **`mail_*` MCP** for project tracks. Use **`scheduling_*` MCP** for meeting tasks on `ea-scheduling`.

**Do not** load `ea-project-kanban` on mail ingress — that skill is for user-initiated multi-step / HITL campaigns only.

### Project boards — no scheduling sends

Workers on **`project-<slug>`** boards (including **`kind: mail_track`** cards and auto-decomposed children) **must not**:

- Call **`nylas_send_message`** to negotiate meetings or offer calendar slots
- Call **`google_calendar_find_free_slots`** for counterparty scheduling
- Create parallel "Schedule … call" work that duplicates **`ea-scheduling`**

**Scheduling execution lives only on board `ea-scheduling`.** Project workers file docs, update `todo.md` / journal, and **`mail_*` track** state. If scheduling is needed, ingress should already have spawned **`scheduling_create_meeting_task`** (or owner review path C). If you discover missing scheduling on a project card, **`scheduling_list_meeting_tasks`** by `thread_id` — hand off or comment on the existing meeting task; do **not** send from the project board.

If a project card title looks like scheduling but **`ea-scheduling`** already has an open/blocked meeting for that thread → **`kanban_complete`** with metadata `duplicate_of: <meeting task_id>` and a comment — do not compete with the meeting worker.

### Scheduling decision gate (MAIL INGRESS step 5)

`scheduling_eligible: true` means you **may** schedule — not that you **must**. Read the thread, then pick **one** path:

| Path | When | Actions |
|------|------|---------|
| **A — Proceed** | Clear **new** scheduling ask; counterparty expects times; no booking on calendar yet; you are confident | **`scheduling_list_meeting_tasks`** by `thread_id` from ingress body → match → **`scheduling_handoff_meeting_task`**; else **`scheduling_create_meeting_task`** with **`threadId`** + **`provider`** (if Joshu returns `existing_thread`, handoff to that task) |
| **B — Closed (file only)** | Confirmation / "you're all set" / owner booked via Calendly / matching event already on owner Google Calendar | File + track; **no** scheduling child, **no** `find_free_slots`, **no** mail |
| **C — HITL defer (owner review)** | **Any doubt** — see triggers below | File + [owner-review notes](#hitl-defer-owner-review-notes); **no** scheduling child, **no** calendar negotiation, **no** mail |

**Prefer B or C over A** when the latest message is status-only on a thread where scheduling already happened.

#### HITL defer triggers (path C)

Use path **C** when **any** of these apply (even if `scheduling_eligible: true`):

- Latest mail looks like a **confirmation** but calendar check is inconclusive (no obvious event title, wrong week, multiple candidates)
- Thread shows owner **already booked** (Calendly, "I booked…", counterparty confirmed) — you are filing the confirmation, not re-opening negotiation
- **Sensitive / high-stakes** thread where a duplicate outreach would be embarrassing (recruiting, investors, partners)
- Ambiguous whether the companion should **negotiate again** vs update project status only
- You would need **`find_free_slots`** or **`nylas_send_message`** but are not confident it is the right next move
- **`about.md`** already notes a booked meeting for this thread and nothing in the latest mail asks for new times

**When in doubt, choose C.** Morning review and jChat are where the owner clears scheduling judgment calls — not autonomous mail ingress.

#### HITL defer — owner-review notes

When path **C**:

1. **`about.md`** — set `owner_decisions_pending: true` if scheduling judgment is open.
2. **`todo.md`** — add or update a row:
   - **Task:** `Review scheduling — <thread subject or counterparty>` (link thread)
   - **Owner:** the owner (not `agent`)
   - **Waiting on:** owner review at morning check-in / jChat
   - **Blocker:** optional one-line reason (e.g. "booking may already exist")
3. **`journal_YYYY-MM-DD.md`** — section **`## Scheduling — owner review needed`** with:
   - What the latest mail said (one sentence)
   - Why you did **not** spawn `ea-scheduling` or send mail
   - What you checked (e.g. calendar list) and what was unclear
   - Suggested owner actions (confirm booked / ask the companion to schedule / ignore)
4. **`kanban_complete`** metadata: `"scheduling_path": "owner_review"`, `"scheduling_deferred": true`

Do **not** call `google_calendar_find_free_slots` on path C — at most one targeted `google_calendar_list_events` for the relevant date range if you need to mention what you saw in the journal.

#### Confirmation / already-booked (path B)

Scheduling **confirmations** (owner or counterparty: "booked", "confirmed", "you're all set", "see you Monday") are **not** new scheduling requests.

1. Read the latest 1–2 messages (grep + offset on long threads).
2. **`google_calendar_list_events`** for the cited date or next ~7 days — look for a matching event (title/participant/time). **Do not** call `find_free_slots` once a matching event exists.
3. File project docs; journal that scheduling is **closed**; complete ingress. **No** `scheduling_create_meeting_task`.

> **Pitfall — stale Nylas scheduling confirmations**: A stub where the owner confirms a prior the companion-initiated thread ("I can do that time" / "Let's put it on the calendar") is path **B**, not **A**. If calendar match is unclear, use path **C** instead of guessing.

## Triage drain (legacy — cron no longer batch-drains)

Morning/evening crons now send **summary emails only**. Ingest routes mail at arrival. Use this section for **on-demand** stub processing or recovery when classifier was disabled.

Avoid race with 10m ingest:

1. List `Triage/*.stub.md` where `state: new`
2. Write `Triage/_snapshots/<ISO>.json` (paths only)
3. **Read all thread bodies in bulk** — with 10+ stubs, use `execute_code` or equivalent to batch-read all stubs and their source thread files in a single pass. This avoids N sequential `read_file` calls and surfaces the full picture (duplicates, related threads, patterns) before you start classifying. The snapshot + batch-read together take seconds even for 20+ stubs.
4. Run the **core loop** for every path in the snapshot only
5. New stubs arriving during the run wait for the next cron

Skip stubs already `done`.

**Scheduling (after filing, not at ingest):** Do not route stubs to `ea-sched-ingress` at triage time. When mail content is scheduling-related, complete project filing first, then run the [scheduling decision gate](#scheduling-decision-gate-mail-ingress-step-5) (paths A/B/C). Standalone cold scheduling → file under **`Projects/other/`** then path **A** only when clearly a new ask.

**Scheduling inside a project thread:** When the meeting is the next action for an already-filed project (investor reply, partner thread, waitlist onboarding), keep it on that project's slug — update `todo.md` **Waiting on**, then run the scheduling child on `ea-scheduling`. See `references/investor-response-classification.md`.

When promoting from `Projects/other/`, move scheduling meeting context with the project if you later create a dedicated slug.

## Classification guide

Not all stubs are equal. Classify each one to pick the right project and treatment.

### Owner self-sent notes (owner's note-to-self cadence)

the owner often sends fragmentary notes to his own `owner work email` address — reminders, product ideas, isolated to-dos, and project-scoping thoughts. These are different from all other inbound mail:

| Signal | What it is | Treatment |
|--------|-----------|-----------|
| Sender = owner, subject starts with "Another note", "Another idea", "Top things to sort" | Scratchpad / project idea | Categorize → file into the right `Projects/<slug>/` todo + about |
| Sender = owner, no external context, single action ("Pickup medicine", "Haircut at 1pm") | One-off reminder | File into `personal-appointments-health` or calendar — mark done |
| Sender = owner, contains multi-person action items ("Next steps" email to John) | Project rollout thread | Create or update existing project (e.g. `joshu-product-development`) |
| Sender = owner, subject is blank or obvious self-note | Catch-all | Read body, triage by content — don't skip just because there's no subject |

**Technique**: These notes are ingested into gbrain via the mail connector, so before raw Gmail searching, run a gbrain query with terms like `"note to file" OR "idea to jot down" OR "top things to sort" OR from:owner work email` over recent date range. gbrain's compiled truths often already contain the categorized version. Fall back to Gmail search only when gbrain misses something.

### Dan-as-sender: replies to existing threads (not notes)

owner's Gmail produces SENT-labeled stubs when he replies in an ongoing thread — this is different from a note-to-self. Similarly, Nylas can produce stubs where the owner is the sender replying to an ongoing scheduling or project thread (the Nylas mirror catches owner's outgoing reply to an external party). The stub is a **signal that the thread moved**, not a new item to process:

| Signal | What it is | Treatment |
|--------|-----------|-----------|
| Sender = Dan, thread has 3+ prior messages, label = SENT (Gmail) OR from=Dan, thread has the companion+external messages (Nylas) | the owner replied in an existing conversation | Read the thread body to see what the owner said. Update the project's tracking for that thread (note the reply in the journal, update Waiting on status). Do NOT create a new project or todo row — the thread is already tracked. |
| Sender = Dan, thread has external participants, labels/location indicate it's a reply | the owner sent a follow-up to a contact | Same as above. The reply is part of an existing workflow, not a new initiative. |
| Sender = Dan, thread body shows the owner asked someone a question or made a request | the owner pushed the thread forward | Update the todo row's Waiting on column with the new status (now waiting on the other party). |

**Why this matters**: These stubs are mirror artifacts of owner's outbound activity, not inbound requests. Classifying them as new work leads to duplicate todo rows and stale project tracking. The correct response is "the owner did something in this thread — update the thread's status in the project, then close the stub."

**Pitfall — long threads**: Some threads accumulate the full email history (especially older threads forwarded or replied to repeatedly). A thread can be 1000-3000+ lines. When reading a thread where the owner is the sender and the thread has 10+ messages, use `grep` to find the latest message date first, then `read_file` with offset to get only the most recent 1-2 messages. You don't need to read the full history — the stub was created because of the latest message.

**Classification bucket for new notes**:
1. **Larger projects/strategic** — 2+ related threads, multi-step work, product/infra decisions → `joshu-product-development` (or analogous named project)
2. **Isolated to-dos** — single action, time-bound → `personal-appointments-health` or directly onto calendar
3. **Scheduling** — meeting setup with specific people → `ea-scheduling`
4. **One-off noise** — forwarded marketing, automated alerts → `other` with `info` status

After categorizing, update the project's `todo.md` (add/refresh task rows + Waiting on columns) and `about.md` (add to Active threads list). Mark owner-sent stubs as done when processed.

### In-chat idea capture (the owner riffing in conversation)

the owner often uses jChat (or voice) to dump ideas, follow-ups, and product thoughts in real-time — the conversational equivalent of "Another note to file." These are **not mail stubs**.

**Pattern signals:**
- Owner says "add to my list of follow-ups" or "jot this down"
- Stream of short messages: "I want to X" / "Also Y" / "And I need Z"
- "Riffing with you" or "while I think of it"
- Items added during another activity (pre-jog, between meetings)

**Capture workflow:**

1. **Append to today's capture file first** — `${JOSHU_FILES_ROOT}/Planning/capture-YYYY-MM-DD.md` (create from `Planning/` template if missing). Sections: **Tasks**, **Ideas**. One bullet per distinct item.
2. **Clarify** — same classification buckets as mail (project, isolated todo, scheduling, info-only). If clearly belongs to one project, also patch `Projects/<slug>/todo.md` + journal with **links** (no stub to archive).
3. **Read before patch** — always read target files before updating so you don't clobber rows.
4. **Batch** — 3+ items in quick succession: one read, one capture append, then file to projects.

**Parallel to email:** Mail uses Triage stubs → filing. Chat uses **`Planning/capture-*`** → filing. Journal cites what was captured; do not paste full chat into markdown (Hindsight holds conversation context).

**Post-riff:** If the owner signals the riff is done ("prioritize later", "tomorrow"), acknowledge what landed in capture/projects. Do not time-block inline unless asked — defer to **`ea-time-block`**.

### Deduplication across mailboxes (owner Gmail + agent Nylas)

The same message often arrives as **both** a Gmail stub (from owner's Gmail — the owner sent to himself) and a Nylas stub (from `agent mailbox` inbox — the owner sent to the agent). Match on:
- **Subject + received_at timestamp** (within seconds), or
- **identical thread body content**

When you detect a duplicate pair:
1. Process **one** (typically the Gmail copy since it carries `from:` the external party or the customer; prefer the agent Nylas copy when the Gmail copy is a "sent to self" forward and the Nylas copy has the richer recipient chain).
2. Move **both** stubs to `_done/` together.
3. Note the dedup in the journal entry for the project.

Common patterns:
- the owner sends an email to himself (Gmail SENT) AND also sends to agent mailbox via Nylas → same content, process once
- the owner forwards an external message to himself AND the companion receives it via Nylas → process from Nylas copy (has full context)

### Bulk / mass-send deduplication (newsletters, investor updates, broadcasts)

When the owner sends the **same content** to multiple recipients (investor update, launch announcement, mass blast), expect **N stubs for N recipients** — both Gmail self-copies and Nylas sends. These are NOT truly independent threads.

**Detection signals:**
- Same subject line across 3+ stubs arriving within minutes
- Nearly identical thread body content (same newsletter text)
- Gmail copies labeled SENT (the owner to self) + Nylas copies (to specific recipients)

**Treatment:**
1. Read **one** representative thread body (typically the Gmail sent-to-self copy or the first Nylas copy — they're identical).
2. Classify and file to the project **once**.
3. Move **all** matching stubs to `_done/` together.
4. Note the mass-send in the journal entry (who it went to, any auto-replies or bounces received), not N separate entries.

**Bounces and auto-replies from broadcast recipients** (e.g. Carol's OOO auto-reply, Mendel's pitch-form auto-response, Mail Delivery Failed notices) are **related notifications** — file them under the same project as the parent broadcast, not as standalone items. Note them in the parent thread's journal entry rather than creating separate entries for each.

**Investor / broadcast response classification**: When responses come back from a bulk send, each reply needs its own triage within the same parent project. See `references/investor-response-classification.md` for the full classification table (info vs scheduling vs referral vs OOO).

### Same-sender batch incoming notifications

The reverse pattern of broadcasts: **one person sends multiple identical-type notifications** in quick succession (e.g. 6 OneDrive notebook shares, a burst of Google Doc invites, multiple calendar invitations). These are not independent threads — they're a single batch.

**Detection signals:**
- Same sender across 3+ stubs arriving within minutes
- Same notification type (file share, doc invite, calendar invite)
- Nearly identical thread body content (same platform template)

**Treatment:**
1. Read **one** representative thread body (they're identical platform templates).
2. Group them under the parent project's journal entry as a single line: "Sender shared N files (list names)".
3. Do NOT create separate todo rows for each notification — one info row or journal note is sufficient.
4. Move **all** matching stubs to `_done/` together.

See `references/batch-incoming-notifications.md` for worked examples.

### Re-created stubs from the 10-minute ingest cycle

The deterministic 10-minute ingest re-creates stubs for any message still marked `unread: true` in the connector mirror — even if that message was already processed and the stub was already moved to `Triage/_done/` in a prior session. This is not a new item; it is an ingest artifact.

**Detection signals:**
- A stub with the same filename (or same `thread_id` value in frontmatter) already exists in `Triage/_done/`
- Stub body and source thread are identical to a previously processed message
- Most common with Nylas stubs where the agent's message remains unread (Nylas mirror doesn't mark read on session processing)

**Treatment:**
1. Check `Triage/_done/` for a matching stub filename or `thread_id` match before reading the full thread body.
2. If the stub is a re-creation:
   - Move it to `Triage/_done/` **without** reading or re-processing the thread body.
   - Add a brief journal note: "nylas: [subject] — duplicate/re-creation from ingest" and a one-line status reminder.
   - Do NOT create new todo rows, update project docs, or re-fire scheduling handoffs.
3. The project's documents and scheduling tasks were already updated when the original was first processed.

**Why this matters**: Re-processing a re-created stub creates duplicate journal entries, stale status updates, and wasted LLM calls. The 10-minute poll is stateless — it doesn't know what a session already processed. You are the source of truth for "was this handled." Check `_done/` first when a stub's topic looks familiar. This is especially common in cron sessions that run sequentially (e.g. 2 cron jobs hitting the same unread message within minutes).

### System / automated notifications

Transactional emails need a lighter touch than human correspondence:

| Type | Classification | todo.md treatment |
|------|---------------|-------------------|
| Security alerts (Chase, Google, etc.) | `other` or relevant project | `info` status — note and close unless action required |
| Subscription changes (Roku, SaaS) | `other` or `personal-appointments-health` | `info` status — streaming deadline or effective date |
| Family/G Suite alerts (parental controls) | `family-school-logistics` | `info` status unless decision needed |
| System signups (Joshu Admin, app confirmations) | `other` | `info` — one-liner, no task |
| Marketing / vendor updates (Formspree, generic) | `other` | `reading` status — low priority, no action |

Default: automated → `other` with `info` status. Escalate to a named project only if the notification contains a deadline, a required action, or financial exposure.

**Related notifications (bounces, auto-replies)**: When a notification is a bounce, auto-reply, or delivery failure triggered by a thread you're processing, file it under the **same project as the parent thread**, not as a standalone `other` item. Examples:
- Mail Delivery Failed notice for a reply to mendel@awf.vc → file under same project as the Aeon Investors thread that triggered it.
- "Out of office" auto-reply to a sent message → note in the parent thread's journal entry, don't create a separate triage item.
- This prevents orphaned notifications from accumulating in `other` when they're clearly derivative.

### When to create a new project vs. file under `other`

New project threshold (any of these):
- **2+ related threads** about the same topic (e.g. 4 Joshu product threads)
- **Thread contains action items** (asks, assignments, decisions needed), not just info
- **Topic is core to owner's business** (product, revenue, hiring, deployment)
- **Thread starts a multi-step workflow** (rollout plan, setup meetings for team members)
- **Partnership or business development thread** with a named organization — even a single thread about a partnership opportunity (like U of Digital for AI education workshops, or a distribution partnership) warrants a named project or at least a prominent entry in an existing project. Partnership threads involve negotiation, deliverables, and long timelines — don't bury them in `other`.

File to `Projects/other/` when:
- Single thread, info-only
- Automated notification with no action required
- Marketing / vendor update
- One-off networking request without follow-up structure

When you create a project from multiple threads, aggregate them all into a single `about.md` outcome statement and `todo.md` task table. Each thread gets a journal entry.

### Project scope hygiene: strategic thinking vs. operational execution

Owner preference: **strategic product thinking** (ideas, concepts, design direction, research) gets its own clean project. **Operational execution** (scheduling meetings, processing investor replies, sending drips, deployment rollout, partner onboarding) gets broken out into separate projects.

**The rule:** If a project contains both "thinking about the product" rows AND "follow up with person X" / "schedule Y" / "send Z email" rows, it's overstuffed. Split along the strategy vs. execution boundary.

| Stays in product-ideas project | Moves to its own project |
|---|---|
| Communication model design (Telegram, Evernote integration) | Investor follow-ups (Mara, Thierry, investor list processing) |
| Skills/tools ecosystem planning | Deployment setup (Becca onboarding, John pipeline) |
| Desktop character / chat bubbles concept | Partner onboarding / signup follow-ups |
| Product research (Granola, integrations) | Scheduling coordination |
| Blog post / demo strategy | Waitlist drip campaigns (already in `joshu-waitlist-drip`) |
| Logging/update system requirements | Crons documentation / infra ops |

**When to split:** Review project boundaries when a single project's todo.md has 8+ rows or covers 3+ distinct categories of work (e.g. product design + investor relations + deployment). Each category likely warrants its own `about.md` and `todo.md`.

**What NOT to split:** Don't create a new project for a single thread or a single follow-up with no structure yet. The threshold is "accumulated enough mass to justify its own outcome statement." A single investor reply stays in the parent project's journal. Five investor threads with two active scheduling negotiations warrant their own `investor-relations` project.

**Reference the parent project:** When splitting operational work from a product-ideas project, reference the parent in the new project's `about.md` so the relationship is traceable. E.g. `joshu-investor-relations/about.md` can note "Spun off from joshu-product-development after the [Aeon Investors] newsletter generated multiple active follow-ups."

**Boundaries are fluid:** A project that starts as a single thread can grow into its own project as volume accumulates. Review during weekly EA hygiene. The `_archive/` folder exists for this — don't hoard stale projects.

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
| **Specific event details** | `GOOGLECALENDAR_EVENTS_GET` with event_id | Who a meeting is with (attendees), description |

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

### Resolved-by-owner investor replies

Investor broadcast replies where the owner already handled the reply himself (asked a question, made a closing remark) and the investor replied back with a natural resolution do NOT need a new todo row. Note them in the project journal under a single "Investor newsletter follow-up" heading and close the stub. The existing `references/investor-response-classification.md` covers the classification table — add "the owner already replied" as a terminal state: file and note only.

## Hermes skill-backed crons

Welcome installs jobs in `~/.hermes/cron/jobs.json` with:

- `skills: ["ea-playbook"]` — Hermes loads **this** `SKILL.md` for the run ([skill-backed cron jobs](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron#skill-backed-cron-jobs))
- `deliver: local` — run in the gateway workspace

| Job name | Typical work after skill loads |
|----------|--------------------------------|
| `EA morning` | **`skill_view('ea-morning-review')`** — prep `Planning/daily-review-*.md`, pointer email; interactive review when owner opens jChat |
| `EA evening` | **`skill_view('ea-shutdown')`** — draft shutdown section, journals + evening pointer email |
| `EA weekly` | `Projects/other` hygiene, **`status: someday`** scan, archive `done`, chase Waiting on / Blocker, clarify stale `Planning/capture-*` |

Cron **prompt** text is a short headline; **this skill** is the procedure. Follow the core loop first when the prompt mentions triage.

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

## Every run — read first

1. `FILING.md`
2. `.joshu/nylas/profile.json` — if missing or empty, call `nylas_get_profile()` to fetch live data from the Nylas API instead
3. Active `Projects/*/about.md` + `todo.md` (`status: active`, urgency 1–2)
4. `Planning/capture-YYYY-MM-DD.md` (today) if capture or time-block context
5. `Planning/daily-review-YYYY-MM-DD.md` (today) if morning/evening handoff context
6. Pending `Triage/*.stub.md` (`state: new`)

No gbrain write tools. No connector sync (Joshu polls automatically).

## Project files

| File | Role |
|------|------|
| `about.md` | Outcome, urgency/importance (1=highest), **`status`** (`active` \| `someday` \| `reference` \| `done`), optional `someday_review`, `owner_decisions_pending`; optional `kanban_board` / `kanban_root_task` when **`ea-project-kanban`** runs |
| `todo.md` | Task table — **Waiting on** / **Blocker**; include **source links** when filed from mail (`joshu://` + `source_path`) |
| `Planning/capture-*.md` | Intraday inbox before filing (chat/voice) — not for mail stubs |
| `Planning/daily-review-*.md` | Day handoff — checkboxes, carryover, shutdown (see **`ea-morning-review`**, **`ea-shutdown`**) |
| `Planning/time-block-*.excalidraw` | One linked diagram per day — visual plan; do not edit past days in place |
| `scheduling/*.md` | **Legacy** — replaced by Kanban `ea-scheduling`; may remain for old cases |
| `journal_YYYY-MM-DD.md` | Append-only daily log with links, not pasted bodies |

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
