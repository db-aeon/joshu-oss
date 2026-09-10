/**
 * Owner visibility on external mail — auto-CC primary work email and thread visibility checks.
 * Owner is the boss: counterparty sends must not happen invisibly behind their back.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import type { MailThreadFrontmatter } from "../connectors/mirror.js";
import { parseGmailThreadMirrorSections } from "../connectors/composio/gmailMirrorFormat.js";
import type { MailRecipient } from "../nylas/recipients.js";
import { readAgentProfile } from "../nylas/profile.js";
import { parseEmailAddress } from "./schedulingTypes.js";
import { resolveJoshuAgentEmails, isFromJoshuAgent } from "./ingestFilters.js";

export type OwnerThreadVisibility = {
  ownerOnThread: boolean;
  reason: string;
  /** Latest non-agent message body snippet when owner was not on thread. */
  threadContextSnippet?: string;
};

/** Primary work email for owner visibility (not personal Gmail). */
export function resolvePrimaryOwnerEmail(projectRoot = process.cwd()): string | null {
  const profile = readAgentProfile(projectRoot);
  for (const raw of [
    profile?.primaryWorkEmail,
    process.env.JOSHU_OWNER_EMAIL?.trim(),
    process.env.JOSHU_AROZ_USER?.trim(),
  ]) {
    const addr = raw?.trim().toLowerCase();
    if (addr?.includes("@")) return addr;
  }
  return null;
}

function normalizeRecipientEmails(recipients?: MailRecipient[]): Set<string> {
  const out = new Set<string>();
  for (const r of recipients ?? []) {
    const addr = r.email?.trim().toLowerCase();
    if (addr) out.add(addr);
  }
  return out;
}

/** True when any recipient is neither the primary owner nor the agent mailbox. */
export function isExternalSend(
  to: MailRecipient[],
  cc: MailRecipient[] | undefined,
  bcc: MailRecipient[] | undefined,
  projectRoot: string,
): boolean {
  const owner = resolvePrimaryOwnerEmail(projectRoot);
  const agentEmails = resolveJoshuAgentEmails(projectRoot);
  const all = [
    ...normalizeRecipientEmails(to),
    ...normalizeRecipientEmails(cc),
    ...normalizeRecipientEmails(bcc),
  ];
  return all.some((addr) => {
    if (owner && addr === owner) return false;
    if (agentEmails.has(addr)) return false;
    return true;
  });
}

export type EnsureOwnerCcResult = {
  cc: MailRecipient[] | undefined;
  ownerCcAdded: boolean;
};

/** Append primary owner to CC on external sends when missing from to/cc/bcc. */
export function ensureOwnerCcOnExternalSend(opts: {
  to: MailRecipient[];
  cc: MailRecipient[] | undefined;
  bcc: MailRecipient[] | undefined;
  projectRoot: string;
}): EnsureOwnerCcResult {
  if (!isExternalSend(opts.to, opts.cc, opts.bcc, opts.projectRoot)) {
    return { cc: opts.cc, ownerCcAdded: false };
  }
  const owner = resolvePrimaryOwnerEmail(opts.projectRoot);
  if (!owner) return { cc: opts.cc, ownerCcAdded: false };

  const seen = new Set<string>([
    ...normalizeRecipientEmails(opts.to),
    ...normalizeRecipientEmails(opts.cc),
    ...normalizeRecipientEmails(opts.bcc),
  ]);
  if (seen.has(owner)) return { cc: opts.cc, ownerCcAdded: false };

  const cc = [...(opts.cc ?? []), { email: owner }];
  return { cc, ownerCcAdded: true };
}

function collectEmailsFromHeaderFields(values?: string[]): string[] {
  if (!values?.length) return [];
  return values
    .map((v) => parseEmailAddress(v))
    .filter((v): v is string => Boolean(v));
}

/** Scan mirror frontmatter + body for primary owner presence on the thread. */
export function ownerVisibleOnThreadMirror(
  fm: MailThreadFrontmatter,
  body: string,
  projectRoot: string,
): OwnerThreadVisibility {
  const owner = resolvePrimaryOwnerEmail(projectRoot);
  if (!owner) {
    return { ownerOnThread: false, reason: "primary_owner_email_unconfigured" };
  }

  const participants = new Set<string>([
    ...collectEmailsFromHeaderFields(fm.from ? [fm.from] : []),
    ...collectEmailsFromHeaderFields(fm.to),
    ...collectEmailsFromHeaderFields(fm.cc),
    ...collectEmailsFromHeaderFields(fm.bcc),
  ]);
  for (const meta of fm.thread_messages ?? []) {
    if (meta.from) {
      const addr = parseEmailAddress(meta.from);
      if (addr) participants.add(addr);
    }
  }

  if (participants.has(owner)) {
    return { ownerOnThread: true, reason: "owner_on_thread_headers" };
  }

  const sections = parseGmailThreadMirrorSections(body);
  for (const section of sections) {
    const fromAddr = parseEmailAddress(section.from);
    if (fromAddr === owner) {
      return { ownerOnThread: true, reason: "owner_in_thread_body" };
    }
  }

  let threadContextSnippet: string | undefined;
  for (let i = sections.length - 1; i >= 0; i--) {
    const section = sections[i]!;
    if (isFromJoshuAgent(section.from, projectRoot)) continue;
    const text = section.body.trim().replace(/\s+/g, " ");
    if (text) {
      threadContextSnippet = text.slice(0, 300);
      break;
    }
  }

  return {
    ownerOnThread: false,
    reason: "owner_not_on_prior_messages",
    threadContextSnippet,
  };
}

export function stripMailThreadMirror(raw: string): { fm: MailThreadFrontmatter | null; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/u.exec(raw);
  if (!match) return { fm: null, body: raw };
  try {
    const fm = YAML.parse(match[1]!) as MailThreadFrontmatter;
    return { fm, body: match[2] ?? "" };
  } catch {
    return { fm: null, body: match[2] ?? "" };
  }
}

/** Load thread mirror and compute owner visibility for send path / ingress. */
export async function resolveOwnerThreadVisibilityFromSourcePath(opts: {
  filesRoot: string;
  sourcePath: string;
  projectRoot?: string;
}): Promise<OwnerThreadVisibility | null> {
  const rel = opts.sourcePath.trim().replace(/^\/+/, "");
  if (!rel) return null;
  const full = path.join(opts.filesRoot, rel);
  let raw: string;
  try {
    raw = await readFile(full, "utf8");
  } catch {
    return null;
  }
  const { fm, body } = stripMailThreadMirror(raw);
  if (!fm) return null;
  return ownerVisibleOnThreadMirror(fm, body, opts.projectRoot ?? process.cwd());
}
