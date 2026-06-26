import type { Response } from "express";
import type { NylasSendGateResult } from "./nylasSendGate.js";

/** Apply Nylas send gate result to an Express response. Returns true when send may proceed. */
export function respondNylasSendGate(res: Response, gate: NylasSendGateResult): gate is { allowed: true } {
  if (gate.allowed) return true;
  if ("unavailable" in gate) {
    res.status(503).json({
      error: gate.unavailable.code,
      message: gate.unavailable.message,
    });
    return false;
  }
  res.json(gate.stub);
  return false;
}
