/**
 * The delivery of report updates, failure notes, and "nothing new" lines without a Hermes turn
 * (design decision D7). Email goes from the companion mailbox to the owner email addresses of the
 * box profile, a text message goes on the owner text channel (which falls back to email), and Slack
 * and Telegram go with the send functions of the owner outbox to the latest origin of the owner on
 * that channel. When that origin is gone, the box sends on the owner text channel. The box never
 * takes a recipient from a model answer: every address comes from the box profile or the outbox.
 */

import { buildJoshuSignedEmailHtml } from "../../email/joshuEmailSignature.js";
import { resolveJoshuIdentity } from "../../joshuIdentity.js";
import { sendMessage } from "../../nylas/client.js";
import type { NylasSendAttachment } from "../../nylas/attachments.js";
import { readAgentProfile } from "../../nylas/profile.js";
import { readAgentGrant } from "../../nylas/store.js";
import { sendOwnerText, type OwnerTextInput, type OwnerTextResult } from "../../ownerTextChannel.js";
import { postSlackMessage, sendTelegramMessage } from "../../realtimeGoals/delivery.js";
import { RealtimeGoalStore } from "../../realtimeGoals/store.js";
import type { ReportChannel } from "./types.js";

export type ChatOrigin = { replyAddress?: string; threadId?: string };

export type DeliverySenders = {
  /** The owner email addresses of the box profile, the primary one first. */
  profileEmails(): { email: string; name?: string }[];
  /**
   * Send one email from the companion mailbox; returns the Nylas message identifier. Throws on
   * failure. `body` is light markdown (`emailText`); the box sender turns it into HTML.
   */
  email(to: { email: string; name?: string }[], subject: string, body: string, attachments?: NylasSendAttachment[]): Promise<string>;
  ownerText(input: OwnerTextInput): Promise<OwnerTextResult>;
  /** The latest origin of the owner on Slack or Telegram, or null. */
  origin(channel: "slack" | "telegram"): Promise<ChatOrigin | null>;
  chat(channel: "slack" | "telegram", origin: ChatOrigin, text: string, dedupeKey: string): Promise<{ delivered: boolean; error?: string }>;
};

export type OutgoingMessage = {
  subject: string;
  /** The text for email, Slack, and Telegram. */
  text: string;
  /** A shorter text for a text message; default `text`. */
  smsText?: string;
  attachments?: NylasSendAttachment[];
  /** Lines of `text` that are headings, for example the topics of the lanes. Email shows them as headings. */
  headings?: string[];
  /** The owner addresses that the setup chose; each must be in the box profile. */
  emailTo?: string[];
  dedupeKey: string;
};

export type DeliveryResult = {
  delivered: boolean;
  /** The channel that the box sent on, which can differ from the channel of the recurring report. */
  channel?: ReportChannel;
  messageId?: string;
  error?: string;
};

/** The recipients of an email: the chosen addresses that are in the profile, or the primary address. */
export function emailRecipients(profile: { email: string; name?: string }[], chosen: string[] = []): { email: string; name?: string }[] {
  const wanted = new Set(chosen.map((e) => e.trim().toLowerCase()).filter(Boolean));
  const picked = profile.filter((p) => wanted.has(p.email.toLowerCase()));
  return picked.length ? picked : profile.slice(0, 1);
}

const REDIRECT = /^https?:\/\/(www\.)?google\.com\/(goto|url)\b/;

/** The link text of a bare link in an email: the site, for example "reuters.com". */
export function linkLabel(url: string): string {
  if (REDIRECT.test(url)) return "Google News";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * The text of an email as light markdown for `buildJoshuSignedEmailHtml`: each line of `headings`
 * becomes a heading, and each bare link shows the name of its site instead of the whole URL.
 */
export function emailText(text: string, headings: string[] = []): string {
  const wanted = new Set(headings.map((h) => h.trim().toLowerCase()).filter(Boolean));
  return text
    .split("\n")
    .map((line) => (wanted.has(line.trim().replace(/:$/, "").toLowerCase()) ? `### ${line.trim().replace(/:$/, "")}` : line))
    .join("\n")
    .replace(/(\]\()?(https?:\/\/[^\s<>()"']+[^\s<>()"'.,;:!?])/g, (m, inLink: string | undefined, url: string) => (inLink ? m : `[${linkLabel(url)}](${url})`));
}

/** Send one message on `channel`. Never throws. */
export async function deliver(channel: ReportChannel, msg: OutgoingMessage, senders: DeliverySenders): Promise<DeliveryResult> {
  const viaOwnerText = async (): Promise<DeliveryResult> => {
    const sent = await senders.ownerText({ sms: msg.smsText ?? msg.text, emailSubject: msg.subject, emailBody: msg.text }).catch(
      (err: Error) => ({ delivered: false, error: err.message }) as OwnerTextResult,
    );
    return sent.delivered ? { delivered: true, channel: sent.channel ?? "sms" } : { delivered: false, error: sent.error ?? "unknown error" };
  };
  try {
    if (channel === "email") {
      const to = emailRecipients(senders.profileEmails(), msg.emailTo);
      if (!to.length) return { delivered: false, error: "the box profile has no owner email address" };
      const messageId = await senders.email(to, msg.subject, emailText(msg.text, msg.headings), msg.attachments);
      return { delivered: true, channel: "email", messageId };
    }
    if (channel === "sms") return await viaOwnerText();
    const origin = await senders.origin(channel);
    if (!origin?.replyAddress) return await viaOwnerText();
    const sent = await senders.chat(channel, origin, msg.text, msg.dedupeKey);
    return sent.delivered ? { delivered: true, channel } : { delivered: false, channel, error: sent.error ?? "unknown error" };
  } catch (err) {
    return { delivered: false, channel, error: (err as Error).message };
  }
}

/** The production senders of a box. */
export function boxSenders(projectRoot: string): DeliverySenders {
  return {
    profileEmails() {
      const profile = readAgentProfile(projectRoot);
      const name = profile?.ownerName?.trim() || undefined;
      const emails = [profile?.primaryWorkEmail, profile?.personalEmail].map((e) => e?.trim()).filter((e): e is string => Boolean(e));
      return [...new Set(emails)].map((email) => ({ email, ...(name ? { name } : {}) }));
    },
    async email(to, subject, body, attachments) {
      const grant = readAgentGrant(projectRoot);
      if (!grant?.grantId || !grant.email) throw new Error("the companion mailbox is not connected");
      const identity = resolveJoshuIdentity(projectRoot);
      const html = buildJoshuSignedEmailHtml(body, {
        name: identity.name,
        portraitImageUrl: identity.imageUrl ?? undefined,
        ownerDisplayName: identity.owner.displayName,
      });
      return sendMessage(grant.grantId, { to, subject, body: html, from: grant.email, ...(attachments?.length ? { attachments } : {}) });
    },
    ownerText: (input) => sendOwnerText(projectRoot, input),
    async origin(channel) {
      const state = await new RealtimeGoalStore(projectRoot).read();
      const origin = state.owner?.presence?.lastByChannel?.[channel]?.origin;
      return origin?.replyAddress ? { replyAddress: origin.replyAddress, ...(origin.threadId ? { threadId: origin.threadId } : {}) } : null;
    },
    async chat(channel, origin, text, dedupeKey) {
      // A report update starts its own message in the chat with the owner, not a reply in an old thread.
      return channel === "slack"
        ? postSlackMessage(projectRoot, { channel: origin.replyAddress, text, dedupeKey })
        : sendTelegramMessage(projectRoot, { chatId: origin.replyAddress, text });
    },
  };
}
