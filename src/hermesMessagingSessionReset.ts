/**
 * Joshu product default: Slack + Telegram idle-reset after 30 minutes.
 * jChat (api_server) stays on Hermes global `session_reset.mode: none`.
 *
 * Owner SMS also uses the `api_server` pipe (same toolsets as jChat), so it cannot
 * share Hermes `reset_by_platform` without resetting jChat. SMS idle is enforced
 * in `twilioSmsSession.ts` by rotating `sms:<e164>:<epoch>` after the same idle
 * window (`JOSHU_HERMES_MESSAGING_IDLE_MINUTES`).
 *
 * Hermes `config.yaml` `session_reset` maps only to the *default* policy.
 * Per-platform overrides are `reset_by_platform` on GatewayConfig, loaded from
 * `~/.hermes/gateway.json` (and ignored in yaml unless a future Hermes maps it).
 * Joshu writes both so the live gateway honors Slack/Telegram idle without
 * resetting jChat.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";

export type ConfigRecord = Record<string, unknown>;

export const JOSHU_MESSAGING_RESET_PLATFORMS = ["slack", "telegram"] as const;
export const DEFAULT_JOSHU_MESSAGING_IDLE_MINUTES = 30;

function asRecord(value: unknown): ConfigRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as ConfigRecord) : {};
}

/** `null` = disable messaging idle reset (keep continuous Slack/Telegram). */
export function resolveJoshuMessagingIdleMinutes(
  env: NodeJS.ProcessEnv = process.env,
): number | null {
  const raw = env.JOSHU_HERMES_MESSAGING_IDLE_MINUTES?.trim();
  if (raw === "0" || /^none$/i.test(raw ?? "") || /^off$/i.test(raw ?? "")) return null;
  if (!raw) return DEFAULT_JOSHU_MESSAGING_IDLE_MINUTES;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_JOSHU_MESSAGING_IDLE_MINUTES;
  return Math.floor(n);
}

export function joshuMessagingResetPolicy(idleMinutes: number | null): ConfigRecord {
  if (idleMinutes == null) {
    return { mode: "none", notify: true };
  }
  return {
    mode: "idle",
    idle_minutes: idleMinutes,
    notify: true,
  };
}

function policiesEqual(a: ConfigRecord, b: ConfigRecord): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Pin global none + Slack/Telegram overrides on the managed Hermes config slice. */
export function syncJoshuMessagingSessionReset(
  config: ConfigRecord,
  idleMinutes: number | null = resolveJoshuMessagingIdleMinutes(),
): boolean {
  let changed = false;
  const sessionReset = asRecord(config.session_reset);
  if (sessionReset.mode !== "none") {
    sessionReset.mode = "none";
    changed = true;
  }
  config.session_reset = sessionReset;

  const byPlatform = asRecord(config.reset_by_platform);
  const desired = joshuMessagingResetPolicy(idleMinutes);
  for (const platform of JOSHU_MESSAGING_RESET_PLATFORMS) {
    const existing = asRecord(byPlatform[platform]);
    if (!policiesEqual(existing, desired)) {
      byPlatform[platform] = { ...desired };
      changed = true;
    }
  }
  config.reset_by_platform = byPlatform;
  return changed;
}

async function atomicWriteText(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${randomBytes(8).toString("hex")}.tmp`;
  await writeFile(tmpPath, content, "utf8");
  await rename(tmpPath, filePath);
}

/**
 * Merge Slack/Telegram reset into legacy gateway.json so current Hermes loads it.
 * Returns true when the file was written.
 */
export async function mergeHermesGatewayJsonMessagingReset(
  hermesHome: string,
  idleMinutes: number | null = resolveJoshuMessagingIdleMinutes(),
): Promise<boolean> {
  const jsonPath = path.join(hermesHome, "gateway.json");
  let existing: ConfigRecord = {};
  try {
    existing = asRecord(JSON.parse(await readFile(jsonPath, "utf8")));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(
        `[hermes-api] gateway.json unreadable; Slack/Telegram idle reset may not apply: ${(err as Error).message}`,
      );
      return false;
    }
  }

  const byPlatform = asRecord(existing.reset_by_platform);
  const desired = joshuMessagingResetPolicy(idleMinutes);
  let changed = false;
  for (const platform of JOSHU_MESSAGING_RESET_PLATFORMS) {
    const existingPolicy = asRecord(byPlatform[platform]);
    if (!policiesEqual(existingPolicy, desired)) {
      byPlatform[platform] = { ...desired };
      changed = true;
    }
  }
  if (!changed) return false;

  existing.reset_by_platform = byPlatform;
  await atomicWriteText(jsonPath, `${JSON.stringify(existing, null, 2)}\n`);
  return true;
}
