import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { htmlToPlainText } from "../connectors/emailPlaintext.js";
import { buildThreadBodyPreview } from "../connectors/mirrorBodyPreview.js";
import { listGmailRegistryAccounts } from "../connectors/composio/gmailAccounts.js";
import {
  googleCalendarRootDir,
  mailThreadsDir,
  resolveConnectorPaths,
} from "../connectors/paths.js";
import type { Day0ExtractResult, Day0ThreadRow } from "./types.js";
import { countNoiseThreads, selectSignalThreads } from "./noiseMail.js";

const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;
const EMAIL_RE = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;

function parseEmailAddress(raw?: string): { address: string; displayName?: string } | null {
  if (!raw?.trim()) return null;
  const m = /<?([^<>\s]+@[^>\s]+)>?/.exec(raw);
  const address = (m?.[1] ?? raw).trim().toLowerCase();
  if (!address.includes("@")) return null;
  const displayName = raw.replace(/<[^>]+>/, "").replace(/"/g, "").trim();
  return {
    address,
    displayName: displayName && !displayName.includes("@") ? displayName : undefined,
  };
}

function truncateSnippet(text: string, max = 400): string {
  const preview = buildThreadBodyPreview(text, max);
  const plain = htmlToPlainText(preview).replace(/\s+/g, " ").trim();
  if (plain.length <= max) return plain;
  return `${plain.slice(0, max)}…`;
}

async function parseThreadFile(
  absolutePath: string,
  accountEmail?: string,
): Promise<Day0ThreadRow | null> {
  const raw = await readFile(absolutePath, "utf8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/m.exec(raw);
  if (!match?.[1]) return null;
  const fm = (YAML.parse(match[1]) as Record<string, unknown>) ?? {};
  const body = match[2]?.trim() ?? "";
  const threadId =
    typeof fm.thread_id === "string"
      ? fm.thread_id
      : path.basename(absolutePath, ".md");
  const date = typeof fm.date === "string" ? fm.date : undefined;
  const dateEpoch = date ? Math.floor(Date.parse(date) / 1000) : undefined;

  return {
    threadId,
    subject: typeof fm.subject === "string" ? fm.subject : undefined,
    from: typeof fm.from === "string" ? fm.from : undefined,
    to: Array.isArray(fm.to) ? fm.to.filter((t): t is string => typeof t === "string") : undefined,
    date,
    dateEpoch: Number.isFinite(dateEpoch) ? dateEpoch : undefined,
    accountEmail:
      typeof fm.account_email === "string"
        ? fm.account_email
        : accountEmail,
    bodySnippet: truncateSnippet(body),
    messageCount:
      typeof fm.message_count === "number" ? fm.message_count : 1,
    labels: Array.isArray(fm.labels)
      ? fm.labels.filter((l): l is string => typeof l === "string")
      : undefined,
  };
}

async function listThreadsForAccount(
  filesRoot: string,
  accountKey: string,
  accountEmail?: string,
  sinceEpoch?: number,
): Promise<Day0ThreadRow[]> {
  const threadsDir = mailThreadsDir("gmail", filesRoot, accountKey);
  let entries: string[];
  try {
    entries = await readdir(threadsDir);
  } catch {
    return [];
  }

  const rows: Day0ThreadRow[] = [];
  for (const name of entries) {
    if (!name.endsWith(".md")) continue;
    const row = await parseThreadFile(path.join(threadsDir, name), accountEmail);
    if (!row) continue;
    if (sinceEpoch && row.dateEpoch && row.dateEpoch < sinceEpoch) continue;
    rows.push(row);
  }
  rows.sort((a, b) => (b.dateEpoch ?? 0) - (a.dateEpoch ?? 0));
  return rows;
}

async function listCalendarEvents(filesRoot: string, sinceEpoch?: number) {
  const eventsRoot = googleCalendarRootDir(filesRoot);
  let entries: string[];
  try {
    entries = await readdir(eventsRoot, { recursive: true }) as string[];
  } catch {
    return [];
  }

  const events: Day0ExtractResult["events"] = [];
  for (const name of entries) {
    if (!name.endsWith(".md")) continue;
    const raw = await readFile(path.join(eventsRoot, name), "utf8");
    const match = /^---\r?\n([\s\S]*?)\r?\n---/m.exec(raw);
    if (!match?.[1]) continue;
    const fm = (YAML.parse(match[1]) as Record<string, unknown>) ?? {};
    const start = typeof fm.start === "string" ? fm.start : undefined;
    if (sinceEpoch && start) {
      const ms = Date.parse(start);
      if (Number.isFinite(ms) && ms / 1000 < sinceEpoch) continue;
    }
    events.push({
      title: typeof fm.title === "string" ? fm.title : undefined,
      start,
      end: typeof fm.end === "string" ? fm.end : undefined,
      location: typeof fm.location === "string" ? fm.location : undefined,
    });
  }
  return events;
}

const PERSONAL_MAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "hotmail.com",
  "outlook.com",
  "live.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "proton.me",
  "protonmail.com",
  "aol.com",
]);

function isPersonalMailbox(email: string): boolean {
  const domain = email.split("@")[1]?.toLowerCase();
  return Boolean(domain && PERSONAL_MAIL_DOMAINS.has(domain));
}

/** Guess work vs personal when multiple Gmail accounts are connected. */
export function inferMailboxRoles(
  accounts: Array<{ email?: string; isDefault?: boolean }>,
): { primaryWorkEmail?: string; personalEmail?: string } {
  const emails = accounts
    .map((a) => a.email?.trim().toLowerCase())
    .filter((e): e is string => Boolean(e));
  if (emails.length === 0) return {};
  if (emails.length === 1) {
    const only = emails[0]!;
    return isPersonalMailbox(only)
      ? { personalEmail: only }
      : { primaryWorkEmail: only };
  }

  const work = emails.filter((e) => !isPersonalMailbox(e));
  const personal = emails.filter((e) => isPersonalMailbox(e));
  const defaultEmail = (
    accounts.find((a) => a.isDefault)?.email ?? accounts[0]?.email
  )
    ?.trim()
    .toLowerCase();

  let primaryWorkEmail = work[0];
  if (!primaryWorkEmail && defaultEmail && !isPersonalMailbox(defaultEmail)) {
    primaryWorkEmail = defaultEmail;
  }
  if (!primaryWorkEmail) {
    primaryWorkEmail = emails.find((e) => e !== personal[0]);
  }

  let personalEmail = personal[0];
  if (!personalEmail) {
    personalEmail = emails.find((e) => e !== primaryWorkEmail);
  }

  return { primaryWorkEmail, personalEmail };
}

function buildCorrespondentStats(
  threads: Day0ThreadRow[],
  selfEmails: Set<string>,
): Day0ExtractResult["topCorrespondents"] {
  const counts = new Map<string, { count: number; displayName?: string }>();

  for (const t of threads) {
    const add = (raw?: string) => {
      const parsed = parseEmailAddress(raw);
      if (!parsed || selfEmails.has(parsed.address)) return;
      const prev = counts.get(parsed.address) ?? { count: 0, displayName: parsed.displayName };
      prev.count += 1;
      if (parsed.displayName && !prev.displayName) prev.displayName = parsed.displayName;
      counts.set(parsed.address, prev);
    };
    add(t.from);
    for (const to of t.to ?? []) add(to);
  }

  return [...counts.entries()]
    .map(([address, v]) => ({ address, count: v.count, displayName: v.displayName }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 40);
}

function extractUrls(threads: Day0ThreadRow[]): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const t of threads) {
    const hay = `${t.subject ?? ""} ${t.bodySnippet}`;
    for (const m of hay.matchAll(URL_RE)) {
      const u = m[0].replace(/[.,;:!?)]+$/, "");
      if (!seen.has(u)) {
        seen.add(u);
        urls.push(u);
      }
    }
  }
  return urls.slice(0, 100);
}

function buildSendHistogram(threads: Day0ThreadRow[]): number[] {
  const hist = new Array(24).fill(0) as number[];
  for (const t of threads) {
    if (!t.dateEpoch) continue;
    const h = new Date(t.dateEpoch * 1000).getUTCHours();
    hist[h] = (hist[h] ?? 0) + 1;
  }
  return hist;
}

/** Infer working hours from send histogram + calendar event starts. */
function inferWorkingHoursHint(
  hist: number[],
  events: Day0ExtractResult["events"],
): Day0ExtractResult["workingHoursHint"] {
  const activeHours = hist
    .map((c, h) => ({ h, c }))
    .filter((x) => x.c > 0)
    .sort((a, b) => b.c - a.c);

  let startH = 9;
  let endH = 17;
  if (activeHours.length >= 3) {
    const hours = activeHours.map((x) => x.h).sort((a, b) => a - b);
    startH = Math.min(...hours.slice(0, 3));
    endH = Math.max(...hours.slice(0, 5)) + 1;
    if (endH <= startH) endH = Math.min(startH + 8, 23);
  }

  const eventHours = events
    .map((e) => (e.start ? new Date(e.start).getUTCHours() : null))
    .filter((h): h is number => h != null);
  if (eventHours.length >= 5) {
    eventHours.sort((a, b) => a - b);
    startH = Math.min(startH, eventHours[Math.floor(eventHours.length * 0.1)] ?? startH);
    endH = Math.max(endH, (eventHours[Math.floor(eventHours.length * 0.9)] ?? endH) + 1);
  }

  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    start: `${pad(startH)}:00`,
    end: `${pad(Math.min(endH, 23))}:00`,
  };
}

export async function extractDay0Signals(
  projectRoot: string,
  opts: { connectedAccountId?: string; sinceEpoch?: number } = {},
): Promise<Day0ExtractResult> {
  const paths = resolveConnectorPaths(projectRoot);
  if (!paths) {
    return { threads: [], topCorrespondents: [], urls: [], sendHourHistogram: [], events: [] };
  }

  const accounts = await listGmailRegistryAccounts(projectRoot);
  const scoped = opts.connectedAccountId
    ? accounts.filter((a) => a.connectedAccountId === opts.connectedAccountId)
    : accounts.filter((a) => a.enabled !== false);

  const accountEmails: string[] = [];
  const accountThreadCounts: Record<string, number> = {};
  const allThreads: Day0ThreadRow[] = [];

  for (const acct of scoped) {
    if (acct.email) accountEmails.push(acct.email);
    const rows = await listThreadsForAccount(
      paths.filesRoot,
      acct.accountKey,
      acct.email,
      opts.sinceEpoch,
    );
    const countKey = acct.email ?? acct.accountKey;
    accountThreadCounts[countKey] = rows.length;
    allThreads.push(...rows);
  }

  allThreads.sort((a, b) => (b.dateEpoch ?? 0) - (a.dateEpoch ?? 0));

  const defaultAcct = scoped.find((a) => a.isDefault) ?? scoped[0];
  const selfEmails = new Set(accountEmails.map((e) => e.toLowerCase()));
  const signalThreads = selectSignalThreads(allThreads);
  const noiseThreadCount = countNoiseThreads(allThreads);
  const events = await listCalendarEvents(paths.filesRoot, opts.sinceEpoch);
  const sendHourHistogram = buildSendHistogram(signalThreads.length ? signalThreads : allThreads);
  const emailRoles = inferMailboxRoles(scoped);

  return {
    accountEmail: defaultAcct?.email ?? accountEmails[0],
    accountEmails,
    accountThreadCounts,
    emailRoles,
    threads: allThreads,
    signalThreads,
    noiseThreadCount,
    topCorrespondents: buildCorrespondentStats(
      signalThreads.length ? signalThreads : allThreads,
      selfEmails,
    ),
    urls: extractUrls(signalThreads.length ? signalThreads : allThreads),
    sendHourHistogram,
    events,
    workingHoursHint: inferWorkingHoursHint(sendHourHistogram, events),
  };
}

/** Collect unique email domains from threads (for tool/channel hints). */
export function collectEmailDomains(threads: Day0ThreadRow[]): string[] {
  const domains = new Set<string>();
  for (const t of threads) {
    for (const m of `${t.from ?? ""} ${(t.to ?? []).join(" ")}`.matchAll(EMAIL_RE)) {
      const domain = m[1]?.split("@")[1]?.toLowerCase();
      if (domain) domains.add(domain);
    }
  }
  return [...domains].slice(0, 30);
}
