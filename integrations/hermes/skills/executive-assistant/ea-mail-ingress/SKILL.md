---
name: ea-mail-ingress
description: File one ingress email to a project and mail track.
metadata:
  hermes:
    category: executive-assistant
    version: "1.0.1"
  joshu:
    split_from: ea-playbook
---

# EA mail ingress — file one email

Joshu mirrors mail every **10 minutes** and creates one **`ea-mail-ingress`** Kanban task per actionable message. Joshu preloads this skill and **`ea-mail-track`** on each mail ingress task. `ea-mail-track` has the filing rules that this skill links to: [Link discipline](#link-discipline-required), [Mail attachments](#mail-attachments), [Canonical project matching](#canonical-project-matching), [Project reconcile](#project-reconcile), [Project boards — no scheduling sends](#project-boards--no-scheduling-sends), and [MCP / Joshu API failures](#mcp--joshu-api-failures).

Summary email, crons, situation report, in-chat capture, and escalation are in skill `ea-playbook`. Load it with `skill_view('ea-playbook')` only when the task needs one of them.

## Mail ingress (ea-mail-ingress)

When your Kanban task body includes `kind: mail_ingress`, run this **short-circuit** — no browse-until-found loops.

### Required order (do not reorder)

1. **Skills are preloaded** — `ea-mail-ingress` (this skill) and `ea-mail-track` are already in your prompt. Do **not** call `skill_view` for them, and do **not** load `ea-project-kanban`.
2. **Read ingress body fields:** `agent_authorized`, `owner_on_thread`, `scheduling_eligible`, `owner_reply_eligible`, `allowed_actions`, `source_path`, `thread_id`, `message_id`, `account_key`, `provider`, `coordination_scope_id`. Triage stub is a pointer only. When **`owner_on_thread: false`**, the companion was pulled into a thread without the owner on prior messages — visibility risk; external replies must CC owner (API enforced) and include brief counterparty context.
3. **Coordination preflight (2026-09):** Before spawning scheduling or owner-reply children, call **`coordination_list_active`** (or **`coordination_scope_resolve`**) with `threadId` + `sourcePath`. If an open **`meeting_negotiation`** exists on scope → **handoff only** (`scheduling_handoff_meeting_task`); never **`scheduling_create_meeting_task`**. If open **`owner_deliverable`** exists → **`owner_reply_handoff_task`** only. Joshu API mutexes cross-board spawns; treat `action: existing_coordination` as handoff to returned `task_id`.
3. **`read_file` the mail mirror** at `${JOSHU_FILES_ROOT}/<source_path>` (once). Then file:
   - Match existing `Projects/<slug>/` via [Canonical project matching](#canonical-project-matching) **or** create minimal `about.md` / `todo.md` / `journal_*` from `_template/`.
   - Prefer known slug from gbrain / prior tracks / **`about.md` title+outcome** over inventing new folders.
   - Skip AppleDouble `._*` and other sidecar noise in search results.
4. **Track via Joshu MCP** (args are **flat** — never nest `tool_call`, never use `slug`):
   - `mail_list_track_tasks(projectSlug="<folder-slug>", threadId="<thread_id>")` — folder name only, e.g. `joshu-product-development` (board is `project-<slug>`). With `threadId`, Joshu returns only the open track that already contains this thread.
   - **One track returned** → that is the match. Hand off to it. Do not search further, and do not write scripts over tool results.
   - **No track returned, but `done_match`** → a done track holds this thread. If this email continues the matter of that track, that is the match: hand off to `done_match.task_id`. Joshu reopens the track and its worker judges the email. If the email starts a new matter, create a new track.
   - **No track and no `done_match`** → call `mail_list_track_tasks(projectSlug="<folder-slug>")` without `threadId`. Joshu returns the compact track list (no full bodies). Match by judgment from `title`, `thread_ids`, and `latest_handoff` (a track can span several threads). Keep this list for step 4b.
   - **Match** → `mail_handoff_track_task(taskId=…, projectSlug=…, sourcePath=…, messageId=…, summary=…)`.
   - **No match** → `mail_create_track_task(…, projectSlug=…, threadId=…, messageId=…, sourcePath=…)` (**blocked**).
4b. **[Project reconcile](#project-reconcile)** on that slug — only when no worker of a track was woken: you created a new track, or `mail_handoff_track_task` returned `evaluation_queued: false`. When the handoff returned `evaluation_queued: true`, skip this step: the worker of the track runs Project reconcile. Use the compact track list (reuse it from step 4 if you have it), complete the tracks this mail supersedes, and set `about.md` `status: done` if nothing is left waiting.
5. **Scheduling decision** — only when **`scheduling_eligible: true`** (see [Scheduling decision gate](#scheduling-decision-gate-mail-ingress-step-5)). If **`agent_authorized: false`** or **`allowed_actions: file`** — **stop after step 4b** (Joshu still wakes the worker of a blocked track after the handoff); no scheduling child, no outbound mail, no calendar probes.
5b. **Owner-reply (path D)** — when **`owner_reply_eligible: true`** (owner mailed **agent Nylas** with a non-meeting ask). After filing: **`owner_reply_list_tasks`** by `thread_id` → match → **`owner_reply_handoff_task`**; else **`owner_reply_create_task`** (pass **`threadId`** + **`provider`** + **`from`**). If Joshu returns `existing_thread`, handoff. **Do not** research or **`nylas_send_message`** on this ingress card — the **`ea-owner-reply`** worker does that. Skip path D when you took scheduling **path A** (meeting worker owns outbound).
5c. **Open realtime goals** — when the card has `open_realtime_goal:` lines (only on an email of the owner): if this email asks for the same thing as one of them (same people, day, and time, or the same request), call **`realtime_goal_close_done_elsewhere`** after steps 5 and 5b with `goalId`, `taskId` (the scheduling or owner-reply task that does the work, else this ingress card), and `note` (one short line for the owner, e.g. "Your email asked for the same meeting, so I'm booking it from there."). Joshu stops that realtime goal and sends the note on its channel. Skip a realtime goal that asks for something else.
6. **Stub done:** open `Triage/gmail-<account_key>-<thread_id>.stub.md` (or `Triage/<provider>-<thread_id>.stub.md` when no account_key) — set `state: done`, move to `Triage/_done/`. Prefer that path; do not recursive-search for stubs.
7. **`kanban_complete`** the ingress card.

Stop when the short-circuit is done. Do **not** spend turns on directory explore, `search_files` fishing for `about.md`, or re-reading the mirror after you already filed.

## Scheduling decision gate (MAIL INGRESS step 5)

`scheduling_eligible: true` means you **may** schedule — not that you **must**. Read the thread, then pick **one** path:

| Path | When | Actions |
|------|------|---------|
| **A — Proceed** | Clear **new** scheduling ask; counterparty expects times; no booking on calendar yet; you are confident | **`scheduling_list_meeting_tasks`** by `thread_id` from ingress body → match → **`scheduling_handoff_meeting_task`**; else **`scheduling_create_meeting_task`** with **`threadId`** + **`provider`** (if Joshu returns `existing_thread`, handoff to that task) |
| **B — Closed (file only)** | Confirmation / "you're all set" / owner booked via Calendly / matching event already on owner Google Calendar | File + track; **no** scheduling child, **no** `find_free_slots`, **no** mail |
| **C — HITL defer (owner review)** | **Any doubt** — see triggers below | File + [owner-review notes](#hitl-defer-owner-review-notes); **no** scheduling child, **no** calendar negotiation, **no** mail |
| **D — Owner reply** | Owner mailed **agent Nylas**; ask/deliverable for the companion; **not** a meeting (or meeting already owned by `ea-scheduling`); **`owner_reply_eligible: true`** | **`owner_reply_list_tasks`** by `thread_id` → **`owner_reply_handoff_task`** or **`owner_reply_create_task`**. **No** research/send on ingress. |

**Prefer B or C over A** when the latest message is status-only on a thread where scheduling already happened.

### HITL defer triggers (path C)

Use path **C** when **any** of these apply (even if `scheduling_eligible: true`):

- Latest mail looks like a **confirmation** but calendar check is inconclusive (no obvious event title, wrong week, multiple candidates)
- Thread shows owner **already booked** (Calendly, "I booked…", counterparty confirmed) — you are filing the confirmation, not re-opening negotiation
- **Sensitive / high-stakes** thread where a duplicate outreach would be embarrassing (recruiting, investors, partners)
- Ambiguous whether the companion should **negotiate again** vs update project status only
- You would need **`find_free_slots`** or **`nylas_send_message`** but are not confident it is the right next move
- **`about.md`** already notes a booked meeting for this thread and nothing in the latest mail asks for new times

**When in doubt, choose C.** Morning review and jChat are where the owner clears scheduling judgment calls — not autonomous mail ingress.

### HITL defer — owner-review notes

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

### Confirmation / already-booked (path B)

Scheduling **confirmations** (owner or counterparty: "booked", "confirmed", "you're all set", "see you Monday") are **not** new scheduling requests.

1. Read the latest 1–2 messages (grep + offset on long threads).
2. **`google_calendar_list_events`** for the cited date or next ~7 days — look for a matching event (title/participant/time). **Do not** call `find_free_slots` once a matching event exists.
3. File project docs; journal that scheduling is **closed**; complete ingress. **No** `scheduling_create_meeting_task`.

> **Pitfall — stale Nylas scheduling confirmations**: A stub where the owner confirms a prior the companion-initiated thread ("I can do that time" / "Let's put it on the calendar") is path **B**, not **A**. If calendar match is unclear, use path **C** instead of guessing.

### Scheduling after filing

**Scheduling (after filing, not at ingest):** Do not route stubs to `ea-sched-ingress` at triage time. When mail content is scheduling-related, complete project filing first, then run the [scheduling decision gate](#scheduling-decision-gate-mail-ingress-step-5) (paths A/B/C). Standalone cold scheduling → file under **`Projects/other/`** then path **A** only when clearly a new ask.

**Scheduling inside a project thread:** When the meeting is the next action for an already-filed project (partner thread, waitlist onboarding, follow-up call), keep it on that project's slug — update `todo.md` **Waiting on**, then run the scheduling child on `ea-scheduling`.

When promoting from `Projects/other/`, move scheduling meeting context with the project if you later create a dedicated slug.

## Core loop: one Triage stub → one project

For **each** stub in the active snapshot:

1. Read stub frontmatter (`source_path`, `subject`, `from`) — **do not** copy the email body into the stub.
2. Read the thread at `${JOSHU_FILES_ROOT}/<source_path>`. When the work needs a file that the email has as an attachment, fetch it — see [Mail attachments](#mail-attachments).
3. **Choose or create** `Projects/<slug>/` — see [Canonical project matching](#canonical-project-matching).
4. **Update project docs** (filesystem writes only):
   - `about.md` — urgency/importance, deadline, `status` if changing lifecycle, `owner_decisions_pending` if principal must decide
   - `todo.md` — add/refresh rows (**Waiting on** / **Blocker** columns); **link** to thread via `source_path` (see Link discipline)
   - `journal_YYYY-MM-DD.md` — append what you did; cite `joshu://<source_path>` or relative path — **do not paste** mail body
5. Mark stub `state: done` (delete or move to `Triage/_done/`).

That is the default outcome of triage: **mail pointer → project truth**, not “leave mail in a queue.”

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

An owner reply from owner Gmail (label SENT) creates no stub. Joshu mirrors the thread and hands off the reply to each open track of the thread (see [After a handoff to a track](#after-a-handoff-to-a-track)). Older SENT-labeled stubs can still exist. Nylas can produce stubs where the owner is the sender replying to an ongoing scheduling or project thread (the Nylas mirror catches owner's outgoing reply to an external party). The stub is a **signal that the thread moved**, not a new item to process:

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
3b. **Owner asked the companion** (agent Nylas, non-meeting) → `ea-owner-reply` after filing
4. **One-off noise** — forwarded marketing, automated alerts → `other` with `info` status

After categorizing, update the project's `todo.md` (add/refresh task rows + Waiting on columns) and `about.md` (add to Active threads list). Mark owner-sent stubs as done when processed.

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

**Bounces and auto-replies from broadcast recipients** (e.g. Carol's OOO auto-reply, an investor's pitch-form auto-response, Mail Delivery Failed notices) are **related notifications** — file them under the same project as the parent broadcast, not as standalone items. Note them in the parent thread's journal entry rather than creating separate entries for each.

**Broadcast / bulk-send replies:** When responses come back from a bulk send, file each reply on the **same parent project**. Then run [Project reconcile](#project-reconcile) — conversational closure or “nothing left to do” completes waiting tracks; a real ask (schedule, follow-up, referral) stays open. Do not invent a per-category table.

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
- Mail Delivery Failed notice for a reply to an investor (`investor@fund.example`) → file under the same project as the investor outreach thread that triggered it.
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
