/**
 * Sync Composio-connected Gmail + Google Calendar into connector markdown mirrors.
 */
import path from "node:path";
import {
  calendarEventsDir,
  googleCalendarLegacyEventsDir,
  mailThreadsDir,
  gmailSyncStatePath,
  resolveConnectorPaths,
} from "../paths.js";
import { truncateBody, writeCalendarEventMirror, writeMailThreadMirror, type MailThreadFrontmatter } from "../mirror.js";
import { readSyncState, writeSyncState } from "../state.js";
import { fetchGmailAllMailMessages, fetchGmailInboxMessages, fetchGmailThreadMessages } from "./gmail.js";
import { fetchGmailHistoryCursor, fetchGmailThreadsFromHistory } from "./gmailHistory.js";
import { messageIdsUnchanged, readMirrorExternalId, readMirrorMessageIds } from "../mirrorRead.js";
import { buildGmailThreadMirrorBody } from "./gmailMirrorFormat.js";
import { epochMsToIso } from "./gmailBodies.js";
import { fetchGoogleCalendarEventsForAccount } from "./calendar.js";
import { isComposioEnabled } from "../../composioApi.js";
import {
  listGmailRegistryAccounts,
  migrateLegacyGmailMirrorIfNeeded,
  type GmailRegistryAccount,
} from "./gmailAccounts.js";
import {
  listCalendarRegistryAccounts,
  type CalendarRegistryAccount,
} from "./calendarAccounts.js";
import { refreshConnectorsRegistry } from "../registry.js";
import { relativeFromFilesRoot, safeThreadFilename } from "../paths.js";
import { readdir, rename, mkdir } from "node:fs/promises";
import { createTriageStubAfterMirror } from "../../ea/triageStub.js";
import { gmailIngestSkipLabel, isGmailJunkThread } from "../../ea/gmailJunk.js";
import {
  canonicalThreadIdFromMessages,
  resolveGmailThreadIdsFromSummaries,
} from "./gmailThreadIds.js";

export type ComposioConnectorSyncResult = {
  ok: boolean;
  threadsWritten: number;
  eventsWritten: number;
  error?: string;
  accountsSynced?: number;
};

const THREAD_HYDRATE_CONCURRENCY = 5;
/** Connector cron: narrow window when history cursor unavailable. */
const INCREMENTAL_POLL_DAYS = 1;
const INCREMENTAL_POLL_LIMIT = 40;

async function mapPool<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, Math.max(1, items.length)) }, async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) break;
        results[i] = await fn(items[i]!);
      }
    }),
  );
  return results;
}

type GmailAccountSyncOpts = {
  messageLimit?: number;
  days?: number;
  allMail?: boolean;
  classifyTriage?: boolean;
  skipTriageStubs?: boolean;
  /** `incremental` — GMAIL_LIST_HISTORY + skip unchanged mirrors; `full` — windowed fetch (Day 0 / manual). */
  syncMode?: "incremental" | "full";
};

async function hydrateAndMirrorGmailThread(opts: {
  projectRoot: string;
  ctx: { connectedAccountId: string };
  account: GmailRegistryAccount;
  paths: { filesRoot: string };
  threadsDir: string;
  listThreadId: string;
  summaries: Awaited<ReturnType<typeof fetchGmailInboxMessages>>;
  syncedAt: string;
  classifyTriage: boolean;
  skipTriageStubs: boolean;
}): Promise<number> {
  const {
    projectRoot,
    ctx,
    account,
    paths,
    threadsDir,
    listThreadId,
    summaries,
    syncedAt,
    classifyTriage,
    skipTriageStubs,
  } = opts;

  let messages;
  try {
    messages = await fetchGmailThreadMessages(projectRoot, listThreadId, ctx);
  } catch {
    messages = summaries.filter((m) => m.threadId === listThreadId);
  }
  if (messages.length === 0) return 0;

  const threadId = canonicalThreadIdFromMessages(messages, listThreadId);
  if (isGmailJunkThread(messages)) {
    const skipLabel = gmailIngestSkipLabel(messages[messages.length - 1]?.labelIds);
    console.info(
      `[gmail-sync] skip mirror/triage ${account.accountKey}/${threadId}${skipLabel ? ` (label: ${skipLabel})` : ""}`,
    );
    return 0;
  }

  const messageIds = messages.map((m) => m.id);
  const mirrorPath = path.join(threadsDir, safeThreadFilename(threadId));
  const existingIds = await readMirrorMessageIds(mirrorPath);
  if (messageIdsUnchanged(existingIds, messageIds)) return 0;

  const priorLatestMessageId = (await readMirrorExternalId(mirrorPath)) ?? undefined;
  const latest = messages[messages.length - 1]!;
  const { bodyMarkdown, threadMessages } = buildGmailThreadMirrorBody(
    messages.map((m) => ({
      ...m,
      body: truncateBody(m.body || m.snippet || "", 8000),
    })),
  );
  const fm: MailThreadFrontmatter = {
    source: "composio:gmail",
    external_id: latest.id,
    thread_id: threadId,
    ...(latest.rfcMessageId ? { rfc_message_id: latest.rfcMessageId } : {}),
    from: latest.from,
    ...(latest.to?.length ? { to: latest.to } : {}),
    ...(latest.cc?.length ? { cc: latest.cc } : {}),
    ...(latest.bcc?.length ? { bcc: latest.bcc } : {}),
    date: epochMsToIso(latest.messageTimestamp),
    subject: latest.subject,
    labels: latest.labelIds,
    unread: latest.unread,
    synced_at: syncedAt,
    message_ids: messageIds,
    thread_messages: threadMessages,
    message_count: messages.length,
    connected_account_id: account.connectedAccountId,
    account_email: account.email,
    account_key: account.accountKey,
  };
  const writtenPath = await writeMailThreadMirror({
    threadsDir,
    threadId,
    frontmatter: fm,
    bodyMarkdown,
  });
  const sourcePath = relativeFromFilesRoot(
    paths.filesRoot,
    writtenPath ?? mirrorPath,
  );
  await createTriageStubAfterMirror({
    filesRoot: paths.filesRoot,
    provider: "gmail",
    threadId,
    accountKey: account.accountKey,
    sourcePath,
    subject: latest.subject,
    from: latest.from,
    to: latest.to,
    cc: latest.cc,
    bcc: latest.bcc,
    accountEmail: account.email,
    receivedAt: epochMsToIso(latest.messageTimestamp),
    labels: latest.labelIds,
    classify: classifyTriage,
    skipTriageStubs,
    projectRoot,
    messageId: latest.id,
    rfcMessageId: latest.rfcMessageId,
    priorLatestMessageId,
  }).catch((err) => {
    console.warn(`[gmail-sync] triage stub: ${(err as Error).message}`);
  });
  return 1;
}

export async function syncGmailAccount(
  projectRoot: string,
  account: GmailRegistryAccount,
  opts: GmailAccountSyncOpts = {},
): Promise<{ threadsWritten: number; error?: string }> {
  const paths = resolveConnectorPaths(projectRoot);
  if (!paths) {
    return { threadsWritten: 0, error: "JOSHU_FILES_ROOT unavailable" };
  }

  await migrateLegacyGmailMirrorIfNeeded(projectRoot, account.accountKey);

  const syncMode = opts.syncMode ?? "full";
  const incremental = syncMode === "incremental" && !opts.allMail;
  const days = opts.days ?? (incremental ? INCREMENTAL_POLL_DAYS : 7);
  const limit =
    opts.messageLimit ?? (incremental ? INCREMENTAL_POLL_LIMIT : days >= 7 ? 100 : 30);
  const syncedAt = new Date().toISOString();
  const ctx = { connectedAccountId: account.connectedAccountId };
  const statePath = gmailSyncStatePath(paths.filesRoot, account.accountKey);
  const prior = await readSyncState(statePath);
  let historyId = prior.historyId;

  try {
    const threadsDir = mailThreadsDir("gmail", paths.filesRoot, account.accountKey);
    const classifyTriage = opts.classifyTriage !== false;
    const skipTriageStubs = opts.skipTriageStubs === true;
    let threadIds: string[] = [];
    let summaries: Awaited<ReturnType<typeof fetchGmailInboxMessages>> = [];
    let usedHistory = false;

    if (incremental && !historyId) {
      // Fresh connect / post-reset: seed Gmail history cursor only — no mailbox backfill.
      // Historical mail is Day 0 (`runDay0ColdStart`) or explicit full sync with `days`.
      const cursor = await fetchGmailHistoryCursor(projectRoot, ctx);
      await writeSyncState(statePath, {
        lastSyncAt: syncedAt,
        threadsWritten: 0,
        historyId: cursor,
        connectedAccountId: account.connectedAccountId,
        email: account.email,
      });
      console.info(
        `[gmail-sync] ${account.accountKey}: seeded historyId (incremental baseline — no backfill)`,
      );
      return { threadsWritten: 0 };
    }

    if (incremental && historyId) {
      const hist = await fetchGmailThreadsFromHistory(projectRoot, ctx, historyId);
      if (hist.historyTooOld) {
        console.warn(
          `[gmail-sync] ${account.accountKey}: historyId too old — recovery fetch newer_than:${INCREMENTAL_POLL_DAYS}d`,
        );
        historyId = undefined;
      } else if (hist.threadIds.length === 0) {
        const cursor = await fetchGmailHistoryCursor(projectRoot, ctx);
        await writeSyncState(statePath, {
          lastSyncAt: syncedAt,
          threadsWritten: 0,
          historyId: cursor ?? historyId,
          connectedAccountId: account.connectedAccountId,
          email: account.email,
        });
        return { threadsWritten: 0 };
      } else {
        threadIds = hist.threadIds;
        usedHistory = true;
        if (hist.latestHistoryId) historyId = hist.latestHistoryId;
      }
    }

    if (!usedHistory) {
      const fetchMessages = opts.allMail ? fetchGmailAllMailMessages : fetchGmailInboxMessages;
      summaries = await fetchMessages(projectRoot, ctx, {
        maxResults: limit,
        days,
        idsOnly: incremental,
      });
      threadIds = await resolveGmailThreadIdsFromSummaries(projectRoot, summaries, ctx);
    }

    const written = await mapPool(threadIds, THREAD_HYDRATE_CONCURRENCY, async (listThreadId) =>
      hydrateAndMirrorGmailThread({
        projectRoot,
        ctx,
        account,
        paths,
        threadsDir,
        listThreadId,
        summaries,
        syncedAt,
        classifyTriage,
        skipTriageStubs,
      }),
    );
    const threadsWritten = written.reduce<number>((sum, n) => sum + n, 0);

    const cursor = await fetchGmailHistoryCursor(projectRoot, ctx);
    await writeSyncState(statePath, {
      lastSyncAt: syncedAt,
      threadsWritten,
      historyId: cursor ?? historyId,
      connectedAccountId: account.connectedAccountId,
      email: account.email,
    });

    return { threadsWritten };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await writeSyncState(statePath, {
      lastSyncAt: syncedAt,
      lastError: message,
      historyId,
      connectedAccountId: account.connectedAccountId,
      email: account.email,
    }).catch(() => undefined);
    return { threadsWritten: 0, error: message };
  }
}

/** Move legacy flat calendar/google/events/*.md into the default account subdir once. */
async function migrateLegacyGoogleCalendarMirrorIfNeeded(
  projectRoot: string,
  defaultAccountKey: string,
): Promise<void> {
  const paths = resolveConnectorPaths(projectRoot);
  if (!paths) return;

  const legacyDir = googleCalendarLegacyEventsDir(paths.filesRoot);
  const targetDir = calendarEventsDir("google", paths.filesRoot, defaultAccountKey);

  let legacyEntries: string[];
  try {
    legacyEntries = await readdir(legacyDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }

  const mdFiles = legacyEntries.filter((n) => n.endsWith(".md"));
  if (mdFiles.length === 0) return;

  let targetEntries: string[] = [];
  try {
    targetEntries = await readdir(targetDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (targetEntries.some((n) => n.endsWith(".md"))) return;

  await mkdir(targetDir, { recursive: true });
  for (const name of mdFiles) {
    await rename(path.join(legacyDir, name), path.join(targetDir, name));
  }
  console.log(
    `[connectors] migrated ${mdFiles.length} legacy Google Calendar event(s) → google/${defaultAccountKey}/events/`,
  );
}

async function syncGoogleCalendarAccount(
  projectRoot: string,
  account: CalendarRegistryAccount,
  opts: {
    calendarDaysBack?: number;
    calendarDaysForward?: number;
    syncedAt: string;
    filesRoot: string;
  },
): Promise<{ eventsWritten: number; error?: string }> {
  try {
    const events = await fetchGoogleCalendarEventsForAccount(
      projectRoot,
      { connectedAccountId: account.connectedAccountId },
      {
        maxResults:
          opts.calendarDaysBack && opts.calendarDaysBack > 14 ? 120 : 60,
        daysBack: opts.calendarDaysBack ?? 7,
        daysForward: opts.calendarDaysForward ?? 14,
      },
    );
    const eventsDir = calendarEventsDir("google", opts.filesRoot, account.accountKey);
    let eventsWritten = 0;
    for (const ev of events) {
      const body = [
        ev.description ? truncateBody(ev.description, 6000) : "",
        ev.location ? `**Location:** ${ev.location}` : "",
        ev.calendarSummary ? `**Calendar:** ${ev.calendarSummary}` : "",
        ev.accessRole === "freeBusyReader" ? "**Note:** free/busy only — event details may be hidden." : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      await writeCalendarEventMirror({
        eventsDir,
        eventId: ev.id,
        frontmatter: {
          source: "composio:googlecalendar",
          external_id: ev.id,
          title: ev.summary,
          start: ev.start,
          end: ev.end,
          location: ev.location,
          calendar_id: ev.calendarId,
          calendar_summary: ev.calendarSummary,
          access_role: ev.accessRole,
          connected_account_id: account.connectedAccountId,
          account_email: account.email,
          account_key: account.accountKey,
          synced_at: opts.syncedAt,
        },
        bodyMarkdown: body || "(no description)",
      });
      eventsWritten += 1;
    }
    return { eventsWritten };
  } catch (err) {
    return {
      eventsWritten: 0,
      error: `${account.email ?? account.accountKey}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function syncComposioConnectors(
  projectRoot: string,
  opts: {
    messageLimit?: number;
    syncCalendar?: boolean;
    days?: number;
    connectedAccountId?: string;
    allMail?: boolean;
    calendarDaysBack?: number;
    calendarDaysForward?: number;
    classifyTriage?: boolean;
    skipTriageStubs?: boolean;
    syncMode?: "incremental" | "full";
  } = {},
): Promise<ComposioConnectorSyncResult> {
  if (!isComposioEnabled()) {
    return { ok: false, threadsWritten: 0, eventsWritten: 0, error: "Composio is not configured" };
  }

  const paths = resolveConnectorPaths(projectRoot);
  if (!paths) {
    return { ok: false, threadsWritten: 0, eventsWritten: 0, error: "JOSHU_FILES_ROOT unavailable" };
  }

  let accounts = await listGmailRegistryAccounts(projectRoot);
  accounts = accounts.filter((a) => a.enabled !== false);
  if (opts.connectedAccountId) {
    accounts = accounts.filter((a) => a.connectedAccountId === opts.connectedAccountId);
  }

  let calendarAccounts =
    opts.syncCalendar !== false ? await listCalendarRegistryAccounts(projectRoot) : [];
  calendarAccounts = calendarAccounts.filter((a) => a.enabled !== false);
  if (opts.connectedAccountId && opts.syncCalendar !== false) {
    calendarAccounts = calendarAccounts.filter((a) => a.connectedAccountId === opts.connectedAccountId);
  }

  if (accounts.length === 0 && calendarAccounts.length === 0) {
    return {
      ok: false,
      threadsWritten: 0,
      eventsWritten: 0,
      error: "No Gmail or Google Calendar accounts connected",
    };
  }

  let threadsWritten = 0;
  let eventsWritten = 0;
  const syncedAt = new Date().toISOString();
  const errors: string[] = [];

  for (const account of accounts) {
    const result = await syncGmailAccount(projectRoot, account, {
      messageLimit: opts.messageLimit,
      days: opts.days,
      allMail: opts.allMail,
      classifyTriage: opts.classifyTriage,
      skipTriageStubs: opts.skipTriageStubs,
      syncMode: opts.syncMode,
    });
    threadsWritten += result.threadsWritten;
    if (result.error) errors.push(`${account.email ?? account.accountKey}: ${result.error}`);
  }

  if (opts.syncCalendar !== false) {
    const defaultCalendar = calendarAccounts.find((a) => a.isDefault) ?? calendarAccounts[0];
    if (defaultCalendar) {
      await migrateLegacyGoogleCalendarMirrorIfNeeded(projectRoot, defaultCalendar.accountKey);
    }

    for (const account of calendarAccounts) {
      const result = await syncGoogleCalendarAccount(projectRoot, account, {
        calendarDaysBack: opts.calendarDaysBack,
        calendarDaysForward: opts.calendarDaysForward,
        syncedAt,
        filesRoot: paths.filesRoot,
      });
      eventsWritten += result.eventsWritten;
      if (result.error) errors.push(`calendar: ${result.error}`);
    }
  }

  await refreshConnectorsRegistry(projectRoot).catch(() => undefined);

  if (errors.length > 0 && threadsWritten === 0 && eventsWritten === 0) {
    return {
      ok: false,
      threadsWritten,
      eventsWritten,
      error: errors.join("; "),
      accountsSynced: accounts.length,
    };
  }

  return {
    ok: true,
    threadsWritten,
    eventsWritten,
    accountsSynced: accounts.length,
    ...(errors.length > 0 ? { error: errors.join("; ") } : {}),
  };
}
