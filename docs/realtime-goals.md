# Realtime goals

Joshu moves clearly long owner requests out of realtime chat turns and into a
durable Hermes Kanban worker. The owner receives an immediate same-channel
acknowledgment, may continue chatting or queue more work, and receives blocked
questions and completion results on the originating channel.

**Theory of operation** (routing model, session thread vs Hermes, channel
policy): [`realtime-goals-theory-of-operation.md`](realtime-goals-theory-of-operation.md).
This page is the implementation reference.

## Scope

Included owner-authenticated surfaces:

- Twilio SMS
- jChat
- embedded AG-UI app chat
- browser voice
- Twilio PSTN voice
- Hermes Slack
- Hermes Telegram

Mail ingress and public Share Chat are intentionally excluded.

## Flow

1. The channel adapter records the owner turn in a bounded **session thread**
   (owner↔box transcript — not Hermes history) and sends the message to
   `RealtimeGoalBroker` on queue-capable channels.
2. The context router reads recent thread turns + active goals and returns
   `pass`, `clarify`, `queue`, `update`, `cancel`, `status`, or `ack`.
3. Classification is intentionally conservative. Only high-confidence work that
   is clearly longer than about one minute is deferred. Errors and uncertainty
   pass through to the normal Hermes turn.

### Channel policy

| Channel | Auto queue via broker | `realtime_goal_defer` | Session thread |
| --- | --- | --- | --- |
| SMS | yes | yes | yes |
| PSTN / browser voice | yes | yes | yes |
| Slack / Telegram | yes | yes | yes |
| jChat | no (sync only) | no | yes |
| AG-UI | no (sync only) | no | yes |
| mail | excluded | — | — |

jChat and AG-UI assume the owner can wait on a synchronous Hermes turn. They
still append to the session thread for consistency, but never auto-queue.

### Channel-neutral admission (coding preference)

**One router policy for queue-capable surfaces.** Do **not** add domain
whitelists (`search_flights`, `book_hotel`, travel regexes, etc.) or
channel-specific “long intent” tables. Those rot quickly and duplicate what the
context router already does with thread + goals.

When a channel mis-queues or mis-passes, fix **plumbing** so the classifier sees
the same owner substance other channels get:

| Surface | Broker `text` source |
| --- | --- |
| jChat / AG-UI | Last user message in the chat turn |
| SMS | Inbound body |
| Slack / Telegram | Gateway hook message |
| Voice `think` | Full structured think user message (`Intent` / `Conversation summary` / `User said`) — same string Hermes receives, **not** a thin Realtime paraphrase |

Voice-realtime: [`packages/voice-realtime/src/brainThink.ts`](../packages/voice-realtime/src/brainThink.ts)
calls `POST /api/realtime-goals/route` before Hermes. PSTN uses stable
`sessionKey: pstn:owner` so status/cancel works across `CallSid`s.

The router prompt may mention structured voice fields generically (weight
`User said` when present). Deterministic shortcuts stay limited to explicit
cancel/status phrases and greetings — never task taxonomy or ack phrase lists.

Interpret follow-ups in thread context: *"Nope"* after *"Anything else?"* →
`ack`; *"also include the New York Times"* → `update`; *"actually, never mind"*
→ `cancel`.

General Joshu preferences for this subsystem: minimize scope, keep architecture
clean, avoid application-specific exceptions when a structural fix suffices, and
prefer DRY channel adapters over parallel policies.

4. Consequential missing information is requested on the same channel before
   work is queued.
5. Accepted work enters a durable 60-second commit window. During that window,
   owner updates merge into the goal and “never mind” cancels without starting a
   worker.
6. The lifecycle sweeper creates one directly assigned task on the managed
   `realtime-goals` Kanban board. Automatic decomposition is disabled for this
   board to avoid duplicate external actions and make cancellation atomic.
7. The worker completes with `kanban_complete(summary, metadata, artifacts)` or
   blocks with one concise question (see
   [owner questions vs. system stalls](#blocked-goals-owner-questions-vs-system-stalls-2026-09-24)).
   The broker treats persisted Kanban
   task/run state as authoritative and delivers the event on the source channel.
   The completion summary **is** the owner message. The worker does not send it.

Hermes's pinned Kanban implementation documents `scheduled_at`, but does not
implement it. The commit window therefore lives in Joshu's persisted broker
state; the bridge does not pretend that an ignored field delayed execution.

## Durable state and idempotency

State defaults to:

```text
${JOSHU_FILES_ROOT}/.joshu/realtime-goals/state.json
${JOSHU_FILES_ROOT}/.joshu/realtime-goals/threads.json
```

Local development falls back to `.local/realtime-goals/`. Override with
`JOSHU_REALTIME_GOALS_STATE_DIR`.

Session threads store the last **12 turns** (default) or **48h** TTL, keyed by
stable `sessionKey` (`sms:+1…`, `pstn:owner`, etc.). Provider `messageId`
deduplicates owner appends on transport retry.

Each record stores the logical goal ID, origin route, source event ID, intake
messages, release time, Kanban task ID, task status, result summary, and delivery
cursor. Provider event IDs (Twilio `MessageSid`, Slack/Telegram message ID,
jChat message ID, AG-UI run ID, voice think job ID) deduplicate transport
retries. Logical goal IDs remain distinct so separate requests in one
conversation never collapse.

SMS owner messages are written to a small durable inbox before Joshu returns the
Twilio webhook ACK. Normal completion clears the inbox entry. If the process
dies before handling it, restart recovery texts the owner with a bounded preview
and asks for a replay rather than silently losing an ACKed message.

Strict realtime Kanban keys use a partial unique SQLite index and search all
task statuses, including archived tasks. Each handled provider event also keeps
its immutable response receipt so an older webhook retry receives its original
acknowledgment instead of a newer goal response.

## Channel delivery

- SMS uses the existing carrier-safe `sendSms` helper. Completion text is the
  Kanban run summary (`latest_run.summary`, else `completion_summary`, else the
  last comment). [`formatOwnerCompletion`](../src/realtimeGoals/ownerDelivery.ts)
  rewrites that before send: second person, one fact per line, CAPTCHA and
  "this run" notes removed. If the summary mentions a handoff and does not
  include a URL, the broker appends the pending handoff link (same
  `kanbanTaskId`, otherwise the newest pending record). The factory
  `realtime-goal` skill and the task body tell the worker to write that summary
  as a text to the owner, with the full URL on its own line. A worker that
  still says "pays at the handoff link" does not omit the URL.
- Handoff links expire (default 45 minutes; the handoff page heartbeat extends
  them). An expired record stays `pending` on disk until something reads it.
  The browser tab can still show the checkout URL after the link is dead. A
  later proxy failure replaces that tab with Chrome's error page
  (`chrome-error://chromewebdata/`, `ERR_TUNNEL_CONNECTION_FAILED`); reloading
  once the proxy works does not restore an airline cart. The site typically
  returns its search form.
- jChat and AG-UI use a durable per-session surface-event queue polled by their
  mounted chat clients. Before acknowledging consumption, the client persists
  the assistant event in a bounded browser cache; reloads rehydrate it into the
  visible transcript and the next Hermes turn includes it.
- Slack uses `chat.postMessage` with the original channel and `thread_ts`.
- Telegram uses `sendMessage` with the original chat and forum thread.
- Browser voice uses the underlying jChat/app session.
- PSTN completion starts an owner callback only during the configured proactive
  working window. The call still requires the Telephone think passphrase. Only
  after successful unlock does voice-realtime fetch and speak the signed goal
  result, then ask whether the owner needs anything else. Redial, voicemail, and
  burst rules are in [PSTN callback delivery](#pstn-callback-delivery-2026-09-24).

Delivery attempts use persisted leases so a process restart cannot leave an
event permanently stuck in `attempting`. Slack also receives a deterministic
`client_msg_id`; channels without a provider idempotency primitive retain the
durable attempt cursor and bounded retry policy.

Completion SMS is idempotent: owner updates appended to a **done** Kanban task no
longer reset the done cursor, and `claimDeliveryAttempt()` atomically suppresses
duplicate sends of the same completion body (regression fixed 2026-09-18).

### Blocked goals: owner questions vs. system stalls (2026-09-24)

A Kanban task can be `blocked` for two unrelated reasons. The bridge reports
which one via `block_cause` (from the latest `blocked` / `gave_up` /
`unblocked` event), and [`blockCause.ts`](../src/realtimeGoals/blockCause.ts)
classifies it:

| Cause | Source | Broker action |
| --- | --- | --- |
| **Owner question** | Worker `kanban_block(reason)` | Deliver the question on the origin channel |
| **System stall** | Hermes circuit breaker (`gave_up`: crashes, timeouts, spawn failures, or clean exits without `kanban_complete`/`kanban_block`), or a reasonless block | Never page the owner. Append a `Joshu recovery` note and unblock, up to 2 times. Then send one honest message: couldn't finish, say “try again” or “cancel”. |

There is no generic “I need more information” fallback any more: with nothing
concrete to ask, the voice model invented a question (patrick 2026-09-24, flight
card that already had its dates).

### Blocked answers

When the owner replies while a goal is **blocked**:

1. The broker records `blockedAnsweredAt`, `lastBlockedPrompt`, and
   `lastOwnerAnswer`, resets the auto-recovery budget, and counts the question
   as delivered (no redial of a question the owner just answered).
2. The card gets a task-neutral **`Owner answer`** append: `You asked:` (the
   block question) and `Owner replied:`. The worker decides what the reply means
   for its own objective; nothing assumes booking or checkout.
3. If the worker later blocks with the **same** question, the broker does not
   re-ask the owner. It appends a `Joshu recovery` note quoting the answer and
   unblocks (same budget as system stalls).

Replies heard on a **callback** go through the bound router first
(`answerFromCallback`): a progress question (“were you able to find those
flights?”) gets a status reply, cancel cancels, and an unrelated request falls
through to a normal voice turn. Only a real answer is written to the card. If
the router is unavailable, the reply is treated as the answer.

### PSTN callback delivery (2026-09-24)

A callback is delivered only after passphrase unlock and playback ack (or an
owner answer). Undelivered calls follow
[`voiceDeliveryPolicy.ts`](../src/realtimeGoals/voiceDeliveryPolicy.ts):

| How the call ended | Detected by | Result |
| --- | --- | --- |
| Voicemail | Twilio async AMD (`AnsweredBy=machine_*`/`fax`, call hung up), or a voicemail greeting transcript while locked | **Park** |
| Passphrase lockout | voice-realtime `auth_failed` | **Park** |
| No answer / busy / hung up before unlock | Twilio status, voice-realtime `no_unlock` | Retry at 15m, then 30m; park after 3 calls |

**Park** is session-wide: every pending PSTN result for that owner stops
dialing, the owner gets one SMS naming the task(s) (no results; the passphrase
still gates content), and callbacks for the session hold for 60 minutes. A
parked result is picked up when the owner calls in and asks for an update (the
router sees parked results for `status`), and a new question or result on that
goal starts delivery again.

Callbacks are **serialized per owner session**: one call in flight at a time
and a 2-minute gap after a call ends, so several blocked goals no longer ring in
a burst. Deliveries deferred by working hours no longer spend an attempt.

**When a callback may ring** ([`callbackWindow.ts`](../src/realtimeGoals/callbackWindow.ts)):
the owner's proactive window (weekdays, working hours, plus evenings/weekends
if they opted in) — or, for up to **6 hours after the owner's last message on
the goal**, any day **07:00–22:00** owner-local. "I'll call you back when it's
done" is a promise, not a nudge: an 8 PM request is called back at 8:15 PM,
not at 9 AM tomorrow. When a finished callback must wait anyway, the owner gets
**one** SMS with the task title and when Joshu will call (no result — the
passphrase still gates content); `delivery.deferNoticeAt` records it.

Set `JOSHU_REALTIME_GOALS_CALLBACK_AMD=0` to disable answering-machine
detection (the transcript check and outcome reports still apply).

Voice-realtime also drops **passphrase residue** after unlock (the passphrase
plus at most one other word, and partial matches for 10 s), refuses a `think`
whose quoted request is only the passphrase, and says “Unlocked. I have an update
for you.” on callbacks instead of asking the owner to repeat their request.

**Links on voice.** A callback result or blocked question that contains URLs is
spoken without them; Joshu texts the links to the owner (once per result,
recorded as `linksTextedKey`/`linksTextedAt`) and the spoken text says so — or
says honestly that the text failed. Live Hermes answers on a call go through the
same path (`POST /api/realtime-goals/voice/owner-text`, loopback +
`HERMES_API_KEY`, recipient always the owner). Blocked questions are relayed as
questions (options with exact details, then the ask), not as summaries.

**Follow-ups stay on the goal.** The router sees each goal's
`waiting_on_owner` question and `found` result. A question about those details
(“when does the United flight take off?”, “nonstop only”) is an `update` of the
bound goal — its worker has the context — never a new queued goal. Hermes'
voice context lists the same details plus goals finished in the last 6 hours,
including whether a phone-call link was actually texted.

**Voice intake wording.** Queued work on a call says “I'll call you back when
it's done” (not “I'll reply here”) and does not stack another “Anything else?”;
updates to background work say “I'll get back to you when it's ready” instead of
asking the owner to hold.

Twilio callback status webhooks validate `X-Twilio-Signature`. Goal result fetches
use a purpose-separated HMAC token derived from
`JOSHU_REALTIME_GOALS_CALLBACK_SECRET`, falling back to the media-stream secret
and then the Twilio Auth Token. Result/reply/ack routes additionally require a
direct-loopback request, `HERMES_API_KEY`, and the active callback `CallSid`;
the status-callback token cannot read a result. Delivery is acknowledged only
after the speech response completes and Twilio drains a trailing playback mark.

Privileged browser entry points validate the presented cookie against ArozOS
`/system/auth/checkLogin` over loopback before broker admission or voice-token
issuance. Internal plugin/voice broker calls require both proxy-safe direct
localhost and `HERMES_API_KEY`; Caddy-proxied requests cannot masquerade as
local services.

## Cancellation

“Never mind”, “cancel that”, “stop that”, and “forget it” target the most
recently acknowledged active goal only when unambiguous; with several jobs, the
owner is asked to name one.

The router uses thread context so bare negation answering *“Anything else?”*
returns `ack`, not `cancel`. Only explicit cancel intent (or high-confidence
cancel with thread/goal binding) stops work. The broker first enters a durable `cancelling` state
and suppresses completion delivery. A pre-release goal is never created on
Kanban. For a released goal, the bridge verifies the worker PID belongs to that
Kanban task, terminates its process group, confirms it stopped, records an audit
comment, and only then archives the task. Failures remain `cancelling` and retry.
If cancellation races task creation, the post-create compare-and-set immediately
stops the new worker without resurrecting the goal.

## Hermes integration

Repo plugin `.hermes/plugins/joshu-realtime-goals/`:

- intercepts already-authorized Slack/Telegram owner messages through Hermes's
  gateway hook and calls the local broker;
- exposes `realtime_goal_defer` when an initially synchronous Hermes turn
  discovers that the work is long.

The defer handler accepts only queue-capable session identities (SMS, PSTN,
browser voice, Slack, Telegram). It rejects jChat, AG-UI, mail, public Share
Chat, unknown sessions, and all Kanban worker processes (`HERMES_KANBAN_TASK`).

On `pass` for queue-capable channels, Hermes receives a compact broker snapshot
(active goals + recent thread) as an extra system message so sync chat does not
contradict cancelled/queued state.

Factory skill `realtime-goal` is force-loaded by deferred workers. It requires
workers to re-read owner updates before consequential actions, use normal action
guard policy, block with one question, and return a self-contained completion
summary without sending directly.

## Configuration

```dotenv
# Default 60 seconds; 0 is useful in tests.
JOSHU_REALTIME_GOALS_RELEASE_SECONDS=60

# Default lifecycle poll is 5000 ms, minimum 1000.
JOSHU_REALTIME_GOALS_POLL_MS=5000

# Optional cheap router override.
JOSHU_REALTIME_GOALS_CLASSIFIER_MODEL=openai/gpt-5.4-nano

# Session thread bounds (defaults: 12 turns, 48h).
JOSHU_REALTIME_GOALS_THREAD_MAX_TURNS=12
JOSHU_REALTIME_GOALS_THREAD_TTL_HOURS=48

# Optional explicit persistent state directory.
JOSHU_REALTIME_GOALS_STATE_DIR=

# Optional dedicated HMAC secret for PSTN result callbacks.
JOSHU_REALTIME_GOALS_CALLBACK_SECRET=

# Twilio async answering-machine detection on callbacks (default on).
JOSHU_REALTIME_GOALS_CALLBACK_AMD=1
```

The router uses the existing Day 0/OpenRouter credential path. If it is not
configured, realtime admission fails open and normal Hermes handles the turn.

Implementation: [`src/realtimeGoals/router.ts`](../src/realtimeGoals/router.ts),
[`src/realtimeGoals/sessionThread.ts`](../src/realtimeGoals/sessionThread.ts),
[`src/realtimeGoals/broker.ts`](../src/realtimeGoals/broker.ts).

See also: [`realtime-goals-theory-of-operation.md`](realtime-goals-theory-of-operation.md).

## Verification

```bash
npm run test:realtime-goals
npm run test:realtime-goals-plugin
npm run test:kanban-bridge-max-runtime
npm run test:sms-send
npm run typecheck
npm run build -w @joshu/app-agent
npm run build -w @joshu/voice-realtime
```
