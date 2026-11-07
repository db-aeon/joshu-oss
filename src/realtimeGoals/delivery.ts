/** Slack and Telegram senders for owner outbox items. */
import { createHash } from "node:crypto";
import fs from "node:fs";

import { resolveMessagingBotToken } from "../hermesMessagingEnv.js";

type SendResult = { delivered: boolean; providerId?: string; error?: string };

/**
 * A file that goes with an outbox text, for example the PDF of a Research report whose report
 * link is in the text (change research-reports, design decision D9). When the upload fails, the
 * sender sends the text alone, and the text still has the report link.
 */
export type OutboxFile = { path: string; filename: string; title?: string };

/** Telegram allows at most 1024 characters in a document caption. */
const TELEGRAM_CAPTION_MAX = 1_024;

/** Slack upload: get an upload URL, send the bytes, then share the file with the text as comment. */
async function uploadSlackFiles(
  token: string,
  input: { channel: string; threadTs?: string; text: string; files: OutboxFile[] },
): Promise<SendResult> {
  const uploaded: { id: string; title: string }[] = [];
  for (const file of input.files) {
    const bytes = fs.readFileSync(file.path);
    const form = new URLSearchParams({ filename: file.filename, length: String(bytes.length) });
    const urlRes = await fetch("https://slack.com/api/files.getUploadURLExternal", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      signal: AbortSignal.timeout(15_000),
    });
    const urlBody = (await urlRes.json().catch(() => ({}))) as { ok?: boolean; upload_url?: string; file_id?: string; error?: string };
    if (!urlBody.ok || !urlBody.upload_url || !urlBody.file_id) {
      return { delivered: false, error: urlBody.error || `Slack HTTP ${urlRes.status}` };
    }
    const put = await fetch(urlBody.upload_url, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: bytes,
      signal: AbortSignal.timeout(60_000),
    });
    if (!put.ok) return { delivered: false, error: `Slack upload HTTP ${put.status}` };
    uploaded.push({ id: urlBody.file_id, title: file.title ?? file.filename });
  }
  const done = await fetch("https://slack.com/api/files.completeUploadExternal", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      files: uploaded,
      channel_id: input.channel,
      initial_comment: input.text,
      ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await done.json().catch(() => ({}))) as { ok?: boolean; files?: { id?: string }[]; error?: string };
  return body.ok
    ? { delivered: true, providerId: body.files?.[0]?.id ?? uploaded[0]?.id }
    : { delivered: false, error: body.error || `Slack HTTP ${done.status}` };
}

/** Telegram document with the text as caption (or no caption when the text is longer). */
async function sendTelegramDocument(
  token: string,
  input: { chatId: string; threadId?: string; caption?: string; file: OutboxFile },
): Promise<SendResult> {
  const form = new FormData();
  form.set("chat_id", input.chatId);
  if (input.caption) form.set("caption", input.caption);
  if (input.threadId && /^\d+$/.test(input.threadId)) form.set("message_thread_id", input.threadId);
  form.set("document", new Blob([fs.readFileSync(input.file.path)], { type: "application/pdf" }), input.file.filename);
  const response = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  const body = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    description?: string;
    result?: { message_id?: number };
  };
  return body.ok
    ? { delivered: true, providerId: String(body.result?.message_id ?? "") || undefined }
    : { delivered: false, error: body.description || `Telegram HTTP ${response.status}` };
}

/** Slack `client_msg_id` is a UUID; derive it so a retried post is deduplicated. */
function slackClientMsgId(dedupeKey: string): string {
  const hex = createHash("sha256").update(dedupeKey).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function postSlackMessage(
  projectRoot: string,
  input: { channel?: string; threadTs?: string; text: string; dedupeKey: string; files?: OutboxFile[] },
): Promise<SendResult> {
  const token = resolveMessagingBotToken("SLACK_BOT_TOKEN", projectRoot);
  const channel = input.channel?.trim();
  if (!token || !channel) return { delivered: false, error: "Slack delivery is not configured" };
  if (input.files?.length) {
    const uploaded = await uploadSlackFiles(token, { channel, threadTs: input.threadTs, text: input.text, files: input.files }).catch(
      (err: Error) => ({ delivered: false, error: err.message }) as SendResult,
    );
    if (uploaded.delivered) return uploaded;
    console.warn(`[owner-outbox] Slack file upload failed, sending the text alone: ${uploaded.error}`);
  }
  const response = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      channel,
      text: input.text,
      client_msg_id: slackClientMsgId(input.dedupeKey),
      ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    ts?: string;
    error?: string;
  };
  return body.ok
    ? { delivered: true, providerId: body.ts }
    : { delivered: false, error: body.error || `Slack HTTP ${response.status}` };
}

export async function sendTelegramMessage(
  projectRoot: string,
  input: { chatId?: string; threadId?: string; text: string; files?: OutboxFile[] },
): Promise<SendResult> {
  const token = resolveMessagingBotToken("TELEGRAM_BOT_TOKEN", projectRoot);
  const chatId = input.chatId?.trim();
  if (!token || !chatId) return { delivered: false, error: "Telegram delivery is not configured" };
  if (input.files?.length) {
    const sent = await sendTelegramFiles(token, { chatId, threadId: input.threadId, text: input.text, files: input.files }).catch(
      (err: Error) => ({ delivered: false, error: err.message }) as SendResult,
    );
    if (sent.delivered) return sent;
    console.warn(`[owner-outbox] Telegram document failed, sending the text alone: ${sent.error}`);
  }
  return sendTelegramText(token, { chatId, threadId: input.threadId, text: input.text });
}

/** One document for each file; the text is the caption, or a message first when it is too long. */
async function sendTelegramFiles(
  token: string,
  input: { chatId: string; threadId?: string; text: string; files: OutboxFile[] },
): Promise<SendResult> {
  const fitsCaption = input.text.length <= TELEGRAM_CAPTION_MAX;
  let first: SendResult | undefined;
  if (!fitsCaption) {
    first = await sendTelegramText(token, input);
    if (!first.delivered) return first;
  }
  for (const [i, file] of input.files.entries()) {
    const caption = fitsCaption && i === 0 ? input.text : undefined;
    const sent = await sendTelegramDocument(token, { chatId: input.chatId, threadId: input.threadId, caption, file });
    // A failed document after the text went out is not a failed delivery: the text has the link.
    if (!sent.delivered) return first ?? sent;
    first ??= sent;
  }
  return first ?? { delivered: false, error: "no file" };
}

async function sendTelegramText(
  token: string,
  input: { chatId: string; threadId?: string; text: string },
): Promise<SendResult> {
  const chatId = input.chatId;
  const text = input.text;
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: text.length > 4_000 ? `${text.slice(0, 3_997)}...` : text,
      ...(input.threadId && /^\d+$/.test(input.threadId)
        ? { message_thread_id: Number(input.threadId) }
        : {}),
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    description?: string;
    result?: { message_id?: number };
  };
  return body.ok
    ? { delivered: true, providerId: String(body.result?.message_id ?? "") || undefined }
    : { delivered: false, error: body.description || `Telegram HTTP ${response.status}` };
}
