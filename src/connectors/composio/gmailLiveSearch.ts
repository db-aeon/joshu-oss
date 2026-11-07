/**
 * Live Gmail search: one Gmail search query on Gmail itself, for each enabled owner Gmail
 * account, with the connection of that account. The mail mirror skips bulk mail and reads
 * only recent mail, so the companion uses this search when the mail mirror misses.
 * Spec: gmail-live-search (change gmail-live-search).
 */
import { epochMsToIso } from "./gmailBodies.js";
import { searchGmailMessages, type GmailMessageSummary } from "./gmail.js";
import { listGmailRegistryAccounts, type GmailRegistryAccount } from "./gmailAccounts.js";

export const GMAIL_LIVE_SEARCH_DEFAULT_LIMIT = 20;
export const GMAIL_LIVE_SEARCH_MAX_LIMIT = 50;

export type GmailLiveSearchHit = {
  messageId: string;
  threadId: string;
  connectedAccountId: string;
  accountEmail?: string;
  from?: string;
  subject?: string;
  date?: string;
  snippet?: string;
  labels: string[];
};

export type GmailLiveSearchAccount = {
  connectedAccountId: string;
  accountEmail?: string;
  ok: boolean;
  hits?: number;
  error?: string;
};

export type GmailLiveSearchResult = {
  query: string;
  hits: GmailLiveSearchHit[];
  accounts: GmailLiveSearchAccount[];
  incomplete: boolean;
};

export type GmailLiveSearchDeps = {
  listAccounts: (projectRoot: string) => Promise<GmailRegistryAccount[]>;
  search: typeof searchGmailMessages;
};

const defaultDeps: GmailLiveSearchDeps = {
  listAccounts: listGmailRegistryAccounts,
  search: searchGmailMessages,
};

export class GmailLiveSearchError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 502,
    readonly accounts: GmailLiveSearchAccount[] = [],
  ) {
    super(message);
  }
}

export function clampLiveSearchLimit(raw: number | undefined): number {
  if (!raw || !Number.isFinite(raw) || raw < 1) return GMAIL_LIVE_SEARCH_DEFAULT_LIMIT;
  return Math.min(Math.floor(raw), GMAIL_LIVE_SEARCH_MAX_LIMIT);
}

function toHit(m: GmailMessageSummary, account: GmailRegistryAccount): GmailLiveSearchHit {
  return {
    messageId: m.id,
    threadId: m.threadId,
    connectedAccountId: account.connectedAccountId,
    accountEmail: account.email,
    from: m.from,
    subject: m.subject,
    date: epochMsToIso(m.messageTimestamp),
    snippet: m.snippet || undefined,
    labels: m.labelIds ?? [],
  };
}

/**
 * Search each enabled owner Gmail account (or only connectedAccountId), merge the hits newest
 * first, and cut them to limit. Throws GmailLiveSearchError for no query (400), no owner Gmail
 * account (404), or a failed search in each owner Gmail account (502).
 */
export async function searchOwnerGmailLive(
  projectRoot: string,
  opts: { query: string; limit?: number; connectedAccountId?: string; includeSpamTrash?: boolean },
  deps: GmailLiveSearchDeps = defaultDeps,
): Promise<GmailLiveSearchResult> {
  const query = opts.query.trim();
  if (!query) throw new GmailLiveSearchError("q (a Gmail search query) is required", 400);
  const limit = clampLiveSearchLimit(opts.limit);

  const all = await deps.listAccounts(projectRoot);
  const accounts = opts.connectedAccountId
    ? all.filter((a) => a.connectedAccountId === opts.connectedAccountId)
    : all.filter((a) => a.enabled);
  if (accounts.length === 0) {
    throw new GmailLiveSearchError(
      opts.connectedAccountId
        ? `No owner Gmail account with connectedAccountId ${opts.connectedAccountId}`
        : "No owner Gmail account is connected",
      404,
    );
  }

  const settled = await Promise.allSettled(
    accounts.map((account) =>
      deps.search(
        projectRoot,
        { connectedAccountId: account.connectedAccountId },
        { query, maxResults: limit, includeSpamTrash: opts.includeSpamTrash },
      ),
    ),
  );

  const report: GmailLiveSearchAccount[] = [];
  const hits: Array<GmailLiveSearchHit & { ts: number }> = [];
  settled.forEach((outcome, i) => {
    const account = accounts[i]!;
    if (outcome.status === "rejected") {
      const reason = outcome.reason;
      report.push({
        connectedAccountId: account.connectedAccountId,
        accountEmail: account.email,
        ok: false,
        error: reason instanceof Error ? reason.message : String(reason),
      });
      return;
    }
    report.push({
      connectedAccountId: account.connectedAccountId,
      accountEmail: account.email,
      ok: true,
      hits: outcome.value.length,
    });
    for (const m of outcome.value) hits.push({ ...toHit(m, account), ts: m.messageTimestamp ?? 0 });
  });

  if (report.every((a) => !a.ok)) {
    throw new GmailLiveSearchError("Live Gmail search failed for each owner Gmail account", 502, report);
  }

  hits.sort((a, b) => b.ts - a.ts);
  return {
    query,
    hits: hits.slice(0, limit).map(({ ts: _ts, ...hit }) => hit),
    accounts: report,
    incomplete: report.some((a) => !a.ok),
  };
}
