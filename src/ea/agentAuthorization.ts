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
};

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

function ownerDelegatedInThread(threadBody: string, ownerEmails: Set<string>, assistantNames: string[]): boolean {
  if (!threadBody.trim()) return false;
  const sections = parseGmailThreadMirrorSections(threadBody);
  for (let i = sections.length - 1; i >= 0; i--) {
    const section = sections[i]!;
    const fromAddr = parseEmailAddress(section.from);
    if (!fromAddr || !ownerEmails.has(fromAddr)) continue;
    if (bodyIndicatesDelegation(section.body, assistantNames)) return true;
  }
  return false;
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

  if (input.agentInbox || input.provider === "nylas") {
    if (recipientIncludesAgent(allRecipients, agentEmails)) {
      return authorized("agent_on_recipients", input.category);
    }
  }

  if (recipientIncludesAgent(allRecipients, agentEmails)) {
    return authorized("agent_on_recipients", input.category);
  }

  const fromAddr = parseEmailAddress(input.from);
  if (fromAddr && ownerEmails.has(fromAddr) && bodyIndicatesDelegation(input.triggerBodyPreview ?? "", assistantNames)) {
    return authorized("owner_delegated_trigger", input.category);
  }

  if (ownerDelegatedInThread(input.threadBodyPreview ?? "", ownerEmails, assistantNames)) {
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

/** Recompute authorization from a mirrored thread file (API gates, outbound send). */
export async function resolveAuthorizationFromSourcePath(opts: {
  filesRoot: string;
  sourcePath: string;
  projectRoot?: string;
  category?: string;
  /**
   * Outbound send path: if the mirror tip is our own prior message, do not hard-fail
   * with `agent_sent_message` (that rule is for ingest loop prevention). Re-evaluate
   * against the prior non-agent message + thread body; if still ambiguous, treat a
   * prior agent send on the thread as proof we were already authorized.
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
  const { fm, body } = stripMirrorFrontmatter(raw);
  if (!fm) return null;
  const projectRoot = opts.projectRoot ?? process.cwd();
  const provider: TriageProvider = fm.source?.includes("nylas") ? "nylas" : "gmail";
  const threadPreview = body.trim().slice(0, 8000);
  const tipIsAgent = isFromJoshuAgent(fm.from, projectRoot);

  // Outbound follow-up on a thread where we already sent: skip the ingest-only
  // "agent_sent_message" short-circuit and evaluate prior context instead.
  if (opts.forOutbound && tipIsAgent) {
    const priorFrom = latestNonAgentFrom(fm, projectRoot);
    const auth = resolveAgentAuthorization({
      provider,
      from: priorFrom ?? fm.from,
      to: fm.to,
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
    });
    if (auth.agent_authorized) return auth;
    // We already mailed on this thread (passed this gate + owner approval once).
    return authorized("prior_agent_send_on_thread", opts.category);
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
    projectRoot: opts.projectRoot,
  });

  let owner_on_thread: boolean | undefined;
  try {
    const rel = opts.sourcePath.trim().replace(/^\/+/, "");
    if (rel) {
      const full = path.join(opts.filesRoot, rel);
      const raw = await readFile(full, "utf8");
      const { fm, body } = stripMailThreadMirror(raw);
      if (fm) {
        owner_on_thread = ownerVisibleOnThreadMirror(
          fm,
          body,
          opts.projectRoot ?? process.cwd(),
        ).ownerOnThread;
      }
    }
  } catch {
    /* visibility scan is best-effort at ingress */
  }

  return owner_on_thread !== undefined ? { ...auth, owner_on_thread } : auth;
}
