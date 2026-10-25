# Realtime goals — theory of operation

High-level mental model for how Joshu routes owner messages on SMS, voice,
Slack, Telegram, jChat, and embedded app chat when some work belongs in
**background Kanban** and some belongs in a **synchronous Hermes turn**.

Implementation detail, config, and verification live in
[`realtime-goals.md`](../realtime-goals.md).

## The core question

Every owner message on a realtime surface asks one routing question:

> **Should I handle this now in chat, or queue it as durable background work?**

- **Handle now** — Hermes answers in one turn (seconds to ~one minute): lookup,
  short reply, quick tool use, casual conversation.
- **Queue** — work is likely multi-step, multi-site, or retry-heavy; the owner
  gets an immediate ack on the same channel, keeps talking, and receives
  blocked questions and completion on that channel later.

Mail is inherently async and uses a different ingress. Public Share Chat is
excluded. jChat and embedded AG-UI are **sync-only**: the owner is already at a
desktop and can wait on the stream, so those surfaces never auto-queue through
the broker (they still maintain a session thread for consistency).

## Trunk + active branch (primary mental model)

| Concept | What it is |
| --- | --- |
| **Trunk** | Stable `sessionKey` + bounded session thread (`threads.json`) |
| **Branch** | One realtime goal record + optional Kanban task (the branch worker) |
| **Active branch** | `SessionThread.activeGoalId` — at most one open branch per trunk |

The owner experiences one SMS (or Slack/voice) conversation. Long jobs are
**branches** off that trunk. Follow-ups on the same job (search → pick hotel →
choose rate → checkout handoff) stay on the **same branch** until the job is
truly finished or cancelled.

The active pointer is a **routing hint only**. Goal status remains authoritative
for Kanban execution. On mismatch (pointer → missing goal), the pointer is
cleared.

## Two conversation layers (do not confuse them)

| Layer | What it is | Used for |
| --- | --- | --- |
| **Session thread** | Bounded owner↔box transcript (`threads.json`) | Routing: *"Nope"* after *"Anything else?"*, active branch pointer |
| **Hermes session** | Full tool/MCP/skills history on the box | Executing sync chat turns and Kanban workers |

The session thread is **not** a copy of Hermes history. It records only what the
owner and the box said on the channel — inbound SMS, broker acks, delivery
SMS, and Hermes replies on the pass path — so the router can interpret short
follow-ups in context without loading the entire agent transcript.

Hermes keeps its own session for sync turns. On queue-capable channels, when a
message passes through to Hermes, Joshu injects a **compact broker snapshot**
(active branch, active goals, last few thread turns) as an extra system message
so sync chat does not contradict queued or cancelled state.

## End-to-end flow (queue-capable channels)

```text
Owner message
    │
    ▼
Append owner turn → session thread (trunk)
    │
    ▼
Deterministic bind: activeGoalId set and not greeting/cancel/status?
    │
    ├─ yes ───────────────► Continue branch (update / answer blocked /
    │                       clarifying→queued / reopen recent done)
    │
    └─ no ──► Slim LLM router (unbound only)
                │
                ├─ pass ──────────► Hermes sync turn (+ broker snapshot)
                ├─ queue ─────────► New branch + set activeGoalId
                ├─ ack / cancel / status ─► Box reply (deterministic shortcuts)
                └─ (errors) ──────► fail open → pass
```

Slack and Telegram enter through the Hermes gateway hook, which calls the same
broker `route()` as SMS. Voice `think` calls `POST /api/realtime-goals/route`
before Hermes, with the same structured payload Hermes will see.

## Branch continuation (deterministic)

When an active branch is bound, the LLM router is **not** called.

| Active goal status | Owner message | Action |
| --- | --- | --- |
| `clarifying` | substantive answer | merge → **`queued`** + `releaseAt` |
| `blocked` | answer / choice | append `Owner answer` (question + reply) → worker continues |
| `blocked` | "did you find it?" | status reply; nothing written to the card |
| `queued` / `running` / `ready` | amendment | merge update → Kanban append |
| `done` (within continuable window) | follow-up on same job | reopen branch → worker continues |

**Continuable window** — same session, goal `done`/`blocked` within 48h (aligned
with thread TTL). Binding uses the active pointer + recency, not domain regexes.

**Greetings only** (`hey`, `hi`, …) pass through to sync Hermes even when a
branch is active.

## Unbound router decisions (plain language)

| Decision | Meaning |
| --- | --- |
| **pass** | Sync Hermes turn on this message |
| **queue** | New long work → new branch → Kanban after commit window |
| **cancel** | Owner stops an active goal (with thread/goal binding; not bare "nope") |
| **status** | Owner asks how a goal is going |
| **ack** | Owner answers the box's last prompt; brief reply, no Hermes, no cancel |

Follow-ups on an in-progress branch are **never** classified here — the broker
binds them deterministically first.

Deterministic shortcuts are minimal (explicit cancel/status phrases, greetings).
SMS carrier keywords (`STOP`, etc.) stay in the SMS gateway, not the router.

## After work is queued

1. **Commit window (default 60s)** — owner can update or cancel before a worker
   starts; updates merge into the goal record.
2. **Release** — one Kanban task on the managed `realtime-goals` board (no
   auto-decompose; cancellation stays atomic). `activeGoalId` is set on the trunk.
3. **Worker** — factory `realtime-goal` skill; **`kanban_block`** for owner
   choice menus; **`kanban_complete`** only for checkout handoff or final outcome.
4. **Delivery** — broker reads Kanban state and pushes blocked/completed/failed
   text back on the **originating channel** and appends to the session thread.
   Only a worker's real `kanban_block` question reaches the owner; a Hermes
   system stall (crash, timeout, exit without complete/block) is restarted
   automatically, then reported plainly. PSTN callbacks are serialized per owner
   and park (one SMS nudge) on voicemail instead of redialing.
   Blocked delivery keeps the active pointer; true completion clears it.
   Completed text is the worker's `kanban_complete` summary after
   [`formatOwnerCompletion`](../../src/realtimeGoals/ownerDelivery.ts) (owner voice,
   line breaks, and a real handoff URL when the summary only says "the handoff
   link"). The worker must not send that message itself.
5. **Owner outbox** — delivery is decided per owner,
   not per goal and channel. Results go where the owner is: offered on a live
   call, texted to a thread they are using, or called back in one batched call.
   A missed callback texts the full result and backs off instead of parking;
   any owner message clears the backoff; "call me back" on any channel calls.
   An SMS counts as heard only when Twilio reports it delivered; an
   undelivered SMS leaves the item open for the next route.
   See [realtime-goals — Owner outbox](../realtime-goals.md#owner-outbox-2026-09-27).

Kanban owns execution truth; Joshu state owns intake, idempotency, thread,
active branch pointer, delivery cursors, the commit window, and (outbox) the
owner's reachability.

## Channel policy (summary)

| Channel | Auto-queue | Session thread | Typical owner experience |
| --- | --- | --- | --- |
| SMS | yes | yes | Text anytime; long jobs ack + text when done |
| PSTN / browser voice | yes | yes | Speak; long jobs ack + callback or screen |
| Slack / Telegram | yes | yes | Chat; long jobs ack in thread + follow-ups |
| jChat | no | yes | Wait on SSE stream; no background queue |
| AG-UI | no | yes | Same as jChat for embedded apps |
| mail | — | — | Async EA ingress (separate system) |

`realtime_goal_defer` (Hermes tool escape hatch) is allowed only on
queue-capable channels when a sync turn discovers mid-flight that work is long.

## Stable identity across messages

Routing and delivery key off **`sessionKey`**, not ephemeral transport ids:

- SMS: `sms:<E.164>` (Hermes SMS session may rotate; goals/thread do not)
- PSTN: `pstn:owner` across `CallSid`s
- Slack/Telegram: Hermes gateway session key (includes thread when applicable)
- jChat / AG-UI: `joshu-hermes-chat:<sessionId>` or app-scoped key

Provider **`messageId`** (Twilio `MessageSid`, etc.) deduplicates retries on
goals and thread appends.

With the owner outbox on, **visibility is owner-scoped**: every channel sees the
owner's goals and unheard results, whichever channel started them. On
2026-09-26 SMS Hermes said a finished phone-started Cancun search did not exist
and that it could not dial out; the session key had hidden it. Session keys
still scope threads, active pointers, and idempotency.

## How long an SMS turn runs

An owner SMS that the broker passes to Hermes runs as one SMS turn in
[`twilioSmsGateway.ts`](../../src/twilioSmsGateway.ts). The SMS gateway runs
one SMS turn at a time per owner, texts an interim "Working on it" after 25
seconds, and texts the reply of the SMS turn when it ends.

The deadline of an SMS turn ([`smsTurnDeadline.ts`](../../src/smsTurnDeadline.ts))
follows progress, not a fixed time:

1. Before the progress check time (`JOSHU_SMS_HERMES_TIMEOUT_MS`, default 5
   minutes), the SMS gateway never stops the SMS turn.
2. After the progress check time, the SMS turn continues while Hermes reported
   progress (a `hermes.tool.progress` event, streamed text, or streamed
   reasoning) within the stall time (`JOSHU_SMS_HERMES_STALL_MS`, default 3
   minutes).
3. No SMS turn runs longer than the limit (`JOSHU_SMS_HERMES_MAX_MS`, default 20
   minutes).

When the deadline stops an SMS turn, Hermes ends the turn because the stream
closes. The SMS gateway then calls `defer()` of the broker with the owner text
and a note that the stopped SMS turn can have done part of the work, and it
texts the owner that a background task continues the request. The worker of
the new branch checks the current state (for example the shared browser) before
it repeats a step. Without a broker, the owner gets an SMS that says Joshu
stopped without finishing.

Design decisions:

- **2026-10-16: follow progress instead of a fixed limit.** A checkout over SMS
  made a tool call every few seconds and was stopped at the fixed limit of 5
  minutes, in the middle of a passenger form, and the owner got only a generic
  error. A fixed limit of 20 minutes was rejected, because a hung SMS turn
  (for example a wedged gateway) would then hold the owner SMS lock for 20
  minutes with no progress. Deferring each SMS turn at 5 minutes was rejected,
  because the worker starts from the request text and loses the context of the
  SMS turn, while the SMS turn was close to the end.
- **2026-10-16: a stopped SMS turn becomes a branch.** The owner asked for the
  work, so the work continues in the background instead of ending with an
  error. Resuming the same Hermes session in a worker was rejected, because a
  Kanban worker runs its own Hermes session; the note in the objective and the
  state of the shared browser give the worker what it needs.

Limits: a new owner SMS that the broker passes to Hermes waits for the running
SMS turn, so a long SMS turn delays the answer to it. Status and cancel of
branches do not wait, because the broker answers them before the SMS lock. A
worker can repeat a step that the stopped SMS turn already did, for example an
email; the note asks the worker to check first, and writes still go through
the action guard.

## Format of owner SMS text

Each SMS to the owner goes through `sendSms` ([`twilioSmsSend.ts`](../../src/twilioSmsSend.ts)), which folds the text to GSM characters (`smsGsmFold`) and splits a long text into SMS parts (`smsGsmParts`). Two kinds of text are prepared before that:

- The reply of an SMS turn, of an SMS continuation, or of a proactive message turn goes through [`smsModelReplyPlaintext`](../../src/smsModelReplyPlaintext.ts). It removes markdown marks (bold, italics, inline code, code fences, headings, and quotes), changes a markdown link to `label: url`, changes each bullet to `- `, and keeps each line break.
- The completion summary of a realtime goal goes through `formatOwnerCompletion` ([`ownerDelivery.ts`](../../src/realtimeGoals/ownerDelivery.ts)), which puts one fact on each line, keeps each line that starts with a URL as it is, and adds a missing handoff link under "Open the live browser here:".

`smsGsmFold` drops the characters that are not GSM before it folds spaces, so a dropped emoji leaves one space. `smsGsmParts` ends each SMS part at a blank line, then at a line break, then at the end of a sentence, then at a space, so a list item stays in one SMS part.

Design decisions:

- **2026-10-21: SMS text has its own markdown cleaner.** Before, `smsModelReplyPlaintext` used the cleaner for text to speech, which folds each line break into a space and changes each blank line to ". ". A list of nine direct messages arrived as one line of 1,596 characters in 3 SMS, with one list item cut across two SMS, and a reply read "approved.. The event page". The cleaner for text to speech also dropped the URL of each markdown link. Changing that cleaner was rejected, because text to speech must fold lines. The cleaner for text to speech had no other caller, so it was removed.
- **2026-10-21: the completion SMS keeps links unchanged.** `layoutOwnerLines` changed the first letter of each line to upper case, so a handoff link on its own line became `Https://`, `formatOwnerCompletion` did not find it, and the owner got the link twice under "Finish and pay here:". Now a line that starts with a URL keeps its case, the check for a missing link ignores case, and the label is neutral, because most browser handoffs are a sign-in or a code. A payment label for payment tasks was rejected, because `formatOwnerCompletion` does not know the kind of the task.

Limits: `sendSms` sends the SMS parts one after the other with no wait, and carriers do not promise the order of separate SMS. An emoji is dropped, not changed to a word.

## Design principles

1. **Trunk + one active branch** — follow-ups bind to the open branch; new
   branches only when unbound and clearly new long work.
2. **Thread for routing, Hermes for doing** — keep layers separate.
3. **Conservative queueing on unbound turns** — uncertain or router-down → pass.
4. **Same-channel UX** — ack, block, and complete where the owner spoke.
5. **Fail open on router errors** — a missed queue beats stranding the owner.
6. **No domain regex tables** — channel-neutral policy only.
7. **Write `state.json` only when its content changes.** The realtime-goal broker ticks every 5 seconds, and `state.json` is on the owner Desktop, where the File Brain watcher and other watchers see each write. Each transaction of `RealtimeGoalStore` keeps the text that it read, and the store skips the write when the new text is the same. This check covers every caller, also a caller that reports a change after it sets a field to the value that the field already had. Before 2026-10-24, `OwnerOutbox.upsertForGoal` did that for each blocked realtime goal whose question was already in the owner outbox, so the realtime-goal broker rewrote the same `state.json` on every tick and File Brain reindexed without a stop. A fix of only that caller was not enough, because many other updates of the owner outbox report a change without a check.

## Where to read next

| Topic | Doc |
| --- | --- |
| State files, idempotency, cancellation, config | [`realtime-goals.md`](../realtime-goals.md) |
| Voice admission before Hermes | [`packages/voice-realtime/`](../../packages/voice-realtime/) |
| SMS and the Twilio number | [`vps-sandbox/twilio-self-host.md`](../vps-sandbox/twilio-self-host.md) |
| jChat SSE path (sync-only) | [`hermes-chat-arozos-app.md`](../hermes-chat-arozos-app.md) |
| Hermes plugin + defer tool | [`.hermes/plugins/joshu-realtime-goals/`](../../.hermes/plugins/joshu-realtime-goals/) · [`hermes-integration.md`](../hermes-integration.md) |
| Code | [`src/realtimeGoals/`](../../src/realtimeGoals/) |
