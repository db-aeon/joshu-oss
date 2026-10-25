/**
 * Align Hermes cron timezone with the box owner's IANA zone.
 * Hermes interprets cron hour/minute in config.yaml `timezone` (or HERMES_TIMEZONE).
 * Without this, VPS boxes (UTC) fire EA jobs at UTC wall clock instead of owner local time.
 *
 * Hermes resolves the timezone once per process (hermes_time.get_timezone caches it).
 * A running gateway keeps the old zone until it restarts, so a change also calls the
 * handler that server.ts registers: it realigns the stored cron next_run_at values and
 * restarts the gateway.
 */
import { homedir } from "node:os";
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { isValidIanaTimezone, normalizeIanaTimezone } from "./ianaTimezone.js";
import { readManagedHermesConfig, writeMergedHermesConfig } from "./hermesConfigSplit.js";
import { callCronBridge } from "./hermesCronBridge.js";

function getHermesHome(): string {
  return process.env.HERMES_HOME?.trim() || path.join(homedir(), ".hermes");
}

/** Shell-safe .env value (mirrors hermesApi.formatHermesDotenvValue). */
function formatDotenvValue(value: string): string {
  if (/^[A-Za-z0-9_./:@+-]+$/.test(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Keep HERMES_TIMEZONE in ~/.hermes/.env aligned (highest priority for Hermes cron). */
async function syncHermesTimezoneDotenv(timezone: string): Promise<boolean> {
  const envPath = path.join(getHermesHome(), ".env");
  const key = "HERMES_TIMEZONE";
  const next = `${key}=${formatDotenvValue(timezone)}`;
  let lines: string[] = [];
  try {
    lines = (await readFile(envPath, "utf8")).split("\n");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
  const idx = lines.findIndex((line) => line === next || line.startsWith(`${key}=`));
  if (idx >= 0) {
    if (lines[idx] === next) return false;
    lines[idx] = next;
  } else {
    lines.push(next);
  }
  const body = lines.join("\n").replace(/\n*$/, "\n");
  await writeFile(envPath, body, "utf8");
  return true;
}

/** Applies a changed owner timezone to the running Hermes gateway. */
export type OwnerTimezoneChangeHandler = (timezone: string) => Promise<void> | void;

let ownerTimezoneChangeHandler: OwnerTimezoneChangeHandler | null = null;

/** server.ts registers the handler; null removes it (tests). */
export function setOwnerTimezoneChangeHandler(handler: OwnerTimezoneChangeHandler | null): void {
  ownerTimezoneChangeHandler = handler;
}

/**
 * Recompute next_run_at of recurring cron jobs that Hermes stored in a different timezone.
 * Without this, a job stored at 09:00 UTC fires once more at the converted local time
 * (17:00 for UTC+8) after the gateway restarts, and only then moves to 09:00 local.
 */
export async function realignHermesCronToOwnerTimezone(): Promise<{ realigned: number }> {
  const result = await callCronBridge({ action: "realign_timezone" });
  if (!result.success) {
    throw new Error(typeof result.error === "string" ? result.error : "cron timezone realign failed");
  }
  const realigned = Array.isArray(result.realigned) ? result.realigned.length : 0;
  return { realigned };
}

export type SyncHermesOwnerTimezoneResult = {
  ok: boolean;
  changed: boolean;
  timezone?: string;
  error?: string;
};

/** The config is already on disk, so a handler failure only logs. */
async function applyOwnerTimezoneChange(timezone: string): Promise<void> {
  if (!ownerTimezoneChangeHandler) return;
  try {
    await ownerTimezoneChangeHandler(timezone);
  } catch (err) {
    console.warn(`[hermes-timezone] apply ${timezone} to Hermes gateway: ${(err as Error).message}`);
  }
}

/**
 * Write owner IANA timezone into managed Hermes config + .env.
 * Idempotent when already set to the same zone.
 * On a change, call the registered handler (gateway restart + cron realign).
 */
export async function syncHermesOwnerTimezone(
  timezone: string | undefined,
): Promise<SyncHermesOwnerTimezoneResult> {
  const raw = timezone?.trim();
  if (!raw) {
    return { ok: false, changed: false, error: "timezone is required" };
  }
  const normalized = normalizeIanaTimezone(raw);
  if (!isValidIanaTimezone(normalized)) {
    return { ok: false, changed: false, error: `invalid IANA timezone "${raw}"` };
  }

  try {
    const hermesHome = getHermesHome();
    const { managed } = await readManagedHermesConfig(hermesHome);
    const config = { ...managed };
    const previous = typeof config.timezone === "string" ? config.timezone.trim() : "";
    const configChanged = previous !== normalized;
    if (configChanged) {
      config.timezone = normalized;
      await writeMergedHermesConfig(hermesHome, config);
    }
    const dotenvChanged = await syncHermesTimezoneDotenv(normalized);
    const changed = configChanged || dotenvChanged;
    if (changed) {
      console.info(`[hermes-timezone] synced owner timezone ${normalized} (Hermes cron + clock)`);
      await applyOwnerTimezoneChange(normalized);
    }
    return { ok: true, changed, timezone: normalized };
  } catch (err) {
    return { ok: false, changed: false, error: (err as Error).message };
  }
}
