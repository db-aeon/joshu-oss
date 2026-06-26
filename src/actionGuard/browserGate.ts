import { awaitOwnerApproval, buildBrowserActionSummary } from "./gate.js";
import { browserActionId } from "./classify.js";
import { isActionGuardEnabled, loadActionGuardPolicy } from "./policy.js";
import { stubBrowserActionResponse } from "./stubs.js";

export type BrowserWriteGateResult =
  | { allowed: true }
  | { allowed: false; stub: Record<string, unknown> }
  | { allowed: false; unavailable: { code: string; message: string } };

/** Owner approval gate for agent browser writes (click/type/press/evaluate). */
export async function gateBrowserWriteRequest(
  kind: string,
  args: Record<string, unknown>,
  projectRoot: string,
): Promise<BrowserWriteGateResult> {
  const policy = loadActionGuardPolicy(projectRoot);
  if (!isActionGuardEnabled(projectRoot) || !policy.browserGateWrites) {
    return { allowed: true };
  }

  const actionId = browserActionId(kind);
  const summary = buildBrowserActionSummary(kind, args);
  const result = await awaitOwnerApproval({ actionId, summary }, projectRoot);

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
    return { allowed: false, stub: stubBrowserActionResponse(kind, args) };
  }
  return { allowed: true };
}

/** Handler for Hermes browser_camofox.py action-guard patch. */
export async function handleBrowserGateRoute(
  body: Record<string, unknown>,
  projectRoot: string,
): Promise<{ allowed: boolean; stub?: Record<string, unknown> }> {
  const kind = typeof body.kind === "string" ? body.kind.trim() : "";
  if (!kind) {
    throw new Error("kind is required");
  }
  const args =
    body.args && typeof body.args === "object" && !Array.isArray(body.args)
      ? (body.args as Record<string, unknown>)
      : {};
  const gate = await gateBrowserWriteRequest(kind, args, projectRoot);
  if (!gate.allowed) {
    if ("unavailable" in gate) {
      return { allowed: false, stub: { error: gate.unavailable.code, message: gate.unavailable.message } };
    }
    return { allowed: false, stub: gate.stub };
  }
  return { allowed: true };
}
