/**
 * Idempotent markdown mirror writer for connector sync workers.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { safeEventFilename, safeThreadFilename } from "./paths.js";

export type MailThreadMessageMeta = {
  id: string;
  date?: string;
  from?: string;
  subject?: string;
};

export type MailThreadFrontmatter = {
  source: string;
  external_id: string;
  thread_id: string;
  /** RFC 5322 Message-ID for latest message (cross-mailbox dedup). */
  rfc_message_id?: string;
  from?: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  date?: string;
  subject?: string;
  labels?: string[];
  unread?: boolean;
  synced_at: string;
  message_ids?: string[];
  /** Composio connected account (multi-Gmail). */
  connected_account_id?: string;
  account_email?: string;
  account_key?: string;
  /** Per-message metadata for threaded UI (Gmail / Nylas). */
  thread_messages?: MailThreadMessageMeta[];
  message_count?: number;
};

export type CalendarEventFrontmatter = {
  source: string;
  external_id: string;
  title?: string;
  start?: string;
  end?: string;
  location?: string;
  calendar_id?: string;
  calendar_summary?: string;
  /** Google ACL role for this calendar (owner, reader, freeBusyReader, …). */
  access_role?: string;
  /** Composio connected account (multi Google Calendar OAuth). */
  connected_account_id?: string;
  account_email?: string;
  account_key?: string;
  synced_at: string;
};

function yamlBlock(data: Record<string, unknown>): string {
  return YAML.stringify(data, { lineWidth: 0 }).trim();
}

import { htmlToPlainText } from "./emailPlaintext.js";

export function stripHtmlToText(html: string): string {
  return htmlToPlainText(html);
}

export function truncateBody(text: string, maxChars = 12_000): string {
  const t = text.trim();
  if (t.length <= maxChars) return t;
  return `${t.slice(0, maxChars)}\n\n… (truncated)`;
}

export function epochToIso(epoch?: number): string | undefined {
  if (epoch == null || !Number.isFinite(epoch)) return undefined;
  return new Date(epoch * 1000).toISOString();
}

export async function writeMailThreadMirror(opts: {
  threadsDir: string;
  threadId: string;
  frontmatter: MailThreadFrontmatter;
  bodyMarkdown: string;
}): Promise<string> {
  await mkdir(opts.threadsDir, { recursive: true });
  const filePath = path.join(opts.threadsDir, safeThreadFilename(opts.threadId));
  const content = `---\n${yamlBlock(opts.frontmatter as unknown as Record<string, unknown>)}\n---\n\n${opts.bodyMarkdown.trim()}\n`;
  await writeFile(filePath, content, "utf8");
  return filePath;
}

export async function writeCalendarEventMirror(opts: {
  eventsDir: string;
  eventId: string;
  frontmatter: CalendarEventFrontmatter;
  bodyMarkdown: string;
}): Promise<string> {
  await mkdir(opts.eventsDir, { recursive: true });
  const filePath = path.join(opts.eventsDir, safeEventFilename(opts.eventId));
  const content = `---\n${yamlBlock(opts.frontmatter as unknown as Record<string, unknown>)}\n---\n\n${opts.bodyMarkdown.trim()}\n`;
  await writeFile(filePath, content, "utf8");
  return filePath;
}
