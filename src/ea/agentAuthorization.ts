/**
 * Deterministic "may the companion act on this mail?" — copied on thread or owner delegated.
 * Filing/observing is allowed without authorization; scheduling + outbound mail are not.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { readMirrorBodyPreview } from "../connectors/mirrorBodyPreview.js";
import { parseGmailThreadMirrorSections } from "../connectors/composio/gmailMirrorFormat.js";
import type { MailThreadFrontmatter } from "../connectors/mirror.js";
import { resolveJoshuAgentEmails, isFromJoshuAgent } from "./ingestFilters.js";
import { parseEmailAddress } from "./schedulingTypes.js";
import { readAgentProfile } from "../nylas/profile.js";
import type { TriageProvider } from "./triageTypes.js";

export type MailAgentAuthorization = {
  agent_authorized: boolean;
  scheduling_eligible: boolean;
  reason: string;
};

export type ResolveAgentAuthorizationInput = {
  provider: TriageProvider;
  from?: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  /** Body of the triggering message (for owner delegation on that send). */
  triggerBodyPreview?: string;
  /** Full thread text — scan owner sections for delegation. */
  threadBodyPreview?: string;
  projectRoot?: string;
  /** Synced mailbox owner (Gmail account email). */
  accountEmail?: string;
  /** When true, mail arrived on the agent Nylas inbox. */
  agentInbox?: boolean;
  /** LLM category — scheduling only eligible when authorized. */
  category?: string;
};

const DELEGATION_PATTERNS = [
  /\bcopying\s+patrick\b/i,
  /\bcopy(?:ing)?\s+(?:my\s+)?assistant\b/i,
  /\bloops?\s+in\s+patrick\b/i,
  /\bloops?\s+in\s+(?:my\s+)?assistant\b/i,
  /\bpatrick\s+(?:will|can)\s+(?:help|coordinate|schedule|find|suggest)\b/i,
  /\b(?:please\s+)?(?:have\s+)?patrick\s+(?:suggest|find|coordinate|schedule)\b/i,
];

function normalizeEmailList(values?: string[]): string[] {
  if (!values?.length) return [];
  const out = new Set<string>();
  for (const raw of values) {
    const addr = parseEmailAddress(raw);
    if (addr) out.add(addr);
  }
  return [...out];
}

function resolveOwnerEmails(projectRoot: string, accountEmail?: string): Set<string> {
  const emails = new Set<string>();
  const profile = readAgentProfile(projectRoot);
  for (const raw of [
    profile?.primaryWorkEmail,
    profile?.personalEmail,
    accountEmail,
    process.env.JOSHU_AROZ_USER?.trim(),
  ]) {
    const addr = raw?.trim().toLowerCase();
    if (addr?.includes("@")) emails.add(addr);
  }
  return emails;
}

function recipientIncludesAgent(recipients: string[], agentEmails: Set<string>): boolean {
  return recipients.some((r) => agentEmails.has(r));
}

function bodyIndicatesDelegation(body: string, assistantName?: string): boolean {
  const text = body.trim();
  if (!text) return false;
  if (DELEGATION_PATTERNS.some((re) => re.test(text))) return true;
  const name = assistantName?.trim();
  if (name && name.length > 2) {
    const re = new RegExp(`\\bcopying\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (re.test(text)) return true;
  }
  return false;
}

function ownerDelegatedInThread(threadBody: string, ownerEmails: Set<string>, assistantName?: string): boolean {
  if (!threadBody.trim()) return false;
  const sections = parseGmailThreadMirrorSections(threadBody);
  for (let i = sections.length - 1; i >= 0; i--) {
    const section = sections[i]!;
    const fromAddr = parseEmailAddress(section.from);
    if (!fromAddr || !ownerEmails.has(fromAddr)) continue;
    if (bodyIndicatesDelegation(section.body, assistantName)) return true;
  }
  return false;
}

/** Core authorization from headers + thread context. */
export function resolveAgentAuthorization(input: ResolveAgentAuthorizationInput): MailAgentAuthorization {
  const projectRoot = input.projectRoot ?? process.cwd();
  const agentEmails = resolveJoshuAgentEmails(projectRoot);
  const ownerEmails = resolveOwnerEmails(projectRoot, input.accountEmail);
  const profile = readAgentProfile(projectRoot);
  const to = normalizeEmailList(input.to);
  const cc = normalizeEmailList(input.cc);
  const bcc = normalizeEmailList(input.bcc);
  const allRecipients = [...to, ...cc, ...bcc];

  if (isFromJoshuAgent(input.from, projectRoot)) {
    return {
      agent_authorized: false,
      scheduling_eligible: false,
      reason: "agent_sent_message",
    };
  }

  if (input.agentInbox || input.provider === "nylas") {
    if (recipientIncludesAgent(allRecipients, agentEmails)) {
      return authorized("agent_on_recipients", input.category);
    }
  }

  if (recipientIncludesAgent(allRecipients, agentEmails)) {
    return authorized("agent_on_recipients", input.category);
  }

  const fromAddr = parseEmailAddress(input.from);
  if (fromAddr && ownerEmails.has(fromAddr) && bodyIndicatesDelegation(input.triggerBodyPreview ?? "", profile?.assistantName)) {
    return authorized("owner_delegated_trigger", input.category);
  }

  if (ownerDelegatedInThread(input.threadBodyPreview ?? "", ownerEmails, profile?.assistantName)) {
    return authorized("owner_delegated_thread", input.category);
  }

  return {
    agent_authorized: false,
    scheduling_eligible: false,
    reason: "not_copied_or_delegated",
  };
}

function authorized(reason: string, category?: string): MailAgentAuthorization {
  const scheduling = category === "scheduling";
  return {
    agent_authorized: true,
    scheduling_eligible: scheduling,
    reason,
  };
}

function stripMirrorFrontmatter(raw: string): { fm: MailThreadFrontmatter | null; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/u.exec(raw);
  if (!match) return { fm: null, body: raw };
  try {
    const fm = YAML.parse(match[1]!) as MailThreadFrontmatter;
    return { fm, body: match[2] ?? "" };
  } catch {
    return { fm: null, body: match[2] ?? "" };
  }
}

/** Recompute authorization from a mirrored thread file (API gates, outbound send). */
export async function resolveAuthorizationFromSourcePath(opts: {
  filesRoot: string;
  sourcePath: string;
  projectRoot?: string;
  category?: string;
}): Promise<MailAgentAuthorization | null> {
  const rel = opts.sourcePath.trim().replace(/^\/+/, "");
  if (!rel) return null;
  const full = path.join(opts.filesRoot, rel);
  let raw: string;
  try {
    raw = await readFile(full, "utf8");
  } catch {
    return null;
  }
  const { fm, body } = stripMirrorFrontmatter(raw);
  if (!fm) return null;
  const provider: TriageProvider = fm.source?.includes("nylas") ? "nylas" : "gmail";
  const threadPreview = body.trim().slice(0, 8000);
  return resolveAgentAuthorization({
    provider,
    from: fm.from,
    to: fm.to,
    cc: fm.cc,
    bcc: fm.bcc,
    triggerBodyPreview: threadPreview.slice(-2000),
    threadBodyPreview: threadPreview,
    projectRoot: opts.projectRoot,
    accountEmail: fm.account_email,
    agentInbox: provider === "nylas",
    category: opts.category,
  });
}

/** Outbound send: resolve from reply id and/or mirror path. */
export async function resolveOutboundMailAuthorization(opts: {
  filesRoot: string | null;
  projectRoot: string;
  replyToMessageId?: string;
  sourcePath?: string;
}): Promise<MailAgentAuthorization | null> {
  let pathAuth: MailAgentAuthorization | null = null;
  if (opts.sourcePath && opts.filesRoot) {
    pathAuth = await resolveAuthorizationFromSourcePath({
      filesRoot: opts.filesRoot,
      sourcePath: opts.sourcePath,
      projectRoot: opts.projectRoot,
    });
    if (pathAuth?.agent_authorized) return pathAuth;
  }

  let cachedAuth: MailAgentAuthorization | null = null;
  const messageId = opts.replyToMessageId?.trim();
  if (messageId && opts.filesRoot) {
    const { lookupMailIngestAuthorization } = await import("./mailDedup.js");
    cachedAuth = await lookupMailIngestAuthorization(opts.filesRoot, messageId);
    if (cachedAuth?.agent_authorized) return cachedAuth;
  }

  // Prefer live thread mirror over stale per-message ingest cache (e.g. Te'riel msg
  // cached unauthorized, later owner CC'd agent on same thread).
  return pathAuth ?? cachedAuth ?? null;
}

/** Scheduling API gate — cached ingest auth or recompute from mirror. */
export async function resolveSchedulingMailAuthorization(opts: {
  filesRoot: string;
  projectRoot: string;
  messageId: string;
  sourcePath: string;
}): Promise<MailAgentAuthorization | null> {
  const { lookupMailIngestAuthorization } = await import("./mailDedup.js");
  const cached = await lookupMailIngestAuthorization(opts.filesRoot, opts.messageId);
  if (cached) return cached;
  return resolveAuthorizationFromSourcePath({
    filesRoot: opts.filesRoot,
    sourcePath: opts.sourcePath,
    projectRoot: opts.projectRoot,
    category: "scheduling",
  });
}

/** Async wrapper when only source_path is known at classify time. */
export async function resolveAgentAuthorizationForMirror(opts: {
  filesRoot: string;
  sourcePath: string;
  provider: TriageProvider;
  from?: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  accountEmail?: string;
  category?: string;
  projectRoot?: string;
}): Promise<MailAgentAuthorization> {
  const threadBodyPreview = await readMirrorBodyPreview(opts.filesRoot, opts.sourcePath, 8000);
  return resolveAgentAuthorization({
    provider: opts.provider,
    from: opts.from,
    to: opts.to,
    cc: opts.cc,
    bcc: opts.bcc,
    triggerBodyPreview: threadBodyPreview.slice(-2000),
    threadBodyPreview: threadBodyPreview,
    accountEmail: opts.accountEmail,
    agentInbox: opts.provider === "nylas",
    category: opts.category,
    projectRoot: opts.projectRoot,
  });
}
