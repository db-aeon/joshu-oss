import fs from "node:fs";
import { readLocalEnv } from "../safetySettings/localEnv.js";
import { ActionGuardUnavailableError } from "./errors.js";
import { actionGuardTelegramPath, ensureActionGuardDir } from "./paths.js";
import { onboardingDraftPath } from "../onboarding/paths.js";
import { readPending, resolvePending } from "./pending.js";
import { isTelegramUserAllowed } from "./policy.js";

export type TelegramLink = {
  chatId: number;
  username?: string;
  firstName?: string;
  linkedAt: string;
};

function botToken(projectRoot = process.cwd()): string {
  return (
    process.env.JOSHU_ACTION_GUARD_TELEGRAM_BOT_TOKEN?.trim() ||
    readLocalEnv("JOSHU_ACTION_GUARD_TELEGRAM_BOT_TOKEN", projectRoot) ||
    ""
  );
}

export function isTelegramConfigured(projectRoot = process.cwd()): boolean {
  return Boolean(botToken(projectRoot));
}

export function readTelegramLink(projectRoot = process.cwd()): TelegramLink | null {
  const file = actionGuardTelegramPath(projectRoot);
  if (!file || !fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as TelegramLink;
    if (typeof parsed.chatId === "number" && parsed.chatId !== 0) return parsed;
  } catch {
    /* ignore */
  }
  return null;
}

export function writeTelegramLink(link: TelegramLink, projectRoot = process.cwd()): void {
  ensureActionGuardDir(projectRoot);
  const file = actionGuardTelegramPath(projectRoot);
  if (!file) return;
  fs.writeFileSync(file, `${JSON.stringify(link, null, 2)}\n`, { mode: 0o600 });
}

/** Welcome onboarding hint for matching @username on /start. */
export function readExpectedTelegramUsername(projectRoot = process.cwd()): string | null {
  const draftPath = onboardingDraftPath(projectRoot);
  if (!draftPath || !fs.existsSync(draftPath)) return null;
  try {
    const draft = JSON.parse(fs.readFileSync(draftPath, "utf8")) as {
      communicationContacts?: Record<string, string>;
    };
    const handle = draft.communicationContacts?.telegram?.trim();
    if (!handle) return null;
    return handle.replace(/^@+/, "").toLowerCase();
  } catch {
    return null;
  }
}

function normalizeUsername(value: string | undefined): string {
  return (value ?? "").trim().replace(/^@+/, "").toLowerCase();
}

async function telegramApi<T>(method: string, body: Record<string, unknown>): Promise<T> {
  const token = botToken();
  if (!token) throw new Error("JOSHU_ACTION_GUARD_TELEGRAM_BOT_TOKEN is not set");

  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { ok?: boolean; result?: T; description?: string };
  if (!json.ok) {
    throw new Error(json.description || `Telegram API ${method} failed (${res.status})`);
  }
  return json.result as T;
}

export async function sendTelegramMessage(
  chatId: number,
  text: string,
  replyMarkup?: Record<string, unknown>,
): Promise<void> {
  // Telegram hard-caps message text at 4096 chars — send full content in chunks.
  const TELEGRAM_TEXT_MAX = 4000;
  if (text.length <= TELEGRAM_TEXT_MAX) {
    await telegramApi("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
    return;
  }

  let remaining = text;
  let first = true;
  while (remaining.length > 0) {
    let cut = remaining.length <= TELEGRAM_TEXT_MAX ? remaining.length : remaining.lastIndexOf("\n", TELEGRAM_TEXT_MAX);
    if (cut < TELEGRAM_TEXT_MAX * 0.5) cut = Math.min(TELEGRAM_TEXT_MAX, remaining.length);
    const chunk = remaining.slice(0, cut);
    remaining = remaining.slice(cut).replace(/^\n/, "");
    await telegramApi("sendMessage", {
      chat_id: chatId,
      text: chunk,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...(first && replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
    first = false;
  }
}

export async function answerCallbackQuery(callbackQueryId: string, text: string): Promise<void> {
  await telegramApi("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text,
    show_alert: false,
  });
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Human-readable To/CC/BCC line for Telegram (arrays, objects, or RFC-style strings). */
export function formatRecipientField(value: unknown): string {
  if (value == null || value === "") return "";

  const parts: string[] = [];
  const push = (email: string, name?: string) => {
    const addr = email.trim();
    if (!addr) return;
    const label = name?.trim();
    parts.push(label ? `${label} <${addr}>` : addr);
  };

  const items: unknown[] =
    typeof value === "string"
      ? value.split(/[,;]/).map((s) => s.trim()).filter(Boolean)
      : Array.isArray(value)
        ? value
        : [value];

  for (const item of items) {
    if (typeof item === "string") {
      push(item);
      continue;
    }
    if (item && typeof item === "object") {
      const row = item as { email?: unknown; name?: unknown };
      const email = readString(row.email);
      if (email) push(email, readString(row.name) || undefined);
    }
  }
  return parts.join(", ");
}

export function formatApprovalMessage(actionId: string, summary: Record<string, unknown>): string {
  const lines = ["<b>Joshu action approval</b>", `Action: <code>${escapeHtml(actionId)}</code>`];

  const tool = readString(summary.tool);
  const url = readString(summary.url);
  const ref = readString(summary.ref);
  const key = readString(summary.key);
  const channel = readString(summary.channel);
  const repo = readString(summary.repo);
  const action = readString(summary.action);

  if (tool) lines.push(`Tool: <code>${escapeHtml(tool)}</code>`);
  if (action) lines.push(`Browser: <code>${escapeHtml(action)}</code>`);
  if (url) lines.push(`URL: ${escapeHtml(url)}`);
  if (ref) lines.push(`Element: <code>${escapeHtml(ref)}</code>`);
  if (key) lines.push(`Key: <code>${escapeHtml(key)}</code>`);
  if (channel) lines.push(`Channel: ${escapeHtml(channel)}`);
  if (repo) lines.push(`Repo: ${escapeHtml(repo)}`);

  const to = formatRecipientField(summary.to);
  const cc = formatRecipientField(summary.cc);
  const bcc = formatRecipientField(summary.bcc);
  const subject = summary.subject;
  // Prefer full `body` (nylas send). Fall back to legacy truncated previews.
  const body =
    summary.body ?? summary.bodyPreview ?? summary.argsPreview ?? summary.expressionPreview;
  const textPreview = summary.text;

  if (to) lines.push(`To: ${escapeHtml(to)}`);
  if (cc) lines.push(`CC: ${escapeHtml(cc)}`);
  if (bcc) lines.push(`BCC: ${escapeHtml(bcc)}`);
  if (subject) lines.push(`Subject: ${escapeHtml(String(subject))}`);
  if (textPreview) lines.push(`Text: ${escapeHtml(String(textPreview))}`);
  if (body) {
    lines.push("", escapeHtml(String(body)));
  }
  return lines.join("\n");
}

export async function notifyOwnerForApproval(
  pendingId: string,
  actionId: string,
  summary: Record<string, unknown>,
  projectRoot = process.cwd(),
): Promise<void> {
  const link = readTelegramLink(projectRoot);
  if (!link) {
    throw new ActionGuardUnavailableError(
      "action_guard_telegram_not_linked",
      "Telegram not linked — owner must send /start to the Joshu action-guard bot",
    );
  }
  if (!isTelegramUserAllowed(link.chatId, projectRoot)) {
    throw new ActionGuardUnavailableError(
      "action_guard_telegram_not_allowed",
      "Telegram link is not on the action-guard allowlist — owner must /start from an allowed account",
    );
  }

  const text = formatApprovalMessage(actionId, summary);
  const replyMarkup = {
    inline_keyboard: [
      [
        { text: "Approve", callback_data: `ag:approve:${pendingId}` },
        { text: "Deny", callback_data: `ag:deny:${pendingId}` },
      ],
    ],
  };
  try {
    await sendTelegramMessage(link.chatId, text, replyMarkup);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ActionGuardUnavailableError(
      "action_guard_telegram_delivery_failed",
      `Telegram approval notification failed: ${detail}`,
    );
  }
}

export type TelegramUpdate = {
  update_id?: number;
  message?: {
    chat?: { id?: number; username?: string; first_name?: string };
    text?: string;
    from?: { id?: number; username?: string; first_name?: string };
  };
  callback_query?: {
    id?: string;
    data?: string;
    from?: { id?: number; username?: string; first_name?: string };
    message?: { chat?: { id?: number } };
  };
};

function telegramSenderUserId(update: TelegramUpdate): number | null {
  const fromId = update.callback_query?.from?.id ?? update.message?.from?.id;
  if (typeof fromId === "number" && fromId > 0) return fromId;
  const chatId = update.message?.chat?.id;
  if (typeof chatId === "number" && chatId > 0) return chatId;
  return null;
}

export function tryLinkTelegramFromMessage(update: TelegramUpdate, projectRoot = process.cwd()): TelegramLink | null {
  const chat = update.message?.chat;
  const text = update.message?.text?.trim() ?? "";
  if (!chat?.id || !text.startsWith("/start")) return null;

  const senderId = telegramSenderUserId(update);
  if (senderId !== null && !isTelegramUserAllowed(senderId, projectRoot)) {
    return null;
  }

  const username = normalizeUsername(chat.username ?? update.message?.from?.username);
  const expected = readExpectedTelegramUsername(projectRoot);
  if (expected && username && expected !== username) {
    console.warn(
      `[action-guard] Telegram /start username @${username} does not match Welcome hint @${expected}; linking anyway`,
    );
  }

  const link: TelegramLink = {
    chatId: chat.id,
    username: chat.username ?? update.message?.from?.username,
    firstName: chat.first_name ?? update.message?.from?.first_name,
    linkedAt: new Date().toISOString(),
  };
  writeTelegramLink(link, projectRoot);
  return link;
}

export async function handleTelegramUpdate(update: TelegramUpdate, projectRoot = process.cwd()): Promise<void> {
  const messageText = update.message?.text?.trim() ?? "";
  const chatId = update.message?.chat?.id;
  const senderId = telegramSenderUserId(update);

  if (chatId && messageText.startsWith("/start")) {
    if (senderId !== null && !isTelegramUserAllowed(senderId, projectRoot)) {
      await sendTelegramMessage(chatId, "Unauthorized. This bot is restricted to the box owner.");
      console.warn(`[action-guard] rejected Telegram /start from user ${senderId}`);
      return;
    }
  }

  const linked = tryLinkTelegramFromMessage(update, projectRoot);
  if (linked && chatId) {
    await sendTelegramMessage(
      chatId,
      "Linked. You will receive Joshu write-action approvals here.",
    );
    return;
  }

  const cb = update.callback_query;
  if (!cb?.data || !cb.id) return;

  const callbackUserId = cb.from?.id ?? cb.message?.chat?.id ?? null;
  if (callbackUserId !== null && !isTelegramUserAllowed(callbackUserId, projectRoot)) {
    await answerCallbackQuery(cb.id, "Unauthorized");
    console.warn(`[action-guard] rejected Telegram callback from user ${callbackUserId}`);
    return;
  }

  const match = /^ag:(approve|deny):([0-9a-f-]+)$/i.exec(cb.data.trim());
  if (!match?.[1] || !match[2]) return;

  const decision = match[1].toLowerCase() === "approve" ? "approved" : "denied";
  const pendingId = match[2];
  const pending = readPending(pendingId, projectRoot);
  if (!pending) {
    await answerCallbackQuery(cb.id, "Request expired or not found");
    return;
  }
  if (pending.status !== "pending") {
    await answerCallbackQuery(cb.id, `Already ${pending.status}`);
    return;
  }

  resolvePending(pendingId, decision === "approved" ? "approved" : "denied", projectRoot);
  await answerCallbackQuery(cb.id, decision === "approved" ? "Approved" : "Denied");
  const callbackChatId = cb.message?.chat?.id;
  if (callbackChatId) {
    await sendTelegramMessage(callbackChatId, `Action ${decision}: ${pending.actionId}`);
  }
}

export async function getTelegramUpdates(offset: number): Promise<{ updates: TelegramUpdate[]; nextOffset: number }> {
  const result = await telegramApi<TelegramUpdate[]>("getUpdates", {
    offset,
    timeout: 25,
    allowed_updates: ["message", "callback_query"],
  });
  const updates = Array.isArray(result) ? result : [];
  let nextOffset = offset;
  for (const u of updates) {
    if (typeof u.update_id === "number") nextOffset = Math.max(nextOffset, u.update_id + 1);
  }
  return { updates, nextOffset };
}
