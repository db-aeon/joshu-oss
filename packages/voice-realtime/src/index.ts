/**
 * Speech-to-speech voice — OpenAI Realtime or Gemini Live (PSTN μ-law + browser PCM24k).
 */

import "./loadEnv.js";
import express from "express";
import { createServer } from "node:http";
import { WebSocketServer, type RawData } from "ws";

import { BrowserRealtimeSession } from "./browserRealtimeSession.js";
import type { AppVoiceCommand } from "./appVoiceTools.js";
import {
  GEMINI_LIVE_MODEL,
  HERMES_API_BASE_URL,
  HOST,
  MEDIA_STREAM_SECRET,
  MODE,
  OPENAI_REALTIME_MODEL,
  PORT,
  speechToSpeechEnabled,
  speechToSpeechDisableReasons,
  TWILIO_THINK_PASSWORD,
  VOICE_S2S_PROVIDER,
  webRealtimeEnabled,
  webVoiceDisableReasons,
} from "./config.js";
import { voiceS2sProviderLabel } from "./createVoiceS2sClient.js";
import { safeEqualToken } from "./safeEqual.js";
import { TwilioRealtimeSession } from "./twilioRealtimeSession.js";

const app = express();

app.use((req, _res, next) => {
  if (req.path.includes("health")) {
    next();
    return;
  }
  console.info(`[voice-realtime] http ${req.method} ${req.url}`);
  next();
});

const healthHandler = (_req: express.Request, res: express.Response) => {
  const provider = voiceS2sProviderLabel();
  res.json({
    ok: true,
    mode: MODE,
    speechToSpeech: speechToSpeechEnabled(),
    web: webRealtimeEnabled(),
    webStack: provider,
    provider: VOICE_S2S_PROVIDER,
    model: VOICE_S2S_PROVIDER === "gemini_live" ? GEMINI_LIVE_MODEL : OPENAI_REALTIME_MODEL,
  });
};

app.get(["/health", "/voice-rt/health", "/voice/health"], healthHandler);

const MEDIA_PATH_PREFIXES = ["/media", "/voice-rt/media", "/voice/media"];

function isMediaStreamPath(pathname: string): boolean {
  if (MEDIA_PATH_PREFIXES.includes(pathname)) return true;
  for (const prefix of MEDIA_PATH_PREFIXES) {
    if (pathname.startsWith(`${prefix}/`)) return true;
  }
  return false;
}

function extractStreamToken(pathname: string, searchParams: URLSearchParams): string {
  const q = searchParams.get("token") ?? "";
  if (q) return q;
  for (const prefix of MEDIA_PATH_PREFIXES) {
    if (!pathname.startsWith(`${prefix}/`)) continue;
    const rest = pathname.slice(prefix.length + 1);
    if (rest && !rest.includes("/")) {
      try {
        return decodeURIComponent(rest);
      } catch {
        return rest;
      }
    }
  }
  return "";
}

app.get(MEDIA_PATH_PREFIXES, (_req, res) => {
  if (!speechToSpeechEnabled() && !webRealtimeEnabled()) {
    res.status(501).json({
      error: "speech-to-speech pipeline not enabled",
      hint: "Set JOSHU_VOICE_MODE=realtime_s2s, OPENAI_API_KEY, HERMES_API_KEY",
    });
    return;
  }
  res.json({ ok: true, upgrade: "websocket", web: webRealtimeEnabled() });
});

const server = createServer(app);
const wss = new WebSocketServer({
  noServer: true,
  // Joshu proxies browser WS (8788→8792); permessage-deflate breaks frames (RSV1 / 1002).
  perMessageDeflate: false,
});

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "", "http://127.0.0.1");
  if (!isMediaStreamPath(url.pathname)) {
    console.warn(`[voice-realtime] ws rejected path=${url.pathname}`);
    socket.destroy();
    return;
  }

  if (!speechToSpeechEnabled() && !webRealtimeEnabled()) {
    console.warn("[voice-realtime] ws rejected (speech-to-speech not enabled)");
    socket.destroy();
    return;
  }

  const token = extractStreamToken(url.pathname, url.searchParams);
  if (!MEDIA_STREAM_SECRET || !safeEqualToken(token, MEDIA_STREAM_SECRET)) {
    console.warn(
      `[voice-realtime] ws rejected bad token path=${url.pathname} tokenLen=${token.length}`,
    );
    socket.destroy();
    return;
  }

  console.info(`[voice-realtime] ws upgrade ok path=${url.pathname}`);
  delete req.headers["sec-websocket-extensions"];

  wss.handleUpgrade(req, socket, head, (ws) => {
    let twilioSession: TwilioRealtimeSession | null = null;
    let browserSession: BrowserRealtimeSession | null = null;
    let transport: "unknown" | "twilio" | "browser" = "unknown";

    ws.on("message", (data: RawData) => {
      try {
        const raw = typeof data === "string" ? data : data.toString("utf8");
        const msg = JSON.parse(raw) as Record<string, unknown>;
        const ev = msg.event;

        if (transport === "unknown") {
          if (ev === "browser_start") {
            if (!webRealtimeEnabled()) {
              ws.send(JSON.stringify({ event: "error", message: "web realtime voice disabled" }));
              ws.close();
              return;
            }
            transport = "browser";
            browserSession = new BrowserRealtimeSession(ws);
            const voiceSessionId =
              typeof msg.sessionId === "string" && msg.sessionId.trim()
                ? msg.sessionId.trim()
                : `web:${Date.now()}`;
            const chatSessionId =
              typeof msg.chatSessionId === "string" && msg.chatSessionId.trim()
                ? msg.chatSessionId.trim()
                : voiceSessionId;
            browserSession.handleStart(voiceSessionId, chatSessionId, {
              appId: typeof msg.appId === "string" ? msg.appId : undefined,
              voiceCommands: Array.isArray(msg.voiceCommands)
                ? (msg.voiceCommands as AppVoiceCommand[])
                : undefined,
              threadId:
                typeof msg.threadId === "string" && msg.threadId.trim()
                  ? msg.threadId.trim()
                  : chatSessionId,
              guiSnapshot:
                msg.guiSnapshot && typeof msg.guiSnapshot === "object" && !Array.isArray(msg.guiSnapshot)
                  ? (msg.guiSnapshot as Record<string, unknown>)
                  : undefined,
            });
            return;
          }
          if (ev === "connected" || ev === "start") {
            if (!speechToSpeechEnabled()) {
              ws.send(JSON.stringify({ event: "error", message: "pstn voice disabled" }));
              ws.close();
              return;
            }
            transport = "twilio";
          }
        }

        if (transport === "browser" && browserSession) {
          if (ev === "register_surface") {
            const appId = typeof msg.appId === "string" ? msg.appId : "";
            const voiceCommands = Array.isArray(msg.voiceCommands)
              ? (msg.voiceCommands as AppVoiceCommand[])
              : [];
            const threadId = typeof msg.threadId === "string" ? msg.threadId : undefined;
            const guiSnapshot =
              msg.guiSnapshot && typeof msg.guiSnapshot === "object" && !Array.isArray(msg.guiSnapshot)
                ? (msg.guiSnapshot as Record<string, unknown>)
                : undefined;
            if (appId) browserSession.handleRegisterSurface(appId, voiceCommands, { threadId, guiSnapshot });
            return;
          }
          if (ev === "browser_audio") {
            const payload = msg.payload;
            if (typeof payload === "string") browserSession.handleInboundPcm24kPayload(payload);
            return;
          }
          if (ev === "browser_interrupt") {
            browserSession.handleInterrupt();
            return;
          }
          if (ev === "browser_stop") {
            browserSession.close();
            ws.close();
          }
          return;
        }

        if (transport === "twilio") {
          if (ev === "connected") {
            console.info("[voice-realtime] twilio ws connected (awaiting start event)");
            return;
          }

          if (ev === "start") {
            // Defense in depth: Joshu Express also refuses to register PSTN routes without
            // TWILIO_THINK_PASSWORD — reject here so a leaked media-stream URL cannot open an ungated call.
            if (!TWILIO_THINK_PASSWORD) {
              console.warn(
                "[voice-realtime] rejecting Twilio media stream (TWILIO_THINK_PASSWORD unset)",
              );
              ws.close(1008, "think password required");
              return;
            }
            const start = msg.start as Record<string, unknown> | undefined;
            const streamSid = String(start?.streamSid ?? msg.streamSid ?? "");
            const callSid = String(start?.callSid ?? "");
            const custom = start?.customParameters as Record<string, unknown> | undefined;
            const caller =
              typeof custom?.caller === "string" && custom.caller.trim()
                ? custom.caller.trim()
                : undefined;
            const ownerCaller =
              typeof custom?.ownerCaller === "string" && custom.ownerCaller.trim()
                ? custom.ownerCaller.trim()
                : undefined;
            twilioSession = new TwilioRealtimeSession(ws);
            twilioSession.handleStart(callSid, streamSid, { caller, ownerCaller });
            return;
          }

          if (ev === "stop") {
            twilioSession?.close();
            ws.close();
            return;
          }

          if (ev === "media" && twilioSession) {
            const media = msg.media as Record<string, unknown> | undefined;
            if (media?.track === "outbound") return;
            const payload = media?.payload;
            const tsRaw = media?.timestamp;
            const timestampMs =
              typeof tsRaw === "string"
                ? parseInt(tsRaw, 10)
                : typeof tsRaw === "number"
                  ? tsRaw
                  : undefined;
            if (typeof payload === "string") {
              twilioSession.handleInboundMulawPayload(payload, timestampMs);
            }
            return;
          }

          if (ev === "mark" && twilioSession) {
            twilioSession.handleMark();
          }
        }
      } catch (e) {
        console.warn("[voice-realtime] ws message error:", e);
      }
    });

    ws.on("close", (code, reason) => {
      console.info(
        `[voice-realtime] ws close code=${code} reason=${reason.toString() || "(none)"}`,
      );
      twilioSession?.close();
      browserSession?.close();
    });
  });
});

server.listen(PORT, HOST, () => {
  const s2s = speechToSpeechEnabled();
  const web = webRealtimeEnabled();
  console.info("");
  console.info("[voice-realtime] ── speech-to-speech ready ──");
  console.info(`[voice-realtime]   listen   http://${HOST}:${PORT}`);
  console.info(`[voice-realtime]   provider ${VOICE_S2S_PROVIDER}  pstn=${s2s}  web=${web}`);
  console.info(
    `[voice-realtime]   model    ${VOICE_S2S_PROVIDER === "gemini_live" ? GEMINI_LIVE_MODEL : OPENAI_REALTIME_MODEL}`,
  );
  console.info(`[voice-realtime]   hermes   ${HERMES_API_BASE_URL}/v1/chat/completions`);
  console.info(`[voice-realtime]   secret   ${MEDIA_STREAM_SECRET ? `set (${MEDIA_STREAM_SECRET.length} chars)` : "MISSING"}`);
  if (web) {
    console.info("[voice-realtime]   browser  WSS /voice-rt/media?token=… (browser_start + PCM24k)");
  }
  if (s2s) {
    console.info("[voice-realtime]   pstn     WSS /voice-rt/media/<secret> (Twilio Media Streams)");
  }
  console.info("");
  if (!s2s && !web) {
    for (const r of speechToSpeechDisableReasons()) {
      console.info(`[voice-realtime]   → ${r}`);
    }
    for (const r of webVoiceDisableReasons()) {
      console.info(`[voice-realtime]   → web: ${r}`);
    }
  }
});
