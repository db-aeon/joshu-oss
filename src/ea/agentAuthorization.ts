/**
 * Deterministic "may the companion act on this mail?". Filing is allowed without
 * authorization; scheduling and outbound mail are not. Being a recipient is not enough on
 * its own: the owner must have written in the thread (or sent the email), the owner must have
 * delegated the thread, or the outsider send record must prove that the companion already
 * wrote to an outsider on the thread. Otherwise an outsider could make the companion act.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { readMirrorBodyPreview } from "../connectors/mirrorBodyPreview.js";
import { parseGmailThreadMirrorSections } from "../connectors/composio/gmailMirrorFormat.js";
import type { MailThreadFrontmatter } from "../connectors/mirror.js";
import {
  companionWroteToOutsider,
  readOutsiderSendRecord,
  type MailThreadFacts,
  type OutsiderSendRecord,
} from "./outsiderSendRecord.js";
import { resolveJoshuAgentEmails, isFromJoshuAgent } from "./ingestFilters.js";
import { parseEmailAddress } from "./schedulingTypes.js";
import { readAgentProfile } from "../nylas/profile.js";
import { ownerVisibleOnThreadMirror, stripMailThreadMirror } from "./ownerMailVisibility.js";
import type { TriageProvider } from "./triageTypes.js";

export type MailAgentAuthorization = {
  agent_authorized: boolean;
  scheduling_eligible: boolean;
  reason: string;
  /** True when primary owner email appears on prior thread messages (mirror scan). */
  owner_on_thread?: boolean;
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
  /**
   * Outbound-only: skip the ingest loop-prevention rule that rejects mail
   * `from` the agent. Used when re-evaluating a thread whose tip is our send.
   */
  skipAgentSentGuard?: boolean;
  /** Joshu metadata of the mail mirror (thread id, subject, `thread_messages`). */
  thread?: MailThreadFacts;
  /** Outsider send record of the box; without it, no earlier send of the companion counts. */
  outsiderSends?: OutsiderSendRecord;
};

/** Reason when an outsider copied or emailed the companion and the owner has not agreed yet. */
export const OUTSIDER_NEEDS_OWNER_OK = "outsider_needs_owner_ok";

const ASSISTANT_DELEGATION_PATTERNS = [
  /\bcopy(?:ing)?\s+(?:my\s+)?assistant\b/i,
  /\bloops?\s+in\s+(?:my\s+)?assistant\b/i,
  /\b(?:my\s+)?assistant\s+(?:will|can|could)\s+(?:help|coordinate|schedule|find|suggest|book|arrange|set\s+up)\b/i,
];

const SCHEDULING_INTENT = /\b(?:schedul\w*|find\s+(?:a\s+)?times?|(?:suggest|share|send)\s+(?:some\s+)?(?:times|availability|windows)|availability|calendar|book\w*|set\s+(?:it\s+|this\s+)?up|coordinate|meet(?:ing)?)\b/i;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Names the owner may use for the companion: profile name + agent mailbox local parts (ava@joshu.me → ava). */
export function resolveAssistantNames(projectRoot: string): string[] {
  const names = new Set<string>();
  const profileName = readAgentProfile(projectRoot)?.assistantName?.trim();
  if (profileName) names.add(profileName.toLowerCase());
  for (const email of resolveJoshuAgentEmails(projectRoot)) {
    const local = email.split("@")[0]?.trim();
    if (local && /^[a-z][a-z'-]+$/i.test(local)) names.add(local.toLowerCase());
  }
  return [...names].filter((n) => n.length > 2);
}

function namedDelegationPatterns(name: string): RegExp[] {
  const n = escapeRegExp(name);
  return [
    new RegExp(`\\b(?:copying|cc'?ing|cc)\\s+${n}\\b`, "i"),
    new RegExp(`\\bloop(?:s|ing)?\\s+in\\s+${n}\\b`, "i"),
    new RegExp(`\\b${n}\\s+(?:will|can|could|is\\s+going\\s+to)\\s+(?:help|coordinate|schedule|find|suggest|book|arrange|set\\s+up|reach\\s+out)\\b`, "i"),
    new RegExp(`\\b(?:please\\s+)?(?:have\\s+)?${n}\\s+(?:suggest|find|coordinate|schedule|book|arrange|set\\s+up)\\b`, "i"),
  ];
}

function normalizeEmailList(values?: string[]): string[] {
  if (!values?.length) return [];
  const out = new Set<string>();
  for (const raw of values) {
    const addr = parseEmailAddress(raw);
    if (addr) out.add(addr);
  }
  return [...out];
}

/** Owner addresses used for authorization and owner-reply eligibility. */
export function resolveOwnerEmails(projectRoot: string, accountEmail?: string): Set<string> {
  const emails = new Set<string>();
  const profile = readAgentProfile(projectRoot);
  for (const raw of [
    profile?.primaryWorkEmail,
    profile?.personalEmail,
    accountEmail,
    process.env.JOSHU_OWNER_EMAIL?.trim(),
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

/** Owner hands the thread to the companion ("Copying Clara", "Clara can help schedule"). */
export function bodyIndicatesDelegation(body: string, assistantNames: string[]): boolean {
  const text = body.trim();
  if (!text) return false;
  if (ASSISTANT_DELEGATION_PATTERNS.some((re) => re.test(text))) return true;
  return assistantNames.some((name) => namedDelegationPatterns(name).some((re) => re.test(text)));
}

/** Delegation whose ask is about finding/booking a time — routes owner reply-alls to scheduling. */
export function bodyIndicatesSchedulingDelegation(body: string, assistantNames: string[]): boolean {
  return bodyIndicatesDelegation(body, assistantNames) && SCHEDULING_INTENT.test(body);
}

/** True when Joshu metadata (`thread_messages`, written from mail headers) holds a message of the owner. */
function ownerWroteInThread(thread: MailThreadFacts | undefined, ownerEmails: Set<string>): boolean {
  return (thread?.messages ?? []).some((m) => {
    const addr = parseEmailAddress(m.from);
    return Boolean(addr && ownerEmails.has(addr));
  });
}

/**
 * Owner delegation in an earlier owner message. The body sections of a mail mirror are only
 * text, so an outsider can type a fake owner section into an email; count a section only
 * when Joshu metadata shows a real message from that owner address in the thread.
 */
function ownerDelegatedInThread(
  threadBody: string,
  ownerEmails: Set<string>,
  assistantNames: string[],
  thread: MailThreadFacts | undefined,
): boolean {
  if (!threadBody.trim()) return false;
  const ownerSenders = new Set(
    (thread?.messages ?? [])
      .map((m) => parseEmailAddress(m.from))
      .filter((addr): addr is string => Boolean(addr && ownerEmails.has(addr))),
  );
  if (ownerSenders.size === 0) return false;
  const sections = parseGmailThreadMirrorSections(threadBody);
  for (let i = sections.length - 1; i >= 0; i--) {
    const section = sections[i]!;
    const fromAddr = parseEmailAddress(section.from);
    if (!fromAddr || !ownerSenders.has(fromAddr)) continue;
    if (bodyIndicatesDelegation(section.body, assistantNames)) return true;
  }
  return false;
}

/** True when the outsider send record proves an earlier send of the companion to an outsider. */
function companionAlreadyWroteToOutsider(
  input: ResolveAgentAuthorizationInput,
  projectRoot: string,
): boolean {
  if (!input.outsiderSends || !input.thread) return false;
  return companionWroteToOutsider({
    record: input.outsiderSends,
    thread: input.thread,
    triggerFrom: input.from,
    isCompanion: (from) => isFromJoshuAgent(from, projectRoot),
  });
}

/** Core authorization from headers + thread context. */
export function resolveAgentAuthorization(input: ResolveAgentAuthorizationInput): MailAgentAuthorization {
  const projectRoot = input.projectRoot ?? process.cwd();
  const agentEmails = resolveJoshuAgentEmails(projectRoot);
  const ownerEmails = resolveOwnerEmails(projectRoot, input.accountEmail);
  const assistantNames = resolveAssistantNames(projectRoot);
  const to = normalizeEmailList(input.to);
  const cc = normalizeEmailList(input.cc);
  const bcc = normalizeEmailList(input.bcc);
  const allRecipients = [...to, ...cc, ...bcc];

  // Ingest loop prevention: do not triage/act on mail the agent itself sent.
  // Outbound follow-ups set skipAgentSentGuard when the mirror tip is our send.
  if (!input.skipAgentSentGuard && isFromJoshuAgent(input.from, projectRoot)) {
    return {
      agent_authorized: false,
      scheduling_eligible: false,
      reason: "agent_sent_message",
    };
  }

  const fromAddr = parseEmailAddress(input.from);
  const ownerSent = Boolean(fromAddr && ownerEmails.has(fromAddr));
  const companionIsRecipient = recipientIncludesAgent(allRecipients, agentEmails);

  if (companionIsRecipient) {
    if (ownerSent) return authorized("owner_sent_to_companion", input.category);
    if (ownerWroteInThread(input.thread, ownerEmails)) {
      return authorized("owner_wrote_in_thread", input.category);
    }
    if (companionAlreadyWroteToOutsider(input, projectRoot)) {
      return authorized("companion_wrote_to_outsider", input.category);
    }
  }

  if (ownerSent && bodyIndicatesDelegation(input.triggerBodyPreview ?? "", assistantNames)) {
    return authorized("owner_delegated_trigger", input.category);
  }

  if (ownerDelegatedInThread(input.threadBodyPreview ?? "", ownerEmails, assistantNames, input.thread)) {
    return authorized("owner_delegated_thread", input.category);
  }

  return {
    agent_authorized: false,
    scheduling_eligible: false,
    reason: companionIsRecipient ? OUTSIDER_NEEDS_OWNER_OK : "not_copied_or_delegated",
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

/**
 * Most recent non-agent `from` on the thread, if the mirror tip is our own send.
 * Used only for outbound follow-ups (ingest still uses the tip as-is).
 */
function latestNonAgentFrom(
  fm: MailThreadFrontmatter,
  projectRoot: string,
): string | undefined {
  const metas = Array.isArray(fm.thread_messages) ? fm.thread_messages : [];
  for (let i = metas.length - 1; i >= 0; i--) {
    const from = metas[i]?.from?.trim();
    if (from && !isFromJoshuAgent(from, projectRoot)) return from;
  }
  return undefined;
}

/** Front matter of a mail mirror under the files root, or null when it cannot be read. */
export async function readMailMirrorFrontmatter(
  filesRoot: string,
  sourcePath: string,
): Promise<MailThreadFrontmatter | null> {
  const rel = sourcePath.trim().replace(/^\/+/, "");
  if (!rel) return null;
  try {
    return stripMailThreadMirror(await readFile(path.join(filesRoot, rel), "utf8")).fm;
  } catch {
    return null;
  }
}

/** Joshu metadata of a mail mirror that the authorization rule reads. */
export function mailThreadFacts(fm: MailThreadFrontmatter): MailThreadFacts {
  return {
    threadId: fm.thread_id,
    subject: fm.subject,
    messages: Array.isArray(fm.thread_messages) ? fm.thread_messages : [],
  };
}

/** Recompute authorization from a mirrored thread file (API gates, outbound send). */
export async function resolveAuthorizationFromSourcePath(opts: {
  filesRoot: string;
  sourcePath: string;
  projectRoot?: string;
  category?: string;
  /**
   * Outbound send path: if the mirror tip is our own prior message, do not hard-fail
   * with `agent_sent_message` (that rule is for ingest loop prevention). Re-evaluate
   * against the prior non-agent message + thread body. The companion wrote the tip, so it
   * counts as on the thread; the rule still needs the owner or the outsider send record.
   */
  forOutbound?: boolean;
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
  const { fm, body } = stripMailThreadMirror(raw);
  if (!fm) return null;
  const projectRoot = opts.projectRoot ?? process.cwd();
  const provider: TriageProvider = fm.source?.includes("nylas") ? "nylas" : "gmail";
  const threadPreview = body.trim().slice(0, 8000);
  const tipIsAgent = isFromJoshuAgent(fm.from, projectRoot);
  const thread = mailThreadFacts(fm);
  const outsiderSends = readOutsiderSendRecord(opts.filesRoot);

  // Outbound follow-up on a thread where we already sent: skip the ingest-only
  // "agent_sent_message" short-circuit and evaluate prior context instead.
  if (opts.forOutbound && tipIsAgent) {
    const priorFrom = latestNonAgentFrom(fm, projectRoot);
    return resolveAgentAuthorization({
      provider,
      from: priorFrom ?? fm.from,
      // The tip is a message of the companion, so the companion is on this thread.
      to: [...(fm.to ?? []), ...resolveJoshuAgentEmails(projectRoot)],
      cc: fm.cc,
      bcc: fm.bcc,
      triggerBodyPreview: threadPreview.slice(-2000),
      threadBodyPreview: threadPreview,
      projectRoot,
      accountEmail: fm.account_email,
      agentInbox: provider === "nylas",
      category: opts.category,
      // Force-skip agent_sent when priorFrom is missing (still tip=agent).
      skipAgentSentGuard: !priorFrom,
      thread,
      outsiderSends,
    });
  }

  return resolveAgentAuthorization({
    provider,
    from: fm.from,
    to: fm.to,
    cc: fm.cc,
    bcc: fm.bcc,
    triggerBodyPreview: threadPreview.slice(-2000),
    threadBodyPreview: threadPreview,
    projectRoot,
    accountEmail: fm.account_email,
    agentInbox: provider === "nylas",
    category: opts.category,
    thread,
    outsiderSends,
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
      forOutbound: true,
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

  // Mirror missing (e.g. Nylas sync failed): authorize replies from live parent message.
  if (messageId) {
    try {
      const { readAgentGrant } = await import("../nylas/store.js");
      const { getMessage } = await import("../nylas/client.js");
      const agent = readAgentGrant(opts.projectRoot);
      if (agent) {
        const parent = await getMessage(agent.grantId, messageId);
        const liveAuth = resolveAgentAuthorization({
          provider: "nylas",
          from: parent.from,
          to: parent.to,
          cc: parent.cc,
          triggerBodyPreview: (parent.body ?? parent.snippet ?? "").slice(0, 2000),
          projectRoot: opts.projectRoot,
          agentInbox: true,
        });
        if (liveAuth.agent_authorized) return liveAuth;
      }
    } catch (err) {
      console.warn(
        `[ea-auth] live parent lookup for reply ${messageId}: ${(err as Error).message}`,
      );
    }
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
  const projectRoot = opts.projectRoot ?? process.cwd();

  let fm: MailThreadFrontmatter | null = null;
  let body = "";
  try {
    const rel = opts.sourcePath.trim().replace(/^\/+/, "");
    if (rel) ({ fm, body } = stripMailThreadMirror(await readFile(path.join(opts.filesRoot, rel), "utf8")));
  } catch {
    /* a missing mirror leaves only the header facts */
  }

  const auth = resolveAgentAuthorization({
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
    projectRoot,
    ...(fm ? { thread: mailThreadFacts(fm), outsiderSends: readOutsiderSendRecord(opts.filesRoot) } : {}),
  });

  let owner_on_thread: boolean | undefined;
  try {
    if (fm) owner_on_thread = ownerVisibleOnThreadMirror(fm, body, projectRoot).ownerOnThread;
  } catch {
    /* visibility scan is best-effort at ingress */
  }

  return owner_on_thread !== undefined ? { ...auth, owner_on_thread } : auth;
}
