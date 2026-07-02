import { randomUUID } from "node:crypto";
import type WebSocket from "ws";

import {
  HERMES_PROGRESS_FIRST_DELAY_MS,
  HERMES_PROGRESS_INTERVAL_MS,
  HERMES_PROGRESS_MAX_TICKS,
  HERMES_PROGRESS_POST_SPEECH_MS,
  VOICE_S2S_PROVIDER,
  WEB_SYSTEM_PROMPT,
  JOSHU_IDENTITY,
} from "./config.js";
import { runJoshuThink } from "./brainThink.js";
import { resolveDesktopModule } from "./desktopModules.js";
import { buildEmbeddedAppVoicePromptAddendum } from "./joshuIdentity.js";
import { createVoiceS2sClient } from "./createVoiceS2sClient.js";
import {
  buildAppVoiceToolDefinitions,
  mapAppVoiceToolArgs,
  resolveAppVoiceTool,
  type AppVoiceCommand,
} from "./appVoiceTools.js";
import { normalizeThinkToolName } from "./realtimeTools.js";
import type { FunctionCallPayload, ResponseSpeechReason } from "./voiceS2sTypes.js";
import type { VoiceS2sClient } from "./voiceS2sTypes.js";
import { voiceLog, voiceWarn } from "./voiceLog.js";
import {
  fetchAgUiAppInfo,
  surfaceTargetsCurrentApp,
  type EmbeddedAppSurfaceContext,
} from "./voiceAppContext.js";
import {
  responseDoneRequestedThink,
  surfaceAssistantDelta,
  surfaceAssistantDone,
  surfaceBrainJobStart,
  surfaceDesktopAction,
  surfaceAppAction,
  type VoiceSurfaceWireEvent,
} from "./voiceSurfaceSync.js";

const MAX_TRANSCRIPT_TURNS = 12;
const PCM_OUT_BATCH_BYTES = 9600;

const PROGRESS_PHRASES = ["Still checking.", "One moment.", "Still working on that.", "Almost there."];

type TranscriptTurn = { role: "user" | "assistant"; text: string };
type SessionState = "listening" | "thinking" | "speaking";
type JobProgressPhase = "awaiting_ack" | "idle" | "awaiting_speech" | "done";

type JobProgressState = {
  tick: number;
  phase: JobProgressPhase;
  timer: ReturnType<typeof setTimeout> | null;
  longWaitSent: boolean;
};

/** Hermes brain job — desktop/files/tools via think; results sync to the attached surface. */
type BrainJob = {
  abort: AbortController;
  jobId: string;
  userQuote?: string;
  /** When true, inject brain result for S2S to speak (think path). */
  voiceInject: boolean;
  progress: JobProgressState | null;
};

/**
 * Browser WebSocket ↔ speech-to-speech upstream (OpenAI Realtime or Gemini Live, PCM24k uplink).
 * Casual turns: S2S speaks + surface shows S2S transcript. Work turns: think → Hermes brain → surface.
 */
/** Less sensitive than phone defaults — browser mic picks up room noise and speaker bleed. */
const BROWSER_VAD = {
  threshold: 0.68,
  silenceDurationMs: 950,
  prefixPaddingMs: 300,
} as const;

export class BrowserRealtimeSession {
  private sessionId = "";
  /** Correlates Hermes + surface state (jChat session id today; desktop session later). */
  private surfaceSessionId = "";
  private sessionState: SessionState = "listening";
  private s2s: VoiceS2sClient | null = null;
  private transcript: TranscriptTurn[] = [];
  private assistantPartial = "";
  private brainJob: BrainJob | null = null;
  /** User quote for the in-flight S2S turn — brain starts once per turn, not on every event. */
  private pendingUserQuote: string | null = null;
  private realtimeTurnSettled = false;
  private turnThinkRequested = false;
  /** User quote whose brain job already finished — blocks duplicate work on late transcript. */
  private lastBrainHandledQuote: string | null = null;
  /** When true, stream S2S output transcription to the surface (no parallel Hermes job). */
  private organicSurfaceSync = false;
  /** Active spoken response source — used to suppress organic speech during think and limit barge-in. */
  private activeSpeechReason: ResponseSpeechReason | null = null;
  private responseHadSpeech = false;
  private lastAssistantItem: string | null = null;
  private pcmOutAcc = Buffer.alloc(0);
  private t0 = performance.now();
  private surfaceAppId = "";
  private voiceCommands: AppVoiceCommand[] = [];
  /** Embedded app agent context — aligns voice think with AG-UI chat + app_gui_action. */
  private appSurface: EmbeddedAppSurfaceContext | null = null;

  constructor(private readonly ws: WebSocket) {}

  handleRegisterSurface(
    appId: string,
    commands: AppVoiceCommand[],
    surface?: { threadId?: string; guiSnapshot?: Record<string, unknown> },
  ): void {
    const nextAppId = appId.trim();
    const guiOnly =
      nextAppId === this.surfaceAppId &&
      this.voiceCommands.length > 0 &&
      commands.length === 0 &&
      Boolean(this.appSurface);

    if (guiOnly && this.appSurface) {
      this.appSurface = {
        ...this.appSurface,
        threadId: surface?.threadId?.trim() || this.appSurface.threadId,
        guiSnapshot: surface?.guiSnapshot ?? this.appSurface.guiSnapshot,
      };
      return;
    }

    this.surfaceAppId = nextAppId;
    if (commands.length > 0) {
      this.voiceCommands = commands;
    }
    const resolvedThreadId = surface?.threadId?.trim() || this.appSurface?.threadId || this.surfaceSessionId;
    this.appSurface = {
      appId: this.surfaceAppId,
      threadId: resolvedThreadId,
      guiSnapshot: surface?.guiSnapshot ?? this.appSurface?.guiSnapshot,
      mode: "embedded",
      appName: this.appSurface?.appName,
      guiActions: this.appSurface?.guiActions,
      skills: this.appSurface?.skills,
    };
    void this.enrichAppSurfaceFromAgUi(commands.length === 0);
    voiceLog(this.sessionId, "surface", `register app=${this.surfaceAppId} commands=${this.voiceCommands.length}`, {
      threadId: resolvedThreadId.slice(0, 48),
      guiKeys: surface?.guiSnapshot ? Object.keys(surface.guiSnapshot).length : 0,
    });
  }

  private async enrichAppSurfaceFromAgUi(loadVoiceTools = false): Promise<void> {
    if (!this.appSurface) return;
    const info = await fetchAgUiAppInfo(this.appSurface.appId);
    if (!this.appSurface) return;
    if (loadVoiceTools && info.voiceTools.length > 0) {
      this.voiceCommands = info.voiceTools;
    }
    this.appSurface = {
      ...this.appSurface,
      appName: info.appName ?? this.appSurface.appName,
      guiActions: info.guiActions.length ? info.guiActions : this.appSurface.guiActions,
      skills: info.skills.length ? info.skills : this.appSurface.skills,
    };
  }

  private resolveS2sSystemPrompt(): string {
    if (!this.appSurface) return WEB_SYSTEM_PROMPT;
    return `${WEB_SYSTEM_PROMPT} ${buildEmbeddedAppVoicePromptAddendum(JOSHU_IDENTITY, {
      appId: this.appSurface.appId,
      appName: this.appSurface.appName,
      guiActions: this.appSurface.guiActions,
    })}`;
  }

  handleStart(
    sessionId: string,
    chatSessionId: string,
    surface?: {
      appId?: string;
      voiceCommands?: AppVoiceCommand[];
      threadId?: string;
      guiSnapshot?: Record<string, unknown>;
    },
  ): void {
    this.sessionId = sessionId;
    this.surfaceSessionId = chatSessionId || sessionId;
    this.t0 = performance.now();
    void this.bootstrapAndConnect(surface);
  }

  private async bootstrapAndConnect(surface?: {
    appId?: string;
    voiceCommands?: AppVoiceCommand[];
    threadId?: string;
    guiSnapshot?: Record<string, unknown>;
  }): Promise<void> {
    if (surface?.appId) {
      this.handleRegisterSurface(surface.appId, surface.voiceCommands ?? [], {
        threadId: surface.threadId ?? this.surfaceSessionId,
        guiSnapshot: surface.guiSnapshot,
      });
      if (!surface.voiceCommands?.length) {
        await this.enrichAppSurfaceFromAgUi(true);
      }
    }

    const extraTools =
      this.surfaceAppId && this.voiceCommands.length
        ? buildAppVoiceToolDefinitions(this.surfaceAppId, this.voiceCommands)
        : [];

    const provider = VOICE_S2S_PROVIDER;
    this.s2s = createVoiceS2sClient(
      {
        audioFormat: "pcm24",
        systemPrompt: this.resolveS2sSystemPrompt(),
        injectPresentation: "screen",
        turnDetection: BROWSER_VAD,
        extraTools,
      },
      {
        sessionId: this.sessionId,
        onReady: () => {
          voiceLog(
            this.sessionId,
            provider,
            `browser session ready ms=${Math.round(performance.now() - this.t0)}`,
          );
          this.send({ event: "browser_ready", sessionId: this.sessionId, provider });
          this.setState("listening");
        },
        onOutputAudioDelta: ({ deltaB64, itemId }) => this.forwardPcmDelta(deltaB64, itemId),
        onSpeechStarted: () => void this.handleSpeechStarted(),
        onResponseStarted: ({ reason, seq }) => this.handleResponseStarted(reason, seq),
        onUserTranscript: (text) => {
          voiceLog(this.sessionId, "user", `said: ${JSON.stringify(text)}`);
          this.pushTranscript("user", text);
          this.send({ event: "user_transcript", text, partial: false });
          this.beginUserTurn(text);
        },
        onAssistantTranscript: (delta) => {
          this.assistantPartial += delta;
          this.responseHadSpeech = true;
          if (this.organicSurfaceSync && !this.brainJob) {
            this.emitSurface(surfaceAssistantDelta(delta));
          }
        },
        onResponseDone: (info) => {
          voiceLog(this.sessionId, provider, "response.done", info);
          this.logSpokeBeforeThink(info);
          if (this.assistantPartial.trim()) {
            voiceLog(this.sessionId, "speech-out", "realtime spoke", {
              preview: this.assistantPartial.trim().slice(0, 400),
              chars: this.assistantPartial.length,
            });
          }
          if (info.status !== "cancelled") {
            if (this.sessionState === "speaking" || this.pcmOutAcc.length > 0) {
              this.flushPcmOutTail();
            }
            this.setState(this.brainJob ? "thinking" : "listening");
          }
          this.realtimeTurnSettled = true;
          this.reconcileThinkAfterResponseDone(info);
          this.finalizeOrganicSurfaceTurn(info);
          this.handleResponseDone(info);
          this.discardAssistantPartial();
          this.organicSurfaceSync = false;
          this.activeSpeechReason = null;
        },
        onFunctionCall: (call) => void this.handleFunctionCall(call),
        onError: (msg) => {
          voiceWarn(this.sessionId, provider, msg);
          this.send({ event: "error", message: msg });
        },
      },
    );

    this.s2s.connect();
    voiceLog(this.sessionId, "browser", "stream start");
  }

  handleInboundPcm24kPayload(b64: string): void {
    this.s2s?.appendPcm24kB64(b64);
  }

  /** Client confirmed intentional interrupt (local RMS gate passed). */
  handleInterrupt(): void {
    this.applyBargeIn("client");
  }

  close(): void {
    this.cancelBrainJob();
    voiceLog(this.sessionId, "browser", "stream close");
    this.s2s?.close();
    this.s2s = null;
  }

  private forwardPcmDelta(deltaB64: string, itemId?: string): void {
    if (!deltaB64 || this.ws.readyState !== 1) return;
    // Drop stray organic audio while Hermes is running — think path uses progress + inject only.
    if (this.brainJob && this.activeSpeechReason === "organic") return;
    if (itemId) this.lastAssistantItem = itemId;
    this.setState("speaking");

    const chunk = Buffer.from(deltaB64, "base64");
    this.pcmOutAcc = Buffer.concat([this.pcmOutAcc, chunk]);
    while (this.pcmOutAcc.length >= PCM_OUT_BATCH_BYTES) {
      const frame = this.pcmOutAcc.subarray(0, PCM_OUT_BATCH_BYTES);
      this.pcmOutAcc = this.pcmOutAcc.subarray(PCM_OUT_BATCH_BYTES);
      this.send({
        event: "browser_audio_out",
        payload: frame.toString("base64"),
        format: "pcm24k",
      });
    }
  }

  private flushPcmOutTail(): void {
    const tail = this.pcmOutAcc.length - (this.pcmOutAcc.length % 2);
    if (tail >= 2) {
      this.send({
        event: "browser_audio_out",
        payload: this.pcmOutAcc.subarray(0, tail).toString("base64"),
        format: "pcm24k",
      });
    }
    this.pcmOutAcc = Buffer.alloc(0);
    this.send({ event: "tts_end" });
  }

  private handleSpeechStarted(): void {
    // OpenAI speech_started also fires when the user begins a normal turn — only barge-in during TTS.
    if (this.sessionState !== "speaking") return;
    // During think, only interrupt casual S2S — not progress ticks or Hermes summary playback.
    if (this.brainJob && this.activeSpeechReason !== "organic") return;
    this.applyBargeIn("vad");
  }

  private handleResponseStarted(reason: ResponseSpeechReason, seq: number): void {
    if (this.brainJob && reason === "organic") {
      voiceWarn(this.sessionId, "think", "cancel unexpected organic speech during brain job", { seq });
      this.s2s?.cancelActiveResponse();
      this.activeSpeechReason = null;
      return;
    }
    this.activeSpeechReason = reason;
    this.responseHadSpeech = false;
    voiceLog(this.sessionId, VOICE_S2S_PROVIDER, "speech start", { reason, seq });
  }

  /** Warn when S2S spoke then called think in the same response (user hears a guess, then the real answer). */
  private logSpokeBeforeThink(info: Record<string, unknown>): void {
    const fnCalls = Array.isArray(info.functionCalls) ? info.functionCalls : [];
    const calledThink = fnCalls.some((n) => normalizeThinkToolName(String(n)) === "think");
    if (!calledThink || !this.responseHadSpeech) return;
    voiceWarn(this.sessionId, "think", "ANTIPATTERN spoke-before-think", {
      spokePreview: this.assistantPartial.trim().slice(0, 200),
      hint: "S2S spoke in the same turn as think — user may hear a guess before Hermes answers",
    });
  }

  private applyBargeIn(source: "client" | "vad"): void {
    voiceLog(this.sessionId, "vad", `barge-in source=${source} state=${this.sessionState}`);
    this.s2s?.cancelActiveResponse();
    if (this.lastAssistantItem) {
      this.s2s?.truncateItem(this.lastAssistantItem, 0);
    }
    this.lastAssistantItem = null;
    this.pcmOutAcc = Buffer.alloc(0);
    this.send({ event: "clear_audio" });
    this.send({ event: "barge_in" });
    this.discardAssistantPartial();
    this.organicSurfaceSync = false;
    this.activeSpeechReason = null;
    this.setState("listening");
  }

  private discardAssistantPartial(): void {
    this.assistantPartial = "";
  }

  private pushTranscript(role: "user" | "assistant", text: string): void {
    if (role === "user") {
      this.discardAssistantPartial();
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

  private handleResponseDone(info: Record<string, unknown>): void {
    const job = this.brainJob;
    if (!job?.progress || job.progress.phase === "done") return;
    if (info.status === "cancelled") return;

    const { progress } = job;
    if (progress.phase === "awaiting_ack") {
      progress.phase = "idle";
      this.scheduleProgressTick(job.jobId, HERMES_PROGRESS_FIRST_DELAY_MS);
      return;
    }
    if (progress.phase === "awaiting_speech") {
      progress.phase = "idle";
      const gap = HERMES_PROGRESS_INTERVAL_MS + HERMES_PROGRESS_POST_SPEECH_MS;
      this.scheduleProgressTick(job.jobId, gap);
    }
  }

  private scheduleProgressTick(jobId: string, delayMs: number): void {
    const job = this.brainJob;
    if (!job || job.jobId !== jobId || !job.progress || job.progress.phase === "done") return;
    if (job.progress.timer) clearTimeout(job.progress.timer);
    job.progress.timer = setTimeout(() => this.fireProgressTick(jobId), delayMs);
  }

  private fireProgressTick(jobId: string): void {
    const job = this.brainJob;
    if (!job || job.jobId !== jobId || !job.progress || job.progress.phase === "done") return;
    job.progress.timer = null;
    job.progress.tick += 1;

    if (job.progress.tick > HERMES_PROGRESS_MAX_TICKS) {
      if (!job.progress.longWaitSent) {
        job.progress.longWaitSent = true;
        job.progress.phase = "awaiting_speech";
        this.s2s?.injectProgressMessage("This is taking a bit longer than usual.");
      }
      return;
    }

    const phrase = PROGRESS_PHRASES[(job.progress.tick - 1) % PROGRESS_PHRASES.length]!;
    job.progress.phase = "awaiting_speech";
    this.s2s?.injectProgressMessage(phrase);
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

    const toolName = normalizeThinkToolName(call.name);
    voiceLog(this.sessionId, "tool", `invoke ${toolName}`, { callId: call.callId, args });

    if (toolName === "open_desktop") {
      const app = String(args.app ?? "");
      const moduleName = resolveDesktopModule(app);
      if (!moduleName) {
        s2s.sendFunctionOutput(
          call.callId,
          JSON.stringify({ status: "error", error: `Unknown desktop app: ${app}` }),
          { triggerResponse: true },
        );
        return;
      }
      // User is already inside this embedded app — route to think instead of re-opening desktop.
      if (this.surfaceAppId && surfaceTargetsCurrentApp(this.surfaceAppId, moduleName)) {
        voiceLog(this.sessionId, "tool", "open_desktop blocked — embedded app active, starting think", {
          app: moduleName,
          surfaceAppId: this.surfaceAppId,
        });
        s2s.sendFunctionOutput(
          call.callId,
          JSON.stringify({
            status: "redirect",
            message: `${moduleName} is already open — use think for in-app tasks.`,
          }),
          { triggerResponse: false },
        );
        this.turnThinkRequested = true;
        this.organicSurfaceSync = false;
        this.startBrainJob({
          userQuote: this.pendingUserQuote ?? undefined,
          intent: "in_app_task",
          summary: this.conversationSummary(),
          voiceInject: true,
          withProgress: true,
          source: "think",
        });
        return;
      }
      this.emitSurface(surfaceDesktopAction({ kind: "module", target: moduleName }));
      s2s.sendFunctionOutput(
        call.callId,
        JSON.stringify({ status: "opened", app: moduleName }),
        { triggerResponse: true },
      );
      return;
    }

    if (this.surfaceAppId && this.voiceCommands.length) {
      const resolved = resolveAppVoiceTool(call.name, this.voiceCommands, this.surfaceAppId);
      if (resolved) {
        const actionArgs = mapAppVoiceToolArgs(resolved.cmd, args);
        this.emitSurface(surfaceAppAction(this.surfaceAppId, resolved.action, actionArgs));
        s2s.sendFunctionOutput(
          call.callId,
          JSON.stringify({ status: "ok", action: resolved.action, args: actionArgs }),
          { triggerResponse: true },
        );
        return;
      }
    }

    if (toolName !== "think") {
      s2s.sendFunctionOutput(call.callId, JSON.stringify({ error: `Unknown tool: ${call.name}` }));
      return;
    }

    const intent = String(args.intent ?? "task");
    const summary = String(args.summary ?? this.conversationSummary());
    const userQuote = typeof args.user_quote === "string" ? args.user_quote : undefined;

    s2s.sendFunctionOutput(
      call.callId,
      JSON.stringify({
        status: "accepted",
        job_id: this.brainJob?.jobId ?? randomUUID().slice(0, 8),
        message: `${JOSHU_IDENTITY.name} is thinking; results will appear on screen.`,
      }),
      { triggerResponse: false },
    );

    this.turnThinkRequested = true;
    this.organicSurfaceSync = false;

    if (this.brainJob) {
      voiceLog(this.sessionId, "think", `think reuse job=${this.brainJob.jobId}`);
      this.brainJob.voiceInject = true;
      this.brainJob.progress = {
        tick: 0,
        phase: "awaiting_ack",
        timer: null,
        longWaitSent: false,
      };
      s2s.injectProgressMessage("One moment.");
      return;
    }

    s2s.injectProgressMessage("One moment.");

    this.startBrainJob({
      intent,
      summary,
      userQuote: userQuote ?? this.pendingUserQuote ?? undefined,
      voiceInject: true,
      withProgress: true,
      source: "think",
    });
  }

  /** New user utterance — arm organic surface sync; brain only when S2S calls think. */
  private beginUserTurn(userQuote: string): void {
    if (this.lastBrainHandledQuote && this.lastBrainHandledQuote !== userQuote) {
      this.lastBrainHandledQuote = null;
    }
    if (this.lastBrainHandledQuote === userQuote) {
      voiceLog(this.sessionId, "think", "skip duplicate brain trigger (already handled)", {
        preview: userQuote.slice(0, 120),
      });
      this.pendingUserQuote = userQuote;
      return;
    }

    const job = this.brainJob;
    if (job) {
      if (this.turnThinkRequested || !job.userQuote || job.userQuote === userQuote) {
        voiceLog(this.sessionId, "think", "skip duplicate brain trigger (transcript after think)", {
          jobId: job.jobId,
        });
        this.pendingUserQuote = userQuote;
        return;
      }
      this.cancelBrainJob(true);
    }

    this.pendingUserQuote = userQuote;
    this.realtimeTurnSettled = false;
    this.turnThinkRequested = false;
    this.organicSurfaceSync = true;
  }

  /**
   * Casual turn with no think: mirror S2S speech transcription to the attached surface (jChat today).
   */
  private finalizeOrganicSurfaceTurn(info: Record<string, unknown>): void {
    if (!this.organicSurfaceSync) return;
    if (this.brainJob || this.turnThinkRequested) return;
    if (responseDoneRequestedThink(info.functionCalls)) return;

    const text = this.assistantPartial.trim();
    this.pendingUserQuote = null;

    if (info.status === "cancelled") {
      if (text) {
        this.pushTranscript("assistant", text);
        this.emitSurface(surfaceAssistantDone(text));
      }
      voiceLog(this.sessionId, "surface", "organic turn cancelled", { chars: text.length });
      return;
    }

    voiceLog(this.sessionId, "surface", "organic s2s sync", {
      preview: text.slice(0, 120),
      chars: text.length,
    });
    if (text) {
      this.pushTranscript("assistant", text);
    }
    this.emitSurface(surfaceAssistantDone(text));
  }

  /**
   * S2S reported think in response.done but no job started — start brain work for the pending quote.
   */
  private reconcileThinkAfterResponseDone(info: Record<string, unknown>): void {
    if (info.status === "cancelled") return;
    if (!responseDoneRequestedThink(info.functionCalls)) return;
    if (this.brainJob) return;

    const userQuote = this.pendingUserQuote;
    if (!userQuote) {
      voiceLog(this.sessionId, "think", "response.done think requested but no pending user quote");
      return;
    }
    if (this.lastBrainHandledQuote === userQuote) {
      voiceLog(this.sessionId, "think", "response.done think already handled for this utterance");
      return;
    }

    this.organicSurfaceSync = false;
    voiceLog(this.sessionId, "think", "reconcile brain job from response.done think", {
      preview: userQuote.slice(0, 120),
    });
    this.pendingUserQuote = null;
    this.turnThinkRequested = false;
    this.startBrainJob({
      userQuote,
      intent: "task",
      summary: this.conversationSummary(),
      voiceInject: true,
      withProgress: true,
      source: "think",
    });
  }

  private startBrainJob(params: {
    userQuote?: string;
    intent?: string;
    summary?: string;
    voiceInject: boolean;
    withProgress?: boolean;
    source?: "think";
  }): void {
    this.cancelBrainJob(true);
    const jobId = randomUUID().slice(0, 8);
    voiceLog(this.sessionId, "think", `start job=${jobId} source=${params.source ?? "unknown"}`, {
      intent: params.intent ?? "task",
      voiceInject: params.voiceInject,
    });
    const abort = new AbortController();
    this.brainJob = {
      abort,
      jobId,
      userQuote: params.userQuote ?? this.pendingUserQuote ?? undefined,
      voiceInject: params.voiceInject,
      progress: params.withProgress
        ? { tick: 0, phase: "awaiting_ack", timer: null, longWaitSent: false }
        : null,
    };

    this.setState("thinking");
    this.emitSurface(surfaceBrainJobStart());

    void this.enrichAppSurfaceFromAgUi().then(() => {
      void this.runBrainJob({
        jobId,
        abort,
        intent: params.intent ?? "task",
        summary: params.summary ?? this.conversationSummary(),
        userQuote: params.userQuote,
      });
    });
  }

  private async runBrainJob(params: {
    jobId: string;
    abort: AbortController;
    intent: string;
    summary: string;
    userQuote?: string;
  }): Promise<void> {
    const t0 = performance.now();
    try {
      const hermesText = await runJoshuThink({
        callSid: this.surfaceSessionId,
        jobId: params.jobId,
        intent: params.intent,
        summary: params.summary,
        userQuote: params.userQuote,
        signal: params.abort.signal,
        presentation: "screen",
        appContext: this.appSurface ?? undefined,
        onDelta: (delta) => {
          if (this.brainJob?.jobId !== params.jobId) return;
          this.emitSurface(surfaceAssistantDelta(delta));
        },
        onDesktopAction: (action) => {
          if (this.brainJob?.jobId !== params.jobId) return;
          this.emitSurface(surfaceDesktopAction(action));
        },
        onAppAction: (action) => {
          if (this.brainJob?.jobId !== params.jobId) return;
          this.emitSurface(surfaceAppAction(action.appId, action.action, action.args));
        },
      });
      if (params.abort.signal.aborted) return;

      voiceLog(this.sessionId, "think", `ui done job=${params.jobId} ms=${Math.round(performance.now() - t0)}`, {
        preview: hermesText.slice(0, 200),
      });

      this.pushTranscript("assistant", hermesText);
      this.emitSurface(surfaceAssistantDone(hermesText));

      const job = this.brainJob;
      if (job?.jobId === params.jobId && job.voiceInject) {
        this.finishHermesProgress(job);
        voiceLog(this.sessionId, "think", `voice inject job=${params.jobId}`, {
          preview: hermesText.slice(0, 200),
        });
        this.s2s?.injectAssistantMessage(hermesText);
      }
    } catch (e) {
      if (params.abort.signal.aborted) return;
      const msg = e instanceof Error ? e.message : String(e);
      voiceWarn(this.sessionId, "think", `ui failed job=${params.jobId}`, { error: msg });
      const errText = `I tried to complete your request but ran into a problem: ${msg}`;
      this.emitSurface(surfaceAssistantDone(errText));
      if (this.brainJob?.voiceInject) {
        this.finishHermesProgress(this.brainJob);
        this.s2s?.injectAssistantMessage(errText);
      }
    } finally {
      const job = this.brainJob;
      if (job?.jobId === params.jobId) {
        this.finishHermesProgress(job);
        const handledQuote = params.userQuote ?? job.userQuote;
        if (handledQuote) this.lastBrainHandledQuote = handledQuote;
        this.turnThinkRequested = false;
        this.brainJob = null;
        if (!params.abort.signal.aborted) {
          this.flushPcmOutTail();
          this.setState("listening");
        }
      }
    }
  }

  private finishHermesProgress(job: BrainJob): void {
    if (!job.progress) return;
    job.progress.phase = "done";
    if (job.progress.timer) clearTimeout(job.progress.timer);
    job.progress.timer = null;
  }

  private cancelBrainJob(abortHermes = true): void {
    const job = this.brainJob;
    if (!job) return;
    if (job.progress?.timer) clearTimeout(job.progress.timer);
    if (abortHermes) job.abort.abort();
    voiceLog(this.sessionId, "think", `cancelled ui job=${job.jobId}`);
    this.turnThinkRequested = false;
    this.lastBrainHandledQuote = null;
    this.brainJob = null;
  }

  private emitSurface(event: VoiceSurfaceWireEvent): void {
    this.send(event);
  }

  private setState(state: SessionState): void {
    this.sessionState = state;
    this.send({ event: "state", state });
  }

  private send(payload: Record<string, unknown>): void {
    if (this.ws.readyState !== 1) return;
    this.ws.send(JSON.stringify(payload));
  }
}
