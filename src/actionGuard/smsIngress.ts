import { parseApprovalReply } from "./approvalReply.js";
import { listOpenPending, resolvePending } from "./pending.js";
import { ownerSmsPhone, phonesMatch, sendSms } from "../twilioSmsSend.js";

/**
 * Handle inbound owner SMS as an action-guard Y/N reply.
 * Returns true when the message was consumed as an approval or denial.
 * If nothing is pending, returns false so conversational "ok" / "yes" reaches Hermes.
 */
export async function handleSmsApprovalIngress(
  from: string,
  body: string,
  projectRoot = process.cwd(),
): Promise<boolean> {
  const decision = parseApprovalReply(body);
  if (!decision) return false;

  if (!phonesMatch(from, ownerSmsPhone())) return false;

  const open = listOpenPending(projectRoot);
  if (open.length === 0) {
    return false;
  }

  // Resolve the most recently created open pending.
  const pending = open.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0]!;
  if (!resolvePending(pending.id, decision, projectRoot)) {
    await sendSms(from, "That approval request expired or was already handled.");
    return true;
  }

  const label = decision === "approved" ? "Approved" : "Denied";
  await sendSms(from, `${label}: ${pending.actionId}`);
  console.log(`[action-guard] SMS reply ${decision} for pending ${pending.id}`);
  return true;
}
