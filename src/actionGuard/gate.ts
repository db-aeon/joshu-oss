import { readAgentProfile } from "../nylas/profile.js";
import { appendAuditEntry } from "./audit.js";
import { resolveActionExposure } from "./classify.js";
import { isActionGuardUnavailableError } from "./errors.js";
import { classifyExternalAction } from "./externalClassifier.js";
import { isActionGuarded, isActionGuardEnabled, loadActionGuardPolicy } from "./policy.js";
import {
  cleanupPending,
  createPending,
  type PendingDecision,
  waitForPendingDecision,
} from "./pending.js";
import { notifyOwnerForApproval } from "../ownerChannel/notify.js";
import { attachSlackReplyPollingForPending } from "../ownerChannel/slackReplyPoll.js";

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeEmails(value: unknown): string[] {
  if (typeof value === "string") {
    return value
      .split(/[,;]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  }
  if (Array.isArray(value)) {
    const out: string[] = [];
    for (const item of value) {
      if (typeof item === "string") out.push(item.trim().toLowerCase());
      else if (item && typeof item === "object" && "email" in item) {
        const email = readString((item as { email?: unknown }).email).toLowerCase();
        if (email) out.push(email);
      }
    }
    return out.filter(Boolean);
  }
  return [];
}

function isMailAction(actionId: string): boolean {
  return actionId === "nylas_send_message" || /^composio:GMAIL_/i.test(actionId);
}

/** Owner-only recipient bypass for mail actions (summary emails, owner notes). */
function shouldBypassOwnerOnlyRecipients(
  actionId: string,
  summary: Record<string, unknown>,
  projectRoot: string,
): boolean {
  if (!isMailAction(actionId)) return false;
  const policy = loadActionGuardPolicy(projectRoot);
  if (!policy.bypassOwnerOnlyRecipients && !policy.bypassSummaryEmailToOwner) return false;

  const profile = readAgentProfile(projectRoot);
  const ownerEmail = readString(profile?.primaryWorkEmail).toLowerCase();
  if (!ownerEmail) return false;

  const recipients = [
    ...normalizeEmails(summary.to),
    ...normalizeEmails(summary.cc),
    ...normalizeEmails(summary.bcc),
  ];
  if (recipients.length === 0) return false;
  return recipients.every((email) => email === ownerEmail);
}

async function shouldSkipViaClassifier(
  actionId: string,
  summary: Record<string, unknown>,
  projectRoot: string,
): Promise<{ skip: boolean; reason?: string }> {
  const policy = loadActionGuardPolicy(projectRoot);
  const exposure = resolveActionExposure(actionId, summary);

  if (exposure === "external") return { skip: false };
  if (exposure === "owner_only") return { skip: true, reason: "deterministic_owner_only" };

  // Ambiguous: fail closed unless soft LLM classifier is enabled.
  if (!policy.llmClassifier) {
    return { skip: false, reason: "ambiguous_fail_closed" };
  }

  const result = await classifyExternalAction(actionId, summary);
  if (!result.needsApproval && result.confidence >= policy.llmClassifierThreshold) {
    return { skip: true, reason: result.reason };
  }
  return { skip: false, reason: result.reason };
}

export type AwaitApprovalInput = {
  actionId: string;
  summary: Record<string, unknown>;
  bypassGuard?: boolean;
};

export type AwaitApprovalResult = {
  decision: PendingDecision | "skipped" | "unavailable";
  pendingId?: string;
  classifierReason?: string;
  unavailableCode?: string;
  unavailableReason?: string;
};

/**
 * Block until owner approves/denies or timeout. Returns skipped when guard is off or bypassed.
 */
export async function awaitOwnerApproval(
  input: AwaitApprovalInput,
  projectRoot = process.cwd(),
): Promise<AwaitApprovalResult> {
  const { actionId, summary, bypassGuard = false } = input;

  if (bypassGuard || !isActionGuardEnabled(projectRoot) || !isActionGuarded(actionId, projectRoot)) {
    appendAuditEntry(
      { at: new Date().toISOString(), pendingId: "-", actionId, decision: "skipped", summary },
      projectRoot,
    );
    return { decision: "skipped" };
  }

  if (shouldBypassOwnerOnlyRecipients(actionId, summary, projectRoot)) {
    appendAuditEntry(
      { at: new Date().toISOString(), pendingId: "-", actionId, decision: "skipped", summary },
      projectRoot,
    );
    return { decision: "skipped" };
  }

  const classifier = await shouldSkipViaClassifier(actionId, summary, projectRoot);
  if (classifier.skip) {
    appendAuditEntry(
      {
        at: new Date().toISOString(),
        pendingId: "-",
        actionId,
        decision: "skipped",
        summary: { ...summary, classifierReason: classifier.reason },
      },
      projectRoot,
    );
    return { decision: "skipped", classifierReason: classifier.reason };
  }

  const policy = loadActionGuardPolicy(projectRoot);
  const pending = createPending(actionId, summary, policy.approvalTimeoutMs, projectRoot);

  try {
    await notifyOwnerForApproval(pending.id, actionId, summary, projectRoot);
  } catch (err) {
    cleanupPending(pending.id, projectRoot);
    if (isActionGuardUnavailableError(err)) {
      appendAuditEntry(
        {
          at: new Date().toISOString(),
          pendingId: pending.id,
          actionId,
          decision: "unavailable",
          summary: { ...summary, unavailableCode: err.code, unavailableReason: err.message },
        },
        projectRoot,
      );
      console.warn(`[action-guard] approval unavailable (${err.code}): ${err.message}`);
      return {
        decision: "unavailable",
        unavailableCode: err.code,
        unavailableReason: err.message,
      };
    }
    throw err;
  }

  let stopSlackPoll: (() => void) | undefined;
  const slackPoll = attachSlackReplyPollingForPending(pending.id, projectRoot);
  if (slackPoll) stopSlackPoll = slackPoll.stop;

  let decision: PendingDecision;
  try {
    decision = await waitForPendingDecision(pending.id, policy.approvalTimeoutMs, projectRoot);
  } finally {
    stopSlackPoll?.();
  }

  appendAuditEntry(
    {
      at: new Date().toISOString(),
      pendingId: pending.id,
      actionId,
      decision,
      summary: classifier.reason ? { ...summary, classifierReason: classifier.reason } : summary,
    },
    projectRoot,
  );
  cleanupPending(pending.id, projectRoot);
  return { decision, pendingId: pending.id, classifierReason: classifier.reason };
}

export function buildNylasSendSummary(args: Record<string, unknown>): Record<string, unknown> {
  const body = readString(args.body);
  const kanbanTaskId =
    readString(args.kanbanTaskId) ||
    readString(args.kanban_task_id) ||
    readString(args.taskId) ||
    readString(args.task_id);
  const threadId = readString(args.threadId) || readString(args.thread_id);
  return {
    to: args.to,
    cc: args.cc,
    bcc: args.bcc,
    subject: readString(args.subject),
    // Full body for owner 1:1 approval (Slack/Telegram). Do not truncate —
    // owners need to review the exact outbound email before approving.
    body,
    ...(kanbanTaskId ? { kanbanTaskId } : {}),
    ...(threadId ? { threadId } : {}),
  };
}

export function buildComposioToolSummary(toolName: string, args: Record<string, unknown>): Record<string, unknown> {
  const body = readString(args.body ?? args.message ?? args.text ?? args.content);
  return {
    tool: toolName,
    to: args.recipient_email ?? args.to ?? args.attendees,
    cc: args.cc,
    bcc: args.bcc,
    subject: args.subject ?? args.title ?? args.summary,
    channel: args.channel ?? args.channel_id,
    repo: args.repo ?? args.repository,
    bodyPreview: body.slice(0, 400),
    argsPreview: JSON.stringify(args).slice(0, 400),
  };
}

export function buildBrowserActionSummary(
  kind: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  return {
    action: kind,
    url: args.url,
    ref: args.ref,
    text: readString(args.text).slice(0, 200) || undefined,
    key: args.key,
    expressionPreview: readString(args.expression).slice(0, 400) || undefined,
  };
}

export function buildActionSummary(actionId: string, args: Record<string, unknown>): Record<string, unknown> {
  if (actionId === "nylas_send_message") return buildNylasSendSummary(args);
  if (actionId.startsWith("composio:")) {
    return buildComposioToolSummary(actionId.slice("composio:".length), args);
  }
  if (actionId.startsWith("browser:")) {
    return buildBrowserActionSummary(actionId.slice("browser:".length), args);
  }
  return {
    actionId,
    argsPreview: JSON.stringify(args).slice(0, 400),
  };
}
