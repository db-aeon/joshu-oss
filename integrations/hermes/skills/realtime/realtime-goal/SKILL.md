---
name: realtime-goal
description: Finish one deferred owner request; block or summarize.
metadata:
  hermes:
    category: productivity
    version: "2.0.0"
---

# Realtime Goal

Use this skill for a single owner request deferred from SMS, jChat, voice, Slack,
or Telegram.

## Intake turns

- Prefer finishing a request in the current conversation when it is plausibly
  under one minute.
- If required information is missing, ask one focused clarification before
  calling `realtime_goal_defer`.
- If the turn began as quick work but tools/retries make it clearly long, call
  `realtime_goal_defer` with a self-contained objective, then return the tool's
  acknowledgment verbatim. Do not continue the long work in that turn.

## Kanban worker turns

1. Read the complete card body and recent comments before every action.
2. Execute only that card's objective. Use reasonable defaults for low-risk
   details.
3. Follow the normal action guard before consequential external writes.
4. Re-read recent comments before a consequential action and before finishing;
   the owner may amend the goal while it runs.

### Every run ends with exactly one call

- **`kanban_complete`** — you have the result the owner should receive, or
- **`kanban_block`** — you need one specific answer from the owner.

Exiting without either (crash, giving up, running out of ideas) is a failure:
Hermes parks the card with no question, and Joshu restarts it with a
**`Joshu recovery`** note. When you see that note, continue from where the last
run stopped and end properly this time.

### Asking the owner (`kanban_block`)

- Ask **one** concise question the owner can answer in a sentence. Name the
  options when there are options.
- Never ask for anything already on the card — the original request, owner
  updates, and earlier answers are all there. Re-read before asking.
- Never block with a generic "need more information". Say exactly what is
  missing and why.
- Presenting a menu or asking the owner to choose (options, rates, times,
  confirmations) is a block, not a completion. The card stays open until the
  owner picks.

### After the owner answers

The broker appends an **`Owner answer`** section with your question
(`You asked:`) and the reply (`Owner replied:`).

- Continue from where you stopped using that answer. Do not repeat finished
  work or re-ask the question.
- If the reply picks one of the options you offered, proceed with that option.
  Only re-open a broad search if that option turns out to be unavailable, and
  then ask a **new** question.
- If a `Joshu recovery` note says you re-asked an answered question, use the
  answer shown there.

### Completing (`kanban_complete`)

Call `kanban_complete` only when handing off a checkout/approval link or
reporting a truly finished outcome (done, confirmed, delivered artifact). The
summary is the message the owner receives:

- Write it as a short text to them, not an internal note.
- Put each fact on its own line and any handoff URL on its own line.
- Use ASCII ("to", "-"), not arrows.
- Never say "the owner", "handed to the owner", or "at the handoff link" without
  pasting the URL. Leave out CAPTCHA and tool-run notes.

Never send the completion directly. Joshu's durable delivery layer returns it
to the originating channel.

Treat cancellation or an archived task as terminal. Stop work immediately and do
not perform further side effects.
