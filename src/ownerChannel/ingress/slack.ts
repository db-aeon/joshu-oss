import { handleApprovalCallback } from "../notify.js";

type SlackPayload = {
  type?: string;
  actions?: Array<{ action_id?: string; value?: string }>;
};

export async function handleOwnerChannelSlackInteractivity(
  payload: SlackPayload,
  projectRoot: string,
): Promise<{ ok: boolean; message?: string }> {
  if (payload.type !== "block_actions" || !Array.isArray(payload.actions)) {
    return { ok: false, message: "unsupported_payload" };
  }
  for (const action of payload.actions) {
    const value = typeof action.value === "string" ? action.value : "";
    if (!value) continue;
    const handled = await handleApprovalCallback(value, {}, projectRoot);
    if (handled) return { ok: true, message: "decision_recorded" };
  }
  return { ok: false, message: "no_matching_action" };
}
