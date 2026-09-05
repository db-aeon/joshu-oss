/**
 * Deterministic gate: owner mailed the agent Nylas inbox with a non-meeting ask.
 * Ingress files, then path D spawns ea-owner-reply. No second LLM.
 */
import { resolveJoshuAgentEmails } from "./ingestFilters.js";
import { resolveOwnerEmails } from "./agentAuthorization.js";
import { parseEmailAddress } from "./schedulingTypes.js";

export type OwnerReplyEligibilityInput = {
  provider?: string;
  /** True when mail arrived on the agent Nylas inbox. */
  agentInbox?: boolean;
  from?: string;
  ownerEmails: Iterable<string>;
  /** Classifier disposition; ingest only queues track. */
  disposition?: string;
  category?: string;
  /**
   * True when ingest will take scheduling path A (meeting worker owns outbound).
   * `buildMailIngressTaskBody` passes false so owner→agent Nylas asks win Path D
   * even if the classifier tagged scheduling.
   */
  schedulingPathA?: boolean;
  to?: string[];
  cc?: string[];
  projectRoot?: string;
  /** Override agent mailbox set (tests / API). */
  agentEmails?: Iterable<string>;
};

export type OwnerReplyEligibility = {
  eligible: boolean;
  reason: string;
};

function normalizeOwnerSet(ownerEmails: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const raw of ownerEmails) {
    const addr = parseEmailAddress(raw) ?? raw.trim().toLowerCase();
    if (addr?.includes("@")) out.add(addr);
  }
  return out;
}

/** Pure eligibility — unit-test without profile or Kanban. */
export function isOwnerReplyEligible(input: OwnerReplyEligibilityInput): OwnerReplyEligibility {
  const provider = (input.provider ?? "").trim().toLowerCase();
  const agentInbox = input.agentInbox === true || provider === "nylas";
  if (!agentInbox) {
    return { eligible: false, reason: "not_agent_inbox" };
  }

  const fromAddr = parseEmailAddress(input.from);
  const owners = normalizeOwnerSet(input.ownerEmails);
  if (!fromAddr || !owners.has(fromAddr)) {
    return { eligible: false, reason: "not_from_owner" };
  }

  const disposition = (input.disposition ?? "track").trim().toLowerCase();
  if (disposition === "info" || disposition === "noise") {
    return { eligible: false, reason: "disposition_not_track" };
  }

  if (input.schedulingPathA === true) {
    return { eligible: false, reason: "scheduling_path_a" };
  }

  const category = (input.category ?? "").trim().toLowerCase();
  // owner_sent_update should not reach here after biasOwnerAgentInboxClassification;
  // block only if classifier still tagged it without a substantive override.
  if (category === "owner_sent_update") {
    return { eligible: false, reason: "owner_sent_update" };
  }

  // Path D requires a direct owner→agent ask (agent in To, no external counterparty in To).
  // Owner→counterparty with agent CC'd is path A scheduling — not owner-reply.
  if (!isOwnerDirectAgentAsk({
    from: input.from,
    to: input.to,
    cc: input.cc,
    projectRoot: input.projectRoot,
    agentEmails: input.agentEmails,
    ownerEmails: input.ownerEmails,
    provider: input.provider,
  })) {
    return { eligible: false, reason: "counterparty_thread" };
  }

  return { eligible: true, reason: "owner_ask_agent" };
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

/**
 * True when the owner addressed the agent directly (agent in To, no external in To).
 * False when owner emailed a counterparty and CC'd the agent (delegation / path A).
 */
export function isOwnerDirectAgentAsk(input: {
  from?: string;
  to?: string[];
  cc?: string[];
  projectRoot?: string;
  agentEmails?: Iterable<string>;
  ownerEmails?: Iterable<string>;
  /** When nylas, inbound owner mail on the agent grant counts even if To is empty. */
  provider?: string;
}): boolean {
  const projectRoot = input.projectRoot ?? process.cwd();
  const agentEmails = input.agentEmails
    ? new Set([...input.agentEmails].map((e) => e.trim().toLowerCase()))
    : resolveJoshuAgentEmails(projectRoot);
  const ownerEmails = input.ownerEmails
    ? normalizeOwnerSet(input.ownerEmails)
    : resolveOwnerEmails(projectRoot);
  const fromAddr = parseEmailAddress(input.from);
  if (!fromAddr || !ownerEmails.has(fromAddr)) return false;

  const to = normalizeEmailList(input.to);
  const cc = normalizeEmailList(input.cc);
  const agentInTo = to.some((e) => agentEmails.has(e));
  const agentInCc = cc.some((e) => agentEmails.has(e));
  const externalInTo = to.filter((e) => !agentEmails.has(e) && !ownerEmails.has(e));

  // Agent Nylas inbox: delivered mail may omit To; owner inbound is always to the agent.
  if ((input.provider ?? "").trim().toLowerCase() === "nylas") {
    if (externalInTo.length > 0) return false;
    return agentInTo || agentInCc || to.length === 0;
  }

  if (!agentInTo) return false;
  return externalInTo.length === 0;
}

/** Ingress card lines — spawn-only; ingress still must not research or send. */
export function ownerReplyIngressPlaybookLines(eligible: boolean): string[] {
  if (!eligible) return [];
  return [
    "After filing: owner_reply_list_tasks by thread_id; handoff or owner_reply_create_task (pass threadId) on ea-owner-reply.",
    "Path D spawn only — do not research or nylas_send_message on ea-mail-ingress.",
  ];
}
