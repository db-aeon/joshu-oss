/**
 * Notify box owner via SMS when Twilio owner gateway is configured.
 */

import {
  ownerSmsPhone,
  SMS_RECEIPT_WAIT_MS,
  sendSmsWithReceipt,
  twilioSmsGatewayEnabled,
} from "./twilioSmsSend.js";

export type AppOwnerDeliveryInput = {
  appId: string;
  title: string;
  summary: string;
  link?: string;
};

/** Send a short app event summary to the owner by SMS when configured. An undelivered SMS is not delivered. */
export async function notifyOwnerAppEvent(
  input: AppOwnerDeliveryInput,
  projectRoot: string,
): Promise<{ delivered: boolean; channels: string[] }> {
  if (!twilioSmsGatewayEnabled(projectRoot)) return { delivered: false, channels: [] };

  const phone = ownerSmsPhone(projectRoot);
  if (!phone) return { delivered: false, channels: [] };

  const body = input.link
    ? `${input.title}\n${input.summary}\n\n${input.link}`
    : `${input.title}\n${input.summary}`;
  const receipt = await sendSmsWithReceipt(phone, body, SMS_RECEIPT_WAIT_MS);
  if (receipt.outcome === "undelivered") return { delivered: false, channels: [] };
  return { delivered: true, channels: ["sms"] };
}
