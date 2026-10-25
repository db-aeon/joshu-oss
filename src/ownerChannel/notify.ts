import { ActionGuardUnavailableError } from "../actionGuard/errors.js";
import { formatApprovalMessage } from "../actionGuard/approvalMessage.js";
import { markPendingNotified } from "../actionGuard/pending.js";
import {
  ownerSmsPhone,
  SMS_RECEIPT_WAIT_MS,
  sendSmsWithReceipt,
  twilioSmsGatewayEnabled,
} from "../twilioSmsSend.js";

/**
 * Text the approval request to the owner. Throws ActionGuardUnavailableError
 * when the SMS send fails or the SMS is undelivered: the owner cannot answer
 * an approval request that never reached the phone.
 */
export async function notifyOwnerForApproval(
  pendingId: string,
  actionId: string,
  summary: Record<string, unknown>,
  projectRoot = process.cwd(),
): Promise<"sms"> {
  if (!twilioSmsGatewayEnabled(projectRoot)) {
    throw new ActionGuardUnavailableError(
      "owner_channel_sms_not_configured",
      "Owner SMS not configured — set owner mobile in Telephone (or TWILIO_OWNER_CALLER) and Twilio account/number/webhook",
    );
  }

  const ownerPhone = ownerSmsPhone(projectRoot);
  if (!ownerPhone) {
    throw new ActionGuardUnavailableError(
      "owner_channel_not_linked",
      "Owner mobile is not set — add it in Telephone",
    );
  }

  const text = formatApprovalMessage(actionId, summary);
  try {
    const receipt = await sendSmsWithReceipt(ownerPhone, text, SMS_RECEIPT_WAIT_MS);
    if (receipt.outcome === "undelivered") throw new Error(`SMS undelivered (${receipt.detail})`);
    markPendingNotified(pendingId, projectRoot);
    return "sms";
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ActionGuardUnavailableError(
      "owner_channel_sms_delivery_failed",
      `SMS approval notification failed: ${detail}`,
    );
  }
}
