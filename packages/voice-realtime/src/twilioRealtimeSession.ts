import { randomUUID } from "node:crypto";
import type WebSocket from "ws";

import {
  HERMES_PROGRESS_FIRST_DELAY_MS,
  HERMES_PROGRESS_INTERVAL_MS,
  HERMES_PROGRESS_MAX_TICKS,
  HERMES_PROGRESS_POST_SPEECH_MS,
  PHONE_SYSTEM_PROMPT,
  PHONE_VAD_EAGERNESS,
  PHONE_VAD_MODE,
  PHONE_VAD_SILENCE_MS,
  PHONE_VAD_THRESHOLD,
  TWILIO_PHONE_SESSION_HANGUP_MS,
  TWILIO_PHONE_SESSION_WARN_MS,
  TWILIO_THINK_PASSWORD,
  VOICE_S2S_PROVIDER,
} from "./config.js";
import { runJoshuThink } from "./brainThink.js";
import { JOSHU_IDENTITY } from "./config.js";
import { createVoiceS2sClient, voiceS2sProviderLabel } from "./createVoiceS2sClient.js";
import { normalizeThinkToolName } from "./realtimeTools.js";
import type { FunctionCallPayload, ResponseSpeechReason, VoiceS2sClient } from "./voiceS2sTypes.js";
import { matchesThinkPassphrase } from "./phonePassphrase.js";
import { classifyUserTranscript } from "./userInputGate.js";
import { voiceLog, voiceWarn } from "./voiceLog.js";

const MAX_TRANSCRIPT_TURNS = 12;

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
};

type StartMetadata = {
  caller?: string;
  ownerCaller?: string;
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
  private transcript: TranscriptTurn[] = [];
  private assistantPartial = "";
  private activeJob: ActiveJoshuJob | null = null;
  private thinkAuthorized = false;
  private requiresRestatedIntentAfterUnlock = false;
  private sessionWarnTimer: ReturnType<typeof setTimeout> | null = null;
  private sessionHangupTimer: ReturnType<typeof setTimeout> | null = null;
  /** No warn/hangup timers after successful passphrase unlock. */
  private sessionTimerDisabled = false;
  private startMetadata: StartMetadata | undefined;
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

  constructor(private readonly ws: WebSocket) {}

  handleStart(callSid: string, streamSid: string, metadata?: StartMetadata): void {
    this.callSid = callSid;
    this.streamSid = streamSid;
    this.t0 = performance.now();
    this.latestMediaTimestamp = 0;
    this.lastAssistantItem = null;
    this.responseStartTimestampTwilio = null;
    this.markQueue = [];
    this.thinkAuthorized = !TWILIO_THINK_PASSWORD;
    this.requiresRestatedIntentAfterUnlock = false;
    this.startMetadata = metadata;
    this.greetingSent = false;
    this.sessionTimerDisabled = false;
    this.suppressAssistantAudio = this.geminiPhone;

    const provider = voiceS2sProviderLabel();
    this.s2s = createVoiceS2sClient(
      {
        audioFormat: "pcmu",
        systemPrompt: PHONE_SYSTEM_PROMPT,
        injectPresentation: "voice_only",
        turnDetection: PHONE_VAD,
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
        this.allowGeminiCallerReply("user speech stopped");
        voiceLog(this.callSid, "vad", "user speech stopped (awaiting transcript)");
      },
      onTranscriptionComplete: (text) => this.handleUserTranscription(text),
        onAssistantTranscript: (delta) => {
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
  }

  close(): void {
    this.cancelActiveJob();
    this.clearSessionDeadline();
    voiceLog(this.callSid, "twilio", "stream close", this.metrics);
    this.s2s?.close();
    this.s2s = null;
  }

  private normalizePhone(raw: string | undefined): string {
    return (raw ?? "").replace(/[^\d+]/g, "");
  }

  private injectGreeting(metadata?: StartMetadata): void {
    const s2s = this.s2s;
    if (!s2s || this.greetingSent) return;
    const caller = this.normalizePhone(metadata?.caller);
    const owner = this.normalizePhone(metadata?.ownerCaller);
    const ownerCheckEnabled = Boolean(owner);
    const isOwner = ownerCheckEnabled && Boolean(caller) && caller === owner;
    const greeting = !ownerCheckEnabled
      ? "Hi. Great to hear from you."
      : isOwner
        ? "Hi. Great to hear from you."
        : "Hello. Friendly heads up: this phone session is limited to sixty seconds.";
    this.joshuInitiatedResponse = true;
    s2s.injectControlMessage(greeting);
    this.greetingSent = true;
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

    this.sessionWarnTimer = setTimeout(() => {
      if (this.sessionTimerDisabled || this.ws.readyState !== 1) return;
      this.joshuInitiatedResponse = true;
      this.s2s?.injectControlMessage(
        "Heads up — this call is almost out of time. You have about thirty seconds left.",
      );
    }, effectiveWarn);

    this.sessionHangupTimer = setTimeout(() => {
      if (this.sessionTimerDisabled || this.ws.readyState !== 1) return;
      this.joshuInitiatedResponse = true;
      this.s2s?.injectControlMessage(
        "This call has reached its time limit. I need to hang up now. Goodbye.",
      );
      setTimeout(() => {
        try {
          this.ws.close();
        } catch {
          // no-op
        }
      }, 2500);
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

    if (kind === "empty") {
      voiceLog(this.callSid, "turn", "empty input (VAD only, no transcript) — ignoring");
      return;
    }

    this.turn += 1;

    if (kind === "unclear") {
      voiceLog(this.callSid, "turn", `#${this.turn} USER (unclear) → ${JSON.stringify(text)} — reprompting`);
      this.joshuInitiatedResponse = true;
      s2s.injectRepromptMessage();
      return;
    }

    const justUnlocked = this.updateThinkAuthorization(text, "transcript");
    if (justUnlocked) {
      // Passphrase is auth-only; keep transcript so an earlier task request can still be used.
      if (!this.utteranceLooksLikeTaskRequest(text)) {
        this.requiresRestatedIntentAfterUnlock = true;
      }
      this.joshuInitiatedResponse = true;
      s2s.injectControlMessage("Unlocked. Please repeat your request.");
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
    if (this.requiresRestatedIntentAfterUnlock) {
      // This is the first post-unlock intent turn; allow think from this point onward.
      this.requiresRestatedIntentAfterUnlock = false;
      voiceLog(this.callSid, "auth", "accepted first post-unlock restated intent");
    }
    if (this.geminiPhone) {
      this.allowGeminiCallerReply("validated transcript");
      if (this.geminiUserTurnNeedsReply && !this.responseHadSpeech) {
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

  private updateThinkAuthorization(text: string, source: string): boolean {
    if (!TWILIO_THINK_PASSWORD || this.thinkAuthorized) return false;
    if (matchesThinkPassphrase(text, TWILIO_THINK_PASSWORD)) {
      this.thinkAuthorized = true;
      this.disableSessionTimeLimit("passphrase");
      voiceLog(this.callSid, "auth", `think password accepted (${source})`);
      return true;
    }
    return false;
  }

  /** Try unlock from transcript and/or think-tool args (STT may vary). */
  private tryAuthorizeThinkFromContext(parts: string[], source: string): boolean {
    const combined = parts.filter(Boolean).join(" ");
    if (!combined) return this.thinkAuthorized;
    return this.updateThinkAuthorization(combined, source);
  }

  private utteranceLooksLikeTaskRequest(text: string): boolean {
    return /\b(file|files|desktop|folder|journal|note|email|calendar|fetch|find|look up|read|open)\b/i.test(
      text,
    );
  }

  /** Control secret is used only for unlock checks; never forward it to Hermes context. */
  private sanitizeTextForThinkContext(text: string): string {
    if (!TWILIO_THINK_PASSWORD) return text;
    const password = TWILIO_THINK_PASSWORD.trim();
    if (!password) return text;
    const escaped = password.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const redacted = text.replace(new RegExp(escaped, "gi"), " ");
    return redacted.replace(/\s+/g, " ").trim();
  }

  private onGeminiInputTranscript(text: string): void {
    if (!this.geminiPhone || !text.trim()) return;
    this.allowGeminiCallerReply("input transcript");
    this.geminiUserTurnNeedsReply = true;
  }

  private allowGeminiCallerReply(reason: string): void {
    if (!this.geminiPhone) return;
    const wasSuppressed = this.suppressAssistantAudio;
    this.callerInputSeen = true;
    this.suppressAssistantAudio = false;
    if (wasSuppressed) {
      voiceLog(this.callSid, "turn", `gemini phone: ${reason} — allowing assistant audio`);
    }
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
      this.allowGeminiCallerReply("speech during greeting");
      voiceLog(this.callSid, "vad", "user speech during greeting (not barge-in)");
      return;
    }

    // speech_started fires on normal user turns too — only barge-in while assistant is playing.
    const assistantSpeaking =
      Boolean(this.lastAssistantItem) ||
      this.markQueue.length > 0 ||
      Boolean(this.assistantPartial.trim());

    if (!assistantSpeaking) {
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

  private cancelActiveJob(): void {
    if (!this.activeJob) return;
    this.clearProgressTimer(this.activeJob);
    this.activeJob.abort.abort();
    voiceLog(this.callSid, "joshu", `cancelled job=${this.activeJob.jobId}`);
    this.activeJob = null;
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

    const phrase = PROGRESS_PHRASES[(job.progress.tick - 1) % PROGRESS_PHRASES.length]!;
    job.progress.phase = "awaiting_speech";
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
      args,
    });

    if (toolName !== "think") {
      voiceWarn(this.callSid, "tool", `unknown tool ${call.name}`);
      s2s.sendFunctionOutput(call.callId, JSON.stringify({ error: `Unknown tool: ${call.name}` }));
      return;
    }

    if (TWILIO_THINK_PASSWORD && !this.thinkAuthorized) {
      const heardForUnlock = [
        typeof args.user_quote === "string" ? args.user_quote : "",
        typeof args.summary === "string" ? args.summary : "",
        ...this.transcript.map((t) => t.text),
      ];
      if (!this.tryAuthorizeThinkFromContext(heardForUnlock, "think_tool")) {
        voiceWarn(this.callSid, "auth", "blocked think call before passphrase", {
          heardPreview: heardForUnlock.join(" ").slice(0, 120),
        });
        s2s.sendFunctionOutput(
          call.callId,
          JSON.stringify({
            status: "denied",
            reason: "missing_passphrase",
            message: "Think is locked until the caller says the passphrase.",
          }),
          { triggerResponse: false },
        );
        this.joshuInitiatedResponse = true;
        s2s.injectControlMessage("Please say your passphrase to unlock personal data requests.");
        return;
      }
    }

    if (this.requiresRestatedIntentAfterUnlock) {
      const hasTaskInContext =
        this.transcript.some(
          (t) => t.role === "user" && this.utteranceLooksLikeTaskRequest(t.text),
        ) || this.utteranceLooksLikeTaskRequest(String(args.summary ?? ""));
      if (hasTaskInContext) {
        this.requiresRestatedIntentAfterUnlock = false;
        voiceLog(this.callSid, "auth", "restate satisfied — prior task still in call context");
      } else {
        voiceLog(this.callSid, "auth", "blocked think until caller restates intent after unlock");
        s2s.sendFunctionOutput(
          call.callId,
          JSON.stringify({
            status: "deferred",
            reason: "restate_after_unlock_required",
            message: "Passphrase unlocked access. Wait for the caller to restate their request before think.",
          }),
          { triggerResponse: false },
        );
        this.joshuInitiatedResponse = true;
        s2s.injectControlMessage("Please repeat what you want me to do now that you're unlocked.");
        return;
      }
    }

    const intent = String(args.intent ?? "task");
    const summary = this.sanitizeTextForThinkContext(String(args.summary ?? this.conversationSummary()));
    const rawUserQuote = typeof args.user_quote === "string" ? args.user_quote : undefined;
    const userQuote = rawUserQuote
      ? this.sanitizeTextForThinkContext(rawUserQuote) || undefined
      : undefined;
    const jobId = randomUUID().slice(0, 8);
    this.requiresRestatedIntentAfterUnlock = false;

    voiceLog(this.callSid, "turn", `#${this.turn} THINK START job=${jobId} intent=${JSON.stringify(intent)}`, {
      userQuote,
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

  private startJoshuJob(params: {
    jobId: string;
    intent: string;
    summary: string;
    userQuote?: string;
  }): void {
    this.cancelActiveJob();

    const abort = new AbortController();
    this.activeJob = {
      abort,
      jobId: params.jobId,
      progress: {
        tick: 0,
        phase: "awaiting_ack",
        timer: null,
        longWaitSent: false,
      },
    };
    void this.runJoshuJob(params, abort);
  }

  private async runJoshuJob(
    params: { jobId: string; intent: string; summary: string; userQuote?: string },
    abort: AbortController,
  ): Promise<void> {
    const t0 = performance.now();
    try {
      const result = await runJoshuThink({
        callSid: this.callSid,
        jobId: params.jobId,
        intent: params.intent,
        summary: params.summary,
        userQuote: params.userQuote,
        signal: abort.signal,
        presentation: "phone",
      });
      if (abort.signal.aborted) return;

      voiceLog(this.callSid, "turn", `#${this.turn} THINK DONE job=${params.jobId} ms=${Math.round(performance.now() - t0)} → injecting`, {
        preview: result.slice(0, 200),
      });
      this.s2s?.injectAssistantMessage(result);
      this.pushTranscript("assistant", result);
    } catch (e) {
      if (abort.signal.aborted) return;
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
  }
}
