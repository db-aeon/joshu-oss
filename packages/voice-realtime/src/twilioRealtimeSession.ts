import { randomUUID } from "node:crypto";
import type WebSocket from "ws";

import {
  HERMES_PROGRESS_FIRST_DELAY_MS,
  HERMES_PROGRESS_INTERVAL_MS,
  HERMES_PROGRESS_MAX_TICKS,
  HERMES_PROGRESS_POST_SPEECH_MS,
  HERMES_API_KEY,
  GEMINI_LIVE_PHONE_THINKING_LEVEL,
  PHONE_SYSTEM_PROMPT,
  PHONE_VAD_EAGERNESS,
  PHONE_VAD_MODE,
  PHONE_VAD_SILENCE_MS,
  PHONE_VAD_THRESHOLD,
  resolveTwilioThinkPassword,
  VOICE_S2S_PROVIDER,
} from "./config.js";
import {
  claimPhoneThinkJob,
  detachPhoneThinkJob,
  resolveThinkUserQuote,
  runJoshuThinkDetailed,
  speakableWithLinksTexted,
  textAnswerToOwner,
  waitPhoneThinkJob,
} from "./brainThink.js";
import { claimCorrection, detectDeliveryClaim } from "./deliveryClaimGuard.js";
import { sendWorkClaimNudge, WorkClaimGuard } from "./workClaimGuard.js";
import {
  NATIVE_JOB_TOOL_NAMES,
  runNativeVoiceTool,
  type NativeToolRequest,
} from "./nativeToolRunner.js";
import { classifyWrapUp, wrapUpApplies, wrapUpLine } from "./phoneWrapUp.js";
import { JOSHU_IDENTITY } from "./config.js";
import { createVoiceS2sClient, voiceS2sProviderLabel } from "./createVoiceS2sClient.js";
import { normalizeThinkToolName, PHONE_TOOL_NAMES } from "./realtimeTools.js";
import {
  appendDictationChunk,
  buildDictationThinkMessage,
  createDictationSession,
  DICTATION_NOT_EXPLICIT_MESSAGE,
  dictationStatusPayload,
  looksLikeDictationDone,
  recentUserSpeechLooksLikeDictationStart,
  type DictationSessionState,
} from "./dictationSession.js";
import type { FunctionCallPayload, ResponseSpeechReason, VoiceS2sClient } from "./voiceS2sTypes.js";
import { redactPassphrase } from "./phonePassphrase.js";
import { getLockPromptClip } from "./lockPrompts.js";
import { classifyUserTranscript } from "./userInputGate.js";
import { spokenCovers } from "./deliveryCoverage.js";
import type { GateMode, UnlockVia } from "./gate/unlockToken.js";
import { resolveOwnerLanguage } from "./joshuIdentity.js";
import { detectLanguageMismatch, languageCorrection } from "./languageGuard.js";
import { buildInboundOpenerTurn, buildOpenerContext, fetchOpener, type OpenerPayload } from "./opener.js";
import {
  offerReplyAllowsSave,
  ownerMobileOfferFor,
  ownerMobileSaveAnswer,
  SAVE_OWNER_MOBILE_TOOL,
  SAVE_OWNER_MOBILE_TOOL_NAME,
  type OwnerMobileOffer,
} from "./ownerMobileOffer.js";
import { voiceLog, voiceWarn } from "./voiceLog.js";

const MAX_TRANSCRIPT_TURNS = 12;
/** Owner outbox: how often a live call checks for results that just finished (renews presence too). */
const PENDING_POLL_MS = 10_000;
/** An owner reply counts as "heard" only after the result was being spoken this long. */
const OWNER_REPLY_HEARD_MIN_MS = 5_000;
/** ...and the model had said at least this much since it was handed over. */
const OWNER_REPLY_HEARD_MIN_CHARS = 40;
/** 20 ms of μ-law 8 kHz — the frame size Twilio Media Streams expects. */
const MULAW_FRAME_BYTES = 160;
/** μ-law 8 kHz: one byte per sample. */
const MULAW_BYTES_PER_MS = 8;
const JOSHU_API_BASE = (
  process.env.JOSHU_API_BASE_URL ?? "http://127.0.0.1:8788/joshu"
).replace(/\/+$/, "");

/** Realtime sometimes apologizes for lacking access, then calls think in the same response. */
const LIMITATION_DENIAL_RE =
  /\b(can't|cannot|don't have|do not have|unable to|no access|don't see|do not see|not able to)\b.*\b(file|desktop|journal|note|memory|screen|see your|access your)/i;

const PROGRESS_PHRASES = [
  "Still checking.",
  "One moment.",
  "Still working on that.",
  "Almost there.",
];
/**
 * Progress tick (~35 s in) at which a slow answer offers to text instead of
 * holding the caller on filler. The answer is texted whenever the caller hangs
 * up before it arrives, so the offer is always true.
 */
const TEXT_OFFER_TICK = 3;
const TEXT_OFFER_LINE =
  "This is taking a bit. I'll text you the answer as soon as it's ready, so feel free to hang up.";
/** A think still running after hang-up is abandoned after this long. */
const DETACHED_JOB_MAX_MS = 10 * 60_000;
/** A think answer that outlasted its budget is followed this long (then Joshu delivers it). */
const LATE_ANSWER_MAX_MS = 10 * 60_000;
/** Long-poll slice while following a late answer. */
const LATE_ANSWER_POLL_MS = 20_000;
/** Wrap-up heard via transcript and via the model's think call count once. */
const WRAP_UP_DEDUPE_MS = 5_000;
/** Native end_call: silence after the goodbye before hanging up, and the upper bound. */
const END_CALL_QUIET_MS = 1_200;
const END_CALL_MAX_WAIT_MS = 15_000;

/**
 * PSTN: server_vad (default) for low latency; semantic_vad opt-in via VOICE_PHONE_VAD_MODE.
 * @see https://developers.openai.com/api/docs/guides/realtime-vad#semantic-vad
 */
const PHONE_VAD = {
  vadType: PHONE_VAD_MODE,
  eagerness: PHONE_VAD_EAGERNESS,
  threshold: PHONE_VAD_THRESHOLD,
  silenceDurationMs: PHONE_VAD_SILENCE_MS,
  prefixPaddingMs: 300,
  createResponse: false,
  interruptResponse: false,
};

type TranscriptTurn = { role: "user" | "assistant"; text: string };

type JobProgressPhase = "awaiting_ack" | "idle" | "awaiting_speech" | "done";

type JobProgressState = {
  tick: number;
  phase: JobProgressPhase;
  timer: ReturnType<typeof setTimeout> | null;
  longWaitSent: boolean;
};

type ActiveJoshuJob = {
  abort: AbortController;
  jobId: string;
  progress: JobProgressState;
  /** Caller hung up while this ran; its answer is texted instead of spoken. */
  detached: boolean;
};

/** Native path: one async tool call (think / start_task) the model is waiting on. */
type NativeToolJob = {
  abort: AbortController;
  jobId: string;
  callId: string;
  tool: string;
  /** Caller hung up while this ran; its answer is texted instead of spoken. */
  detached: boolean;
};

type StartMetadata = {
  caller?: string;
  ownerCaller?: string;
  /** Owner outbox callback: one call for a batch of results. */
  realtimeGoalBatchId?: string;
  realtimeGoalBatchToken?: string;
  /** The owner asked to be called back. */
  ownerRequested?: boolean;
  /** How the call gate let this caller in (the stream only opens after it). */
  gate: { mode: GateMode; via: UnlockVia };
};

/** An owner outbox result handed to this call, until it is confirmed heard. */
type OfferedItem = {
  title: string;
  text: string;
  offeredAtMs: number;
  /** What the model said since it was handed over. */
  spoken: string;
  /** Handed over as a turn to speak (callback / live update), not just context. */
  injected: boolean;
};

type PendingResult = { id: string; kind: string; title: string; text: string };

/**
 * Twilio Media Streams ↔ speech-to-speech upstream (OpenAI Realtime or Gemini Live, μ-law 8 kHz).
 * Personal/user-specific work → single async brain path (think).
 */
export class TwilioRealtimeSession {
  private streamSid: string | null = null;
  private callSid = "";
  private s2s: VoiceS2sClient | null = null;
  private latestMediaTimestamp = 0;
  private lastAssistantItem: string | null = null;
  private responseStartTimestampTwilio: number | null = null;
  private markQueue: string[] = [];
  /**
   * When Twilio should finish playing the model audio we already sent
   * (performance.now() ms). Gemini deltas carry no item id, so no marks — and
   * it generates faster than real time, so seconds of reply can still be
   * queued after response.done. Without this the caller could not barge in.
   */
  private modelAudioPlaysUntil = 0;
  private transcript: TranscriptTurn[] = [];
  private assistantPartial = "";
  /** Legacy path: the single brain job the handler owns speech for. */
  private activeJob: ActiveJoshuJob | null = null;
  /**
   * Native async tools (Gemini 3.8 Live): the model speaks tool results itself, so
   * none of the legacy wait lines / organic muting / injected results apply.
   */
  private nativeTools = false;
  /** Native path: in-flight tool calls by callId (several may run at once). */
  private nativeJobs = new Map<string, NativeToolJob>();
  /** The call is ending — ignore further turns. */
  private hangingUp = false;
  private startMetadata: StartMetadata | undefined;
  private realtimeGoalAwaitingReply = false;
  private realtimeGoalAckPending = false;
  private realtimeGoalResponseDone = false;
  /** Owner outbox results handed to this call, until confirmed heard. */
  private offeredItems = new Map<string, OfferedItem>();
  /** Checks for results that finish while the owner is on the call. */
  private pendingPollTimer: ReturnType<typeof setInterval> | null = null;
  /** Owner presence was reported as on this call. */
  private presenceReported = false;
  /** Joshu's opening context + unheard results, fetched as the call starts. */
  private openerPromise: Promise<OpenerPayload | undefined> | null = null;
  private openerSent = false;
  /** The owner started talking before the opener went out (skip the greeting). */
  private callerSpokeBeforeOpener = false;
  /** One language correction per call (see languageGuard.ts). */
  private languageCorrected = false;
  /** Owner mobile offer of this call (inbound, unlocked by passphrase or PIN, no owner mobile). */
  private ownerMobileOffer: OwnerMobileOffer | undefined;
  /** save_owner_mobile already ran on this call (one try per call). */
  private ownerMobileSaveTried = false;
  /** Phone think jobs past their budget, followed until the answer lands (jobId → quote). */
  private lateJobs = new Map<string, { quote?: string }>();
  /** Sends the model claimed while a think job was still running (deliveryClaimGuard). */
  private pendingDeliveryClaims: string[] = [];
  /** Native: work claims that no tool call backs (workClaimGuard). */
  private readonly workClaims = new WorkClaimGuard();
  private turn = 0;
  private responseNum = 0;
  /** responseNum of the last response that reported done (native end_call waits on it). */
  private responsesDone = 0;
  /** Native: the model asked to hang up; one hang-up per call. */
  private endCallRequested = false;
  /** Set before requestOrganicResponse / injectRepromptMessage; cleared on response.created. */
  private joshuInitiatedResponse = false;
  /** Set when caller spoke but the auto-reply may have been muted; nudge once on transcript. */
  private geminiUserTurnNeedsReply = false;
  /** Multi-turn voice capture — buffer until finish_dictation / done phrase. */
  private dictation: DictationSessionState | null = null;
  private readonly geminiPhone = VOICE_S2S_PROVIDER === "gemini_live";
  private currentResponseReason: ResponseSpeechReason = "organic";
  private responseHadSpeech = false;
  private metrics = {
    realtimeReadyMs: 0,
    firstAudioMs: 0,
    joshuJobCount: 0,
    bargeInCount: 0,
  };
  private t0 = performance.now();
  /** Set on input_audio_buffer.speech_stopped; used for turn latency logs. */
  private lastSpeechStoppedAt: number | null = null;
  /** Goodbye line queued: hang up once its audio drains. */
  private hangUpAfterSpeech = false;
  private hangUpOnMarkDrain = false;
  private lastWrapUpAtMs = 0;

  constructor(private readonly ws: WebSocket) {}

  handleStart(callSid: string, streamSid: string, metadata: StartMetadata): void {
    this.callSid = callSid;
    this.streamSid = streamSid;
    this.t0 = performance.now();
    this.latestMediaTimestamp = 0;
    this.lastAssistantItem = null;
    this.responseStartTimestampTwilio = null;
    this.markQueue = [];
    this.modelAudioPlaysUntil = 0;
    this.hangingUp = false;
    this.startMetadata = metadata;
    this.realtimeGoalAwaitingReply = false;
    this.offeredItems = new Map();
    this.presenceReported = false;
    this.hangUpAfterSpeech = false;
    this.hangUpOnMarkDrain = false;
    this.lastWrapUpAtMs = 0;
    this.openerSent = false;
    this.callerSpokeBeforeOpener = false;
    this.languageCorrected = false;
    const offerDecision = ownerMobileOfferFor(metadata);
    this.ownerMobileOffer = "offer" in offerDecision ? offerDecision.offer : undefined;
    this.ownerMobileSaveTried = false;
    voiceLog(
      callSid,
      "owner-mobile",
      this.ownerMobileOffer
        ? `offer eligible number=…${this.ownerMobileOffer.lastDigits}`
        : `no offer (${"skip" in offerDecision ? offerDecision.skip : ""})`,
    );
    // The gate authenticated this caller before the stream opened, so the model
    // joins an unlocked call and hears nothing stale. Its context is fetched now
    // and goes into the system instruction at setup.
    this.openerPromise = fetchOpener(callSid, metadata.gate.mode);
    voiceLog(callSid, "gate", `stream unlocked by gate via=${metadata.gate.via} mode=${metadata.gate.mode}`);

    const provider = voiceS2sProviderLabel();
    this.s2s = createVoiceS2sClient(
      {
        audioFormat: "pcmu",
        systemPrompt: PHONE_SYSTEM_PROMPT,
        systemPromptExtra: this.openerPromise.then((opener) =>
          buildOpenerContext(metadata.gate.mode, opener, this.ownerMobileOffer),
        ),
        injectPresentation: "voice_only",
        turnDetection: PHONE_VAD,
        // PSTN implements think (+ start_task natively) and dictation; declaring
        // open_desktop made the model fake app opens.
        toolNames: PHONE_TOOL_NAMES,
        ...(this.ownerMobileOffer ? { extraTools: [SAVE_OWNER_MOBILE_TOOL] } : {}),
        thinkingLevel: GEMINI_LIVE_PHONE_THINKING_LEVEL,
      },
      {
        sessionId: callSid,
      onReady: () => {
        this.metrics.realtimeReadyMs = Math.round(performance.now() - this.t0);
        voiceLog(callSid, provider, `session ready ms=${this.metrics.realtimeReadyMs}`);
        void this.openCall();
      },
      onOutputAudioDelta: ({ deltaB64, itemId }) => this.forwardMulawDelta(deltaB64, itemId),
      onSpeechStarted: () => void this.handleSpeechStarted(),
      onInterrupted: () => {
        voiceLog(this.callSid, "vad", "gemini generation interrupted (local cancel)");
        this.logInterruptedSpeech();
      },
      onInputTranscript: (text) => this.onGeminiInputTranscript(text),
      onSpeechStopped: () => {
        this.lastSpeechStoppedAt = performance.now();
        voiceLog(this.callSid, "vad", "user speech stopped (awaiting transcript)");
      },
      onTranscriptionComplete: (text) => this.handleUserTranscription(text),
        onAssistantTranscript: (delta) => {
          this.assistantPartial += delta;
          this.responseHadSpeech = true;
        },
      onResponseStarted: ({ reason, seq }) => {
        if (this.activeJob && reason === "organic") {
          voiceWarn(this.callSid, "think", "cancel unexpected organic speech during brain job", {
            seq,
          });
          this.s2s?.cancelActiveResponse();
          return;
        }
        // OpenAI PSTN: manual turn (create_response=false). Gemini auto-responds like browser.
        if (
          this.geminiPhone &&
          reason === "organic" &&
          this.dictation?.active
        ) {
          voiceLog(this.callSid, "dictation", "suppress organic speech while buffering", { seq });
          this.s2s?.cancelActiveResponse();
          return;
        }
        if (
          !this.geminiPhone &&
          reason === "organic" &&
          !this.joshuInitiatedResponse
        ) {
          voiceWarn(this.callSid, "turn", `turn #${this.turn} UNEXPECTED organic response — cancelling`, {
            hint: "VAD noise — Joshu gates replies until transcript is classified",
          });
          this.s2s?.cancelActiveResponse();
          return;
        }
        this.joshuInitiatedResponse = false;

        this.responseNum += 1;
        this.currentResponseReason = reason;
        this.responseHadSpeech = false;

        const tag = `turn #${this.turn} resp #${this.responseNum}`;
        voiceLog(this.callSid, "turn", `${tag} SPEECH START source=${reason} seq=${seq}`);
      },
      onResponseDone: (info) => {
        this.responsesDone = this.responseNum;
        if (info.status === "cancelled") {
          voiceLog(this.callSid, provider, `resp #${this.responseNum} response.cancelled`);
          return;
        }
        this.flushAssistantSpeech(this.currentResponseReason);
        if (!this.nativeTools) this.logSpokeBeforeThink(info);
        voiceLog(this.callSid, provider, `resp #${this.responseNum} response.done`, info);
        if (
          this.geminiPhone &&
          this.currentResponseReason === "organic" &&
          this.responseHadSpeech &&
          this.geminiUserTurnNeedsReply
        ) {
          this.geminiUserTurnNeedsReply = false;
        }
        this.handleResponseDone(info);
        if (this.hangUpAfterSpeech && this.responseHadSpeech) {
          // Goodbye spoken: end the call once Twilio has played it out.
          this.hangUpAfterSpeech = false;
          this.hangUpOnMarkDrain = true;
          this.sendMark();
        }
        if (
          this.realtimeGoalAckPending &&
          this.currentResponseReason === "hermes_inject" &&
          this.responseHadSpeech
        ) {
          this.realtimeGoalResponseDone = true;
          // A trailing mark is acknowledged only after Twilio drains all
          // callback-result audio queued before it.
          this.sendMark();
        }
      },
      onFunctionCall: (call) => void this.handleFunctionCall(call),
      onInteractionIdle: ({ functionCalls }) => {
        if (functionCalls.length) {
          voiceLog(this.callSid, provider, "interaction idle", { functionCalls });
        }
        this.checkWorkClaim(functionCalls);
      },
      onSessionResumed: ({ reason }) => {
        voiceLog(this.callSid, provider, "upstream session resumed", { reason });
      },
      onError: (msg) => voiceWarn(this.callSid, provider, msg),
      },
    );
    this.nativeTools = this.s2s.nativeAsyncTools;
    voiceLog(callSid, provider, `tool mode=${this.nativeTools ? "native_async" : "legacy"}`);

    this.s2s.connect();
    // "Unlocked." plays while the model session comes up; the opener queues behind it.
    if (metadata.gate.via !== "trusted") {
      const clip = getLockPromptClip("unlocked");
      if (clip) this.playMulawClip(clip.mulawB64);
    }
    voiceLog(callSid, "twilio", `stream start streamSid=${streamSid}`);
  }

  handleInboundMulawPayload(b64: string, timestampMs?: number): void {
    if (timestampMs != null && Number.isFinite(timestampMs)) {
      this.latestMediaTimestamp = timestampMs;
    }
    this.s2s?.appendMulaw8kB64(b64);
  }

  handleMark(): void {
    if (this.markQueue.length) this.markQueue.shift();
    if (this.hangUpOnMarkDrain && this.markQueue.length === 0) {
      this.hangUpOnMarkDrain = false;
      voiceLog(this.callSid, "wrap-up", "goodbye played — hanging up");
      this.hangUpSilently();
      return;
    }
    if (
      this.realtimeGoalAckPending &&
      this.realtimeGoalResponseDone &&
      this.markQueue.length === 0
    ) {
      this.realtimeGoalAckPending = false;
      this.realtimeGoalResponseDone = false;
      void this.ackRealtimeGoalPlayback();
    }
  }

  close(): void {
    if (this.pendingPollTimer) clearInterval(this.pendingPollTimer);
    this.pendingPollTimer = null;
    if (this.presenceReported) {
      void this.postJoshu("/api/realtime-goals/voice/presence", { callSid: this.callSid, event: "ended" });
    }
    // An answer still being worked on is texted when it lands — hanging up
    // must not throw away work the caller asked for (e.g. "email me that").
    this.detachActiveJob();
    this.detachNativeJobs();
    this.detachLateJobs();
    this.dictation = null;
    voiceLog(this.callSid, "twilio", "stream close", this.metrics);
    this.s2s?.close();
    this.s2s = null;
  }

  /**
   * Write a clip to the caller. Twilio buffers and paces playback itself, so
   * frames go out back to back; the trailing mark tells us when it drained.
   */
  private playMulawClip(mulawB64: string): void {
    const sid = this.streamSid;
    if (!sid || this.ws.readyState !== 1) return;
    const raw = Buffer.from(mulawB64, "base64");
    for (let offset = 0; offset < raw.length; offset += MULAW_FRAME_BYTES) {
      this.ws.send(
        JSON.stringify({
          event: "media",
          streamSid: sid,
          media: { payload: raw.subarray(offset, offset + MULAW_FRAME_BYTES).toString("base64") },
        }),
      );
    }
    this.sendMark();
  }

  private forwardMulawDelta(deltaB64: string, itemId?: string): void {
    const sid = this.streamSid;
    if (!sid || this.ws.readyState !== 1 || !deltaB64) return;
    if (this.activeJob && this.currentResponseReason === "organic") return;

    if (itemId && itemId !== this.lastAssistantItem) {
      this.responseStartTimestampTwilio = this.latestMediaTimestamp;
      this.lastAssistantItem = itemId;
      this.sendMark();
    }

    if (!this.metrics.firstAudioMs) {
      this.metrics.firstAudioMs = Math.round(performance.now() - this.t0);
    }

    const now = performance.now();
    const chunkMs = Buffer.byteLength(deltaB64, "base64") / MULAW_BYTES_PER_MS;
    this.modelAudioPlaysUntil = Math.max(now, this.modelAudioPlaysUntil) + chunkMs;

    this.ws.send(
      JSON.stringify({
        event: "media",
        streamSid: sid,
        media: { payload: deltaB64 },
      }),
    );
  }

  private sendMark(): void {
    const sid = this.streamSid;
    if (!sid || this.ws.readyState !== 1) return;
    this.ws.send(
      JSON.stringify({
        event: "mark",
        streamSid: sid,
        mark: { name: "responsePart" },
      }),
    );
    this.markQueue.push("responsePart");
  }

  private handleUserTranscription(text: string): void {
    const kind = classifyUserTranscript(text);
    const s2s = this.s2s;
    if (!s2s) return;
    if (this.hangingUp) return;

    if (kind === "empty") {
      voiceLog(this.callSid, "turn", "empty input (VAD only, no transcript) — ignoring");
      return;
    }

    this.turn += 1;
    this.noteCallerSpokeBeforeOpener(text);

    if (kind === "unclear") {
      if (this.nativeTools) {
        // Native: the model hears the audio itself and decides whether "mmm" or a
        // half sentence needs a reply. A Joshu reprompt on top of that talked over the
        // caller while they were still thinking (canary box 2026-09-25 "mmm" test).
        voiceLog(this.callSid, "turn", `#${this.turn} USER (unclear) → ${JSON.stringify(text)} — model decides`);
        return;
      }
      voiceLog(this.callSid, "turn", `#${this.turn} USER (unclear) → ${JSON.stringify(text)} — reprompting`);
      this.joshuInitiatedResponse = true;
      s2s.injectRepromptMessage();
      return;
    }

    const transcriptMs =
      this.lastSpeechStoppedAt != null
        ? Math.round(performance.now() - this.lastSpeechStoppedAt)
        : null;
    this.lastSpeechStoppedAt = null;
    voiceLog(this.callSid, "turn", `#${this.turn} USER → ${JSON.stringify(text)}`, {
      transcriptAfterSpeechStopMs: transcriptMs,
      vadMode: PHONE_VAD_MODE,
      ...(PHONE_VAD_MODE === "server_vad" ? { silenceMs: PHONE_VAD_SILENCE_MS } : { eagerness: PHONE_VAD_EAGERNESS }),
    });
    const safeText = this.sanitizeTextForThinkContext(text);
    if (safeText) this.pushTranscript("user", safeText);
    if (safeText && this.realtimeGoalAwaitingReply) {
      this.realtimeGoalAwaitingReply = false;
      s2s.cancelActiveResponse();
      void this.submitRealtimeGoalReply(safeText);
      return;
    }
    // Native: the model says goodbye itself and ends the call with end_call.
    if (safeText && !this.nativeTools && this.handleWrapUp(safeText)) return;
    this.continueTurn(safeText);
  }

  private lastAssistantText(): string | undefined {
    return this.transcript.filter((t) => t.role === "assistant").at(-1)?.text;
  }

  /**
   * "No, that's it" / "No thanks" after "Anything else?" / "I'm waiting":
   * answer locally instead of sending the words to the brain as a request.
   * Returns true when the turn was consumed.
   */
  private handleWrapUp(text: string): boolean {
    const kind = classifyWrapUp(text);
    if (!kind) return false;
    const jobPending = this.hasPendingJob();
    if (!wrapUpApplies(kind, this.lastAssistantText(), jobPending)) return false;
    const now = performance.now();
    // Same utterance arrives as a transcript and inside the model's think call.
    if (now - this.lastWrapUpAtMs < WRAP_UP_DEDUPE_MS) return true;
    this.lastWrapUpAtMs = now;
    voiceLog(this.callSid, "wrap-up", `#${this.turn} ${kind}`, { jobPending });
    if (this.geminiPhone && this.currentResponseReason === "organic") {
      this.s2s?.cancelActiveResponse();
    }
    if (!jobPending) this.hangUpAfterSpeech = true;
    this.joshuInitiatedResponse = true;
    this.s2s?.injectControlMessage(wrapUpLine(kind, jobPending));
    return true;
  }

  /**
   * Normal handling of an unlocked caller turn (dictation buffer, or let the
   * model answer). Also the fallback when a goal-callback reply turns out not
   * to be about the goal. `forceResponse` re-requests a reply the caller's
   * turn already had cancelled.
   */
  private continueTurn(safeText: string, options: { forceResponse?: boolean } = {}): void {
    const s2s = this.s2s;
    if (!s2s) return;
    if (safeText && this.dictation?.active) {
      this.onDictationUserTranscript(safeText);
      // Stay silent while buffering — OpenAI path must not request organic chat.
      if (this.geminiPhone) this.geminiUserTurnNeedsReply = false;
      return;
    }
    if (this.nativeTools) {
      // Native: the model decides whether and how to reply (proactive audio is always
      // on). Only re-request a reply Joshu itself cancelled (goal-callback fallthrough).
      if (options.forceResponse) s2s.requestOrganicResponse();
      return;
    }
    if (this.geminiPhone) {
      // A think job is answering this turn; a nudged organic reply would only
      // be cancelled, and its trailing audio collides with the filler/result.
      if (this.activeJob && !options.forceResponse) {
        this.geminiUserTurnNeedsReply = false;
        return;
      }
      if (options.forceResponse || (this.geminiUserTurnNeedsReply && !this.responseHadSpeech)) {
        voiceLog(this.callSid, "turn", `#${this.turn} gemini auto-reply was silent — nudging response`);
        this.geminiUserTurnNeedsReply = false;
        s2s.requestOrganicResponse();
      } else {
        this.geminiUserTurnNeedsReply = false;
      }
      return;
    }
    this.joshuInitiatedResponse = true;
    s2s.requestOrganicResponse();
  }

  /** Outbound callback Joshu placed for a batch of results (signed start params). */
  private isGoalCallback(): boolean {
    return Boolean(
      this.startMetadata?.realtimeGoalBatchId?.trim() && this.startMetadata?.realtimeGoalBatchToken?.trim(),
    );
  }

  /**
   * Authenticated request to Joshu's callback API for this call's batch.
   * `suffix` is "" (content), "/ack", or "/reply".
   */
  private realtimeGoalRequest(
    suffix: "" | "/ack" | "/reply",
    init: { method?: "GET" | "POST"; body?: unknown; timeoutMs?: number } = {},
  ): Promise<Response> | undefined {
    const batchId = this.startMetadata?.realtimeGoalBatchId?.trim();
    const batchToken = this.startMetadata?.realtimeGoalBatchToken?.trim();
    if (!batchId || !batchToken) return undefined;
    const base = { path: `batch/${encodeURIComponent(batchId)}`, token: batchToken };
    const method = init.method ?? "GET";
    return fetch(
      `${JOSHU_API_BASE}/api/realtime-goals/voice/${base.path}${suffix}?token=${encodeURIComponent(base.token)}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${HERMES_API_KEY}`,
          "X-Joshu-Voice-Call-Sid": this.callSid,
          ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
        },
        ...(method === "POST" ? { body: JSON.stringify(init.body ?? {}) } : {}),
        signal: AbortSignal.timeout(init.timeoutMs ?? 10_000),
      },
    );
  }

  /** End the call without another word. */
  private hangUpSilently(): void {
    this.hangingUp = true;
    this.clearOutbound();
    setTimeout(() => {
      try {
        this.ws.close();
      } catch {
        // no-op
      }
    }, 250);
  }

  private async deliverRealtimeGoalCallback(): Promise<void> {
    if (!this.isGoalCallback() || !this.s2s) return;
    try {
      const response = await this.realtimeGoalRequest("");
      if (!response?.ok) throw new Error(`result HTTP ${response?.status ?? "unavailable"}`);
      const payload = (await response.json()) as {
        text?: string;
        kind?: "blocked" | "completed";
        ownerRequested?: boolean;
        items?: PendingResult[];
      };
      const result = payload.text?.trim();
      if (!result && (payload.ownerRequested || this.startMetadata?.ownerRequested)) {
        // "Call me back" with nothing new to report.
        this.s2s.injectAssistantMessage("", "requested_callback");
        return;
      }
      if (!result) throw new Error("empty callback result");
      if (payload.items?.length) this.registerOffered(payload.items, true);
      this.realtimeGoalAwaitingReply = payload.kind === "blocked";
      this.realtimeGoalAckPending = true;
      this.realtimeGoalResponseDone = false;
      this.s2s.injectAssistantMessage(
        result,
        payload.kind === "blocked" ? "callback_question" : "callback_answer",
      );
    } catch (error) {
      voiceWarn(this.callSid, "goal-callback", "result delivery failed", {
        error: (error as Error).message,
      });
      this.s2s.injectAssistantMessage(
        "I couldn't load that completed task just now. I'll keep it queued for another callback. Is there anything else?",
      );
    }
  }

  private async ackRealtimeGoalPlayback(): Promise<void> {
    await this.realtimeGoalRequest("/ack", { method: "POST", timeoutMs: 5_000 })?.catch((error) => {
      voiceWarn(this.callSid, "goal-callback", "playback ack failed", {
        error: (error as Error).message,
      });
    });
  }

  /**
   * Hand the caller's reply to Joshu, which routes it: an answer goes onto the
   * card; a status question, cancel, or unrelated request does not.
   */
  private async submitRealtimeGoalReply(text: string): Promise<void> {
    if (!this.isGoalCallback() || !this.s2s) return;
    try {
      const response = await this.realtimeGoalRequest("/reply", {
        method: "POST",
        body: { text, sourceId: `${this.callSid}:${this.turn}` },
      });
      if (!response?.ok) throw new Error(`reply HTTP ${response?.status ?? "unavailable"}`);
      const payload = (await response.json()) as {
        handled?: boolean;
        reply?: string;
        awaitingReply?: boolean;
      };
      // Older Joshu builds omit `handled` and always treated the reply as the answer.
      if (payload.handled === false) {
        voiceLog(this.callSid, "goal-callback", "reply not about the goal — normal turn");
        this.continueTurn(text, { forceResponse: true });
        return;
      }
      this.realtimeGoalAwaitingReply = payload.awaitingReply === true;
      this.s2s.injectAssistantMessage(
        payload.reply?.trim() ||
          "Got it. I added that detail and restarted the work. Is there anything else?",
      );
    } catch (error) {
      voiceWarn(this.callSid, "goal-callback", "owner reply handoff failed", {
        error: (error as Error).message,
      });
      this.s2s.injectAssistantMessage(
        "I couldn't attach that answer just now. Please try again, or tell me something else you'd like handled.",
      );
      this.realtimeGoalAwaitingReply = true;
    }
  }

  /** Control secret is used only for unlock checks; never forward it to Hermes context. */
  private sanitizeTextForThinkContext(text: string): string {
    const password = resolveTwilioThinkPassword().trim();
    if (!password) return text;
    return redactPassphrase(text, password);
  }

  private onGeminiInputTranscript(text: string): void {
    if (!this.geminiPhone || !text.trim()) return;
    this.noteCallerSpokeBeforeOpener(text);
    // Legacy only: nudge a reply if Gemini's auto-reply stays silent.
    if (!this.nativeTools) this.geminiUserTurnNeedsReply = true;
  }

  /** Audio is on the wire — either model deltas or a lock clip Twilio has not drained. */
  private assistantIsSpeaking(): boolean {
    return (
      Boolean(this.lastAssistantItem) ||
      this.markQueue.length > 0 ||
      Boolean(this.assistantPartial.trim()) ||
      performance.now() < this.modelAudioPlaysUntil
    );
  }

  /** After greeting finishes, clear Twilio mark state so the first caller turn is not treated as barge-in. */
  private resetAssistantPlaybackState(): void {
    this.markQueue = [];
    this.lastAssistantItem = null;
    this.responseStartTimestampTwilio = null;
    this.assistantPartial = "";
  }

  private handleSpeechStarted(): void {
    // speech_started fires on normal user turns too — only barge-in while assistant is playing.
    if (!this.assistantIsSpeaking()) {
      voiceLog(this.callSid, "vad", "user speech started (listening — not barge-in)");
      return;
    }

    // During think, only interrupt casual S2S — not progress ticks or Hermes summary playback.
    if (this.activeJob && this.currentResponseReason !== "organic") {
      voiceLog(this.callSid, "vad", "user speech during think progress (not barge-in)");
      return;
    }

    this.metrics.bargeInCount += 1;
    voiceLog(this.callSid, "vad", "user speech started (barge-in, interrupting assistant)");
    this.s2s?.cancelActiveResponse();
    this.joshuInitiatedResponse = false;
    this.logInterruptedSpeech();

    if (
      this.lastAssistantItem &&
      this.markQueue.length > 0 &&
      this.responseStartTimestampTwilio != null
    ) {
      const elapsedMs = this.latestMediaTimestamp - this.responseStartTimestampTwilio;
      this.s2s?.truncateItem(this.lastAssistantItem, elapsedMs);
    }

    this.clearOutbound();
    this.markQueue = [];
    this.lastAssistantItem = null;
    this.responseStartTimestampTwilio = null;
  }

  private flushAssistantSpeech(source: ResponseSpeechReason, interrupted = false): void {
    const t = this.assistantPartial.trim();
    if (!t) return;
    voiceLog(
      this.callSid,
      "turn",
      `turn #${this.turn} resp #${this.responseNum} SPEECH OUT${interrupted ? " (interrupted)" : ""} source=${source}`,
      {
        text: t.slice(0, 400),
        chars: t.length,
      },
    );
    this.logSpeechWhileToolPending(t, source);
    this.transcript.push({ role: "assistant", text: t });
    this.assistantPartial = "";
    this.noteSpokenForDelivery(t);
    this.checkReplyLanguage(t);
    this.checkDeliveryClaim(t, source);
    if (this.nativeTools && source === "organic") this.workClaims.noteReply(t, interrupted);
  }

  /** Native: a work claim with no tool call behind it gets a note (workClaimGuard.ts). */
  private checkWorkClaim(functionCalls: readonly string[]): void {
    if (!this.nativeTools) return;
    const nudge = this.workClaims.onInteractionEnd({
      functionCalls,
      toolRunning: this.hasPendingJob() || this.lateJobs.size > 0,
      callEnding: this.hangingUp || this.endCallRequested || this.hangUpAfterSpeech,
    });
    sendWorkClaimNudge(this.s2s, this.callSid, nudge);
  }

  /** A send claimed while the answer is still being worked on is a guess. */
  private checkDeliveryClaim(text: string, source: ResponseSpeechReason): void {
    // Joshu's own relays (late answers, updates) carry real send notes.
    if (!this.nativeTools || source === "hermes_inject") return;
    const toolPending = [...this.nativeJobs.values()].some((job) => !job.detached);
    // A finished result can back a claim — unless the answer is still coming ("working").
    const pending = this.lateJobs.size > 0 || (toolPending && source !== "function_result");
    if (!pending) return;
    const claim = detectDeliveryClaim(text);
    if (!claim) return;
    this.pendingDeliveryClaims.push(claim);
    voiceWarn(this.callSid, "eval", "ANTIPATTERN delivery-claim-before-result", {
      claim,
      spoke: text.slice(0, 200),
    });
  }

  /** Correction to attach to a result that does not back an earlier claim (clears the claims). */
  private takeClaimCorrection(answer: string, delivered: import("./brainThink.js").DeliveredFact[] | undefined): string | undefined {
    const correction = claimCorrection(this.pendingDeliveryClaims, answer, delivered);
    this.pendingDeliveryClaims = [];
    return correction;
  }

  /**
   * The model answered in a language the owner does not speak (it picks the reply
   * language from what it hears). Log every time; correct it once per call.
   */
  private checkReplyLanguage(text: string): void {
    const ownerLanguage = resolveOwnerLanguage();
    const verdict = detectLanguageMismatch(text, ownerLanguage);
    if (!verdict.mismatch) return;
    voiceWarn(this.callSid, "turn", "ANTIPATTERN language-mismatch", {
      detected: verdict.detected,
      ownerLanguage,
      preview: text.slice(0, 120),
    });
    if (this.languageCorrected) return;
    this.languageCorrected = true;
    this.s2s?.appendContext(languageCorrection(ownerLanguage, verdict.detected));
  }

  /** The owner is already talking — the opener would talk over them. */
  private noteCallerSpokeBeforeOpener(text: string): void {
    if (this.openerSent || this.callerSpokeBeforeOpener) return;
    if (classifyUserTranscript(text) !== "clear") return;
    this.callerSpokeBeforeOpener = true;
    voiceLog(this.callSid, "opener", "owner spoke before the opener");
  }

  /**
   * Model session ready: add the owner context if setup missed it,
   * then open the call with exactly one Joshu-written turn — the greeting (with
   * any unheard results offered by title) or, on a callback, the update itself.
   */
  private async openCall(): Promise<void> {
    const gate = this.startMetadata?.gate;
    if (!gate || !this.s2s) return;
    const opener = (await this.openerPromise) ?? undefined;
    const s2s = this.s2s;
    if (!s2s) return;
    if (!opener) {
      // Joshu did not record the unlock; presence still matters (no callbacks mid-call).
      await this.postJoshu("/api/realtime-goals/voice/presence", { callSid: this.callSid, event: "unlocked" });
    }
    this.presenceReported = true;
    if (!s2s.systemPromptExtraApplied) {
      s2s.appendContext(buildOpenerContext(gate.mode, opener, this.ownerMobileOffer));
    }
    const items = opener?.items ?? [];
    if (gate.mode === "callback") {
      this.openerSent = true;
      await this.deliverRealtimeGoalCallback();
    } else {
      if (items.length) this.registerOffered(items, false);
      if (this.callerSpokeBeforeOpener) {
        voiceLog(this.callSid, "opener", "skipped — the owner is already talking", { unheard: items.length });
      } else {
        this.openerSent = true;
        s2s.injectAssistantMessage(buildInboundOpenerTurn(JOSHU_IDENTITY.owner.displayName, items), "control_turn");
      }
      this.openerSent = true;
    }
    voiceLog(this.callSid, "opener", `call opened mode=${gate.mode} via=${gate.via}`, {
      msSinceStreamStart: Math.round(performance.now() - this.t0),
      unheard: items.length,
      contextInSetup: s2s.systemPromptExtraApplied === true,
    });
    if (!this.s2s || this.pendingPollTimer) return;
    this.pendingPollTimer = setInterval(() => void this.pollPendingResults(false), PENDING_POLL_MS);
    this.pendingPollTimer.unref?.();
  }

  /**
   * The caller talked over the model (or Joshu superseded its turn). What it had
   * said was heard — log it (it used to vanish from the logs, so a call could not
   * be reconstructed) and, on the native path, keep it in the transcript.
   */
  private logInterruptedSpeech(): void {
    const t = this.assistantPartial.trim();
    if (!t) return;
    if (this.nativeTools) {
      this.flushAssistantSpeech(this.currentResponseReason, true);
      return;
    }
    voiceLog(this.callSid, "turn", `turn #${this.turn} resp #${this.responseNum} SPEECH OUT (interrupted) source=${this.currentResponseReason}`, {
      text: t.slice(0, 400),
      chars: t.length,
    });
    this.assistantPartial = "";
    this.noteSpokenForDelivery(t);
  }

  /**
   * Native eval signal: what the model said while a tool it called was still running.
   * A short ack is expected; owner facts here are the hallucination we measure
   * (grep `owner-fact-before-result`).
   */
  private logSpeechWhileToolPending(text: string, source: ResponseSpeechReason): void {
    if (!this.nativeTools || source === "function_result") return;
    const pending = [...this.nativeJobs.values()].filter((job) => !job.detached);
    if (pending.length === 0 && this.lateJobs.size === 0) return;
    voiceLog(this.callSid, "eval", "owner-fact-before-result candidate", {
      spoke: text.slice(0, 300),
      pendingTools: [...pending.map((job) => job.tool), ...[...this.lateJobs.keys()].map(() => "think(late)")],
    });
  }

  /** Warn when Realtime spoke (often a denial) then called think in the same response. */
  private logSpokeBeforeThink(info: Record<string, unknown>): void {
    const fnCalls = Array.isArray(info.functionCalls) ? info.functionCalls : [];
    const calledThink = fnCalls.some((n) => normalizeThinkToolName(String(n)) === "think");
    if (!calledThink) return;

    if (!this.responseHadSpeech) return;

    const spoke = this.transcript.filter((t) => t.role === "assistant").at(-1)?.text ?? "";
    const denial = LIMITATION_DENIAL_RE.test(spoke);
    voiceWarn(this.callSid, "turn", `#${this.turn} ANTIPATTERN spoke-before-think`, {
      spokePreview: spoke.slice(0, 200),
      likelyDenial: denial,
      hint: "Realtime spoke in the same turn as think — user may hear a refusal, then the real answer",
    });
  }

  private flushAssistantPartial(): void {
    // Native: keep what the model said when the caller talks over it — 3.8 replies while
    // the caller is still going, and discarding hid those replies from the logs and the
    // think context. Legacy: discard — flushing split one reply into several SPEECH OUT lines.
    if (this.nativeTools) {
      this.flushAssistantSpeech(this.currentResponseReason);
      return;
    }
    this.assistantPartial = "";
  }

  private pushTranscript(role: "user" | "assistant", text: string): void {
    if (role === "user") {
      this.flushAssistantPartial();
      this.noteOwnerSpokeForDelivery();
      this.workClaims.noteOwnerSpoke();
    }
    this.transcript.push({ role, text });
    while (this.transcript.length > MAX_TRANSCRIPT_TURNS) {
      this.transcript.shift();
    }
  }

  private conversationSummary(): string {
    return this.transcript
      .map((t) => `${t.role}: ${t.text}`)
      .join("\n")
      .slice(-4000);
  }

  /** Most recent user transcript line — STT fallback when Realtime omits user_quote. */
  private lastUserTranscript(): string | undefined {
    for (let i = this.transcript.length - 1; i >= 0; i--) {
      const turn = this.transcript[i];
      if (turn?.role === "user" && turn.text.trim()) return turn.text.trim();
    }
    return undefined;
  }

  private cancelActiveJob(): void {
    if (!this.activeJob) return;
    this.clearProgressTimer(this.activeJob);
    this.activeJob.abort.abort();
    voiceLog(this.callSid, "joshu", `cancelled job=${this.activeJob.jobId}`);
    this.activeJob = null;
  }

  /** Call ended mid-think: let the job finish and text its answer (bounded). */
  private detachActiveJob(): void {
    const job = this.activeJob;
    if (!job) return;
    this.clearProgressTimer(job);
    job.detached = true;
    job.progress.phase = "done";
    this.activeJob = null;
    const timer = setTimeout(() => job.abort.abort(), DETACHED_JOB_MAX_MS);
    timer.unref?.();
    voiceLog(this.callSid, "joshu", `detached job=${job.jobId} — answer will be texted`);
  }

  private clearProgressTimer(job: ActiveJoshuJob): void {
    if (job.progress.timer) {
      clearTimeout(job.progress.timer);
      job.progress.timer = null;
    }
  }

  /** Schedule next progress line only after prior speech finishes (no overlap). */
  private handleResponseDone(info: Record<string, unknown>): void {
    const job = this.activeJob;
    if (!job || job.progress.phase === "done") return;
    if (info.status === "cancelled") return;

    const { progress } = job;

    if (progress.phase === "awaiting_ack") {
      progress.phase = "idle";
      voiceLog(this.callSid, "joshu", `progress ack done job=${job.jobId}, first tick in ${HERMES_PROGRESS_FIRST_DELAY_MS}ms`);
      this.scheduleProgressTick(job.jobId, HERMES_PROGRESS_FIRST_DELAY_MS);
      return;
    }

    if (progress.phase === "awaiting_speech") {
      progress.phase = "idle";
      const gap = HERMES_PROGRESS_INTERVAL_MS + HERMES_PROGRESS_POST_SPEECH_MS;
      voiceLog(this.callSid, "joshu", `progress speech done job=${job.jobId}, next tick in ${gap}ms`);
      this.scheduleProgressTick(job.jobId, gap);
    }
  }

  private scheduleProgressTick(jobId: string, delayMs: number): void {
    const job = this.activeJob;
    if (!job || job.jobId !== jobId || job.progress.phase === "done") return;

    this.clearProgressTimer(job);
    job.progress.timer = setTimeout(() => this.fireProgressTick(jobId), delayMs);
  }

  private fireProgressTick(jobId: string): void {
    const job = this.activeJob;
    if (!job || job.jobId !== jobId || job.progress.phase === "done") return;

    job.progress.timer = null;
    job.progress.tick += 1;

    if (job.progress.tick > HERMES_PROGRESS_MAX_TICKS) {
      if (!job.progress.longWaitSent) {
        job.progress.longWaitSent = true;
        job.progress.phase = "awaiting_speech";
        this.s2s?.injectProgressMessage("This is taking a bit longer than usual.");
        voiceLog(this.callSid, "joshu", `progress long-wait job=${jobId} tick=${job.progress.tick}`);
      }
      return;
    }

    job.progress.phase = "awaiting_speech";
    if (job.progress.tick === TEXT_OFFER_TICK) {
      this.s2s?.injectControlMessage(TEXT_OFFER_LINE);
      voiceLog(this.callSid, "joshu", `progress text-offer job=${jobId} tick=${job.progress.tick}`);
      return;
    }
    const phrase = PROGRESS_PHRASES[(job.progress.tick - 1) % PROGRESS_PHRASES.length]!;
    this.s2s?.injectProgressMessage(phrase);
    voiceLog(this.callSid, "joshu", `progress job=${jobId} tick=${job.progress.tick} phrase=${JSON.stringify(phrase)}`);
  }

  private async handleFunctionCall(call: FunctionCallPayload): Promise<void> {
    const s2s = this.s2s;
    if (!s2s) return;

    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(call.argumentsJson) as Record<string, unknown>;
    } catch {
      args = {};
    }

    // Single brain path; accept legacy tool names from older prompts.
    const toolName = normalizeThinkToolName(call.name);

    voiceLog(this.callSid, "tool", `invoke ${toolName}`, {
      callId: call.callId,
      // The model sometimes wraps the passphrase in tool args; keep it out of logs.
      args: Object.fromEntries(
        Object.entries(args).map(([key, value]) => [
          key,
          typeof value === "string" ? this.sanitizeTextForThinkContext(value) : value,
        ]),
      ),
    });

    if (toolName === "start_dictation") {
      this.handleStartDictation(call.callId, args);
      return;
    }
    if (toolName === "finish_dictation") {
      this.handleFinishDictation(call.callId, args);
      return;
    }
    if (toolName === "cancel_dictation") {
      this.handleCancelDictation(call.callId);
      return;
    }

    if (this.nativeTools && toolName === "end_call") {
      this.handleEndCall(call.callId);
      return;
    }

    if (toolName === SAVE_OWNER_MOBILE_TOOL_NAME && this.ownerMobileOffer) {
      await this.handleSaveOwnerMobile(call.callId, this.ownerMobileOffer, args);
      return;
    }

    const nativeJobTool = this.nativeTools && NATIVE_JOB_TOOL_NAMES.has(toolName);
    if (toolName !== "think" && !nativeJobTool) {
      // Not declared to the model on PSTN (see PHONE_TOOL_NAMES) — hallucinated call.
      voiceWarn(this.callSid, "tool", `unsupported tool on phone: ${call.name}`);
      s2s.sendFunctionOutput(
        call.callId,
        JSON.stringify({
          status: "unsupported",
          message: `${call.name} is not available on a phone call. Nothing happened — do not tell the caller it worked. Use think instead.`,
        }),
      );
      return;
    }

    const rawUserQuote = typeof args.user_quote === "string" ? args.user_quote : undefined;

    // The model hears audio directly and often calls think before our transcript
    // lands — "No, thank you" must not become a request (or a goal update).
    const quotedWrapUp = rawUserQuote ? this.sanitizeTextForThinkContext(rawUserQuote) : "";
    if (quotedWrapUp && !this.nativeTools && this.handleWrapUp(quotedWrapUp)) {
      voiceLog(this.callSid, "wrap-up", "ignored think — caller is wrapping up");
      this.declineToolCall(
        call.callId,
        {
          status: "ignored",
          reason: "caller_wrapping_up",
          message: "The caller is wrapping up, not asking for anything. Joshu is saying goodbye; stay silent.",
        },
        "Nothing to look up — the caller is wrapping up, not asking for anything.",
      );
      return;
    }

    const intent = String(args.intent ?? "task");
    const summary = this.sanitizeTextForThinkContext(String(args.summary ?? this.conversationSummary()));
    const userQuote = resolveThinkUserQuote(
      rawUserQuote ? this.sanitizeTextForThinkContext(rawUserQuote) || undefined : undefined,
      this.lastUserTranscript(),
    );
    const jobId = randomUUID().slice(0, 8);

    if (nativeJobTool) {
      this.startNativeJob(call.callId, toolName, jobId, { args, intent, summary, userQuote });
      return;
    }

    voiceLog(this.callSid, "turn", `#${this.turn} THINK START job=${jobId} intent=${JSON.stringify(intent)}`, {
      userQuote,
      hasUserQuote: Boolean(userQuote),
      summaryPreview: summary.slice(0, 120),
    });
    // No response.create on tool output — Realtime will guess/hallucinate if we let it speak here.
    s2s.sendFunctionOutput(
      call.callId,
      JSON.stringify({
        status: "accepted",
        job_id: jobId,
        message: `${JOSHU_IDENTITY.name} is checking — wait for the brain result before speaking.`,
      }),
      { triggerResponse: false },
    );
    s2s.injectProgressMessage("One moment.");

    this.metrics.joshuJobCount += 1;
    this.startJoshuJob({ jobId, intent, summary, userQuote });
  }

  private onDictationUserTranscript(text: string): void {
    if (!this.dictation?.active) return;
    const before = this.dictation.chunks.length;
    this.dictation = appendDictationChunk(this.dictation, text);
    if (this.dictation.chunks.length !== before) {
      voiceLog(this.callSid, "dictation", "buffered chunk", {
        chunks: this.dictation.chunks.length,
        preview: text.slice(0, 120),
      });
    }
    if (looksLikeDictationDone(text) && this.dictation.chunks.length > 0) {
      voiceLog(this.callSid, "dictation", "done phrase — finishing session");
      this.completeDictationAndThink("done_phrase");
    }
  }

  /** Last few user STT lines — dictation start is transcript-gated, not model-quote. */
  private recentUserTexts(n = 3): string[] {
    return this.transcript
      .filter((t) => t.role === "user" && t.text.trim())
      .slice(-n)
      .map((t) => t.text);
  }

  private rejectStartDictation(
    callId: string,
    reason: string,
    message: string,
    triggerResponse: boolean,
  ): void {
    const s2s = this.s2s;
    if (!s2s) return;
    voiceLog(this.callSid, "dictation", `rejected start_dictation (${reason})`);
    s2s.sendFunctionOutput(
      callId,
      JSON.stringify({ status: "rejected", reason, message }),
      { triggerResponse },
    );
  }

  private handleStartDictation(callId: string, args: Record<string, unknown>): void {
    const s2s = this.s2s;
    if (!s2s) return;
    if (!recentUserSpeechLooksLikeDictationStart(this.recentUserTexts())) {
      this.rejectStartDictation(
        callId,
        "not_explicit",
        DICTATION_NOT_EXPLICIT_MESSAGE,
        true,
      );
      return;
    }
    const destination = String(args.destination ?? "").trim() || "Desktop note";
    const title = typeof args.title === "string" ? args.title : undefined;
    this.dictation = createDictationSession({
      destination,
      format: args.format,
      title,
    });
    voiceLog(this.callSid, "dictation", "started", dictationStatusPayload(this.dictation));
    s2s.sendFunctionOutput(
      callId,
      JSON.stringify({
        status: "started",
        ...dictationStatusPayload(this.dictation),
        message:
          "Dictation mode on. Stay nearly silent while the caller speaks. Call finish_dictation when they are done.",
      }),
      { triggerResponse: false },
    );
    this.joshuInitiatedResponse = true;
    s2s.injectProgressMessage("Ready — go ahead.");
  }

  private handleFinishDictation(callId: string, args: Record<string, unknown>): void {
    const s2s = this.s2s;
    if (!s2s) return;
    if (!this.dictation?.active) {
      s2s.sendFunctionOutput(
        callId,
        JSON.stringify({ status: "error", error: "No active dictation session" }),
        { triggerResponse: true },
      );
      return;
    }
    const note = typeof args.note === "string" ? args.note.trim() : "";
    s2s.sendFunctionOutput(
      callId,
      JSON.stringify({
        status: "finishing",
        ...dictationStatusPayload(this.dictation),
        message: `${JOSHU_IDENTITY.name} is formatting and saving the dictation.`,
      }),
      { triggerResponse: false },
    );
    this.completeDictationAndThink("finish_dictation", note);
  }

  private handleCancelDictation(callId: string): void {
    const s2s = this.s2s;
    if (!s2s) return;
    const chunks = this.dictation?.chunks.length ?? 0;
    this.dictation = null;
    voiceLog(this.callSid, "dictation", "cancelled", { chunks });
    s2s.sendFunctionOutput(
      callId,
      JSON.stringify({ status: "cancelled", discarded_chunks: chunks }),
      { triggerResponse: true },
    );
  }

  private completeDictationAndThink(source: string, extraNote = ""): void {
    const session = this.dictation;
    if (!session?.active) return;
    session.active = false;
    const msg = buildDictationThinkMessage(session);
    if (extraNote) {
      msg.summary = `${msg.summary} Note: ${extraNote}`;
    }
    this.dictation = null;
    const jobId = randomUUID().slice(0, 8);
    voiceLog(this.callSid, "dictation", `complete source=${source}`, {
      jobId,
      chunks: session.chunks.length,
      chars: msg.userQuote.length,
      format: session.format,
      destination: session.destination,
    });
    this.joshuInitiatedResponse = true;
    this.s2s?.injectProgressMessage("One moment.");
    this.metrics.joshuJobCount += 1;
    this.startJoshuJob({
      jobId,
      intent: msg.intent,
      summary: this.sanitizeTextForThinkContext(msg.summary),
      userQuote: msg.userQuote,
    });
  }

  /**
   * Answer a tool call Joshu will not act on. Legacy: silent tool output. Native: an
   * ordinary completed result with a plain factual answer. 3.8 treats anything else as
   * a failed tool and later tells the caller "a system error occurred" — measured on
   * the callback replay: `nothing_to_do` + instructions 3–4/6 runs, `done` + answer 1/18.
   */
  private declineToolCall(callId: string, legacy: Record<string, unknown>, nativeAnswer: string): void {
    if (this.nativeTools) {
      this.s2s?.sendFunctionResult(callId, { status: "done", answer: nativeAnswer });
      return;
    }
    this.s2s?.sendFunctionOutput(callId, JSON.stringify(legacy), { triggerResponse: false });
  }

  /**
   * Native: the model said goodbye and asked to end the call. Hang up once its goodbye
   * has finished playing; unfinished tool answers are texted (detach on close).
   */
  private handleEndCall(callId: string): void {
    this.s2s?.sendFunctionResult(callId, {
      status: "ok",
      note: "The call will end after your goodbye finishes playing. Say nothing more.",
    });
    if (this.endCallRequested) return;
    this.endCallRequested = true;
    voiceLog(this.callSid, "wrap-up", "end_call — hanging up after goodbye plays");
    const startedAt = performance.now();
    let quietSince = 0;
    const poll = setInterval(() => {
      const now = performance.now();
      const speaking = this.assistantIsSpeaking() || this.responseInProgress();
      quietSince = speaking ? 0 : quietSince || now;
      // Wait for a short stretch of silence (goodbye may still be generating), bounded.
      if ((quietSince && now - quietSince >= END_CALL_QUIET_MS) || now - startedAt >= END_CALL_MAX_WAIT_MS) {
        clearInterval(poll);
        this.hangUpSilently();
      }
    }, 250);
    poll.unref?.();
  }

  /**
   * Owner mobile offer: the owner said yes, so Joshu saves the caller ID of this call
   * (never a number from the model). One try per call, and a save only on a clear yes.
   */
  private async handleSaveOwnerMobile(
    callId: string,
    offer: OwnerMobileOffer,
    args: Record<string, unknown>,
  ): Promise<void> {
    let outcome: Parameters<typeof ownerMobileSaveAnswer>[0];
    const userQuote = typeof args.user_quote === "string" ? args.user_quote : undefined;
    if (this.ownerMobileSaveTried) {
      outcome = "already_tried";
    } else if (!offerReplyAllowsSave(userQuote, this.lastUserTranscript())) {
      outcome = "not_clear_yes";
      this.ownerMobileSaveTried = true;
    } else {
      this.ownerMobileSaveTried = true;
      const response = await this.postJoshu("/api/telephone/owner-mobile/from-call", {
        callSid: this.callSid,
        caller: offer.caller,
      });
      const status = response
        ? ((await response.json().catch(() => ({}))) as { status?: unknown }).status
        : undefined;
      outcome = status === "saved" || status === "already_set" || status === "invalid" ? status : "failed";
    }
    voiceLog(this.callSid, "owner-mobile", `save ${outcome} number=…${offer.lastDigits}`);
    // Both paths speak this result (legacy: function output + response.create).
    this.s2s?.sendFunctionResult(callId, { status: "done", answer: ownerMobileSaveAnswer(outcome, offer.lastDigits) });
  }

  /** A model response started and has not reported done yet. */
  private responseInProgress(): boolean {
    return this.responseNum > this.responsesDone;
  }

  /** A brain job or native tool call is still working for the caller. */
  private hasPendingJob(): boolean {
    if (this.activeJob && !this.activeJob.detached) return true;
    return [...this.nativeJobs.values()].some((job) => !job.detached);
  }

  /**
   * Native path: run think / start_task in the background. The model keeps the
   * conversation going and speaks the function result itself — no wait line,
   * progress ticks, or injected answer.
   */
  private startNativeJob(
    callId: string,
    tool: string,
    jobId: string,
    params: { args: Record<string, unknown>; intent: string; summary: string; userQuote?: string },
  ): void {
    const job: NativeToolJob = {
      abort: new AbortController(),
      jobId,
      callId,
      tool,
      detached: false,
    };
    this.nativeJobs.set(callId, job);
    this.metrics.joshuJobCount += 1;

    const ref = { callSid: this.callSid, jobId, presentation: "phone" as const };
    const request: NativeToolRequest =
      tool === "start_task"
        ? {
            kind: "start_task",
            task: {
              ...ref,
              title: this.sanitizeTextForThinkContext(String(params.args.title ?? "")),
              objective: this.sanitizeTextForThinkContext(
                String(params.args.objective ?? params.userQuote ?? params.summary),
              ),
              userQuote: params.userQuote,
            },
          }
        : {
            kind: "think",
            think: {
              ...ref,
              intent: params.intent,
              summary: params.summary,
              userQuote: params.userQuote,
              signal: job.abort.signal,
            },
          };

    voiceLog(this.callSid, "turn", `#${this.turn} THINK START job=${jobId} tool=${tool} native`, {
      userQuote: params.userQuote,
      hasUserQuote: Boolean(params.userQuote),
      summaryPreview: params.summary.slice(0, 120),
    });
    void this.runNativeJob(job, request);
  }

  private async runNativeJob(job: NativeToolJob, request: NativeToolRequest): Promise<void> {
    const t0 = performance.now();
    const outcome = await runNativeVoiceTool(request, () => job.detached);
    this.nativeJobs.delete(job.callId);
    if (job.abort.signal.aborted && !job.detached) return;
    const elapsedMs = Math.round(performance.now() - t0);

    if (job.detached) {
      if (outcome.jobId) {
        // Joshu's inline job: the owner outbox delivers it (texted — the call is over).
        const handed = await detachPhoneThinkJob(outcome.jobId);
        voiceLog(this.callSid, "joshu", `detached job=${job.jobId} → Joshu delivers`, { inlineJob: outcome.jobId, handed });
        return;
      }
      // Queue confirmations and errors are not worth a text; real answers are.
      if (outcome.source !== "hermes") return;
      const texted = await textAnswerToOwner(outcome.rawText);
      voiceLog(this.callSid, "joshu", `detached job=${job.jobId} finished ms=${elapsedMs}`, { texted });
      return;
    }

    if (outcome.pending && outcome.jobId) {
      voiceLog(this.callSid, "turn", `#${this.turn} THINK WORKING job=${job.jobId} ms=${elapsedMs} — past budget, following`, {
        inlineJob: outcome.jobId,
      });
      this.s2s?.sendFunctionResult(job.callId, outcome.result);
      this.followLateAnswer(outcome.jobId, request.kind === "think" ? request.think.userQuote : undefined);
      return;
    }

    if (outcome.result.status === "done") {
      const correction = this.takeClaimCorrection(outcome.rawText, outcome.delivered);
      if (correction) outcome.result = { ...outcome.result, correction };
    }

    voiceLog(
      this.callSid,
      "turn",
      `#${this.turn} THINK DONE job=${job.jobId} tool=${job.tool} ms=${elapsedMs} source=${outcome.source} → function result`,
      { preview: JSON.stringify(outcome.result).slice(0, 200) },
    );
    this.s2s?.sendFunctionResult(job.callId, outcome.result);
  }

  /**
   * A phone think outlasted its budget: wait for Joshu's job, then speak the
   * answer at the next idle moment. If the call cannot take it (ended, or the
   * job was delivered elsewhere), Joshu's owner outbox has it.
   */
  private followLateAnswer(jobId: string, quote?: string): void {
    this.lateJobs.set(jobId, { quote });
    const startedAt = Date.now();
    void (async () => {
      try {
        let job = await waitPhoneThinkJob(jobId, LATE_ANSWER_POLL_MS);
        while (job.status === "running" && this.lateJobs.has(jobId) && Date.now() - startedAt < LATE_ANSWER_MAX_MS) {
          job = await waitPhoneThinkJob(jobId, LATE_ANSWER_POLL_MS);
        }
        if (!this.lateJobs.has(jobId) || !this.s2s) return; // call ended — detached in close()
        if (job.status === "running") {
          this.lateJobs.delete(jobId);
          await detachPhoneThinkJob(jobId);
          return;
        }
        const claimed = await claimPhoneThinkJob(jobId);
        this.lateJobs.delete(jobId);
        if (!claimed.claimed || !this.s2s) {
          voiceLog(this.callSid, "joshu", `late answer job=${jobId} not claimed (delivered elsewhere)`);
          return;
        }
        const answer =
          claimed.status === "done"
            ? claimed.answer?.trim() || "I couldn't find an answer to that."
            : "I couldn't finish that one — ask me again in a moment.";
        const correction = this.takeClaimCorrection(answer, claimed.delivered);
        voiceLog(this.callSid, "turn", `#${this.turn} THINK DONE (late) inlineJob=${jobId} ms=${Date.now() - startedAt}`, {
          preview: answer.slice(0, 200),
          delivered: claimed.delivered,
          corrected: Boolean(correction),
        });
        this.s2s.injectAssistantMessage(correction ? `${correction}

${answer}` : answer, "late_answer");
      } catch (error) {
        voiceWarn(this.callSid, "joshu", `late answer job=${jobId} failed`, { error: (error as Error).message });
        if (this.lateJobs.delete(jobId)) await detachPhoneThinkJob(jobId);
      }
    })();
  }

  /** Call ended: Joshu delivers every answer still being followed (owner outbox). */
  private detachLateJobs(): void {
    for (const jobId of this.lateJobs.keys()) {
      voiceLog(this.callSid, "joshu", `late answer job=${jobId} — call ended, Joshu delivers`);
      void detachPhoneThinkJob(jobId);
    }
    this.lateJobs.clear();
  }

  /** Call ended mid-tool: let native jobs finish and text their answers (bounded). */
  private detachNativeJobs(): void {
    for (const job of this.nativeJobs.values()) {
      if (job.detached) continue;
      job.detached = true;
      const timer = setTimeout(() => job.abort.abort(), DETACHED_JOB_MAX_MS);
      timer.unref?.();
      voiceLog(this.callSid, "joshu", `detached job=${job.jobId} tool=${job.tool} — answer will be texted`);
    }
  }

  private startJoshuJob(params: {
    jobId: string;
    intent: string;
    summary: string;
    userQuote?: string;
  }): void {
    this.cancelActiveJob();

    const job: ActiveJoshuJob = {
      abort: new AbortController(),
      jobId: params.jobId,
      progress: {
        tick: 0,
        phase: "awaiting_ack",
        timer: null,
        longWaitSent: false,
      },
      detached: false,
    };
    this.activeJob = job;
    void this.runJoshuJob(params, job);
  }

  private async runJoshuJob(
    params: { jobId: string; intent: string; summary: string; userQuote?: string },
    job: ActiveJoshuJob,
  ): Promise<void> {
    const { abort } = job;
    const t0 = performance.now();
    try {
      const result = await runJoshuThinkDetailed({
        callSid: this.callSid,
        jobId: params.jobId,
        intent: params.intent,
        summary: params.summary,
        userQuote: params.userQuote,
        signal: abort.signal,
        presentation: "phone",
      });
      if (abort.signal.aborted) return;
      const elapsedMs = Math.round(performance.now() - t0);

      if (job.detached) {
        // Broker intake lines ("I'll call you back…") are not worth a text.
        if (result.source !== "hermes") return;
        const texted = await textAnswerToOwner(result.text);
        voiceLog(this.callSid, "joshu", `detached job=${params.jobId} finished ms=${elapsedMs}`, { texted });
        return;
      }

      // Links cannot be spoken: Joshu texts them and returns speakable text.
      const spoken =
        result.source === "hermes" ? await speakableWithLinksTexted(result.text) : result.text;
      if (abort.signal.aborted) return;
      if (job.detached) {
        await textAnswerToOwner(result.text);
        return;
      }
      voiceLog(this.callSid, "turn", `#${this.turn} THINK DONE job=${params.jobId} ms=${elapsedMs} → injecting`, {
        preview: spoken.slice(0, 200),
      });
      this.s2s?.injectAssistantMessage(spoken);
      this.pushTranscript("assistant", spoken);
    } catch (e) {
      if (abort.signal.aborted) return;
      if (job.detached) return;
      const msg = e instanceof Error ? e.message : String(e);
      voiceWarn(this.callSid, "turn", `#${this.turn} THINK FAILED job=${params.jobId}`, { error: msg });
      this.s2s?.injectAssistantMessage(
        `I tried to complete your request but ran into a problem: ${msg}`,
      );
    } finally {
      const job = this.activeJob;
      if (job?.jobId === params.jobId) {
        job.progress.phase = "done";
        this.clearProgressTimer(job);
        this.activeJob = null;
      }
    }
  }

  /** POST to Joshu (loopback + service key). Owner outbox bookkeeping never breaks a call. */
  private async postJoshu(path: string, body: unknown): Promise<Response | undefined> {
    return fetch(`${JOSHU_API_BASE}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${HERMES_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
    }).catch((error: Error) => {
      voiceWarn(this.callSid, "owner-outbox", `POST ${path} failed`, { error: error.message });
      return undefined;
    });
  }

  private async pollPendingResults(asContext: boolean): Promise<void> {
    if (!this.s2s) return;
    const response = await fetch(
      `${JOSHU_API_BASE}/api/realtime-goals/voice/pending?callSid=${encodeURIComponent(this.callSid)}`,
      {
        headers: { Authorization: `Bearer ${HERMES_API_KEY}` },
        signal: AbortSignal.timeout(5_000),
      },
    ).catch(() => undefined);
    if (!response?.ok) return;
    const payload = (await response.json().catch(() => ({}))) as { items?: PendingResult[] };
    const items = (payload.items ?? []).filter((item) => item.text?.trim());
    if (items.length === 0 || !this.s2s) return;
    this.registerOffered(items, !asContext);
    if (asContext) {
      const lines = items.map((item) => `- ${item.title}: ${item.text}`).join("\n");
      this.s2s.appendContext(
        `[Joshu: results the owner has NOT heard yet. Mention them briefly once ("your ${items[0]!.title} results are ready — want them?") and relay them when asked, keeping every time, price, and name exactly as written.]\n${lines}`,
      );
    } else {
      const text =
        items.length === 1
          ? items[0]!.text
          : items.map((item) => `About “${item.title}”: ${item.text}`).join("\n\n");
      this.s2s.injectAssistantMessage(text, "live_update");
    }
    voiceLog(this.callSid, "owner-outbox", `offered ${items.length} unheard result(s) ${asContext ? "as context" : "live"}`, {
      titles: items.map((item) => item.title),
    });
  }

  private registerOffered(items: PendingResult[], injected: boolean): void {
    const now = performance.now();
    for (const item of items) {
      if (this.offeredItems.has(item.id)) continue;
      this.offeredItems.set(item.id, {
        title: item.title,
        text: item.text,
        offeredAtMs: now,
        spoken: "",
        injected,
      });
    }
  }

  /** The model said something: results whose key facts it covered were heard. */
  private noteSpokenForDelivery(text: string): void {
    if (this.offeredItems.size === 0) return;
    const heard: string[] = [];
    for (const [id, item] of this.offeredItems) {
      item.spoken = `${item.spoken} ${text}`.slice(-8_000);
      if (spokenCovers(item.text, item.spoken)) heard.push(id);
    }
    this.reportHeard(heard, "transcript_coverage");
  }

  /** The owner answered while a handed-over result was being spoken. */
  private noteOwnerSpokeForDelivery(): void {
    if (this.offeredItems.size === 0) return;
    const now = performance.now();
    const heard = [...this.offeredItems]
      .filter(
        ([, item]) =>
          item.injected &&
          now - item.offeredAtMs >= OWNER_REPLY_HEARD_MIN_MS &&
          item.spoken.trim().length >= OWNER_REPLY_HEARD_MIN_CHARS,
      )
      .map(([id]) => id);
    this.reportHeard(heard, "owner_reply");
  }

  private reportHeard(itemIds: string[], evidence: "transcript_coverage" | "owner_reply"): void {
    if (itemIds.length === 0) return;
    for (const id of itemIds) this.offeredItems.delete(id);
    voiceLog(this.callSid, "owner-outbox", `heard ${itemIds.length} result(s)`, { evidence });
    void this.postJoshu("/api/realtime-goals/outbox/heard", { callSid: this.callSid, itemIds, evidence });
  }

  private clearOutbound(): void {
    const sid = this.streamSid;
    if (!sid || this.ws.readyState !== 1) return;
    this.ws.send(JSON.stringify({ event: "clear", streamSid: sid }));
    this.modelAudioPlaysUntil = 0;
  }
}
