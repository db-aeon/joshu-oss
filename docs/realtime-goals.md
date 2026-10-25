# Realtime goals

Joshu moves clearly long owner requests out of realtime chat turns and into a
durable Hermes Kanban worker. The owner receives an immediate same-channel
acknowledgment, may continue chatting or queue more work, and receives blocked
questions and completion results on the originating channel.

**Theory of operation** (routing model, session thread vs Hermes, channel
policy): [`realtime-goals-theory-of-operation.md`](technical-reference/realtime-goals-theory-of-operation.md).
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
  "this run" notes removed. A line that starts with a URL keeps its case. If
  the summary mentions a handoff and does not include a URL, the broker
  appends the pending handoff link under "Open the live browser here:" (same
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
concrete to ask, the voice model invented a question (fleet box 2026-09-24, flight
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

### PSTN callbacks

Callbacks are placed by the [owner outbox](#owner-outbox-2026-09-27): one call
carries every ready result, it is answered at the call gate, and a missed call
texts the full results instead of redialing.

**When a callback may ring** ([`callbackWindow.ts`](../src/realtimeGoals/callbackWindow.ts)):
the owner's proactive window (weekdays, working hours, plus evenings/weekends
if they opted in) — or, for up to **6 hours after the owner's last message on
the goal**, any day **07:00–22:00** owner-local. "I'll call you back when it's
done" is a promise, not a nudge: an 8 PM request is called back at 8:15 PM,
not at 9 AM tomorrow. Outside call hours (07:00–22:00 owner-local) the result
is texted instead of waiting for tomorrow's call.

Set `JOSHU_REALTIME_GOALS_CALLBACK_AMD=0` to disable answering-machine
detection (the gate still recognizes a voicemail greeting).

**Links on voice.** A callback result or blocked question that contains URLs is
spoken without them; Joshu texts the links to the owner (once per result,
recorded as `linksTextedKey`/`linksTextedAt`) and the spoken text says so — or
says honestly that the text failed. The spoken text does not wait for the
delivery receipt of that SMS, because the voice service has short time limits
(2.5 s for the opener, 5 s for pending results, 10 s for the callback batch).
Joshu reads the receipt in the background for up to 45 s
(`sendSmsCheckReceiptLater` in [`twilioSmsSend.ts`](../src/twilioSmsSend.ts)).
When a carrier rejects the SMS, the inline job marks its link fact `ok: false`
and the goal loses `linksTextedKey`/`linksTextedAt`, so later turns do not
claim the link and the next delivery texts it again. Live Hermes answers on a call go through the
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

## Owner outbox (2026-09-27)

Every result, question, and late answer reaches the owner through one
owner-level outbox (it replaced per-goal, per-channel delivery). On the canary box (2026-09-26) one voicemail verdict parked
every phone result for an hour while the owner was calling in and texting;
finished flight results reached him 51–52 minutes after he asked, one twice.

**Owner-scoped trunk.** The box has one owner. Goals, results, and delivery
state are visible from every channel: SMS, Slack, Telegram, and voice `think`
all get the same snapshot (`buildHermesContextSnapshot` →
[`brokerContext.ts`](../src/realtimeGoals/brokerContext.ts)), with where each
goal was asked, whether the owner heard the result, and that Joshu can call the
owner. The per-thread active pointer still binds follow-ups, and a phone goal's
question texted to the owner binds their SMS reply. `channel:sessionKey` stays
only for transport idempotency.

**Items.** Every result, blocked question, or failure becomes an outbox item
(`ready → offered → heard`, or `superseded` / `cancelled`). The same content is
never enqueued twice for a goal, and new content supersedes anything unheard.

**Delivery policy** ([`outboxPolicy.ts`](../src/realtimeGoals/outboxPolicy.ts), pure):

| Situation | What happens |
| --- | --- |
| Owner on an unlocked call | No dialing; the live call offers the result |
| Owner said how ("don't call, text me") | That route, for that goal (or owner-wide for 24h) |
| Owner texted in the last 10 min | The result goes to that text thread |
| SMS / Slack / Telegram / surface request | Its own channel (unchanged) |
| Phone request | One batched callback after a 60 s settle (no call in flight, callback window, no backoff) |
| Callback missed (no answer, busy, voicemail, hang-up before unlock) | Full result by SMS now; backoff 10 min → 30 min → no calls until the owner makes contact |
| Outside call hours (07:00–22:00 owner-local) | Text instead of calling tomorrow |
| Owner says "call me back" (any channel) | Dial now, whatever the backoff or window |
| SMS sent, no delivery receipt yet | Wait; no other SMS and no callback for that item (up to 10 min) |
| SMS undelivered (Twilio `undelivered` / `failed`) | Never texted again; a phone result goes back to the callback rules, else it waits for the next call |

Any owner message on any channel, or unlocking a call, clears the backoff.

**Delivery commands.** The router has a `delivery` decision: "call me back",
"please call", "I'm asking you to call back" → call now; "don't call, text me",
"no need to call me back" → route override; "call me when it's done" → phone.
Clear phrasings are deterministic
([`deterministicDeliveryCommand`](../src/realtimeGoals/router.ts)); the model
classifies the rest. A route change on a running goal also reaches its worker
as an owner update ("just email me the link").

**Heard.** Slack and Telegram count as heard when the API accepts the message.
SMS counts as heard only with a delivery receipt: Twilio accepts an SMS before
the carrier delivers it, and carriers reject SMS later (fleet audit
2026-10-10: errors 30034 unregistered A2P number, 30003 unreachable handset,
30007 carrier filter, all recorded as heard before this rule). After the send,
the item keeps state `ready` with `smsPending` (the message SIDs), and each
dispatch pass reads the Twilio status of each SMS part, at most every 15 s
(`fetchSmsStatus` in [`twilioSmsSend.ts`](../src/twilioSmsSend.ts)). Every part
`delivered` → heard (`channel_delivered`). Any part `undelivered`, `failed`, or
`canceled` → attempt outcome `undelivered` with the Twilio error code; the item
stays open and is never texted again. No final status after 10 min → every
part `sent` counts as heard (`sms_sent`, the carrier took it without a
receipt); any other status is a failed send and is texted again after the
backoff. The SMS thread record and the binding of a texted question happen
only when the SMS counts as heard. A phone result counts as heard
when the voice service sees its key facts in what the model actually said
([`deliveryCoverage.ts`](../packages/voice-realtime/src/deliveryCoverage.ts)),
when the owner answers while it is being spoken, when the batch playback ack
drains, or when the owner asks for its status. A result relayed from context
counts too. Offered-but-unheard results go back to `ready` when the call ends,
so the policy texts them.

**Live calls.** On unlock, voice-realtime reports presence, adds unheard phone
results to the model's context ("mention them briefly once"), and polls every
10 s for results that finish mid-call (`live_update` turn at the next idle
moment). Callbacks carry one **batch** (`realtimeGoalBatchId` + token): every
ready result in one call, blocked questions first.

| Route | Caller | Purpose |
| --- | --- | --- |
| `GET /api/realtime-goals/voice/batch/:batchId` | voice (callback CallSid) | Batch content; marks it offered |
| `POST /api/realtime-goals/voice/batch/:batchId/{outcome,reply,ack}` | voice (callback CallSid) | Voicemail/lockout, blocked answer, playback drained |
| `GET /api/realtime-goals/voice/pending?callSid=` | voice (loopback + key) | Unheard phone results to offer now; renews the call's presence lease |
| `POST /api/realtime-goals/voice/presence` | voice (loopback + key) | `unlocked` / `ended` |
| `POST /api/realtime-goals/outbox/heard` | voice (loopback + key) | Coverage / owner-reply evidence |
| `POST /api/realtime-goals/voice/opener` | voice (loopback + key) | Call opened: presence `unlocked`, owner context, unheard results (offered) |

**Call gate.** Callbacks are placed with TwiML that redirects to the voice-realtime gate (passphrase or PIN via Twilio
`<Gather>`), and answering-machine detection switches to `DetectMessageEnd`:
after the beep, Joshu redirects a still-locked call to the gate's voicemail
notice ("I've sent the details by text"), records `voicemail`, and the policy
texts the full results. A call that already got through is never touched by
AMD. Inbound gated calls open with one turn that offers unheard results by
title ([voice-realtime.md — Call gate](vps-sandbox/voice-realtime.md#call-gate-passphrase--pin)).

The first run migrates pending, attempting, and parked per-goal deliveries into
the outbox, once, after copying `state.json` to `state.json.bak-owner-outbox`.

Implementation: [`outbox.ts`](../src/realtimeGoals/outbox.ts),
[`outboxDispatcher.ts`](../src/realtimeGoals/outboxDispatcher.ts),
[`ownerOutboxSenders.ts`](../src/realtimeGoals/ownerOutboxSenders.ts).
Tests, including a replay of the 2026-09-26 session: `npm run test:owner-outbox`.

## Inline jobs (phone `think` with a time budget)

A cheap classifier used to pick sync vs. background up front: on the canary box
(2026-09-26) a 59 s sync turn held the caller while "email me the link" became a
background goal. Now phone `think` always starts inline as a Joshu job
([`inlineJobs.ts`](../src/realtimeGoals/inlineJobs.ts)) and only the budget
decides: answered within 10 s → spoken; slower →
"still working", then spoken when it lands; caller gone → owner outbox `answer`
item (texted — the promise on the line). Unclaimed answers reach the outbox after
45 s; jobs persist in `inline-jobs.json`, and one that was running when Joshu
restarted becomes "I restarted before I could finish …".

| Route (loopback + service key) | Purpose |
| --- | --- |
| `POST /api/realtime-goals/jobs` | Broker `route`, then Hermes; waits up to `budgetMs` (≤25 s). Done → claimed and returned speakable (links texted, `delivered` facts) |
| `GET /api/realtime-goals/jobs/:id?waitMs=` | Long-poll a running job |
| `POST /api/realtime-goals/jobs/:id/claim` | The call will speak it now; `claimed: false` once delivered elsewhere |
| `POST /api/realtime-goals/jobs/:id/detach` | Caller hung up — deliver through the outbox when done |

Because slow answers no longer hold anyone, phone admission queues only on
clear long work: `JOSHU_REALTIME_GOALS_VOICE_QUEUE_CONFIDENCE` (default 0.85;
other channels keep 0.7). Explicit `start_task` / defer commits after
`JOSHU_REALTIME_GOALS_EXPLICIT_RELEASE_SECONDS` (default 10) instead of the
60 s classifier window. SMS turns send one "Working on it — I'll text you when
it's done." after `JOSHU_SMS_INTERIM_SECONDS` (default 25; 0 = off).

Browser handoff links minted during a job
([`collectHandoffUrlsForSession`](../src/realtimeGoals/inlineJobs.ts)) are
texted with the answer even when Hermes forgot to paste them.

Tests: `npm run test:inline-jobs`, voice `test/lateAnswer.test.mjs`.

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
  discovers that the work is long;
- blocks a Hermes `cronjob` call whose delivery target cannot reach anyone
  (`cron_guard.py`), for example a reminder made in an SMS turn without
  `deliver`. Reminders to the owner use `owner_reminder_create`
  ([executive-assistant.md — Owner reminders](executive-assistant.md#owner-reminders-2026-10)).

The SMS gateway also defers an SMS turn that its deadline stopped, with the
owner text and a note about partial work as the objective
([How long an SMS turn runs](technical-reference/realtime-goals-theory-of-operation.md#how-long-an-sms-turn-runs)).

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

See also: [`realtime-goals-theory-of-operation.md`](technical-reference/realtime-goals-theory-of-operation.md).

## Verification

```bash
npm run test:realtime-goals
npm run test:owner-outbox
npm run test:realtime-goals-plugin
npm run test:kanban-bridge-max-runtime
npm run test:sms-send
npm run typecheck
npm run build -w @joshu/app-agent
npm run build -w @joshu/voice-realtime
```
