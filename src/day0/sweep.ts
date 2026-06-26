import { readJsonFile, writeJsonFile } from "../onboarding/paths.js";
import { isGmailConnected, runMailSync } from "../connectors/syncHelpers.js";
import { day0StatePath } from "./paths.js";
import { extractDay0Signals } from "./extract.js";
import { inferDay0SweepDigest } from "./infer.js";
import { isDay0LlmConfigured } from "./llm.js";
import type { Day0State, Day0SweepResult } from "./types.js";
import { DEFAULT_DAY0_STATE } from "./types.js";

function readDay0State(projectRoot: string): Day0State {
  return readJsonFile<Day0State>(day0StatePath(projectRoot)) ?? DEFAULT_DAY0_STATE;
}

function patchDay0State(projectRoot: string, patch: Partial<Day0State>): Day0State {
  const file = day0StatePath(projectRoot);
  if (!file) throw new Error("day0 state path unavailable");
  const next: Day0State = { ...readDay0State(projectRoot), ...patch, schemaVersion: 1 };
  writeJsonFile(file, next);
  return next;
}

export async function runDay0Sweep(
  projectRoot: string,
  opts: { since?: string; connectedAccountId?: string } = {},
): Promise<Day0SweepResult> {
  if (!(await isGmailConnected(projectRoot))) {
    return {
      ok: false,
      error: "Gmail not connected",
      day0: readDay0State(projectRoot),
    };
  }

  if (!isDay0LlmConfigured()) {
    return {
      ok: false,
      error: "Day 0 LLM not configured — set OPENROUTER_API_KEY",
      day0: readDay0State(projectRoot),
    };
  }

  const prior = readDay0State(projectRoot);
  const sinceIso = opts.since ?? prior.lastSweepAt ?? prior.completedAt;
  const sinceEpoch = sinceIso ? Math.floor(Date.parse(sinceIso) / 1000) : undefined;
  const sinceLabel = sinceIso ?? "last 7 days";

  const days = sinceEpoch
    ? Math.min(30, Math.max(1, Math.ceil((Date.now() / 1000 - sinceEpoch) / 86400)))
    : 7;

  try {
    await runMailSync(projectRoot, "gmail", {
      days,
      messageLimit: 150,
      syncCalendar: true,
      allMail: true,
      connectedAccountId: opts.connectedAccountId,
      calendarDaysBack: days,
      calendarDaysForward: 14,
    });

    const extract = await extractDay0Signals(projectRoot, {
      connectedAccountId: opts.connectedAccountId,
      sinceEpoch,
    });

    const digest = await inferDay0SweepDigest(extract, sinceLabel);
    const now = new Date().toISOString();
    const day0 = patchDay0State(projectRoot, {
      lastSweepAt: now,
      lastDigest: digest,
      threadsAnalyzed: extract.threads.length,
      eventsAnalyzed: extract.events.length,
    });

    return { ok: true, digest, day0 };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: message,
      day0: patchDay0State(projectRoot, { error: message }),
    };
  }
}
