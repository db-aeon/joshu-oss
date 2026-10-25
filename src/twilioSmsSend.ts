/**
 * Shared Twilio SMS send helper (owner SMS gateway + action-guard approvals).
 */

import twilio from "twilio";

import { smsDeliveryVerdict } from "./realtimeGoals/outboxPolicy.js";
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
  let text = raw.replace(/\r\n/g, "\n");
  text = text
    .replace(/[\u2192\u279C\u27A1]/g, " to ")
    .replace(/\u2190/g, " from ")
    .replace(/[\u2194\u21D4]/g, "-")
    .replace(/[\u201C\u201D\u00AB\u00BB]/g, '"')
    .replace(/[\u2018\u2019\u201A]/g, "'")
    .replace(/[\u2014\u2013\u2212]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/\u00A0/g, " ")
    .replace(/[\u2022\u00B7]/g, "-");
  // Remaining non-ASCII forces UCS-2 and blows the segment budget. Remove it before
  // spaces fold, so "Reacted <emoji> to" becomes "Reacted to" with one space.
  text = text.replace(/[^\x09\x0A\x0D\x20-\x7E]/g, "");
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Last index at or before `end` that is a good split (paragraph, line, sentence, then word). */
function preferSplitAt(text: string, end: number): number {
  if (end >= text.length) return text.length;
  const window = text.slice(0, end);
  // A list item stays in one SMS part.
  const paragraph = window.lastIndexOf("\n\n");
  if (paragraph >= Math.floor(end * 0.4)) return paragraph;
  const line = window.lastIndexOf("\n");
  if (line >= Math.floor(end * 0.4)) return line;
  const sentence = Math.max(window.lastIndexOf(". "), window.lastIndexOf("? "), window.lastIndexOf("! "));
  if (sentence >= Math.floor(end * 0.4)) return sentence + 1;
  const space = window.lastIndexOf(" ");
  if (space >= Math.floor(end * 0.5)) return space;
  return end;
}

/**
 * Split folded GSM text into carrier-safe SMS bodies.
 * Prefer paragraph, line, sentence, then word boundaries. Excess after SMS_MAX_PARTS is dropped
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

function twilioClient() {
  return twilio(envTrim("TWILIO_ACCOUNT_SID"), envTrim("TWILIO_AUTH_TOKEN"));
}

/**
 * Send an outbound SMS from the box Twilio number to the owner (or any E.164).
 * Returns the message SID of each SMS part. Twilio accepted the parts; the
 * delivery receipt comes later (fetchSmsStatus).
 */
export async function sendSms(to: string, body: string): Promise<string[]> {
  const messagingServiceSid = envTrim("TWILIO_MESSAGING_SERVICE_SID");
  const fromNumber = envTrim("TWILIO_PHONE_NUMBER");
  const client = twilioClient();
  const parts = smsGsmParts(body);
  if (parts.length === 0) return [];
  if (parts.length > 1 || parts[0]!.length < body.trim().length) {
    console.info(
      `[twilio-sms] outbound split into ${parts.length} SMS (${parts.map((p) => p.length).join("+")} gsm chars, was ${body.length})`,
    );
  }
  const sids: string[] = [];
  for (const text of parts) {
    const created = messagingServiceSid
      ? await client.messages.create({ to, messagingServiceSid, body: text })
      : await client.messages.create({ to, from: fromNumber, body: text });
    console.info(`[twilio-sms] outbound sid=${created.sid} to=${to} chars=${text.length}`);
    sids.push(created.sid);
  }
  return sids;
}

export type SmsStatus = { sid: string; status: string; errorCode?: number };

/** Current Twilio status of one sent SMS (`sent`, `delivered`, `undelivered`, ...). */
export async function fetchSmsStatus(sid: string): Promise<SmsStatus> {
  const message = await twilioClient().messages(sid).fetch();
  return {
    sid,
    status: String(message.status ?? ""),
    ...(message.errorCode ? { errorCode: message.errorCode } : {}),
  };
}

/** Wait at most this long for a delivery receipt (owner text channel, approval SMS, background check). */
export const SMS_RECEIPT_WAIT_MS = 45_000;
/** Read the Twilio status of each SMS part this often while waiting for the receipt. */
const SMS_RECEIPT_POLL_MS = 2_000;

/** Twilio calls and clock of the receipt helpers. Tests replace them. */
export type SmsTransport = {
  send: (to: string, body: string) => Promise<string[]>;
  status: (sid: string) => Promise<SmsStatus>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
};

const TWILIO_TRANSPORT: SmsTransport = {
  send: sendSms,
  status: fetchSmsStatus,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};
let smsTransport = TWILIO_TRANSPORT;

/** Replace the Twilio calls and the clock of the receipt helpers (no argument = the real ones). */
export function setSmsTransportForTests(transport?: Partial<SmsTransport>): void {
  smsTransport = transport ? { ...TWILIO_TRANSPORT, ...transport } : TWILIO_TRANSPORT;
}

export type SmsReceipt =
  | { outcome: "delivered" | "no_receipt"; sids: string[] }
  | { outcome: "undelivered"; sids: string[]; detail: string };

/** Resolve `promise`, or undefined after `ms` (a hung Twilio status read must not stretch the wait). */
async function withinMs<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Wait for the delivery receipt of each SMS part until `waitMs` of real time
 * has passed, status reads included. `undelivered`: a carrier rejected a part;
 * `detail` is for example `twilio undelivered 30034`. `no_receipt`: no final
 * status in time; Twilio accepted the SMS, so the caller counts the SMS as sent.
 */
async function awaitSmsReceipt(to: string, sids: string[], waitMs: number): Promise<SmsReceipt> {
  const deadline = smsTransport.now() + waitMs;
  while (sids.length > 0) {
    const sleepMs = Math.min(SMS_RECEIPT_POLL_MS, deadline - smsTransport.now());
    if (sleepMs <= 0) break;
    await smsTransport.sleep(sleepMs);
    const readMs = deadline - smsTransport.now();
    if (readMs <= 0) break;
    const reads = Promise.all(sids.map((sid) => smsTransport.status(sid).catch(() => undefined)));
    const statuses = await withinMs(reads, readMs);
    if (!statuses) break;
    // sentAt = now: before the outbox timeout, only a delivery receipt settles the verdict.
    const now = smsTransport.now();
    const verdict = smsDeliveryVerdict(statuses, now, now);
    if (verdict.kind === "delivered") return { outcome: "delivered", sids };
    if (verdict.kind === "undelivered") {
      console.warn(`[twilio-sms] undelivered to=${to} sids=${sids.join(",")} ${verdict.detail}`);
      return { outcome: "undelivered", sids, detail: verdict.detail };
    }
  }
  return { outcome: "no_receipt", sids };
}

/**
 * Send an SMS and wait at most `waitMs` for the delivery receipt (awaitSmsReceipt).
 * Throws when Twilio does not accept the SMS, as sendSms does.
 */
export async function sendSmsWithReceipt(to: string, body: string, waitMs: number): Promise<SmsReceipt> {
  return awaitSmsReceipt(to, await smsTransport.send(to, body), waitMs);
}

/**
 * Send an SMS and return when Twilio accepts it. The delivery receipt is read
 * in the background for at most SMS_RECEIPT_WAIT_MS, and `onUndelivered` runs
 * when a carrier rejects the SMS. For callers that cannot wait: a live phone
 * call, a callback batch. Throws when Twilio does not accept the SMS.
 */
export async function sendSmsCheckReceiptLater(
  to: string,
  body: string,
  onUndelivered?: (detail: string) => void | Promise<void>,
): Promise<string[]> {
  const sids = await smsTransport.send(to, body);
  void awaitSmsReceipt(to, sids, SMS_RECEIPT_WAIT_MS)
    .then(async (receipt) => {
      if (receipt.outcome === "undelivered") await onUndelivered?.(receipt.detail);
    })
    .catch((error: Error) => console.warn(`[twilio-sms] background receipt check failed: ${error.message}`));
  return sids;
}
