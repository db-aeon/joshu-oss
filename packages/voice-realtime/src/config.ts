import { buildVoiceSystemPrompt, resolveJoshuIdentity } from "./joshuIdentity.js";

export function envTrim(name: string, fallback = ""): string {
  return process.env[name]?.trim() ?? fallback;
}

const resolvedIdentity = resolveJoshuIdentity();

export const PORT = Number(envTrim("VOICE_REALTIME_PORT", "8792"));
export const HOST = envTrim("VOICE_REALTIME_HOST", "127.0.0.1");
export const MODE = envTrim("JOSHU_VOICE_MODE", "realtime_s2s");

/** `openai` (default) or `gemini_live` for browser + PSTN S2S upstream. */
export type VoiceS2sProvider = "openai" | "gemini_live";

export function parseVoiceS2sProvider(raw: string): VoiceS2sProvider {
  return raw === "gemini_live" ? "gemini_live" : "openai";
}

export const VOICE_S2S_PROVIDER = parseVoiceS2sProvider(envTrim("JOSHU_VOICE_PROVIDER", "openai"));

export const OPENAI_API_KEY =
  envTrim("OPENAI_API_KEY") ||
  envTrim("VOICE_TOOLS_OPENAI_KEY") ||
  envTrim("HINDSIGHT_API_LLM_API_KEY");
export const OPENAI_REALTIME_MODEL = envTrim("OPENAI_REALTIME_MODEL", "gpt-realtime-2");
export const OPENAI_REALTIME_VOICE =
  resolvedIdentity.voiceId || envTrim("OPENAI_REALTIME_VOICE", "alloy");

export const GEMINI_API_KEY =
  envTrim("GEMINI_API_KEY") ||
  envTrim("GOOGLE_API_KEY") ||
  envTrim("GOOGLE_GENAI_API_KEY");
export const GEMINI_LIVE_MODEL = envTrim("GEMINI_LIVE_MODEL", "gemini-3.1-flash-live-preview");
export const GEMINI_LIVE_VOICE =
  resolvedIdentity.voiceId || envTrim("GEMINI_LIVE_VOICE", "Kore");

/** gpt-realtime-2 internal reasoning; OpenAI recommends `low` for production voice agents. */
export const OPENAI_REALTIME_REASONING_EFFORT = envTrim(
  "OPENAI_REALTIME_REASONING_EFFORT",
  "low",
);

/** PSTN turn detection: semantic_vad (default) or server_vad — see OpenAI Realtime VAD guide. */
export type PhoneVadMode = "semantic_vad" | "server_vad";
export type PhoneVadEagerness = "low" | "medium" | "high" | "auto";

function parsePhoneVadMode(raw: string): PhoneVadMode {
  return raw === "server_vad" ? "server_vad" : "semantic_vad";
}

function parsePhoneVadEagerness(raw: string): PhoneVadEagerness {
  if (raw === "medium" || raw === "high" || raw === "auto") return raw;
  return "low";
}

/** Default server_vad — predictable ~500ms silence; semantic_vad is opt-in (see eagerness). */
export const PHONE_VAD_MODE = parsePhoneVadMode(envTrim("VOICE_PHONE_VAD_MODE", "server_vad"));
/** semantic_vad only: `low` waits longer before end-of-turn; use `high` when optimizing latency. */
export const PHONE_VAD_EAGERNESS = parsePhoneVadEagerness(
  envTrim("VOICE_PHONE_VAD_EAGERNESS", "high"),
);
/** server_vad only: OpenAI default is 500ms; raise on noisy PSTN lines. */
export const PHONE_VAD_SILENCE_MS = Number(envTrim("VOICE_PHONE_VAD_SILENCE_MS", "500"));
export const PHONE_VAD_THRESHOLD = Number(envTrim("VOICE_PHONE_VAD_THRESHOLD", "0.62"));

export const JOSHU_IDENTITY = resolvedIdentity;

export const HERMES_API_BASE_URL = envTrim("HERMES_API_BASE_URL", "http://127.0.0.1:8642");
export const HERMES_API_KEY = envTrim("HERMES_API_KEY") || envTrim("API_SERVER_KEY");
/** Match JOSHU_OPENROUTER_DEFAULT_MODEL in src/joshuOpenRouterDefaults.ts */
export const HERMES_MODEL = envTrim("JOSHU_HERMES_MODEL", "deepseek/deepseek-v4-flash");

export const MEDIA_STREAM_SECRET =
  envTrim("TWILIO_MEDIA_STREAM_SECRET") ||
  envTrim("JOSHU_WEB_VOICE_TOKEN") ||
  envTrim("HERMES_API_KEY") ||
  envTrim("API_SERVER_KEY");

export const WEB_VOICE_ENABLED =
  envTrim("JOSHU_WEB_VOICE_ENABLED", "true").toLowerCase() !== "false";

export const WEB_SYSTEM_PROMPT = envTrim(
  "JOSHU_WEB_VOICE_SYSTEM_PROMPT",
  buildVoiceSystemPrompt(resolvedIdentity, "web"),
);

export function geminiLiveConfigured(): boolean {
  return Boolean(GEMINI_API_KEY);
}

export function voiceS2sApiConfigured(): boolean {
  return VOICE_S2S_PROVIDER === "gemini_live" ? geminiLiveConfigured() : Boolean(OPENAI_API_KEY);
}

export function webVoiceConfigured(): boolean {
  if (!WEB_VOICE_ENABLED) return false;
  return Boolean(voiceS2sApiConfigured()) && Boolean(HERMES_API_KEY) && Boolean(MEDIA_STREAM_SECRET);
}

export function webRealtimeEnabled(): boolean {
  return MODE === "realtime_s2s" && webVoiceConfigured();
}

/** Speech-to-speech enabled for phone and browser (OpenAI or Gemini Live). */
export function voiceEnabled(): boolean {
  if (MODE !== "realtime_s2s" || !HERMES_API_KEY) return false;
  return voiceS2sApiConfigured();
}

/** @deprecated Use voiceEnabled() */
export function speechToSpeechEnabled(): boolean {
  return voiceEnabled();
}

/** Delay after the initial "checking" ack finishes before first progress line (default 10s). */
export const HERMES_PROGRESS_FIRST_DELAY_MS = Number(
  envTrim("VOICE_HERMES_PROGRESS_FIRST_DELAY_MS", "10000"),
);
/** Gap between progress lines — measured from end of previous phrase (default 10s). */
export const HERMES_PROGRESS_INTERVAL_MS = Number(
  envTrim("VOICE_HERMES_PROGRESS_INTERVAL_MS", "10000"),
);
/** Extra buffer after response.done so Twilio can finish playing audio (default 2s). */
export const HERMES_PROGRESS_POST_SPEECH_MS = Number(
  envTrim("VOICE_HERMES_PROGRESS_POST_SPEECH_MS", "2000"),
);
/** Max progress ticks before a long-wait message (default 12). */
export const HERMES_PROGRESS_MAX_TICKS = Number(envTrim("VOICE_HERMES_PROGRESS_MAX_TICKS", "12"));

export const PHONE_SYSTEM_PROMPT = envTrim(
  "TWILIO_PHONE_SYSTEM_PROMPT",
  buildVoiceSystemPrompt(resolvedIdentity, "phone"),
);

/** Optional spoken passphrase required before phone calls may use think/Hermes. */
export const TWILIO_THINK_PASSWORD = envTrim("TWILIO_THINK_PASSWORD").replace(/^["']|["']$/g, "");

/** PSTN: spoken time warning (default 60s). */
export const TWILIO_PHONE_SESSION_WARN_MS = Number(
  envTrim("TWILIO_PHONE_SESSION_WARN_MS", envTrim("TWILIO_PHONE_SESSION_MAX_MS", "60000")),
);
/** PSTN: goodbye + hang up (default 90s). */
export const TWILIO_PHONE_SESSION_HANGUP_MS = Number(envTrim("TWILIO_PHONE_SESSION_HANGUP_MS", "90000"));

/** Human-readable reasons when speech-to-speech is off (startup logs). */
export function speechToSpeechDisableReasons(): string[] {
  const reasons: string[] = [];
  if (MODE !== "realtime_s2s") {
    reasons.push(`JOSHU_VOICE_MODE=${MODE || "(unset)"} (need realtime_s2s)`);
  }
  if (VOICE_S2S_PROVIDER === "gemini_live") {
    if (!geminiLiveConfigured()) {
      reasons.push("GEMINI_API_KEY missing (JOSHU_VOICE_PROVIDER=gemini_live)");
    }
  } else if (!OPENAI_API_KEY) {
    reasons.push("OPENAI_API_KEY missing (or VOICE_TOOLS_OPENAI_KEY in ~/.hermes/.env)");
  }
  if (!HERMES_API_KEY) reasons.push("HERMES_API_KEY missing");
  return reasons;
}

export function webVoiceDisableReasons(): string[] {
  const reasons: string[] = [];
  if (!WEB_VOICE_ENABLED) reasons.push("JOSHU_WEB_VOICE_ENABLED=false");
  if (!voiceS2sApiConfigured()) {
    if (VOICE_S2S_PROVIDER === "gemini_live") {
      reasons.push("GEMINI_API_KEY missing");
    } else {
      reasons.push("OPENAI_API_KEY missing");
    }
  }
  if (!HERMES_API_KEY) reasons.push("HERMES_API_KEY missing");
  if (!MEDIA_STREAM_SECRET) reasons.push("voice WSS token missing");
  return reasons;
}
