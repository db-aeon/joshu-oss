/**
 * Shared Twilio SMS send helper (owner SMS gateway + action-guard approvals).
 */

import twilio from "twilio";

import { resolveOwnerCaller } from "./telephoneSettings/resolve.js";

/**
 * Carrier-safe SMS body cap. UCS-2 is 70 chars/segment; US carriers reject
 * ~10+ concatenated segments (Twilio error 30019 — "content size exceeds
 * carrier limit"). 640 stays under 10 UCS-2 segments even if a non-GSM
 * character slips through, and is ~4 GSM-7 segments after normalization.
 */
export const SMS_MAX_CHARS = 640;

/** Cap follow-up SMS so a rambling Hermes turn cannot flood the owner. */
export const SMS_MAX_PARTS = 4;

/** Fold fancy punctuation so Twilio stays on GSM-7 (160 chars/segment). */
export function smsGsmFold(raw: string): string {
  let text = raw.replace(/\s+/g, " ").trim();
  text = text
    .replace(/[\u201C\u201D\u00AB\u00BB]/g, '"')
    .replace(/[\u2018\u2019\u201A]/g, "'")
    .replace(/[\u2014\u2013\u2212]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/\u00A0/g, " ")
    .replace(/[\u2022\u00B7]/g, "-");
  // Remaining non-ASCII forces UCS-2 and blows the segment budget.
  return text.replace(/[^\x09\x0A\x0D\x20-\x7E]/g, "");
}

/** Last index at or before `end` that is a good split (sentence, then word). */
function preferSplitAt(text: string, end: number): number {
  if (end >= text.length) return text.length;
  const window = text.slice(0, end);
  const sentence = Math.max(window.lastIndexOf(". "), window.lastIndexOf("? "), window.lastIndexOf("! "));
  if (sentence >= Math.floor(end * 0.4)) return sentence + 1;
  const space = window.lastIndexOf(" ");
  if (space >= Math.floor(end * 0.5)) return space;
  return end;
}

/**
 * Split folded GSM text into carrier-safe SMS bodies.
 * Prefer sentence/word boundaries. Excess after SMS_MAX_PARTS is dropped
 * with a trailing "..." on the last part (flood guard, not the common path).
 */
export function smsGsmParts(raw: string): string[] {
  const folded = smsGsmFold(raw);
  if (!folded) return [];
  if (folded.length <= SMS_MAX_CHARS) return [folded];

  const parts: string[] = [];
  let rest = folded;
  while (rest.length > 0 && parts.length < SMS_MAX_PARTS) {
    if (rest.length <= SMS_MAX_CHARS) {
      parts.push(rest);
      return parts;
    }
    const cut = preferSplitAt(rest, SMS_MAX_CHARS);
    const chunk = rest.slice(0, cut).trim();
    if (!chunk) {
      parts.push(rest.slice(0, SMS_MAX_CHARS));
      rest = rest.slice(SMS_MAX_CHARS).trim();
      continue;
    }
    parts.push(chunk);
    rest = rest.slice(cut).trim();
  }
  if (rest.length > 0 && parts.length > 0) {
    const last = parts[parts.length - 1]!;
    const clipped =
      last.length <= SMS_MAX_CHARS - 3 ? last : last.slice(0, SMS_MAX_CHARS - 3).trimEnd();
    parts[parts.length - 1] = `${clipped}...`;
  }
  return parts;
}

/** Fold + single-body view (first part). Prefer smsGsmParts for send. */
export function smsGsmPlaintext(raw: string): string {
  return smsGsmParts(raw)[0] ?? "";
}

export function envTrim(name: string): string {
  return process.env[name]?.trim() ?? "";
}

export function normalizePhone(raw: string): string {
  return raw.replace(/[^\d+]/g, "");
}

export function phonesMatch(a: string, b: string): boolean {
  const na = normalizePhone(a);
  const nb = normalizePhone(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const stripCountry = (p: string) => (p.startsWith("+1") ? p.slice(2) : p.replace(/^\+/, ""));
  return stripCountry(na) === stripCountry(nb);
}

function smsInboundWebhookUrl(): string | undefined {
  const explicit = envTrim("TWILIO_SMS_WEBHOOK_URL");
  if (explicit) return explicit;
  const voice = envTrim("TWILIO_VOICE_WEBHOOK_URL");
  if (!voice) return undefined;
  return voice.replace(/\/voice\/inbound\/?$/, "/sms/inbound");
}

/** Twilio account + box number + inbound webhook — enough to register SMS routes. */
export function twilioSmsAccountReady(): boolean {
  return Boolean(
    envTrim("TWILIO_AUTH_TOKEN") &&
      envTrim("TWILIO_ACCOUNT_SID") &&
      envTrim("TWILIO_PHONE_NUMBER") &&
      smsInboundWebhookUrl(),
  );
}

/**
 * Owner SMS is fully configured when Twilio is wired *and* an owner mobile is
 * known (Telephone settings file, then TWILIO_OWNER_CALLER).
 */
export function twilioSmsGatewayEnabled(projectRoot = process.cwd()): boolean {
  return twilioSmsAccountReady() && Boolean(ownerSmsPhone(projectRoot));
}

export function ownerSmsPhone(projectRoot = process.cwd()): string {
  return resolveOwnerCaller(projectRoot);
}

/** Send an outbound SMS from the box Twilio number to the owner (or any E.164). */
export async function sendSms(to: string, body: string): Promise<void> {
  const accountSid = envTrim("TWILIO_ACCOUNT_SID");
  const authToken = envTrim("TWILIO_AUTH_TOKEN");
  const messagingServiceSid = envTrim("TWILIO_MESSAGING_SERVICE_SID");
  const fromNumber = envTrim("TWILIO_PHONE_NUMBER");
  const client = twilio(accountSid, authToken);
  const parts = smsGsmParts(body);
  if (parts.length === 0) return;
  if (parts.length > 1 || parts[0]!.length < body.trim().length) {
    console.info(
      `[twilio-sms] outbound split into ${parts.length} SMS (${parts.map((p) => p.length).join("+")} gsm chars, was ${body.length})`,
    );
  }
  for (const text of parts) {
    const created = messagingServiceSid
      ? await client.messages.create({ to, messagingServiceSid, body: text })
      : await client.messages.create({ to, from: fromNumber, body: text });
    console.info(`[twilio-sms] outbound sid=${created.sid} to=${to} chars=${text.length}`);
  }
}
