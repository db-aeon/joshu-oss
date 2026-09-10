function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Human-readable To/CC/BCC line (arrays, objects, or RFC-style strings). */
export function formatRecipientField(value: unknown): string {
  if (value == null || value === "") return "";

  const parts: string[] = [];
  const push = (email: string, name?: string) => {
    const addr = email.trim();
    if (!addr) return;
    const label = name?.trim();
    parts.push(label ? `${label} <${addr}>` : addr);
  };

  const items: unknown[] =
    typeof value === "string"
      ? value.split(/[,;]/).map((s) => s.trim()).filter(Boolean)
      : Array.isArray(value)
        ? value
        : [value];

  for (const item of items) {
    if (typeof item === "string") {
      push(item);
      continue;
    }
    if (item && typeof item === "object") {
      const row = item as { email?: unknown; name?: unknown };
      const email = readString(row.email);
      if (email) push(email, readString(row.name) || undefined);
    }
  }
  return parts.join(", ");
}

/** Plain-text approval summary for owner SMS. */
export function formatApprovalMessage(actionId: string, summary: Record<string, unknown>): string {
  const lines = ["Joshu action approval", `Action: ${actionId}`];

  const tool = readString(summary.tool);
  const url = readString(summary.url);
  const ref = readString(summary.ref);
  const key = readString(summary.key);
  const channel = readString(summary.channel);
  const repo = readString(summary.repo);
  const action = readString(summary.action);

  if (tool) lines.push(`Tool: ${tool}`);
  if (action) lines.push(`Browser: ${action}`);
  if (url) lines.push(`URL: ${url}`);
  if (ref) lines.push(`Element: ${ref}`);
  if (key) lines.push(`Key: ${key}`);
  if (channel) lines.push(`Channel: ${channel}`);
  if (repo) lines.push(`Repo: ${repo}`);

  const to = formatRecipientField(summary.to);
  const cc = formatRecipientField(summary.cc);
  const bcc = formatRecipientField(summary.bcc);
  const subject = summary.subject;
  const body =
    summary.body ?? summary.bodyPreview ?? summary.argsPreview ?? summary.expressionPreview;
  const textPreview = summary.text;

  if (to) lines.push(`To: ${to}`);
  if (cc) lines.push(`CC: ${cc}`);
  if (bcc) lines.push(`BCC: ${bcc}`);
  if (subject) lines.push(`Subject: ${String(subject)}`);
  if (textPreview) lines.push(`Text: ${String(textPreview)}`);

  if (actionId === "nylas_send_message" && summary.ownerOnThread === false) {
    const ccNote = summary.ownerCcAdded === true ? " Owner CC added." : "";
    lines.push(`Note: You were not on prior messages in this thread.${ccNote}`);
    const snippet = readString(summary.threadContextSnippet);
    if (snippet) lines.push(`Context: ${snippet}`);
  }

  if (body) {
    lines.push("", String(body));
  }

  lines.push("", "Reply Y to approve or N to deny.");
  return lines.join("\n");
}
