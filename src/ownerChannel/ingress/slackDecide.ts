import { readPending } from "../../actionGuard/pending.js";
import { ownerChannelStatus } from "../config.js";
import { handleApprovalCallback } from "../notify.js";
import { confirmSlackApprovalDecision } from "../slackReplyPoll.js";
import { verifySlackApprovalLink, type SlackApprovalDecision } from "../slackApprovalLinks.js";

function decisionPage(title: string, body: string, ok: boolean): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${title}</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#1a1a1a}
  .card{border:1px solid #e5e5e5;border-radius:12px;padding:1.5rem}
  .ok{color:#0a7a3e}.err{color:#b42318}
</style></head><body><div class="card"><h1 class="${ok ? "ok" : "err"}">${title}</h1><p>${body}</p></div></body></html>`;
}

export async function handleSlackApprovalDecideQuery(
  query: Record<string, string | undefined>,
  projectRoot: string,
): Promise<{ status: number; html: string }> {
  const pendingId = query.pending?.trim() ?? "";
  const decision = query.decision?.trim() as SlackApprovalDecision;
  const exp = query.exp?.trim() ?? "";
  const sig = query.sig?.trim() ?? "";

  const verified = verifySlackApprovalLink(pendingId, decision, exp, sig);
  if (!verified.ok) {
    const messages: Record<string, string> = {
      missing_parameters: "This approval link is incomplete.",
      invalid_decision: "This approval link is invalid.",
      invalid_expiry: "This approval link is malformed.",
      link_expired: "This approval link has expired.",
      invalid_signature: "This approval link could not be verified.",
    };
    return {
      status: 400,
      html: decisionPage("Link invalid", messages[verified.reason] ?? "Unknown error.", false),
    };
  }

  const pending = readPending(pendingId, projectRoot);
  if (!pending) {
    return {
      status: 404,
      html: decisionPage("Not found", "This approval request was not found or already finished.", false),
    };
  }
  if (pending.status !== "pending") {
    return {
      status: 409,
      html: decisionPage(
        "Already decided",
        `This request was already ${pending.status}.`,
        pending.status === "approved",
      ),
    };
  }

  const callback = decision === "approve" ? `ag:approve:${pendingId}` : `ag:deny:${pendingId}`;
  const handled = await handleApprovalCallback(callback, {}, projectRoot);
  if (!handled) {
    return {
      status: 409,
      html: decisionPage("Could not apply", "The decision could not be recorded.", false),
    };
  }

  const label = decision === "approve" ? "Approved" : "Denied";
  const resolved = decision === "approve" ? "approved" : "denied";
  const owner = ownerChannelStatus(projectRoot);
  if (owner.slackDmChannelId) {
    void confirmSlackApprovalDecision(
      owner.slackDmChannelId,
      pending.actionId,
      resolved,
      owner.connectedAccountId,
      projectRoot,
    );
  }
  return {
    status: 200,
    html: decisionPage(
      label,
      `${label}: <code>${pending.actionId}</code>. You can close this tab.`,
      decision === "approve",
    ),
  };
}
