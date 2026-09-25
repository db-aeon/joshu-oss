import { randomUUID } from "node:crypto";
import type WebSocket from "ws";

import {
  HERMES_PROGRESS_FIRST_DELAY_MS,
  HERMES_PROGRESS_INTERVAL_MS,
  HERMES_PROGRESS_MAX_TICKS,
  HERMES_PROGRESS_POST_SPEECH_MS,
  HERMES_API_KEY,
  PHONE_SYSTEM_PROMPT,
  PHONE_VAD_EAGERNESS,
  PHONE_VAD_MODE,
  PHONE_VAD_SILENCE_MS,
  PHONE_VAD_THRESHOLD,
  TWILIO_PHONE_SESSION_HANGUP_MS,
  TWILIO_PHONE_SESSION_WARN_MS,
  resolveTwilioThinkPassword,
  VOICE_S2S_PROVIDER,
} from "./config.js";
import {
  resolveThinkUserQuote,
  runJoshuThinkDetailed,
  speakableWithLinksTexted,
  textAnswerToOwner,
} from "./brainThink.js";
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
import {
  isPassphraseOnlyTurn,
  isPassphraseResidue,
  looksLikePhoneTaskRequest,
  looksLikeVoicemailGreeting,
  matchesThinkPassphrase,
  redactPassphrase,
} from "./phonePassphrase.js";
import {
  getLockPromptClip,
  LOCK_PROMPTS,
  lockPromptsReady,
  type LockPromptKey,
} from "./lockPrompts.js";
import { classifyUserTranscript } from "./userInputGate.js";
import { voiceLog, voiceWarn } from "./voiceLog.js";

const MAX_TRANSCRIPT_TURNS = 12;
/** Clear utterances that fail passphrase match before the call is hung up. */
const MAX_PASSPHRASE_ATTEMPTS = 3;
/**
 * After unlock, STT can deliver trailing fragments of the passphrase as separate
 * turns. Partial passphrase matches are ignored for this long.
 */
const UNLOCK_GRACE_MS = 10_000;
/** How a locked goal callback ended (mirrors RealtimeGoalVoiceCallbackOutcome). */
type GoalCallbackOutcome = "voicemail" | "auth_failed" | "no_unlock";
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
/** Wrap-up heard via transcript and via the model's think call count once. */
const WRAP_UP_DEDUPE_MS = 5_000;

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

type StartMetadata = {
  caller?: string;
  ownerCaller?: string;
  realtimeGoalId?: string;
  realtimeGoalToken?: string;
};

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
  private activeJob: ActiveJoshuJob | null = null;
  private thinkAuthorized = false;
  private requiresRestatedIntentAfterUnlock = false;
  /** Failed clear passphrase attempts this call (hang up at MAX_PASSPHRASE_ATTEMPTS). */
  private passphraseFailures = 0;
  /** True after too many wrong passphrase attempts — ignore further turns. */
  private hangingUpForAuth = false;
  /**
   * Box has a full set of pre-rendered lock clips, so lock lines are played
   * verbatim and the model is muted until unlock. False falls back to
   * instructing the model, which may paraphrase (see lockPrompts.ts).
   */
  private deterministicLockPrompts = false;
  private sessionWarnTimer: ReturnType<typeof setTimeout> | null = null;
  private sessionHangupTimer: ReturnType<typeof setTimeout> | null = null;
  /** No warn/hangup timers after successful passphrase unlock. */
  private sessionTimerDisabled = false;
  private startMetadata: StartMetadata | undefined;
  private realtimeGoalAwaitingReply = false;
  private realtimeGoalAckPending = false;
  private realtimeGoalResponseDone = false;
  /** When the passphrase was accepted (starts the residue grace window). */
  private unlockedAtMs: number | null = null;
  /** A locked goal callback reports its outcome to Joshu at most once. */
  private goalCallbackOutcomeReported = false;
  private greetingSent = false;
  private turn = 0;
  private responseNum = 0;
  /** Set before requestOrganicResponse / injectRepromptMessage; cleared on response.created. */
  private joshuInitiatedResponse = false;
  /** Gemini PSTN: drop unsolicited organic audio until the caller's first validated turn. */
  private suppressAssistantAudio = false;
  /** Caller speech seen (input transcript) — unlocks assistant audio for Gemini PSTN. */
  private callerInputSeen = false;
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

  handleStart(callSid: string, streamSid: string, metadata?: StartMetadata): void {
    this.callSid = callSid;
    this.streamSid = streamSid;
    this.t0 = performance.now();
    this.latestMediaTimestamp = 0;
    this.lastAssistantItem = null;
    this.responseStartTimestampTwilio = null;
    this.markQueue = [];
    this.modelAudioPlaysUntil = 0;
    // PSTN requires a passphrase (media stream is rejected if unset). Call starts locked.
    this.thinkAuthorized = false;
    this.requiresRestatedIntentAfterUnlock = false;
    this.passphraseFailures = 0;
    this.hangingUpForAuth = false;
    this.startMetadata = metadata;
    this.realtimeGoalAwaitingReply = false;
    this.unlockedAtMs = null;
    this.goalCallbackOutcomeReported = false;
    this.greetingSent = false;
    this.sessionTimerDisabled = false;
    this.hangUpAfterSpeech = false;
    this.hangUpOnMarkDrain = false;
    this.lastWrapUpAtMs = 0;
    this.suppressAssistantAudio = this.geminiPhone;
    this.deterministicLockPrompts = lockPromptsReady();
    if (!this.deterministicLockPrompts) {
      voiceWarn(
        callSid,
        "auth",
        "lock prompt clips missing — falling back to model-spoken lock lines " +
          "(still rendering, or TTS unavailable)",
      );
    }

    const provider = voiceS2sProviderLabel();
    this.s2s = createVoiceS2sClient(
      {
        audioFormat: "pcmu",
        systemPrompt: PHONE_SYSTEM_PROMPT,
        injectPresentation: "voice_only",
        turnDetection: PHONE_VAD,
        // PSTN implements `think` only; declaring open_desktop made the model fake app opens.
        toolNames: PHONE_TOOL_NAMES,
      },
      {
        sessionId: callSid,
      onReady: () => {
        this.metrics.realtimeReadyMs = Math.round(performance.now() - this.t0);
        voiceLog(callSid, provider, `session ready ms=${this.metrics.realtimeReadyMs}`);
        this.injectGreeting(this.startMetadata);
      },
      onOutputAudioDelta: ({ deltaB64, itemId }) => this.forwardMulawDelta(deltaB64, itemId),
      onSpeechStarted: () => void this.handleSpeechStarted(),
      onInterrupted: () => {
        voiceLog(this.callSid, "vad", "gemini generation interrupted (local cancel)");
        this.assistantPartial = "";
      },
      onInputTranscript: (text) => this.onGeminiInputTranscript(text),
      onSpeechStopped: () => {
        this.lastSpeechStoppedAt = performance.now();
        // Gemini has no OpenAI speech_stopped — unlock early so auto-reply audio is not muted.
        // Stay muted until passphrase unlock so Gemini cannot chat while the call is locked.
        if (this.thinkAuthorized && !this.requiresRestatedIntentAfterUnlock) {
          this.allowGeminiCallerReply("user speech stopped");
        }
        voiceLog(this.callSid, "vad", "user speech stopped (awaiting transcript)");
      },
      onTranscriptionComplete: (text) => this.handleUserTranscription(text),
        onAssistantTranscript: (delta) => {
          // Muted output never reached the caller — keep it out of the spoken
          // transcript and out of later think context.
          if (this.modelMutedByLock()) return;
          if (
            this.geminiPhone &&
            this.suppressAssistantAudio &&
            this.currentResponseReason === "organic"
          ) {
            return;
          }
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
          this.geminiPhone &&
          reason === "organic" &&
          (!this.thinkAuthorized || this.requiresRestatedIntentAfterUnlock)
        ) {
          voiceLog(this.callSid, "auth", "cancel gemini organic — Joshu owns lock/unlock clips", {
            seq,
            locked: !this.thinkAuthorized,
            awaitingIntent: this.requiresRestatedIntentAfterUnlock,
          });
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
        if (this.geminiPhone && reason === "organic" && this.suppressAssistantAudio) {
          if (this.callerInputSeen) {
            this.suppressAssistantAudio = false;
          } else {
            voiceLog(this.callSid, "turn", "gemini pre-user organic (muting, not interrupting)", { seq });
          }
        }
        this.joshuInitiatedResponse = false;

        this.responseNum += 1;
        this.currentResponseReason = reason;
        this.responseHadSpeech = false;

        const tag = `turn #${this.turn} resp #${this.responseNum}`;
        voiceLog(this.callSid, "turn", `${tag} SPEECH START source=${reason} seq=${seq}`);
      },
      onResponseDone: (info) => {
        if (info.status === "cancelled") {
          voiceLog(this.callSid, provider, `resp #${this.responseNum} response.cancelled`);
          return;
        }
        this.flushAssistantSpeech(this.currentResponseReason);
        this.logSpokeBeforeThink(info);
        voiceLog(this.callSid, provider, `resp #${this.responseNum} response.done`, info);
        if (
          this.geminiPhone &&
          this.currentResponseReason === "progress" &&
          this.greetingSent
        ) {
          this.resetAssistantPlaybackState();
        }
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
      onError: (msg) => voiceWarn(this.callSid, provider, msg),
      },
    );

    this.s2s.connect();
    this.scheduleSessionDeadline();
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
    // Caller hung up (or we did) before unlock on a goal callback. No-op when
    // an outcome was already reported or the call unlocked.
    this.reportGoalCallbackOutcome("no_unlock");
    // An answer still being worked on is texted when it lands — hanging up
    // must not throw away work the caller asked for (e.g. "email me that").
    this.detachActiveJob();
    this.dictation = null;
    this.clearSessionDeadline();
    voiceLog(this.callSid, "twilio", "stream close", this.metrics);
    this.s2s?.close();
    this.s2s = null;
  }

  private normalizePhone(raw: string | undefined): string {
    return (raw ?? "").replace(/[^\d+]/g, "");
  }

  /**
   * While locked, clips are the only voice on the line. The model still hears
   * the caller (we need its transcription to check the passphrase) but nothing
   * it generates reaches them — it has been observed answering a rejection with
   * "Thank you." or "Unlocked.", which reads to the caller as being let in.
   */
  private modelMutedByLock(): boolean {
    return this.deterministicLockPrompts && !this.thinkAuthorized;
  }

  private injectGreeting(metadata?: StartMetadata): void {
    const s2s = this.s2s;
    if (!s2s || this.greetingSent) return;
    const caller = this.normalizePhone(metadata?.caller);
    const owner = this.normalizePhone(metadata?.ownerCaller);
    const ownerCheckEnabled = Boolean(owner);
    const isOwner = ownerCheckEnabled && Boolean(caller) && caller === owner;
    // Always ask for the passphrase — the call stays locked until it matches (3 tries).
    this.speakLockLine(ownerCheckEnabled && !isOwner ? "greeting_guest" : "greeting");
    this.greetingSent = true;
  }

  /**
   * Say one of the fixed lock lines. Prefers the box's pre-rendered clip so the
   * wording is guaranteed; falls back to instructing the model, which sounds
   * natural but may paraphrase (see lockPrompts.ts).
   *
   * Returns the clip's playback length in ms, or 0 when the model is speaking.
   */
  private speakLockLine(key: LockPromptKey): number {
    const clip = this.deterministicLockPrompts ? getLockPromptClip(key) : null;
    if (!clip) {
      this.joshuInitiatedResponse = true;
      this.s2s?.injectControlMessage(LOCK_PROMPTS[key]);
      return 0;
    }
    // Take the floor: on unlock the model is no longer muted and Gemini may
    // already be mid-reply, which would talk over the clip.
    if (this.assistantIsSpeaking()) {
      this.s2s?.cancelActiveResponse();
      this.clearOutbound();
    }
    this.resetAssistantPlaybackState();
    this.playMulawClip(clip.mulawB64);
    voiceLog(this.callSid, "auth", `spoke "${key}" from clip`, { durationMs: clip.durationMs });
    return clip.durationMs;
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

  /** Speak a lock line, then close the Twilio media stream (hangs up the call). */
  private hangUpAfterLockLine(key: LockPromptKey, minDelayMs = 2500): void {
    this.hangingUpForAuth = true;
    // Clip playback is paced by Twilio, so wait out its full length before closing.
    const delayMs = Math.max(minDelayMs, this.speakLockLine(key) + 750);
    setTimeout(() => {
      try {
        this.ws.close();
      } catch {
        // no-op
      }
    }, delayMs);
  }

  private scheduleSessionDeadline(): void {
    if (this.sessionTimerDisabled) return;
    this.clearSessionDeadline();

    const warnMs = Number.isFinite(TWILIO_PHONE_SESSION_WARN_MS) ? TWILIO_PHONE_SESSION_WARN_MS : 60000;
    const hangupMs = Number.isFinite(TWILIO_PHONE_SESSION_HANGUP_MS)
      ? TWILIO_PHONE_SESSION_HANGUP_MS
      : 90000;
    const effectiveWarn = Math.max(5000, warnMs);
    const effectiveHangup = Math.max(effectiveWarn + 5000, hangupMs);

    // These only ever fire pre-unlock (unlock disables the timers), so they are
    // lock lines too — the model is muted by then when clips are available.
    this.sessionWarnTimer = setTimeout(() => {
      if (this.sessionTimerDisabled || this.ws.readyState !== 1) return;
      this.speakLockLine("time_warning");
    }, effectiveWarn);

    this.sessionHangupTimer = setTimeout(() => {
      if (this.sessionTimerDisabled || this.ws.readyState !== 1) return;
      this.reportGoalCallbackOutcome("no_unlock");
      this.hangUpAfterLockLine("time_up");
    }, effectiveHangup);
  }

  private disableSessionTimeLimit(reason: string): void {
    if (this.sessionTimerDisabled) return;
    this.sessionTimerDisabled = true;
    this.clearSessionDeadline();
    voiceLog(this.callSid, "auth", `session time limit disabled (${reason})`);
  }

  private clearSessionDeadline(): void {
    if (this.sessionWarnTimer) {
      clearTimeout(this.sessionWarnTimer);
      this.sessionWarnTimer = null;
    }
    if (this.sessionHangupTimer) {
      clearTimeout(this.sessionHangupTimer);
      this.sessionHangupTimer = null;
    }
  }

  private forwardMulawDelta(deltaB64: string, itemId?: string): void {
    const sid = this.streamSid;
    if (!sid || this.ws.readyState !== 1 || !deltaB64) return;
    if (this.modelMutedByLock()) return;
    if (this.activeJob && this.currentResponseReason === "organic") return;
    if (
      this.geminiPhone &&
      this.suppressAssistantAudio &&
      this.currentResponseReason === "organic"
    ) {
      return;
    }

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
    if (this.hangingUpForAuth) return;

    if (kind === "empty") {
      voiceLog(this.callSid, "turn", "empty input (VAD only, no transcript) — ignoring");
      return;
    }

    this.turn += 1;

    // Call-level lock: until passphrase matches, do not chat or think — only auth.
    if (!this.thinkAuthorized) {
      // An outbound goal callback answered by voicemail: the greeting is not a
      // wrong passphrase. Hang up without spending attempts; Joshu parks the result.
      if (this.isGoalCallback() && looksLikeVoicemailGreeting(text)) {
        voiceWarn(this.callSid, "goal-callback", "voicemail greeting while locked — hanging up", {
          heardPreview: text.slice(0, 80),
        });
        this.reportGoalCallbackOutcome("voicemail");
        this.hangUpSilently();
        return;
      }
      if (kind === "unclear") {
        voiceLog(this.callSid, "auth", `#${this.turn} unclear while locked → ${JSON.stringify(text)}`);
        this.speakLockLine("unclear");
        return;
      }

      const justUnlocked = this.updateThinkAuthorization(text, "transcript");
      if (justUnlocked) {
        const isGoalCallback = this.isGoalCallback();
        // Normal calls wait for a fresh request. Authenticated goal callbacks
        // disclose the queued result immediately after the unlock line.
        this.requiresRestatedIntentAfterUnlock = !isGoalCallback;
        const unlockMs = this.speakLockLine(isGoalCallback ? "unlocked_callback" : "unlocked");
        if (isGoalCallback) {
          setTimeout(
            () => void this.deliverRealtimeGoalCallback(),
            Math.max(750, unlockMs + 250),
          );
        }
        return;
      }

      this.passphraseFailures += 1;
      voiceWarn(this.callSid, "auth", "passphrase rejected", {
        attempt: this.passphraseFailures,
        maxAttempts: MAX_PASSPHRASE_ATTEMPTS,
        heardPreview: text.slice(0, 80),
      });
      if (this.passphraseFailures >= MAX_PASSPHRASE_ATTEMPTS) {
        voiceWarn(this.callSid, "auth", "hanging up after passphrase failures");
        this.reportGoalCallbackOutcome("auth_failed");
        this.hangUpAfterLockLine("locked_out");
        return;
      }
      const left = MAX_PASSPHRASE_ATTEMPTS - this.passphraseFailures;
      this.speakLockLine(left === 1 ? "last_try" : "retry");
      return;
    }

    if (kind === "unclear") {
      voiceLog(this.callSid, "turn", `#${this.turn} USER (unclear) → ${JSON.stringify(text)} — reprompting`);
      if (this.requiresRestatedIntentAfterUnlock) {
        this.speakLockLine("restate_intent");
        return;
      }
      this.joshuInitiatedResponse = true;
      s2s.injectRepromptMessage();
      return;
    }

    const password = resolveTwilioThinkPassword();
    if (
      password &&
      (isPassphraseOnlyTurn(text, password) ||
        isPassphraseResidue(text, password, { graceWindow: this.withinUnlockGrace() }))
    ) {
      voiceLog(this.callSid, "auth", `#${this.turn} ignoring passphrase residue after unlock`);
      // Gemini hears audio directly and may already be answering the fragment.
      if (this.geminiPhone && this.currentResponseReason === "organic") {
        this.s2s?.cancelActiveResponse();
      }
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
    if (safeText && this.handleWrapUp(safeText)) return;
    this.continueUnlockedTurn(safeText);
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
    const jobPending = Boolean(this.activeJob && !this.activeJob.detached);
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
  private continueUnlockedTurn(safeText: string, options: { forceResponse?: boolean } = {}): void {
    const s2s = this.s2s;
    if (!s2s) return;
    if (safeText && this.dictation?.active) {
      this.onDictationUserTranscript(safeText);
      // Stay silent while buffering — OpenAI path must not request organic chat.
      if (this.geminiPhone) {
        this.geminiUserTurnNeedsReply = false;
        this.allowGeminiCallerReply("dictation chunk");
      }
      return;
    }
    // First real request after unlock — passphrase echoes never reach here.
    if (this.requiresRestatedIntentAfterUnlock && safeText) {
      this.requiresRestatedIntentAfterUnlock = false;
      voiceLog(this.callSid, "auth", "accepted first post-unlock restated intent");
    }
    if (this.geminiPhone) {
      this.allowGeminiCallerReply("validated transcript");
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

  /** Try unlock from the caller's STT transcript only — never from Gemini tool args. */
  private updateThinkAuthorization(text: string, source: string): boolean {
    const password = resolveTwilioThinkPassword();
    if (!password || this.thinkAuthorized) return false;
    if (matchesThinkPassphrase(text, password)) {
      this.thinkAuthorized = true;
      this.unlockedAtMs = performance.now();
      this.passphraseFailures = 0;
      this.disableSessionTimeLimit("passphrase");
      voiceLog(this.callSid, "auth", `think password accepted (${source})`);
      return true;
    }
    return false;
  }

  /** Outbound callback placed by Joshu for one realtime goal (signed start params). */
  private isGoalCallback(): boolean {
    return Boolean(
      this.startMetadata?.realtimeGoalId?.trim() && this.startMetadata?.realtimeGoalToken?.trim(),
    );
  }

  private withinUnlockGrace(): boolean {
    return this.unlockedAtMs != null && performance.now() - this.unlockedAtMs < UNLOCK_GRACE_MS;
  }

  /**
   * Authenticated request to Joshu's goal-callback API for this call's goal.
   * `suffix` is "" (result), "/ack", "/reply", or "/outcome".
   */
  private realtimeGoalRequest(
    suffix: "" | "/ack" | "/reply" | "/outcome",
    init: { method?: "GET" | "POST"; body?: unknown; timeoutMs?: number } = {},
  ): Promise<Response> | undefined {
    const goalId = this.startMetadata?.realtimeGoalId?.trim();
    const token = this.startMetadata?.realtimeGoalToken?.trim();
    if (!goalId || !token) return undefined;
    const method = init.method ?? "GET";
    return fetch(
      `${JOSHU_API_BASE}/api/realtime-goals/voice/result/${encodeURIComponent(goalId)}${suffix}?token=${encodeURIComponent(token)}`,
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

  /**
   * Tell Joshu how a still-locked goal callback ended so it can park (voicemail,
   * lockout) or back off (no unlock) instead of redialing every 15 minutes.
   */
  private reportGoalCallbackOutcome(outcome: GoalCallbackOutcome): void {
    if (!this.isGoalCallback() || this.thinkAuthorized || this.goalCallbackOutcomeReported) return;
    this.goalCallbackOutcomeReported = true;
    voiceLog(this.callSid, "goal-callback", `reporting outcome=${outcome}`);
    void this.realtimeGoalRequest("/outcome", {
      method: "POST",
      body: { outcome },
      timeoutMs: 5_000,
    })?.catch((error) => {
      voiceWarn(this.callSid, "goal-callback", "outcome report failed", {
        error: (error as Error).message,
      });
    });
  }

  /** End the call without speaking (voicemail must not record lock prompts). */
  private hangUpSilently(): void {
    this.hangingUpForAuth = true;
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
    if (!this.isGoalCallback() || !this.thinkAuthorized || !this.s2s) return;
    try {
      const response = await this.realtimeGoalRequest("");
      if (!response?.ok) throw new Error(`result HTTP ${response?.status ?? "unavailable"}`);
      const payload = (await response.json()) as {
        text?: string;
        kind?: "blocked" | "completed";
      };
      const result = payload.text?.trim();
      if (!result) throw new Error("empty callback result");
      this.realtimeGoalAwaitingReply = payload.kind === "blocked";
      this.realtimeGoalAckPending = true;
      this.realtimeGoalResponseDone = false;
      this.s2s.injectAssistantMessage(
        payload.kind === "blocked"
          ? result
          : `${result}\n\nIs there anything else you'd like me to handle?`,
        payload.kind === "blocked" ? "question" : "answer",
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
        this.continueUnlockedTurn(text, { forceResponse: true });
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

  /** True when a think `user_quote` is the passphrase (or its leftovers) and nothing else. */
  private quoteIsOnlyPassphrase(quote: string | undefined): boolean {
    const password = resolveTwilioThinkPassword().trim();
    if (!password || !quote?.trim()) return false;
    if (!this.sanitizeTextForThinkContext(quote)) return true;
    return isPassphraseResidue(quote, password, { graceWindow: this.withinUnlockGrace() });
  }

  /** Control secret is used only for unlock checks; never forward it to Hermes context. */
  private sanitizeTextForThinkContext(text: string): string {
    const password = resolveTwilioThinkPassword().trim();
    if (!password) return text;
    return redactPassphrase(text, password);
  }

  private onGeminiInputTranscript(text: string): void {
    if (!this.geminiPhone || !text.trim()) return;
    if (!this.thinkAuthorized || this.requiresRestatedIntentAfterUnlock) return;
    this.allowGeminiCallerReply("input transcript");
    this.geminiUserTurnNeedsReply = true;
  }

  private allowGeminiCallerReply(reason: string): void {
    if (!this.geminiPhone) return;
    if (!this.thinkAuthorized || this.requiresRestatedIntentAfterUnlock) return;
    const wasSuppressed = this.suppressAssistantAudio;
    this.callerInputSeen = true;
    this.suppressAssistantAudio = false;
    if (wasSuppressed) {
      voiceLog(this.callSid, "turn", `gemini phone: ${reason} — allowing assistant audio`);
    }
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
    // Gemini PSTN: caller speaking during the greeting should not cancel the greeting.
    if (
      this.geminiPhone &&
      this.currentResponseReason === "progress" &&
      this.greetingSent
    ) {
      if (this.thinkAuthorized && !this.requiresRestatedIntentAfterUnlock) {
        this.allowGeminiCallerReply("speech during greeting");
      }
      voiceLog(this.callSid, "vad", "user speech during greeting (not barge-in)");
      return;
    }

    // speech_started fires on normal user turns too — only barge-in while assistant is playing.
    if (!this.assistantIsSpeaking()) {
      this.allowGeminiCallerReply("user speech started");
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
    this.assistantPartial = "";

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

  private flushAssistantSpeech(source: ResponseSpeechReason): void {
    const t = this.assistantPartial.trim();
    if (!t) return;
    voiceLog(this.callSid, "turn", `turn #${this.turn} resp #${this.responseNum} SPEECH OUT source=${source}`, {
      text: t.slice(0, 400),
      chars: t.length,
    });
    this.transcript.push({ role: "assistant", text: t });
    this.assistantPartial = "";
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
    // Discard in-flight partial — flushing here splits one reply into multiple SPEECH OUT lines.
    this.assistantPartial = "";
  }

  private pushTranscript(role: "user" | "assistant", text: string): void {
    if (role === "user") this.flushAssistantPartial();
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

    // Auth gate is transcript-only. While locked, ignore every tool call — do not
    // unlock from Gemini wrapping the passphrase in think (that raced clips and
    // leftover STT on patrick 2026-08-22).
    if (!this.thinkAuthorized) {
      voiceWarn(this.callSid, "auth", `ignored ${toolName} while locked (transcript auth only)`);
      s2s.sendFunctionOutput(
        call.callId,
        JSON.stringify({
          status: "denied",
          reason: "missing_passphrase",
          message: "Call is locked. Stay silent. Joshu will speak the lock prompts.",
        }),
        { triggerResponse: false },
      );
      return;
    }

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

    if (toolName !== "think") {
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

    if (this.requiresRestatedIntentAfterUnlock) {
      const hasTaskInContext =
        this.transcript.some(
          (t) => t.role === "user" && looksLikePhoneTaskRequest(t.text),
        ) || looksLikePhoneTaskRequest(String(args.summary ?? ""));
      if (hasTaskInContext) {
        this.requiresRestatedIntentAfterUnlock = false;
        voiceLog(this.callSid, "auth", "restate satisfied — prior task still in call context");
      } else {
        voiceLog(this.callSid, "auth", "deferred think until caller restates intent after unlock");
        s2s.sendFunctionOutput(
          call.callId,
          JSON.stringify({
            status: "deferred",
            reason: "restate_after_unlock_required",
            message: "Stay silent. Joshu already asked the caller to repeat their request.",
          }),
          { triggerResponse: false },
        );
        return;
      }
    }

    const rawUserQuote = typeof args.user_quote === "string" ? args.user_quote : undefined;
    if (this.quoteIsOnlyPassphrase(rawUserQuote)) {
      // The model heard the unlock phrase and turned it into a task ("Save note").
      voiceWarn(this.callSid, "auth", "ignored think — quoted request is only the passphrase", {
        quoteChars: rawUserQuote?.length ?? 0,
      });
      s2s.sendFunctionOutput(
        call.callId,
        JSON.stringify({
          status: "ignored",
          reason: "passphrase_is_not_a_request",
          message: "The caller only said their passphrase. It is not a request. Do not call think for it; stay silent.",
        }),
        { triggerResponse: false },
      );
      return;
    }

    // The model hears audio directly and often calls think before our transcript
    // lands — "No, thank you" must not become a request (or a goal update).
    const quotedWrapUp = rawUserQuote ? this.sanitizeTextForThinkContext(rawUserQuote) : "";
    if (quotedWrapUp && this.handleWrapUp(quotedWrapUp)) {
      voiceLog(this.callSid, "wrap-up", "ignored think — caller is wrapping up");
      s2s.sendFunctionOutput(
        call.callId,
        JSON.stringify({
          status: "ignored",
          reason: "caller_wrapping_up",
          message: "The caller is wrapping up, not asking for anything. Joshu is saying goodbye; stay silent.",
        }),
        { triggerResponse: false },
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
    this.requiresRestatedIntentAfterUnlock = false;

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
    // Same restated-intent gate as think — leftover pre-unlock STT must not arm the buffer.
    if (this.requiresRestatedIntentAfterUnlock) {
      this.rejectStartDictation(
        callId,
        "restate_after_unlock_required",
        "Stay silent. Joshu already asked the caller to repeat their request.",
        false,
      );
      return;
    }
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

  private clearOutbound(): void {
    const sid = this.streamSid;
    if (!sid || this.ws.readyState !== 1) return;
    this.ws.send(JSON.stringify({ event: "clear", streamSid: sid }));
    this.modelAudioPlaysUntil = 0;
  }
}
