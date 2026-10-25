# Voice agent tools

## Purpose

The voice agent is the speech-to-speech model that talks with the owner on a phone call or in browser voice. This document tells how the voice agent asks the rest of Joshu for work on the native async tool path (Gemini 3.8 Live), and how the voice service checks two kinds of claims that the voice agent makes about that work: claims that something was sent, and claims that work is running.

## Motivation

On the native async tool path the voice agent owns the conversation. It decides when to reply, when to call a tool, and how to speak a tool result, and it keeps talking while a tool call runs. The voice service cannot hear the call the way the voice agent does, so it does not decide for the voice agent.

The voice agent can still say things that are false, and the owner believes them. Two claims caused real problems on calls:

- The voice agent said that it had texted a link while nothing had been sent.
- The voice agent said "Let me check your", the owner said "um", and the model stopped the reply before the tool call went out. The voice agent then told the owner for several minutes that it was still looking, while no tool call ran.

The voice service knows the facts behind both claims, because each send and each tool call goes through it. The guards give those facts to the voice agent.

## Architecture

| Component | File | Owns |
|---|---|---|
| Gemini Live client | `packages/voice-realtime/src/geminiLiveClient.ts` | The WebSocket to Gemini Live, tool calls (`onFunctionCall`), the end of each interaction (`onInteractionIdle`), non-turn context (`appendContext`), and turns that Joshu writes (`requestOrganicResponse` and others), which wait until the model finishes its reply. |
| Tool runner | `packages/voice-realtime/src/nativeToolRunner.ts` | Runs `think` and `start_task`, and builds the tool result that the voice agent speaks, with the list of sends that Joshu made (`delivered`). |
| Delivery claim guard | `packages/voice-realtime/src/deliveryClaimGuard.ts` | Patterns for send claims ("I texted it"), and the correction that a tool result carries when nothing was sent. |
| Work claim guard | `packages/voice-realtime/src/workClaimGuard.ts` | Patterns for work claims ("let me check", "I'm still looking into it"), the state of the current interaction, and the note for a work claim that no tool call backs. |
| Sessions | `packages/voice-realtime/src/twilioRealtimeSession.ts`, `packages/voice-realtime/src/browserRealtimeSession.ts` | The running tool calls of a call, the transcript, and the wiring between the client, the tool runner, and the guards. |
| Voice prompt | `buildNativeVoiceSystemPrompt` in `packages/voice-realtime/src/joshuIdentity.ts` | The rules of the voice agent for tools: `think` for anything about the owner, `start_task` for long work, and no claims that a tool result does not back. |

## Theory of operation

A tool call on the native async tool path goes like this:

1. The owner asks for something about the owner, for example a calendar event. The voice agent may say one short line, such as "Let me check", and calls `think`. Each tool is declared `NON_BLOCKING`, so the voice agent keeps listening while the tool call runs.
2. The session starts the tool call with the tool runner. A phone `think` has a budget of 10 seconds. Past the budget, the tool result says that the work is still running, and the session sends the answer as a late answer when it arrives.
3. The voice agent speaks the tool result. The model marks the end of the interaction with `interactionStatus: IDLE`, and the client reports each tool call of the interaction, also a tool call that arrived after the speech.

The delivery claim guard watches what the voice agent says while a `think` call runs. When the voice agent claims a send and the tool result shows that nothing was sent, the tool result carries a correction, and the voice agent says the correction first.

The work claim guard watches each reply that the voice agent chose to say. It skips tool results and turns that Joshu wrote. When a reply has a work claim, the guard keeps it until the interaction ends. At the end of the interaction the guard does nothing when the interaction made a tool call or when a tool call of the session still runs. Otherwise the session logs `ANTIPATTERN work-claim-without-tool` and adds a note to the conversation. The note quotes the work claim, says that no tool call runs and that the words started nothing, and tells the voice agent to call `think` or `start_task` now if the owner asked for something. When the reply finished without an interruption, the session also asks the voice agent for a turn, at most one time for each utterance of the owner, so the voice agent acts while the owner waits. When the owner cut off the reply, the owner is still talking, and the voice agent reads the note on its next reply.

## Design decisions

### 2026-09-26: Sends are facts that Joshu records

Decision: the voice agent may say that something was sent only when the tool result lists the send in `delivered`. A send claim before the result gets a correction in the result.

Alternatives: trust the voice agent, or block the speech. Reason: the voice agent cannot know whether a send happened, and the voice service does know. A correction in the result keeps the conversation natural.

### 2026-10-14: The work claim guard decides at the end of the interaction

Decision: the guard keeps the latest work claim of an interaction and decides at `interactionStatus: IDLE`.

Alternative: decide at the end of each reply (`response.done`). Reason: a `NON_BLOCKING` tool call can arrive after the speech, so a check at the end of the reply would add a note to a correct reply.

### 2026-10-14: The work claim guard gives the voice agent a fact

Decision: the guard adds a note with the facts, and the voice agent decides whether to call a tool or to correct itself.

Alternatives:

- Joshu starts `think` from the transcript itself. Rejected, because Joshu would guess the request, and the voice agent owns the conversation.
- A prompt rule only. Rejected as the whole fix, because a prompt cannot tell the voice agent that its reply was cut off before the tool call. The prompt still has the rule that only a tool call starts work, because the rule lowers the number of work claims with no tool call.
- Mute a work claim. Rejected, because the owner then hears nothing and still waits, and because Gemini 3.8 Live reports a generation that Joshu cuts off to the owner as a system error.

### 2026-10-14: A turn only after a finished reply, one time for each utterance of the owner

Decision: after a finished reply the session asks for a turn after the note. After an interrupted reply it adds the note only. The guard asks for at most one turn before the owner speaks again.

Alternative: always ask for a turn. Reason: a turn while the owner talks makes the voice agent talk over the owner, and a voice agent that answers with another work claim could make a loop of turns.

### 2026-10-14: Regular expressions find work claims

Decision: a short list of patterns matches claims about work now or in the next moment, and not offers such as "I can check that for you".

Alternatives: classify each reply with a language model, or add a note after each interaction with no tool call. Reason: a classifier adds latency and cost to each reply, and a note after each small talk reply would make the voice agent call tools for small talk.

## Limits and failure modes

- A work claim that the patterns do not match gets no note, which is the same as before the guard. Search the voice log for `ANTIPATTERN work-claim-without-tool` and `owner-fact-before-result candidate` to find new phrases.
- A reply with no words and no tool call gets no note, because the voice service cannot tell it from a correct silence after a filler such as "um".
- A work claim about work that was queued on an earlier call gets a note, because no tool call runs on this call. The note tells the voice agent to say that the work is queued, so the cost is one extra sentence at most.
- When Gemini Live does not send `interactionStatus: IDLE`, the guard never decides.
- The legacy tool path (OpenAI Realtime, Gemini 3.1 Flash Live) has no work claim guard, because there the voice service speaks the wait lines itself.

## Code map

- Guards: `packages/voice-realtime/src/deliveryClaimGuard.ts`, `packages/voice-realtime/src/workClaimGuard.ts`.
- Tool runner: `packages/voice-realtime/src/nativeToolRunner.ts`. Tool declarations: `packages/voice-realtime/src/realtimeTools.ts`.
- Sessions: `checkDeliveryClaim` and `checkWorkClaim` in `packages/voice-realtime/src/twilioRealtimeSession.ts`, `noteWorkClaim` and `onInteractionIdle` in `packages/voice-realtime/src/browserRealtimeSession.ts`.
- Configuration: `GEMINI_LIVE_MODEL` chooses the path (`gemini-3.8-live*` is the native async tool path). The voice log line `tool mode=native_async` shows the path of a session.
- Tests: `packages/voice-realtime/test/workClaimGuard.test.mjs`, `packages/voice-realtime/test/lateAnswer.test.mjs`, `packages/voice-realtime/test/geminiLiveNative.test.mjs`.
