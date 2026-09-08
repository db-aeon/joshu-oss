/**
 * Owner SMS Hermes sessions — idle-rotate so texts do not accumulate forever.
 *
 * SMS rides the Hermes `api_server` pipe (same tool surface as jChat). That platform
 * stays on `session_reset.mode: none` so jChat remains continuous. Slack/Telegram
 * get Hermes `reset_by_platform` idle; SMS gets the same idle window by minting a
 * fresh `sms:<e164>:<epoch>` session key after inactivity.
 */

import fs from "node:fs";
import path from "node:path";

import { resolveJoshuMessagingIdleMinutes } from "./hermesMessagingSessionReset.js";
import { normalizePhone } from "./twilioSmsSend.js";

type SmsSessionEntry = {
  sessionKey: string;
  lastActiveAt: string;
};

type SmsSessionState = {
  sessions: Record<string, SmsSessionEntry>;
};

function smsSessionStatePath(projectRoot: string): string {
  return path.join(projectRoot, ".joshu", "sms", "sessions.json");
}

function readState(projectRoot: string): SmsSessionState {
  const filePath = smsSessionStatePath(projectRoot);
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as SmsSessionState;
    if (!parsed || typeof parsed !== "object" || !parsed.sessions || typeof parsed.sessions !== "object") {
      return { sessions: {} };
    }
    return { sessions: parsed.sessions };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[twilio-sms] could not read session state: ${(err as Error).message}`);
    }
    return { sessions: {} };
  }
}

function writeState(projectRoot: string, state: SmsSessionState): void {
  const filePath = smsSessionStatePath(projectRoot);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

function mintSessionKey(phone: string, nowMs: number): string {
  return `sms:${phone}:${nowMs}`;
}

/**
 * Resolve Hermes session id for an owner SMS turn.
 * Rotates after `JOSHU_HERMES_MESSAGING_IDLE_MINUTES` (default 30) of inactivity.
 * When idle reset is disabled (`0` / `none`), keeps a sticky `sms:<e164>` key.
 */
export function resolveOwnerSmsSessionKey(
  fromPhone: string,
  projectRoot = process.cwd(),
  opts?: { nowMs?: number; idleMinutes?: number | null },
): string {
  const phone = normalizePhone(fromPhone);
  if (!phone) return `sms:unknown`;

  const idleMinutes =
    opts?.idleMinutes !== undefined ? opts.idleMinutes : resolveJoshuMessagingIdleMinutes();
  const nowMs = opts?.nowMs ?? Date.now();

  // Idle reset disabled — match historical sticky key (and jChat-like continuity).
  if (idleMinutes == null) {
    return `sms:${phone}`;
  }

  const state = readState(projectRoot);
  const existing = state.sessions[phone];
  const idleMs = idleMinutes * 60_000;
  const lastMs = existing?.lastActiveAt ? Date.parse(existing.lastActiveAt) : NaN;
  const stale =
    !existing?.sessionKey ||
    !Number.isFinite(lastMs) ||
    nowMs - lastMs >= idleMs;

  const sessionKey = stale ? mintSessionKey(phone, nowMs) : existing.sessionKey;
  state.sessions[phone] = {
    sessionKey,
    lastActiveAt: new Date(nowMs).toISOString(),
  };
  writeState(projectRoot, state);
  return sessionKey;
}
