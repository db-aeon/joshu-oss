/**
 * Deadline of one SMS turn. The SMS turn runs at least until the progress check
 * time. After that it continues while Hermes reports progress (a tool event or
 * streamed text) within the stall time, up to the limit. A checkout over SMS can
 * take many minutes of steady browser work; a fixed limit cut one off halfway.
 */

import {
  resolveSmsHermesMaxMs,
  resolveSmsHermesStallMs,
  resolveSmsHermesTimeoutMs,
} from "./twilioSmsConfig.js";

export type SmsTurnStopCause = "stalled" | "limit";

/** Abort reason of the deadline signal. */
export class SmsTurnStopped extends Error {
  constructor(
    readonly cause: SmsTurnStopCause,
    readonly elapsedMs: number,
  ) {
    super(`sms turn stopped (${cause}) after ${Math.round(elapsedMs / 1000)}s`);
    this.name = "SmsTurnStopped";
  }
}

export type SmsTurnDeadline = {
  signal: AbortSignal;
  /** Call on each sign of progress from Hermes. */
  progress: () => void;
  dispose: () => void;
};

export type SmsTurnDeadlineOptions = {
  checkAfterMs?: number;
  stallMs?: number;
  maxMs?: number;
  /** How often the deadline is checked. */
  checkEveryMs?: number;
  now?: () => number;
};

export function smsTurnDeadline(opts: SmsTurnDeadlineOptions = {}): SmsTurnDeadline {
  const now = opts.now ?? Date.now;
  const checkAfterMs = opts.checkAfterMs ?? resolveSmsHermesTimeoutMs();
  const stallMs = opts.stallMs ?? resolveSmsHermesStallMs();
  const maxMs = Math.max(checkAfterMs, opts.maxMs ?? resolveSmsHermesMaxMs());
  const startedAt = now();
  let lastProgressAt = startedAt;
  const controller = new AbortController();

  const check = (): void => {
    if (controller.signal.aborted) return;
    const at = now();
    const elapsedMs = at - startedAt;
    if (elapsedMs < checkAfterMs) return;
    if (elapsedMs >= maxMs) {
      controller.abort(new SmsTurnStopped("limit", elapsedMs));
    } else if (at - lastProgressAt >= stallMs) {
      controller.abort(new SmsTurnStopped("stalled", elapsedMs));
    }
    if (controller.signal.aborted) clearInterval(timer);
  };
  const timer = setInterval(check, opts.checkEveryMs ?? 5_000);
  timer.unref?.();

  return {
    signal: controller.signal,
    progress: () => {
      lastProgressAt = now();
    },
    dispose: () => clearInterval(timer),
  };
}

/** The deadline signal stopped the SMS turn (not another error). */
export function smsTurnStopReason(signal: AbortSignal): SmsTurnStopped | undefined {
  return signal.aborted && signal.reason instanceof SmsTurnStopped ? signal.reason : undefined;
}

function minutesText(elapsedMs: number): string {
  const minutes = Math.max(1, Math.round(elapsedMs / 60_000));
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

/** Objective of the realtime goal that continues a stopped SMS turn. */
export function stoppedSmsTurnObjective(ownerText: string, stop: SmsTurnStopped): string {
  return [
    ownerText.trim(),
    "",
    `Note from Joshu: an SMS turn worked on this request for ${minutesText(stop.elapsedMs)} and stopped before it finished.`,
    "Part of the work can already be done, for example pages, carts, or forms in the shared browser, or messages that were already sent.",
    "Check the current state first, and do not repeat a step that already took effect.",
  ].join("\n");
}

/** SMS to the owner when a realtime goal continues the stopped SMS turn. */
export function stoppedSmsTurnDeferredReply(stop: SmsTurnStopped): string {
  return (
    `This took longer than a text reply allows (${minutesText(stop.elapsedMs)}), so I moved it to a ` +
    "background task that picks up where I stopped. I'll text you when it's done."
  );
}

/** SMS to the owner when nothing can continue the stopped SMS turn. */
export function stoppedSmsTurnPlainReply(stop: SmsTurnStopped): string {
  return (
    `I stopped working on that after ${minutesText(stop.elapsedMs)} without finishing. ` +
    "Text me again if you want me to keep going."
  );
}
