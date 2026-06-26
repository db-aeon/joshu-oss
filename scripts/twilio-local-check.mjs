#!/usr/bin/env node
/**
 * Preflight for local Twilio phone voice (OpenAI Realtime S2S).
 * Usage: npm run twilio-local:check
 * With tunnel: start ngrok first, or PHONE_VOICE_PUBLIC_HOST=https://….
 */

import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function loadDotEnv(filePath) {
  if (!existsSync(filePath)) return {};
  const out = {};
  for (const line of readFileSync(filePath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[t.slice(0, i).trim()] = v;
  }
  return out;
}

const env = {
  ...loadDotEnv(path.join(root, ".env")),
  ...loadDotEnv(path.join(root, ".env.twilio.local")),
  ...process.env,
};

const voiceMode = (env.JOSHU_VOICE_MODE || "realtime_s2s").trim();
const basePath = (env.PUBLIC_BASE_PATH || "/joshu").replace(/\/+$/, "") || "/joshu";
const proxyPort = env.TWILIO_LOCAL_PROXY_PORT || "8790";
/** Joshu Express — do not use PORT (often 8787 = ArozOS in .env). */
const joshuPort = env.JOSHU_PORT || "8788";
const issues = [];
const ok = [];

function check(name, pass, detail) {
  if (pass) ok.push(`✓ ${name}${detail ? `: ${detail}` : ""}`);
  else issues.push(`✗ ${name}${detail ? `: ${detail}` : ""}`);
}

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(12_000),
    headers: { "ngrok-skip-browser-warning": "true", ...opts.headers },
    ...opts,
  });
  const body = await res.json().catch(() => ({}));
  return { res, body };
}

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

const webhook = (env.TWILIO_VOICE_WEBHOOK_URL || "").trim();
const wssUrl = (env.TWILIO_MEDIA_STREAM_WSS_URL || "").trim();
const webhookOrigin = originOf(webhook);
const wssOrigin = wssUrl ? originOf(wssUrl.replace(/^wss:/i, "https:")) : "";
const tunnelOrigin =
  (env.PHONE_VOICE_PUBLIC_HOST || "").trim() ||
  webhookOrigin ||
  "";

/** ngrok local addr e.g. "http://localhost:8788" from :4040 API */
async function ngrokLocalAddr() {
  try {
    const res = await fetch("http://127.0.0.1:4040/api/tunnels", {
      signal: AbortSignal.timeout(3000),
    });
    const data = await res.json();
    for (const t of data.tunnels || []) {
      const url = t.public_url || "";
      if (!url.startsWith("https://")) continue;
      const addr = t.config?.addr || "";
      if (addr) return { publicUrl: url, localAddr: addr };
    }
  } catch {
    /* ngrok not running */
  }
  return null;
}

check("ffmpeg (legacy path)", spawnSync("ffmpeg", ["-version"], { encoding: "utf8" }).status === 0);
check("TWILIO_AUTH_TOKEN", Boolean(env.TWILIO_AUTH_TOKEN));
const streamSecret = (env.TWILIO_MEDIA_STREAM_SECRET || "").trim();
check("TWILIO_MEDIA_STREAM_SECRET", Boolean(streamSecret));
if (streamSecret && /[+/=]/.test(streamSecret)) {
  issues.push("✗ TWILIO_MEDIA_STREAM_SECRET: use openssl rand -hex 32 (not base64)");
}

check("JOSHU_VOICE_MODE", ["legacy", "realtime", "realtime_s2s"].includes(voiceMode), voiceMode);

if (voiceMode === "realtime_s2s") {
  check("OPENAI_API_KEY", Boolean(env.OPENAI_API_KEY));
  check("HERMES_API_KEY", Boolean(env.HERMES_API_KEY || env.API_SERVER_KEY));
} else if (voiceMode === "realtime") {
  check("OPENAI_API_KEY (or Deepgram)", Boolean(env.OPENAI_API_KEY || env.DEEPGRAM_API_KEY));
}

check("HERMES_BIN", Boolean(env.HERMES_BIN), env.HERMES_BIN || "unset");

// Local Joshu
try {
  const { res, body } = await fetchJson(
    `http://127.0.0.1:${joshuPort}${basePath}/api/twilio/health`,
  );
  check("local twilio health", res.ok, String(res.status));
  check("local hermesReady", body.hermesReady === true);
} catch (e) {
  check(
    "local twilio health",
    false,
    `dev:arozos on 127.0.0.1:${joshuPort}? (PORT=8787 in .env is ArozOS — use JOSHU_PORT=8788) ${e.message}`,
  );
}

// Local voice-realtime
if (voiceMode === "realtime_s2s") {
  try {
    const { res, body } = await fetchJson("http://127.0.0.1:8792/health");
    check("local voice-realtime", res.ok && body.speechToSpeech === true);
  } catch (e) {
    check("local voice-realtime :8792", false, `npm run voice-realtime:dev — ${e.message}`);
  }
} else {
  issues.push(`✗ JOSHU_VOICE_MODE=${voiceMode} — only realtime_s2s is supported`);
}

// Local proxy
try {
  const { res } = await fetch(`http://127.0.0.1:${proxyPort}/joshu/api/twilio/health`, {
    signal: AbortSignal.timeout(5000),
  });
  check("local twilio proxy", res.ok, `:${proxyPort}`);
} catch {
  ok.push(`ℹ twilio proxy :${proxyPort} not running (npm run twilio-local:proxy)`);
}

// Tunnel
const ngrok = await ngrokLocalAddr();
if (ngrok?.publicUrl) {
  const ngrokOrigin = originOf(ngrok.publicUrl);
  if (webhookOrigin && ngrokOrigin && webhookOrigin !== ngrokOrigin) {
    issues.push(
      `✗ TWILIO_VOICE_WEBHOOK_URL host (${webhookOrigin}) ≠ ngrok (${ngrokOrigin}) — update Twilio console: npm run twilio-local:urls`,
    );
  }
  if (wssOrigin && ngrokOrigin && wssOrigin !== ngrokOrigin) {
    issues.push(
      `✗ TWILIO_MEDIA_STREAM_WSS_URL host (${wssOrigin}) ≠ ngrok (${ngrokOrigin}) — restart Joshu after npm run twilio-local:env`,
    );
  }
}
if (ngrok && tunnelOrigin && ngrok.publicUrl.replace(/\/$/, "") !== tunnelOrigin.replace(/\/$/, "")) {
  ok.push(`ℹ ngrok https URL differs from TWILIO_VOICE_WEBHOOK_URL — run: npm run twilio-local:urls`);
}
if (ngrok?.localAddr && !ngrok.localAddr.includes(`:${proxyPort}`)) {
  const addrPort = ngrok.localAddr.match(/:(\d+)$/)?.[1];
  const needsProxy = false;
  if (needsProxy && addrPort !== joshuPort) {
    issues.push(
      `✗ ngrok forwards to ${ngrok.localAddr} — for ${voiceMode} use: npm run twilio-local:proxy then ngrok http ${proxyPort}`,
    );
  } else if (voiceMode === "realtime_s2s" && addrPort === joshuPort) {
    ok.push(`ℹ ngrok → :${joshuPort} (Joshu proxies /voice-rt to :8792 — no :${proxyPort} proxy required)`);
  }
}

if (tunnelOrigin) {
  try {
    const { res, body } = await fetchJson(`${tunnelOrigin}${basePath}/api/twilio/health`);
    check("tunnel twilio health", res.ok, tunnelOrigin);
    check("tunnel hermesReady", body.hermesReady === true);
  } catch (e) {
    check("tunnel reachable", false, e.message);
  }

  if (voiceMode === "realtime_s2s") {
    try {
      const { res, body } = await fetchJson(`${tunnelOrigin}/voice-rt/health`);
      const pass = res.ok && body.speechToSpeech === true;
      check(
        "tunnel voice-realtime",
        pass,
        pass
          ? undefined
          : `${res.status} — ngrok http ${joshuPort} + voice-realtime:dev, or proxy :${proxyPort} + ngrok http ${proxyPort}`,
      );
    } catch (e) {
      check(
        "tunnel voice-realtime",
        false,
        `${e.message} — npm run voice-realtime:dev; ngrok http ${joshuPort} (Joshu proxies /voice-rt)`,
      );
    }
  }

  if (wssUrl && !wssUrl.includes(streamSecret) && streamSecret) {
    issues.push("✗ TWILIO_MEDIA_STREAM_WSS_URL does not contain TWILIO_MEDIA_STREAM_SECRET");
  }
  if (wssUrl.includes("?token=")) {
    ok.push("ℹ WSS uses ?token= — if ngrok drops query on WS, use path URL from: npm run twilio-local:urls");
  }
} else {
  ok.push("ℹ Start ngrok (npm run twilio-local:ngrok) then npm run twilio-local:urls");
}

console.log(`\nTwilio local preflight (mode=${voiceMode})\n`);
for (const line of ok) console.log(line);
for (const line of issues) console.log(line);
console.log("");
process.exit(issues.length > 0 ? 1 : 0);
