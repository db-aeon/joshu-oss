import { readdir } from "node:fs/promises";
import path from "node:path";
import type { ConnectorMailProvider } from "./paths.js";
import { calendarEventsDir, googleCalendarRootDir, mailThreadsDir, resolveConnectorPaths } from "./paths.js";
import { listGmailRegistryAccounts } from "./composio/gmailAccounts.js";
import { listCalendarRegistryAccounts } from "./composio/calendarAccounts.js";

/** Count thread markdown files in a mail mirror directory. */
export async function countMailMirrorThreads(threadsDir: string): Promise<number> {
  try {
    const entries = await readdir(threadsDir, { withFileTypes: true });
    let count = 0;
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith(".md")) count += 1;
      if (e.isDirectory()) {
        count += await countMailMirrorThreads(path.join(threadsDir, e.name));
      }
    }
    return count;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }
}

export async function getMailMirrorStats(
  projectRoot: string,
  provider: ConnectorMailProvider,
): Promise<{ threadCount: number; empty: boolean; threadsDir: string | null }> {
  const paths = resolveConnectorPaths(projectRoot);
  if (!paths) {
    return { threadCount: 0, empty: true, threadsDir: null };
  }
  if (provider === "gmail") {
    const all = await getAllGmailMirrorStats(projectRoot);
    const threadCount = all.reduce((sum, a) => sum + a.threadCount, 0);
    return {
      threadCount,
      empty: threadCount === 0,
      threadsDir: path.join(paths.filesRoot, "connectors", "mail", "gmail"),
    };
  }
  const threadsDir = mailThreadsDir(provider, paths.filesRoot);
  const threadCount = await countMailMirrorThreads(threadsDir);
  return { threadCount, empty: threadCount === 0, threadsDir };
}

export async function getGmailMirrorStatsForAccount(
  projectRoot: string,
  accountKey: string,
): Promise<{ threadCount: number; empty: boolean; threadsDir: string | null; accountKey: string }> {
  const paths = resolveConnectorPaths(projectRoot);
  if (!paths) {
    return { threadCount: 0, empty: true, threadsDir: null, accountKey };
  }
  const threadsDir = mailThreadsDir("gmail", paths.filesRoot, accountKey);
  const threadCount = await countMailMirrorThreads(threadsDir);
  return { threadCount, empty: threadCount === 0, threadsDir, accountKey };
}

export async function getAllGmailMirrorStats(
  projectRoot: string,
): Promise<
  Array<{
    accountKey: string;
    connectedAccountId: string;
    email?: string;
    threadCount: number;
    empty: boolean;
    threadsDir: string | null;
  }>
> {
  const accounts = await listGmailRegistryAccounts(projectRoot);
  const out = [];
  for (const account of accounts) {
    const stats = await getGmailMirrorStatsForAccount(projectRoot, account.accountKey);
    out.push({
      accountKey: account.accountKey,
      connectedAccountId: account.connectedAccountId,
      email: account.email,
      threadCount: stats.threadCount,
      empty: stats.empty,
      threadsDir: stats.threadsDir,
    });
  }
  return out;
}

export async function getGoogleCalendarMirrorStatsForAccount(
  projectRoot: string,
  accountKey: string,
): Promise<{ eventCount: number; empty: boolean; eventsDir: string | null; accountKey: string }> {
  const paths = resolveConnectorPaths(projectRoot);
  if (!paths) {
    return { eventCount: 0, empty: true, eventsDir: null, accountKey };
  }
  const eventsDir = calendarEventsDir("google", paths.filesRoot, accountKey);
  const eventCount = await countMailMirrorThreads(eventsDir);
  return { eventCount, empty: eventCount === 0, eventsDir, accountKey };
}

export async function getAllGoogleCalendarMirrorStats(
  projectRoot: string,
): Promise<
  Array<{
    accountKey: string;
    connectedAccountId: string;
    email?: string;
    eventCount: number;
    empty: boolean;
    eventsDir: string | null;
  }>
> {
  const accounts = await listCalendarRegistryAccounts(projectRoot);
  const out = [];
  for (const account of accounts) {
    const stats = await getGoogleCalendarMirrorStatsForAccount(projectRoot, account.accountKey);
    out.push({
      accountKey: account.accountKey,
      connectedAccountId: account.connectedAccountId,
      email: account.email,
      eventCount: stats.eventCount,
      empty: stats.empty,
      eventsDir: stats.eventsDir,
    });
  }
  return out;
}

export async function getGoogleCalendarMirrorStats(
  projectRoot: string,
): Promise<{ eventCount: number; empty: boolean; eventsDir: string | null }> {
  const paths = resolveConnectorPaths(projectRoot);
  if (!paths) {
    return { eventCount: 0, empty: true, eventsDir: null };
  }
  const all = await getAllGoogleCalendarMirrorStats(projectRoot);
  const eventCount = all.reduce((sum, a) => sum + a.eventCount, 0);
  return {
    eventCount,
    empty: eventCount === 0,
    eventsDir: googleCalendarRootDir(paths.filesRoot),
  };
}
