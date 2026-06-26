#!/usr/bin/env node
/**
 * Preflight for local Twilio + Hermes phone voice (legacy path).
 * Usage: PHONE_VOICE_PUBLIC_HOST=https://your-tunnel.ngrok.app npm run phone-voice:check
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
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

const env = { ...loadDotEnv(path.join(root, ".env")), ...process.env };
const basePath = env.PUBLIC_BASE_PATH || "/joshu";
const webhook = (env.TWILIO_VOICE_WEBHOOK_URL || "").trim();

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

const webhookOrigin = originOf(webhook);
const publicHost = (env.PHONE_VOICE_PUBLIC_HOST || webhookOrigin || "").replace(/\/+$/, "");
const issues = [];
const ok = [];

function check(name, pass, detail) {
  if (pass) ok.push(`✓ ${name}${detail ? `: ${detail}` : ""}`);
  else issues.push(`✗ ${name}${detail ? `: ${detail}` : ""}`);
}

check("ffmpeg", spawnSync("ffmpeg", ["-version"], { encoding: "utf8" }).status === 0);
check("TWILIO_AUTH_TOKEN", Boolean(env.TWILIO_AUTH_TOKEN));
const streamSecret = (env.TWILIO_MEDIA_STREAM_SECRET || "").trim();
check("TWILIO_MEDIA_STREAM_SECRET", Boolean(streamSecret));
if (streamSecret && /[+/=]/.test(streamSecret)) {
  issues.push("✗ TWILIO_MEDIA_STREAM_SECRET: use hex (openssl rand -hex 32), not base64 (+/= break URLs)");
} else if (streamSecret && streamSecret.length < 32) {
  issues.push("✗ TWILIO_MEDIA_STREAM_SECRET: too short — use openssl rand -hex 32");
}
check("TWILIO_VOICE_WEBHOOK_URL", Boolean(webhook));
if (webhook && publicHost) {
  const publicOrigin = originOf(publicHost.startsWith("http") ? publicHost : `https://${publicHost}`);
  check(
    "webhook origin matches PHONE_VOICE_PUBLIC_HOST",
    Boolean(webhookOrigin && publicOrigin && webhookOrigin === publicOrigin),
    webhookOrigin ? `${webhookOrigin} vs ${publicOrigin || publicHost}` : webhook,
  );
}
check("HERMES_BIN", Boolean(env.HERMES_BIN), env.HERMES_BIN || "unset");

const hermesHome = env.HERMES_HOME || path.join(homedir(), ".hermes");
check("HERMES_HOME exists", existsSync(hermesHome), hermesHome);

if (publicHost) {
  const healthUrl = `${publicHost}${basePath === "/" ? "" : basePath}/api/twilio/health`;
  try {
    const res = await fetch(healthUrl, {
      signal: AbortSignal.timeout(15_000),
      headers: { "ngrok-skip-browser-warning": "true" },
    });
    const body = await res.json().catch(() => ({}));
    check(
      "twilio health HTTP",
      res.ok,
      res.ok
        ? String(res.status)
        : `${res.status} — use "ngrok http 8788" (not 8787); ArozOS does not proxy /joshu/api/*`,
    );
    check("hermesReady", body.hermesReady === true);
  } catch (e) {
    check("twilio health reachable", false, e instanceof Error ? e.message : String(e));
  }
} else {
  ok.push("ℹ Set PHONE_VOICE_PUBLIC_HOST to probe /api/twilio/health over your tunnel");
}

console.log("\nPhone voice local preflight\n");
for (const line of ok) console.log(line);
for (const line of issues) console.log(line);
console.log("");
process.exit(issues.length > 0 ? 1 : 0);
