/**
 * Owner text channel (openspec/glossary.md): SMS when the box has the Twilio SMS
 * gateway and an owner mobile, otherwise email from the companion mailbox.
 * An undelivered SMS (the carrier rejected it) also falls back to email.
 * Nudges and owner reminders send through this helper. No LLM.
 */
import { sendMessage } from "./nylas/client.js";
import { readAgentProfile } from "./nylas/profile.js";
import { readAgentGrant } from "./nylas/store.js";
import {
  ownerSmsPhone,
  SMS_RECEIPT_WAIT_MS,
  sendSmsWithReceipt,
  twilioSmsGatewayEnabled,
} from "./twilioSmsSend.js";

export type OwnerTextResult = {
  delivered: boolean;
  channel?: "sms" | "email";
  /**
   * When not delivered: `no_delivery_channel`, `sms_failed:<smsError>` (no
   * email channel), or `email_failed:<message>` (with `; sms_failed:<smsError>`
   * after a failed SMS).
   */
  error?: string;
  /**
   * Why the SMS failed when the email fallback was used or also failed: the
   * send error, or the delivery receipt (for example `twilio undelivered 30034`).
   */
  smsError?: string;
};

export type OwnerTextInput = {
  /** SMS text. */
  sms: string;
  /** Email subject and body for the fallback. */
  emailSubject: string;
  emailBody: string;
};

/** The owner mobile when the box can send SMS to the owner, otherwise null. */
function smsRoute(projectRoot: string): string | null {
  if (!twilioSmsGatewayEnabled(projectRoot)) return null;
  return ownerSmsPhone(projectRoot) || null;
}

/** The sender and recipient when the box can email the owner, otherwise null. */
function emailRoute(projectRoot: string) {
  const profile = readAgentProfile(projectRoot);
  const email = profile?.primaryWorkEmail?.trim();
  const grant = readAgentGrant(projectRoot);
  if (!email || !grant?.grantId || !grant.email) return null;
  return { to: email, name: profile?.ownerName?.trim() || undefined, grantId: grant.grantId, from: grant.email };
}

/**
 * The channel that sendOwnerText tries first, or null when the box has no
 * owner mobile with the Twilio SMS gateway and no email route. Callers check
 * this before they spend an LLM call on the text. An SMS that fails can still
 * go out by email.
 */
export function ownerTextChannelFor(projectRoot: string): "sms" | "email" | null {
  if (smsRoute(projectRoot)) return "sms";
  if (emailRoute(projectRoot)) return "email";
  return null;
}

/**
 * SMS first; email from the companion mailbox when SMS is not available, the
 * send fails, or the SMS is undelivered. An SMS without a delivery receipt
 * after SMS_RECEIPT_WAIT_MS counts as delivered (Twilio accepted it).
 */
export async function sendOwnerText(projectRoot: string, input: OwnerTextInput): Promise<OwnerTextResult> {
  let smsError: string | undefined;
  const phone = smsRoute(projectRoot);
  if (phone) {
    try {
      const receipt = await sendSmsWithReceipt(phone, input.sms, SMS_RECEIPT_WAIT_MS);
      if (receipt.outcome !== "undelivered") return { delivered: true, channel: "sms" };
      smsError = receipt.detail;
      console.warn(`[owner-text] SMS undelivered (${receipt.detail}); trying email`);
    } catch (err) {
      smsError = err instanceof Error ? err.message : String(err);
      console.warn("[owner-text] SMS send failed:", err);
    }
  }

  const route = emailRoute(projectRoot);
  if (route) {
    try {
      await sendMessage(route.grantId, {
        to: [{ email: route.to, name: route.name }],
        subject: input.emailSubject,
        body: input.emailBody,
        from: route.from,
      });
      return { delivered: true, channel: "email", ...(smsError ? { smsError } : {}) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return smsError
        ? { delivered: false, error: `email_failed:${msg}; sms_failed:${smsError}`, smsError }
        : { delivered: false, error: `email_failed:${msg}` };
    }
  }

  return smsError
    ? { delivered: false, error: `sms_failed:${smsError}`, smsError }
    : { delivered: false, error: "no_delivery_channel" };
}
