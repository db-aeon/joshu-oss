import { getMailMirrorStats, getGmailMirrorStatsForAccount, getAllGmailMirrorStats } from "./mirrorStats.js";
import { syncComposioConnectors } from "./composio/sync.js";
import { finalizeConnectorSyncForGbrain } from "./gbrainIndex.js";
import { syncNylasConnectors } from "./nylas/sync.js";
import type { ConnectorMailProvider } from "./paths.js";
import { isAnyGmailConnected } from "./composio/gmailAccounts.js";
import { resolveJoshuFilesPaths } from "../joshuFilesPaths.js";
import { reconcileTerminalSchedulingStubs } from "../ea/triageStub.js";

export async function isGmailConnected(projectRoot: string): Promise<boolean> {
  return isAnyGmailConnected(projectRoot);
}

async function reconcileEaTriageStubs(projectRoot: string): Promise<void> {
  const paths = resolveJoshuFilesPaths(projectRoot);
  if (!paths) return;
  await reconcileTerminalSchedulingStubs(paths.filesRoot).catch((err) => {
    console.warn(`[triage] reconcile: ${(err as Error).message}`);
  });
}

export type MailSyncOptions = {
  days?: number;
  messageLimit?: number;
  ifEmpty?: boolean;
  syncCalendar?: boolean;
  connectedAccountId?: string;
  allMail?: boolean;
  calendarDaysBack?: number;
  calendarDaysForward?: number;
  /** When false, connector sync still creates triage stubs but skips OpenRouter scheduling classifier. */
  classifyTriage?: boolean;
  /** When true, mirror only — no Triage stubs (Day 0 historical sync). */
  skipTriageStubs?: boolean;
  /** `incremental` for 10m cron (history / narrow window); `full` for manual sync and Day 0. */
  syncMode?: "incremental" | "full";
};

export async function runMailSync(
  projectRoot: string,
  provider: ConnectorMailProvider,
  opts: MailSyncOptions = {},
): Promise<{
  ok: boolean;
  skipped?: boolean;
  threadsWritten: number;
  eventsWritten: number;
  error?: string;
  threadCountBefore?: number;
  accountsSynced?: number;
}> {
  try {
  if (opts.ifEmpty) {
    if (provider === "gmail") {
      const all = await getAllGmailMirrorStats(projectRoot);
      const total = all.reduce((sum, s) => sum + s.threadCount, 0);
      if (total > 0) {
        return {
          ok: true,
          skipped: true,
          threadsWritten: total,
          eventsWritten: 0,
          threadCountBefore: total,
        };
      }
    } else {
      const stats = await getMailMirrorStats(projectRoot, provider);
      if (!stats.empty) {
        return {
          ok: true,
          skipped: true,
          threadsWritten: stats.threadCount,
          eventsWritten: 0,
          threadCountBefore: stats.threadCount,
        };
      }
    }
  }

  const syncMode = opts.syncMode ?? "full";

  if (provider === "nylas") {
    const days = opts.days ?? (syncMode === "incremental" ? 1 : 7);
    const result = await syncNylasConnectors(projectRoot, {
      days,
      messageLimit: opts.messageLimit ?? (syncMode === "incremental" ? 40 : undefined),
      syncCalendar: opts.syncCalendar,
      classifyTriage: opts.classifyTriage,
      skipTriageStubs: opts.skipTriageStubs,
      syncMode,
    });
    await finalizeConnectorSyncForGbrain(projectRoot, result);
    return { ...result, threadCountBefore: 0 };
  }

  const result = await syncComposioConnectors(projectRoot, {
    days: opts.days,
    messageLimit: opts.messageLimit,
    syncCalendar: opts.syncCalendar ?? false,
    connectedAccountId: opts.connectedAccountId,
    allMail: opts.allMail,
    calendarDaysBack: opts.calendarDaysBack,
    calendarDaysForward: opts.calendarDaysForward,
    classifyTriage: opts.classifyTriage,
    skipTriageStubs: opts.skipTriageStubs,
    syncMode,
  });
  await finalizeConnectorSyncForGbrain(projectRoot, result);
  return { ...result, threadCountBefore: 0 };
  } finally {
    await reconcileEaTriageStubs(projectRoot);
  }
}

export { getGmailMirrorStatsForAccount, getAllGmailMirrorStats };
