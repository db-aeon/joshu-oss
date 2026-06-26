/**
 * Twilio PSTN gateway: inbound voice webhook + bidirectional Media Streams WebSocket.
 * Reuses Hermes STT/TTS subprocesses and HermesApiRunner.streamHermesChat (Hermes Chat parity).
 */

import { timingSafeEqual } from "node:crypto";
import type { Duplex } from "node:stream";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import twilio from "twilio";
import type { IncomingMessage } from "node:http";
import type { Request, Router } from "express";
import express from "express";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import YAML from "yaml";

import { decodeMulawToPcm16, encodePcm16ToMulaw } from "./audioMulawCodec.js";
import type { HermesApiRunner, HermesChatMessage } from "./hermesApi.js";
import { buildOwnerTimeSystemMessage } from "./ownerLocalTime.js";
import { getHermesHomeDir, spawnHermesPython } from "./hermesVoiceRuntime.js";
import {
  encodeWavMono16,
  HermesVoiceVad,
  rmsInt16,
} from "./hermesVoiceVad.js";
import { markdownSpeechPlaintext } from "./markdownSpeechPlaintext.js";

const SAMPLE_RATE = 8000;
/** Twilio frames near 20ms; encode outbound similarly */
const MULAW_CHUNK_SAMPLES = 160;

function envTrim(name: string): string {
  return process.env[name]?.trim() ?? "";
}

function normalizePhone(raw: string): string {
  return raw.replace(/[^\d+]/g, "");
}

function normalizePublicBasePath(raw: string): string {
  if (!raw) return "";
  const p = raw.startsWith("/") ? raw : `/${raw}`;
  return p.replace(/\/+$/, "") || "";
}

function mediaStreamHttpPath(publicBasePath: string): string {
  const base = normalizePublicBasePath(publicBasePath);
  return `${base}/api/twilio/media-stream`;
}

/** Token in the URL path survives ngrok/proxy WebSocket upgrades that drop query strings. */
function mediaStreamPathWithToken(publicBasePath: string, secret: string): string {
  const enc = encodeURIComponent(secret);
  return `${mediaStreamHttpPath(publicBasePath)}/${enc}`;
}

/**
 * Full HTTPS URL configured in Twilio console for POST /voice/inbound (must match signature validation exactly).
 */
function voiceInboundWebhookUrl(): string | undefined {
  const u = envTrim("TWILIO_VOICE_WEBHOOK_URL");
  return u || undefined;
}

function mediaStreamWssUrl(secret: string, publicBasePath = envTrim("PUBLIC_BASE_PATH")): string | undefined {
  const explicit = envTrim("TWILIO_MEDIA_STREAM_WSS_URL");
  if (explicit) {
    try {
      const u = new URL(explicit);
      u.protocol = u.protocol === "https:" ? "wss:" : u.protocol === "http:" ? "ws:" : u.protocol;
      u.hash = "";
      const hasQueryToken = u.searchParams.has("token");
      const isVoiceGatewayPath =
        u.pathname.includes("/voice/media") || u.pathname.includes("/voice-rt/media");
      if (hasQueryToken || isVoiceGatewayPath) {
        return u.toString();
      }
      u.search = "";
      const base = mediaStreamHttpPath(publicBasePath);
      if (u.pathname === base || u.pathname.endsWith("/media-stream")) {
        u.pathname = mediaStreamPathWithToken(publicBasePath, secret);
      } else if (!u.pathname.endsWith(`/${encodeURIComponent(secret)}`)) {
        u.pathname = `${u.pathname.replace(/\/$/, "")}/${encodeURIComponent(secret)}`;
      }
      return u.toString();
    } catch {
      return undefined;
    }
  }
  const hook = voiceInboundWebhookUrl();
  if (!hook) return undefined;
  try {
    const u = new URL(hook);
    if (u.protocol !== "https:" && u.protocol !== "http:") return undefined;
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    u.pathname = mediaStreamPathWithToken(publicBasePath, secret);
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return undefined;
  }
}

function twilioGatewayEnabled(): boolean {
  return Boolean(envTrim("TWILIO_AUTH_TOKEN") && envTrim("TWILIO_MEDIA_STREAM_SECRET") && voiceInboundWebhookUrl());
}

/** URLs Twilio may have signed (console URL, env, trailing slash, ngrok forwarded host). */
function signatureValidationUrls(req: Request, publicBasePath: string): string[] {
  const out = new Set<string>();
  const add = (raw?: string) => {
    const u = raw?.trim();
    if (!u) return;
    out.add(u);
    if (u.endsWith("/")) out.add(u.replace(/\/+$/, ""));
    else out.add(`${u}/`);
  };

  add(voiceInboundWebhookUrl());

  const proto =
    (typeof req.headers["x-forwarded-proto"] === "string"
      ? req.headers["x-forwarded-proto"].split(",")[0]?.trim()
      : undefined) || "https";
  const host =
    (typeof req.headers["x-forwarded-host"] === "string"
      ? req.headers["x-forwarded-host"].split(",")[0]?.trim()
      : undefined) ||
    (typeof req.headers.host === "string" ? req.headers.host : "");
  if (host) {
    const base = normalizePublicBasePath(publicBasePath);
    add(`${proto}://${host}${base}/api/twilio/voice/inbound`);
  }

  return [...out];
}

function validateTwilioVoiceSignature(
  authToken: string,
  signature: string,
  req: Request,
  publicBasePath: string,
): { ok: boolean; matchedUrl?: string; tried: string[] } {
  const params = req.body as Record<string, string>;
  const tried = signatureValidationUrls(req, publicBasePath);
  for (const url of tried) {
    if (twilio.validateRequest(authToken, signature, url, params)) {
      return { ok: true, matchedUrl: url, tried };
    }
  }
  return { ok: false, tried };
}

/** Twilio/WSS clients sometimes deliver '+' as space when the query was not fully percent-encoded. */
function normalizeStreamToken(token: string): string {
  return token.trim().replace(/ /g, "+");
}

function extractMediaStreamToken(reqUrl: URL, streamPath: string): string {
  const fromQuery = normalizeStreamToken(reqUrl.searchParams.get("token") ?? "");
  if (fromQuery) return fromQuery;
  const prefix = `${streamPath}/`;
  const pathname = reqUrl.pathname;
  if (!pathname.startsWith(prefix)) return "";
  const segment = pathname.slice(prefix.length).split("/")[0] ?? "";
  if (!segment) return "";
  try {
    return normalizeStreamToken(decodeURIComponent(segment));
  } catch {
    return normalizeStreamToken(segment);
  }
}

function isMediaStreamUpgradePath(pathname: string, streamPath: string): boolean {
  return pathname === streamPath || pathname.startsWith(`${streamPath}/`);
}

function safeEqualToken(a: string, b: string): boolean {
  const na = normalizeStreamToken(a);
  const nb = normalizeStreamToken(b);
  try {
    const ba = Buffer.from(na);
    const bb = Buffer.from(nb);
    if (ba.length !== bb.length) return false;
    return timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

async function loadVoiceYamlSettings(): Promise<{ silenceThreshold: number; silenceDurationSec: number }> {
  let silenceThreshold = 200;
  let silenceDurationSec = 3;
  const cfgPath = path.join(getHermesHomeDir(), "config.yaml");
  const raw = await readFile(cfgPath, "utf8").catch(() => "");
  if (raw.trim()) {
    try {
      const doc = YAML.parse(raw) as Record<string, unknown> | null | undefined;
      const voice = doc?.voice;
      if (voice && typeof voice === "object" && !Array.isArray(voice)) {
        const v = voice as Record<string, unknown>;
        const st = v.silence_threshold;
        const sd = v.silence_duration;
        if (typeof st === "number" && !Number.isNaN(st)) silenceThreshold = st;
        if (typeof sd === "number" && !Number.isNaN(sd)) silenceDurationSec = sd;
      }
    } catch {
      /* ignore malformed YAML */
    }
  }
  return { silenceThreshold, silenceDurationSec };
}

async function transcribeWav(wav: Buffer): Promise<{ ok: boolean; transcript: string; error?: string }> {
  const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  let tmpDir: string | undefined;
  try {
    tmpDir = await mkdtemp(path.join(tmpdir(), "joshu-phone-stt-"));
    const wavPath = path.join(tmpDir, "clip.wav");
    await writeFile(wavPath, wav);
    const { stdout, stderr, code } = await spawnHermesPython("hermes-chat-transcribe.py", [wavPath]);
    const trimmed = stdout.trim();
    const lastLine = trimmed.split("\n").pop() ?? trimmed;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(lastLine) as Record<string, unknown>;
    } catch {
      return {
        ok: false,
        transcript: "",
        error: `Hermes transcribe invalid JSON: ${stderr.slice(0, 500)} code=${code}`,
      };
    }
    if (!parsed.success) {
      return {
        ok: false,
        transcript: "",
        error: typeof parsed.error === "string" ? parsed.error : "Transcription failed",
      };
    }
    return { ok: true, transcript: typeof parsed.transcript === "string" ? parsed.transcript : "" };
  } catch (e) {
    return { ok: false, transcript: "", error: e instanceof Error ? e.message : String(e) };
  } finally {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function ttsToBuffer(text: string): Promise<{ ok: boolean; audio?: Buffer; error?: string }> {
  const { readFile: rf, rm } = await import("node:fs/promises");
  const payloadText = text.replace(/[\u200B-\u200D\u2060\uFEFF]/g, "").trim();
  if (!payloadText) return { ok: false, error: "empty TTS text" };
  try {
    const { stdout, stderr, code } = await spawnHermesPython("hermes-chat-tts.py", [], payloadText);
    const trimmed = stdout.trim();
    const lastLine = trimmed.split("\n").pop() ?? trimmed;
    let meta: { success?: boolean; file_path?: string; error?: string };
    try {
      meta = JSON.parse(lastLine) as { success?: boolean; file_path?: string; error?: string };
    } catch {
      return { ok: false, error: `Hermes TTS invalid JSON: ${stderr.slice(0, 500)} code=${code}` };
    }
    if (!meta.success || !meta.file_path) {
      return { ok: false, error: meta.error || "TTS generation failed" };
    }
    const audioBuf = await rf(meta.file_path);
    await rm(meta.file_path, { force: true }).catch(() => undefined);
    return { ok: true, audio: audioBuf };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Decode Hermes MP3 (or other ffmpeg-supported audio) to mono s16le @ 8 kHz via ffmpeg stdin/stdout. */
async function ffmpegAudioToPcm8kMono(input: Buffer): Promise<Int16Array> {
  return await new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      "pipe:0",
      "-f",
      "s16le",
      "-ac",
      "1",
      "-ar",
      String(SAMPLE_RATE),
      "pipe:1",
    ]);
    const chunks: Buffer[] = [];
    ff.stdout.on("data", (c: Buffer) => chunks.push(c));
    ff.stderr.on("data", () => undefined);
    ff.on("error", (err) => reject(err));
    ff.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg exited ${code}; install ffmpeg for phone TTS (see docs).`));
        return;
      }
      const buf = Buffer.concat(chunks);
      resolve(new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2));
    });
    ff.stdin.end(input);
  });
}

function concatInt16(chunks: Int16Array[]): Int16Array {
  const n = chunks.reduce((a, c) => a + c.length, 0);
  const out = new Int16Array(n);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

class TwilioMediaStreamSession {
  private streamSid: string | null = null;
  private callSid = "";
  private vad: HermesVoiceVad;
  private segmentChunks: Int16Array[] = [];
  /** Ignore inbound audio while sending TTS (simple echo avoidance). */
  private outboundBusy = false;
  private dialogBusy = false;
  private history: HermesChatMessage[] = [];
  private readonly systemPrompt: string;
  private readonly hermesModel?: string;

  constructor(
    private readonly ws: WebSocket,
    vadOpts: { silenceThreshold: number; silenceDurationSec: number },
    private readonly runner: HermesApiRunner,
  ) {
    this.vad = new HermesVoiceVad(vadOpts);
    this.vad.beginSegment(performance.now() / 1000);
    this.systemPrompt =
      envTrim("TWILIO_PHONE_SYSTEM_PROMPT") ||
      "You are Hermes on a phone call. Reply in concise, spoken-friendly language. Avoid markdown tables, code fences, and long URLs.";
    const m = envTrim("TWILIO_HERMES_MODEL");
    this.hermesModel = m || undefined;
  }

  async handleStart(callSid: string, streamSid: string): Promise<void> {
    this.callSid = callSid;
    this.streamSid = streamSid;
    const vs = await loadVoiceYamlSettings();
    this.vad = new HermesVoiceVad(vs);
    this.vad.beginSegment(performance.now() / 1000);
    this.segmentChunks = [];
    this.history = [];
    console.info(`[twilio-phone] stream start callSid=${callSid} streamSid=${streamSid}`);
  }

  handleInboundMulawPayload(b64: string): void {
    if (this.outboundBusy || this.dialogBusy || !this.streamSid) return;
    const raw = Buffer.from(b64, "base64");
    const frame = decodeMulawToPcm16(new Uint8Array(raw));
    const rms = rmsInt16(frame);
    const t = performance.now() / 1000;
    const endUtterance = this.vad.process(rms, t);
    this.segmentChunks.push(frame);
    if (endUtterance) {
      void this.onUtteranceEnd();
    }
  }

  private async onUtteranceEnd(): Promise<void> {
    const chunks = this.segmentChunks;
    this.segmentChunks = [];
    this.vad.beginSegment(performance.now() / 1000);

    if (this.dialogBusy || !this.streamSid) return;

    const flat = concatInt16(chunks);
    const minSamples = Math.floor(SAMPLE_RATE * 0.35);
    if (flat.length < minSamples) return;

    const wavBuf = Buffer.from(new Uint8Array(encodeWavMono16([flat], SAMPLE_RATE)));

    this.dialogBusy = true;
    try {
      await this.runner.ensureGatewayReady();
      const st = await transcribeWav(wavBuf);
      if (!st.ok || !st.transcript.trim()) {
        if (!st.ok) console.warn("[twilio-phone] transcribe:", st.error);
        return;
      }

      const userText = st.transcript.trim();
      console.info(`[twilio-phone] transcript (${this.callSid}):`, userText.slice(0, 200));

      const messages: HermesChatMessage[] = [
        buildOwnerTimeSystemMessage(process.cwd()),
        { role: "system", content: this.systemPrompt },
        ...this.history.slice(-24),
        { role: "user", content: userText },
      ];

      const sessionKey = `phone:${this.callSid}`;
      const { finalText } = await this.runner.streamHermesChat(
        {
          sessionId: sessionKey,
          model: this.hermesModel,
          messages,
          signal: AbortSignal.timeout(180_000),
        },
        {},
      );

      const spoken = markdownSpeechPlaintext(finalText);
      if (!spoken) {
        console.warn("[twilio-phone] empty assistant speech after markdown strip");
        return;
      }

      this.history.push({ role: "user", content: userText });
      this.history.push({ role: "assistant", content: finalText });

      const tts = await ttsToBuffer(spoken);
      if (!tts.ok || !tts.audio) {
        console.warn("[twilio-phone] TTS:", tts.error);
        return;
      }

      let pcm8k: Int16Array;
      try {
        pcm8k = await ffmpegAudioToPcm8kMono(tts.audio);
      } catch (e) {
        console.warn("[twilio-phone] ffmpeg decode TTS failed:", e);
        return;
      }

      await this.playPcmMulaw(pcm8k);
    } catch (e) {
      console.warn("[twilio-phone] dialog error:", e);
    } finally {
      this.dialogBusy = false;
    }
  }

  /** Send mulaw at ~real-time pace so Twilio buffer doesn't overrun; clears outbound buffer first. */
  private async playPcmMulaw(pcm: Int16Array): Promise<void> {
    const sid = this.streamSid;
    if (!sid || this.ws.readyState !== WebSocket.OPEN) return;

    this.outboundBusy = true;
    try {
      this.ws.send(JSON.stringify({ event: "clear", streamSid: sid }));

      for (let i = 0; i < pcm.length; i += MULAW_CHUNK_SAMPLES) {
        if (this.ws.readyState !== WebSocket.OPEN) break;
        const slice = pcm.subarray(i, Math.min(i + MULAW_CHUNK_SAMPLES, pcm.length));
        const padded =
          slice.length === MULAW_CHUNK_SAMPLES
            ? slice
            : Int16Array.from({ length: MULAW_CHUNK_SAMPLES }, (_, j) => (j < slice.length ? slice[j]! : 0));
        const mulawBytes = encodePcm16ToMulaw(padded);
        const payload = Buffer.from(mulawBytes).toString("base64");
        this.ws.send(
          JSON.stringify({
            event: "media",
            streamSid: sid,
            media: { payload },
          }),
        );
        this.ws.send(
          JSON.stringify({
            event: "mark",
            streamSid: sid,
            mark: { name: `pcm-${i}` },
          }),
        );
        await new Promise((r) => setTimeout(r, 18));
      }
    } finally {
      this.outboundBusy = false;
    }
  }
}

export function registerTwilioVoiceRoutes(
  router: Router,
  runner: HermesApiRunner,
  publicBasePath = envTrim("PUBLIC_BASE_PATH"),
): void {
  if (!twilioGatewayEnabled()) {
    console.info("[twilio-phone] disabled (set TWILIO_AUTH_TOKEN, TWILIO_MEDIA_STREAM_SECRET, TWILIO_VOICE_WEBHOOK_URL)");
    return;
  }

  const authToken = envTrim("TWILIO_AUTH_TOKEN");
  const webhookFullUrl = voiceInboundWebhookUrl()!;
  const secret = envTrim("TWILIO_MEDIA_STREAM_SECRET");
  const wssUrl = mediaStreamWssUrl(secret, publicBasePath);
  if (!wssUrl) {
    console.warn("[twilio-phone] could not build media stream WSS URL");
    return;
  }

  router.post("/api/twilio/voice/inbound", express.urlencoded({ extended: false }), (req, res) => {
    const sig = req.headers["x-twilio-signature"];
    if (typeof sig !== "string") {
      res.status(403).send("missing signature");
      return;
    }
    const validation = validateTwilioVoiceSignature(authToken, sig, req, publicBasePath);
    if (!validation.ok) {
      console.warn(
        "[twilio-phone] invalid Twilio signature (check TWILIO_AUTH_TOKEN = Primary Auth Token for this account, and Twilio console voice URL matches TWILIO_VOICE_WEBHOOK_URL exactly)",
      );
      console.warn("[twilio-phone] configured webhook:", webhookFullUrl);
      console.warn("[twilio-phone] signature URLs tried:", validation.tried.join(" | "));
      res.status(403).send("bad signature");
      return;
    }
    if (validation.matchedUrl && validation.matchedUrl !== webhookFullUrl) {
      console.info("[twilio-phone] signature ok via URL:", validation.matchedUrl);
    }

    const callSid = typeof req.body?.CallSid === "string" ? req.body.CallSid : "";
    const from = typeof req.body?.From === "string" ? req.body.From : "";
    const ownerCaller = envTrim("TWILIO_OWNER_CALLER");
    console.info(`[twilio-phone] inbound voice callSid=${callSid} from=${from}`);

    const vr = new twilio.twiml.VoiceResponse();
    const connect = vr.connect();
    const stream = connect.stream({ url: wssUrl });
    // Forward caller metadata so voice-realtime can apply owner-aware call policy.
    stream.parameter({ name: "caller", value: normalizePhone(from) });
    if (ownerCaller) {
      stream.parameter({ name: "ownerCaller", value: normalizePhone(ownerCaller) });
    }
    res.type("text/xml").send(vr.toString());
  });

  router.get("/api/twilio/health", async (_req, res) => {
    try {
      await runner.ensureGatewayReady();
      res.json({
        ok: true,
        gateway: "twilio",
        hermesReady: true,
        webhookUrlConfigured: Boolean(webhookFullUrl),
        mediaStreamConfigured: Boolean(wssUrl),
      });
    } catch (error) {
      res.status(503).json({
        ok: false,
        gateway: "twilio",
        hermesReady: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  console.info("[twilio-phone] voice webhook expects POST URL:", webhookFullUrl);
  console.info("[twilio-phone] media stream WSS:", wssUrl.replace(/token=[^&]+/, "token=(redacted)"));
}

/**
 * Returns true if this request was handled (including rejected connections).
 * Return false so another upgrade handler (e.g. noVNC) can process the socket.
 */
export function createTwilioUpgradeHandler(
  publicBasePath: string,
  runner: HermesApiRunner,
): ((req: IncomingMessage, socket: Duplex, head: Buffer) => boolean) | null {
  if (!twilioGatewayEnabled()) return null;

  const secret = envTrim("TWILIO_MEDIA_STREAM_SECRET");
  const pathExpected = mediaStreamHttpPath(publicBasePath);

  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws: WebSocket) => {
    // Attach handlers immediately — Twilio can send `start` in the first ms after upgrade.
    const session = new TwilioMediaStreamSession(
      ws,
      { silenceThreshold: 200, silenceDurationSec: 3 },
      runner,
    );
    console.info("[twilio-phone] stream websocket open");

    ws.on("message", (data: RawData) => {
      try {
        const raw = typeof data === "string" ? data : data.toString("utf8");
        const msg = JSON.parse(raw) as Record<string, unknown>;
        const ev = msg.event;

        if (ev === "connected") {
          console.info("[twilio-phone] stream protocol connected");
          return;
        }

        if (ev === "start") {
          const start = msg.start as Record<string, unknown> | undefined;
          const streamSid = String(start?.streamSid ?? msg.streamSid ?? "");
          const callSid = String(start?.callSid ?? "");
          void session.handleStart(callSid, streamSid);
          return;
        }

        if (ev === "stop") {
          console.info("[twilio-phone] stream stop");
          ws.close();
          return;
        }

        if (ev === "media") {
          const media = msg.media as Record<string, unknown> | undefined;
          if (media?.track === "outbound") return;
          const payload = media?.payload;
          if (typeof payload === "string") session.handleInboundMulawPayload(payload);
        }
      } catch (e) {
        console.warn("[twilio-phone] ws message error:", e);
      }
    });

    ws.on("close", () => console.info("[twilio-phone] stream websocket closed"));
  });

  return (req: IncomingMessage, socket: Duplex, head: Buffer): boolean => {
    try {
      const reqUrl = new URL(req.url ?? "/", "http://localhost");
      const pathname = reqUrl.pathname;
      if (!isMediaStreamUpgradePath(pathname, pathExpected)) {
        if (pathname.includes("media-stream") || pathname.includes("twilio")) {
          console.warn(`[twilio-phone] media stream path mismatch: got ${pathname} expected ${pathExpected} or ${pathExpected}/<token>`);
        }
        return false;
      }

      const token = extractMediaStreamToken(reqUrl, pathExpected);
      if (!safeEqualToken(token, secret)) {
        console.warn(
          `[twilio-phone] media stream rejected (bad token) path=${pathname} tokenLen=${token.length} expectedLen=${secret.length} hasQuery=${reqUrl.search.includes("token")} — token is in the WSS path (/media-stream/<secret>), not ?token=, for ngrok compatibility`,
        );
        socket.destroy();
        return true;
      }

      console.info(`[twilio-phone] media stream websocket upgrade ok path=${pathname}`);
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
      return true;
    } catch (e) {
      console.warn("[twilio-phone] media stream upgrade error:", e);
      socket.destroy();
      return true;
    }
  };
}
