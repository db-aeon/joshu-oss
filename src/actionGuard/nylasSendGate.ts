import type { Request } from "express";
import { isJmailOwnerClient } from "./agentRestGate.js";
import { awaitOwnerApproval, buildNylasSendSummary } from "./gate.js";
import { isActionGuardEnabled } from "./policy.js";
import { stubNylasSendResponse } from "./stubs.js";

/** @deprecated Use isJmailOwnerClient */
export const isJmailOwnerSend = isJmailOwnerClient;

export type NylasSendGateResult =
  | { allowed: true }
  | { allowed: false; stub: Record<string, unknown> }
  | { allowed: false; unavailable: { code: string; message: string } };

/** Owner approval gate for agent Nylas sends (REST layer — closes execute_code bypass). */
export async function gateNylasSendRequest(
  req: Request,
  body: Record<string, unknown>,
  projectRoot: string,
): Promise<NylasSendGateResult> {
  if (!isActionGuardEnabled(projectRoot)) {
    return { allowed: true };
  }
  if (isJmailOwnerSend(req)) {
    return { allowed: true };
  }

  const summary = buildNylasSendSummary(body);
  const result = await awaitOwnerApproval({ actionId: "nylas_send_message", summary }, projectRoot);

  if (result.decision === "unavailable") {
    return {
      allowed: false,
      unavailable: {
        code: result.unavailableCode ?? "action_guard_unavailable",
        message: result.unavailableReason ?? "Action guard is unavailable",
      },
    };
  }
  if (result.decision === "denied" || result.decision === "timeout") {
    return { allowed: false, stub: stubNylasSendResponse(body, projectRoot) };
  }
  return { allowed: true };
}
