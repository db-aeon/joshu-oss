import { createHmac, timingSafeEqual } from "node:crypto";
import { resolveJoshuPublicApiBase } from "./publicUrl.js";

export type SlackApprovalDecision = "approve" | "deny";

function approvalLinkSecret(): string {
  return (
    process.env.JOSHU_OWNER_CHANNEL_APPROVAL_SECRET?.trim() ||
    process.env.JOSHU_OWNER_CHANNEL_SLACK_SIGNING_SECRET?.trim() ||
    process.env.JOSHU_ACTION_GUARD_TELEGRAM_WEBHOOK_SECRET?.trim() ||
    "joshu-local-approval-links"
  );
}

function signPayload(payload: string): string {
  return createHmac("sha256", approvalLinkSecret()).update(payload).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function buildSlackApprovalUrl(
  pendingId: string,
  decision: SlackApprovalDecision,
  expiresAtMs: number,
): string {
  const exp = String(expiresAtMs);
  const payload = `${pendingId}:${decision}:${exp}`;
  const sig = signPayload(payload);
  const base = resolveJoshuPublicApiBase();
  const params = new URLSearchParams({
    pending: pendingId,
    decision,
    exp,
    sig,
  });
  return `${base}/api/owner-channel/slack/decide?${params.toString()}`;
}

export function verifySlackApprovalLink(
  pendingId: string,
  decision: SlackApprovalDecision,
  expRaw: string,
  sig: string,
): { ok: true; expiresAtMs: number } | { ok: false; reason: string } {
  if (!pendingId || !decision || !expRaw || !sig) {
    return { ok: false, reason: "missing_parameters" };
  }
  if (decision !== "approve" && decision !== "deny") {
    return { ok: false, reason: "invalid_decision" };
  }
  const expiresAtMs = Number.parseInt(expRaw, 10);
  if (!Number.isFinite(expiresAtMs)) {
    return { ok: false, reason: "invalid_expiry" };
  }
  if (Date.now() > expiresAtMs) {
    return { ok: false, reason: "link_expired" };
  }
  const expected = signPayload(`${pendingId}:${decision}:${expRaw}`);
  if (!safeEqual(expected, sig)) {
    return { ok: false, reason: "invalid_signature" };
  }
  return { ok: true, expiresAtMs };
}
