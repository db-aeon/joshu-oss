import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { parseGmailThreadMirrorSections } from "./composio/gmailMirrorFormat.js";
import type { ConnectorMailProvider } from "./paths.js";
import { mailThreadsDir, resolveConnectorPaths } from "./paths.js";
import type { MailThreadMessageMeta } from "./mirror.js";
import { listGmailRegistryAccounts } from "./composio/gmailAccounts.js";

export type MirrorThreadMessage = {
  id: string;
  date?: string;
  dateEpoch?: number;
  from?: string;
  subject?: string;
  body: string;
};

export type MirrorThreadDetail = {
  threadId: string;
  externalId?: string;
  subject?: string;
  from?: string;
  to?: string[];
  date?: string;
  unread?: boolean;
  body: string;
  relativePath: string;
  threadMessages: MirrorThreadMessage[];
  messageCount: number;
  connectedAccountId?: string;
  accountKey?: string;
  accountEmail?: string;
};

function dateToEpochSec(iso?: string): number | undefined {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return undefined;
  return Math.floor(ms / 1000);
}

function readThreadMessagesFromFrontmatter(
  fm: Record<string, unknown>,
  body: string,
): MirrorThreadMessage[] {
  const meta = Array.isArray(fm.thread_messages)
    ? (fm.thread_messages as MailThreadMessageMeta[]).filter(
        (m): m is MailThreadMessageMeta => m && typeof m.id === "string",
      )
    : [];
  const sections = parseGmailThreadMirrorSections(body);

  if (meta.length > 0) {
    return meta.map((m, i) => {
      const section = sections[i];
      return {
        id: m.id,
        date: m.date,
        dateEpoch: dateToEpochSec(m.date),
        from: m.from ?? section?.from,
        subject: m.subject ?? section?.subject,
        body: section?.body?.trim() || "",
      };
    });
  }

  if (sections.length > 0) {
    const ids = Array.isArray(fm.message_ids)
      ? fm.message_ids.filter((id): id is string => typeof id === "string")
      : [];
    return sections.map((s, i) => ({
      id: ids[i] ?? `${typeof fm.thread_id === "string" ? fm.thread_id : "thread"}#${i}`,
      from: s.from,
      subject: s.subject,
      body: s.body,
      dateEpoch: s.whenLabel ? dateToEpochSec(s.whenLabel) : undefined,
    }));
  }

  return [];
}

async function parseMirrorFile(absolutePath: string, filesRoot: string): Promise<MirrorThreadDetail | null> {
  const raw = await readFile(absolutePath, "utf8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/m.exec(raw);
  if (!match?.[1]) return null;
  const fm = (YAML.parse(match[1]) as Record<string, unknown>) ?? {};
  const body = match[2]?.trim() ?? "";
  const relativePath = path.relative(filesRoot, absolutePath).split(path.sep).join("/");
  const threadMessages = readThreadMessagesFromFrontmatter(fm, body);
  const messageCount =
    typeof fm.message_count === "number"
      ? fm.message_count
      : threadMessages.length > 0
        ? threadMessages.length
        : 1;

  return {
    threadId: typeof fm.thread_id === "string" ? fm.thread_id : path.basename(absolutePath, ".md"),
    externalId: typeof fm.external_id === "string" ? fm.external_id : undefined,
    subject: typeof fm.subject === "string" ? fm.subject : undefined,
    from: typeof fm.from === "string" ? fm.from : undefined,
    to: Array.isArray(fm.to) ? fm.to.filter((t): t is string => typeof t === "string") : undefined,
    date: typeof fm.date === "string" ? fm.date : undefined,
    unread: typeof fm.unread === "boolean" ? fm.unread : undefined,
    body,
    relativePath,
    threadMessages,
    messageCount,
    connectedAccountId:
      typeof fm.connected_account_id === "string" ? fm.connected_account_id : undefined,
    accountKey: typeof fm.account_key === "string" ? fm.account_key : undefined,
    accountEmail: typeof fm.account_email === "string" ? fm.account_email : undefined,
  };
}

async function scanThreadsDirForMessage(
  threadsDir: string,
  filesRoot: string,
  messageId: string,
): Promise<MirrorThreadDetail | null> {
  let entries: string[];
  try {
    entries = await readdir(threadsDir);
  } catch {
    return null;
  }
  for (const name of entries) {
    if (!name.endsWith(".md")) continue;
    const full = path.join(threadsDir, name);
    const parsed = await parseMirrorFile(full, filesRoot);
    if (!parsed) continue;
    if (parsed.externalId === messageId || parsed.threadId === messageId) return parsed;
  }
  for (const name of entries) {
    if (!name.endsWith(".md")) continue;
    const full = path.join(threadsDir, name);
    const raw = await readFile(full, "utf8");
    const match = /^---\r?\n([\s\S]*?)\r?\n---/m.exec(raw);
    if (!match?.[1]) continue;
    const fm = (YAML.parse(match[1]) as Record<string, unknown>) ?? {};
    const messageIds = Array.isArray(fm.message_ids)
      ? fm.message_ids.filter((id): id is string => typeof id === "string")
      : [];
    if (fm.external_id === messageId || messageIds.includes(messageId)) {
      return parseMirrorFile(full, filesRoot);
    }
  }
  return null;
}

export async function readMirrorThreadByMessageId(
  projectRoot: string,
  provider: ConnectorMailProvider,
  messageId: string,
  opts: { connectedAccountId?: string; accountKey?: string } = {},
): Promise<MirrorThreadDetail | null> {
  const paths = resolveConnectorPaths(projectRoot);
  if (!paths) return null;

  if (provider === "gmail") {
    const accounts = await listGmailRegistryAccounts(projectRoot);
    const scoped = opts.connectedAccountId
      ? accounts.filter((a) => a.connectedAccountId === opts.connectedAccountId)
      : opts.accountKey
        ? accounts.filter((a) => a.accountKey === opts.accountKey)
        : accounts;

    for (const account of scoped) {
      const threadsDir = mailThreadsDir("gmail", paths.filesRoot, account.accountKey);
      const found = await scanThreadsDirForMessage(threadsDir, paths.filesRoot, messageId);
      if (found) return found;
    }
    return null;
  }

  const threadsDir = mailThreadsDir(provider, paths.filesRoot);
  return scanThreadsDirForMessage(threadsDir, paths.filesRoot, messageId);
}

export async function readMirrorThreadByThreadId(
  projectRoot: string,
  provider: ConnectorMailProvider,
  threadId: string,
  opts: { connectedAccountId?: string; accountKey?: string } = {},
): Promise<MirrorThreadDetail | null> {
  const paths = resolveConnectorPaths(projectRoot);
  if (!paths) return null;

  const tryFile = async (threadsDir: string) => {
    const safe = threadId.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120);
    const candidates = [
      path.join(threadsDir, `${safe}.md`),
      path.join(threadsDir, `${threadId}.md`),
    ];
    for (const full of candidates) {
      try {
        return await parseMirrorFile(full, paths.filesRoot);
      } catch {
        /* try next */
      }
    }
    return null;
  };

  if (provider === "gmail") {
    const accounts = await listGmailRegistryAccounts(projectRoot);
    const scoped = opts.connectedAccountId
      ? accounts.filter((a) => a.connectedAccountId === opts.connectedAccountId)
      : opts.accountKey
        ? accounts.filter((a) => a.accountKey === opts.accountKey)
        : accounts;
    for (const account of scoped) {
      const threadsDir = mailThreadsDir("gmail", paths.filesRoot, account.accountKey);
      const direct = await tryFile(threadsDir);
      if (direct) return direct;
    }
    return readMirrorThreadByMessageId(projectRoot, provider, threadId, opts);
  }

  const direct = await tryFile(mailThreadsDir(provider, paths.filesRoot));
  if (direct) return direct;
  return readMirrorThreadByMessageId(projectRoot, provider, threadId, opts);
}

export async function readMirrorExternalId(mirrorPath: string): Promise<string | null> {
  try {
    const raw = await readFile(mirrorPath, "utf8");
    const match = /^---\r?\n([\s\S]*?)\r?\n---/m.exec(raw);
    if (!match?.[1]) return null;
    const fm = (YAML.parse(match[1]) as Record<string, unknown>) ?? {};
    return typeof fm.external_id === "string" ? fm.external_id : null;
  } catch {
    return null;
  }
}

/** True when an on-disk mirror already has the same Gmail/Nylas message id set. */
export function messageIdsUnchanged(existing: string[] | null, next: string[]): boolean {
  if (!existing || existing.length === 0) return false;
  if (existing.length !== next.length) return false;
  const a = [...existing].sort();
  const b = [...next].sort();
  return a.every((id, i) => id === b[i]);
}

export async function readMirrorMessageIds(mirrorPath: string): Promise<string[] | null> {
  try {
    const raw = await readFile(mirrorPath, "utf8");
    const match = /^---\r?\n([\s\S]*?)\r?\n---/m.exec(raw);
    if (!match?.[1]) return null;
    const fm = (YAML.parse(match[1]) as Record<string, unknown>) ?? {};
    if (!Array.isArray(fm.message_ids)) return null;
    return fm.message_ids.filter((id): id is string => typeof id === "string");
  } catch {
    return null;
  }
}
