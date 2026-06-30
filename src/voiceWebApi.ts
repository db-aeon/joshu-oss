/**
 * Joshu HTTP helpers for browser voice (speech-to-speech via voice-realtime).
 */

import type { Request, Response, Router } from "express";
import { provisionEnvTrim } from "./provisionInstanceEnv.js";
import { resolveBoxSecret } from "./boxSecrets/resolve.js";

function envTrim(name: string, fallback = ""): string {
  return process.env[name]?.trim() ?? fallback;
}

function voiceS2sProvider(): "openai" | "gemini_live" {
  const fromFile = provisionEnvTrim("JOSHU_VOICE_PROVIDER");
  const raw = fromFile || envTrim("JOSHU_VOICE_PROVIDER", "openai");
  return raw === "gemini_live" ? "gemini_live" : "openai";
}

function resolveGeminiKey(): string {
  return (
    resolveBoxSecret("GEMINI_API_KEY") ||
    envTrim("GEMINI_API_KEY") ||
    envTrim("GOOGLE_API_KEY") ||
    envTrim("GOOGLE_GENAI_API_KEY")
  );
}

function resolveVoiceApiKey(): boolean {
  return voiceS2sProvider() === "gemini_live" ? Boolean(resolveGeminiKey()) : Boolean(resolveOpenAiKey());
}

function voiceStackLabel(): string {
  return voiceS2sProvider() === "gemini_live" ? "gemini_live" : "openai_realtime";
}

function missingVoiceKeyReason(): string {
  if (voiceS2sProvider() === "gemini_live") {
    return "missing GEMINI_API_KEY, HERMES_API_KEY, or voice token";
  }
  return "missing OPENAI_API_KEY, HERMES_API_KEY, or voice token";
}

function resolveVoiceToken(): string {
  return (
    envTrim("TWILIO_MEDIA_STREAM_SECRET") ||
    envTrim("JOSHU_WEB_VOICE_TOKEN") ||
    envTrim("HERMES_API_KEY") ||
    envTrim("API_SERVER_KEY")
  );
}

function resolveOpenAiKey(): string {
  return (
    envTrim("OPENAI_API_KEY") ||
    envTrim("VOICE_TOOLS_OPENAI_KEY") ||
    envTrim("HINDSIGHT_API_LLM_API_KEY")
  );
}

function webVoiceEnabledFlag(): boolean {
  const fromFile = provisionEnvTrim("JOSHU_WEB_VOICE_ENABLED");
  const raw = fromFile || envTrim("JOSHU_WEB_VOICE_ENABLED", "true");
  return raw.toLowerCase() !== "false";
}

function webVoiceConfigured(): boolean {
  if (!webVoiceEnabledFlag()) return false;
  const hermesKey = envTrim("HERMES_API_KEY") || envTrim("API_SERVER_KEY");
  return Boolean(resolveVoiceToken() && hermesKey && resolveVoiceApiKey());
}

function voiceRealtimeBase(): string {
  return envTrim("VOICE_REALTIME_URL", "http://127.0.0.1:8792").replace(/\/+$/, "");
}

function requestOrigin(req: Request): string {
  const proto =
    (typeof req.headers["x-forwarded-proto"] === "string"
      ? req.headers["x-forwarded-proto"].split(",")[0]?.trim()
      : undefined) || req.protocol;
  const host = voiceWsHost(req);
  return `${proto}://${host}`;
}

function voiceWsHost(req: Request): string {
  const explicit = envTrim("JOSHU_VOICE_WSS_HOST");
  if (explicit) return explicit.replace(/^wss?:\/\//, "").replace(/\/+$/, "");

  const host = req.get("host") || "127.0.0.1";
  const arozPort = envTrim("PUBLIC_AROZ_PORT", "8787");
  const joshuPort = envTrim("PORT", "8788");
  if (host.endsWith(`:${arozPort}`)) {
    const hostname = host.slice(0, host.length - arozPort.length - 1) || "127.0.0.1";
    return `${hostname}:${joshuPort}`;
  }
  return host;
}

function voiceWssPath(): string {
  const explicit = envTrim("JOSHU_VOICE_WSS_PATH");
  if (explicit) {
    const p = explicit.startsWith("/") ? explicit : `/${explicit}`;
    return p.replace(/\/+$/, "") || "/voice-rt/media";
  }
  return "/voice-rt/media";
}

function isLoopbackHost(host: string): boolean {
  const hostname = host.split(":")[0]?.trim().toLowerCase() || "";
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}

/** Local dev: connect browser WS straight to voice-realtime — Joshu proxy breaks permessage-deflate. */
function localDirectVoiceWsOrigin(req: Request): string | null {
  const mode = envTrim("JOSHU_VOICE_WSS_DIRECT", "auto").toLowerCase();
  if (mode === "false" || mode === "0") return null;
  // VPS also runs voice-realtime on 127.0.0.1:8792 — only bypass Joshu when the browser is local too.
  if (mode !== "true" && !isLoopbackHost(req.get("host") || "")) return null;
  const rt = voiceRealtimeBase();
  try {
    const u = new URL(rt);
    if (!isLoopbackHost(u.hostname)) return null;
    const port = u.port || (u.protocol === "https:" ? "443" : "80");
    const wsProto = u.protocol === "https:" ? "wss:" : "ws:";
    return `${wsProto}//${u.hostname}:${port}`;
  } catch {
    return null;
  }
}

function buildVoiceWsUrl(req: Request, token: string): string {
  const enc = encodeURIComponent(token);
  const direct = localDirectVoiceWsOrigin(req);
  if (direct) {
    return `${direct}${voiceWssPath()}?token=${enc}`;
  }
  const origin = requestOrigin(req);
  const wsOrigin = origin.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
  return `${wsOrigin}${voiceWssPath()}?token=${enc}`;
}

export async function probeWebVoice(): Promise<{ ok: boolean; web?: boolean }> {
  if (!webVoiceConfigured()) return { ok: false };

  try {
    const res = await fetch(`${voiceRealtimeBase()}/health`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return { ok: false };
    const json = (await res.json()) as { web?: boolean; speechToSpeech?: boolean };
    return { ok: Boolean(json.web ?? json.speechToSpeech), web: json.web !== false };
  } catch {
    return { ok: false };
  }
}

export function registerVoiceWebRoutes(router: Router): void {
  router.get("/api/voice/status", async (_req: Request, res: Response) => {
    const configured = webVoiceConfigured();
    const probe = configured ? await probeWebVoice() : { ok: false, web: false };
    const available = configured && probe.ok && probe.web !== false;
    const voiceMode = envTrim("JOSHU_VOICE_MODE", "realtime_s2s");

    res.json({
      available,
      configured,
      stack: voiceStackLabel(),
      provider: voiceS2sProvider(),
      reason: !configured
        ? missingVoiceKeyReason()
        : !probe.ok
          ? "voice-realtime not running — npm run voice-realtime:dev (or restart dev:arozos)"
          : undefined,
      voiceMode,
      service: "voice-realtime",
    });
  });

  router.get("/api/voice/session", async (req: Request, res: Response) => {
    const configured = webVoiceConfigured();
    if (!configured) {
      res.status(503).json({ available: false, reason: "web voice not configured" });
      return;
    }

    const probe = await probeWebVoice();
    if (!probe.ok || probe.web === false) {
      res.status(503).json({
        available: false,
        reason: "voice-realtime unavailable — run npm run voice-realtime:dev",
      });
      return;
    }

    const token = resolveVoiceToken();
    const chatSessionId =
      typeof req.query.chatSessionId === "string" && req.query.chatSessionId.trim()
        ? req.query.chatSessionId.trim()
        : undefined;

    res.json({
      available: true,
      wsUrl: buildVoiceWsUrl(req, token),
      chatSessionId,
      transport: "websocket-pcm24k",
      stack: voiceStackLabel(),
      provider: voiceS2sProvider(),
    });
  });
}
