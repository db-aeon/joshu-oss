/** Plain-text marker in approval fallback_text — used to ignore bot prompts during Y/N polling. */
export const SLACK_APPROVAL_REQUEST_MARKER = "needs your approval";

/** Map owner Slack reply text to an approval decision. */
export function parseSlackApprovalReply(text: string): "approved" | "denied" | null {
  const normalized = text.trim().toLowerCase().replace(/[.!]+$/g, "");
  if (!normalized) return null;

  const approve = new Set(["y", "yes", "approve", "approved", "ok", "okay", "👍", "✅"]);
  const deny = new Set(["n", "no", "deny", "denied", "reject", "rejected", "👎", "❌"]);

  if (approve.has(normalized)) return "approved";
  if (deny.has(normalized)) return "denied";

  // Allow short phrases: "yes please", "no thanks"
  const first = normalized.split(/\s+/)[0] ?? "";
  if (approve.has(first)) return "approved";
  if (deny.has(first)) return "denied";

  return null;
}

export function isJoshuApprovalBotMessage(text: string): boolean {
  const t = text.toLowerCase();
  return (
    t.includes(SLACK_APPROVAL_REQUEST_MARKER) ||
    t.includes("joshu action approval") ||
    t.includes("joshu approval:")
  );
}
