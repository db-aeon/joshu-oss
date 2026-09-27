# Realtime goals — theory of operation

High-level mental model for how Joshu routes owner messages on SMS, voice,
Slack, Telegram, jChat, and embedded app chat when some work belongs in
**background Kanban** and some belongs in a **synchronous Hermes turn**.

Implementation detail, config, and verification live in
[`realtime-goals.md`](realtime-goals.md).

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
   [`formatOwnerCompletion`](../src/realtimeGoals/ownerDelivery.ts) (owner voice,
   line breaks, and a real handoff URL when the summary only says "the handoff
   link"). The worker must not send that message itself.

Kanban owns execution truth; Joshu state owns intake, idempotency, thread,
active branch pointer, delivery cursors, and the commit window.

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

## Design principles

1. **Trunk + one active branch** — follow-ups bind to the open branch; new
   branches only when unbound and clearly new long work.
2. **Thread for routing, Hermes for doing** — keep layers separate.
3. **Conservative queueing on unbound turns** — uncertain or router-down → pass.
4. **Same-channel UX** — ack, block, and complete where the owner spoke.
5. **Fail open on router errors** — a missed queue beats stranding the owner.
6. **No domain regex tables** — channel-neutral policy only.

## Where to read next

| Topic | Doc |
| --- | --- |
| State files, idempotency, cancellation, config | [`realtime-goals.md`](realtime-goals.md) |
| Voice admission before Hermes | [`vps-sandbox/voice-realtime.md`](vps-sandbox/voice-realtime.md) |
| SMS + A2P | [`vps-sandbox/twilio-self-host.md`](vps-sandbox/twilio-self-host.md) |
| jChat SSE path (sync-only) | [`hermes-chat-arozos-app.md`](hermes-chat-arozos-app.md) |
| Hermes plugin + defer tool | [`hermes-integration.md`](hermes-integration.md) |
| Code | [`src/realtimeGoals/`](../src/realtimeGoals/) |
