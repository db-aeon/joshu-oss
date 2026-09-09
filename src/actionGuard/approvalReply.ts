/** Map owner reply text to an approval decision. */
export function parseApprovalReply(text: string): "approved" | "denied" | null {
  const normalized = text.trim().toLowerCase().replace(/[.!]+$/g, "");
  if (!normalized) return null;

  const approve = new Set(["y", "yes", "approve", "approved", "ok", "okay"]);
  const deny = new Set(["n", "no", "deny", "denied", "reject", "rejected"]);

  if (approve.has(normalized)) return "approved";
  if (deny.has(normalized)) return "denied";

  // First-word match only for short confirmations ("yes please", "ok thanks"),
  // not conversational SMS ("Ok on Nevada. Before I blocked it...").
  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length > 4 || normalized.length > 40) return null;
  const first = words[0] ?? "";
  if (approve.has(first)) return "approved";
  if (deny.has(first)) return "denied";

  return null;
}
