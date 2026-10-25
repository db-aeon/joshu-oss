import { handoffUrlForRecord, listHandoffRecords } from "../browserHandoff/store.js";
import type { KanbanTaskSummary } from "../hermesKanbanBridge.js";

const HANDOFF_URL_RE = /https?:\/\/[^\s<>"')]+\/joshu\/handoff\/[^\s<>"')]+/gi;

/**
 * The kanban summary is what the owner reads. Pull a handoff link from the
 * summary, comments, run metadata, or a pending handoff record so a worker
 * that says "the handoff link" without pasting it still delivers a URL.
 */
export function collectHandoffUrls(
  projectRoot: string,
  task: KanbanTaskSummary | undefined,
  summary: string,
): string[] {
  const found: string[] = [];
  pushUrls(summary, found);
  for (const comment of task?.recent_comments ?? []) pushUrls(comment.body ?? "", found);
  pushUrls(task?.completion_summary ?? "", found);
  collectFromValue(task?.latest_run?.metadata, found);
  const taskId = task?.task_id?.trim();
  let pending: ReturnType<typeof listHandoffRecords> = [];
  try {
    pending = listHandoffRecords(projectRoot);
  } catch {
    pending = [];
  }
  pending = pending
    .filter((record) => record.status === "pending")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const matched = taskId
    ? pending.filter((record) => record.kanbanTaskId === taskId)
    : [];
  // A summary that mentions a handoff but names no URL still needs the live link.
  const chosen = matched.length
    ? matched
    : /handoff/i.test(summary)
      ? pending.slice(0, 1)
      : [];
  for (const record of chosen) found.push(handoffUrlForRecord(record));
  return unique(found.map(trimUrl));
}

/** Turn an internal worker summary into the text the owner should receive. */
export function formatOwnerCompletion(raw: string, handoffUrls: string[]): string {
  let text = raw.replace(/\r\n/g, "\n").trim();
  text = text.replace(/An image CAPTCHA[\s\S]*?this run\.?/gi, "");
  text = text.replace(/[^.!\n]*\bthis run\b[^.!\n]*[.!?]?/gi, "");
  text = text.replace(/[\u2192\u279C]/g, " to ").replace(/[\u2194\u21D4]/g, "-");
  text = text.replace(/\bhanded to the owner\b/gi, "ready for you to finish");
  text = text.replace(/\bthe owner\b/gi, "you");
  text = text.replace(/\bowner enters\b/gi, "please enter");
  text = text.replace(/\bpicks an aisle/gi, "pick an aisle");
  text = text.replace(/\bpays at the handoff link\b/gi, "pay using the link below");
  text = text.replace(/\bis staged at checkout and ready for you to finish\b/gi, "is ready for you to finish");
  text = text.replace(
    /Contact fields prefilled \(([^)]+)\)/gi,
    "I already filled in your contact info ($1)",
  );
  text = layoutOwnerLines(text);
  const urls = unique(handoffUrls.map(trimUrl).filter(Boolean));
  const lower = text.toLowerCase();
  const missing = urls.filter((url) => !lower.includes(url.toLowerCase()));
  if (missing.length) {
    // Neutral label: most handoffs are a sign-in or a code, not a payment.
    text = `${text}\n\nOpen the live browser here:\n${missing[0]}`;
  }
  return text.trim();
}

/** One fact per line so SMS stays readable after GSM folding. */
function layoutOwnerLines(raw: string): string {
  let text = raw.replace(/[ \t]+/g, " ").trim();
  text = text.replace(/\s*;\s*/g, "\n");
  text = text.replace(/\s+(?=Out\b)/, "\n");
  text = text.replace(/\s+(?=back\b)/i, "\n");
  text = text.replace(/([.!?])\s+/g, "$1\n");
  return text
    .split("\n")
    .map((line) => line.replace(/\s{2,}/g, " ").replace(/\s+([,.;])/g, "$1").trim())
    .filter(Boolean)
    // A link stays as it is: "Https://" is not the same text as the link.
    .map((line) => (/^https?:\/\//i.test(line) ? line : line.charAt(0).toUpperCase() + line.slice(1)))
    .join("\n");
}

function pushUrls(text: string, into: string[]): void {
  for (const match of text.match(HANDOFF_URL_RE) ?? []) into.push(match);
}

function collectFromValue(value: unknown, into: string[], depth = 0): void {
  if (depth > 4 || value == null) return;
  if (typeof value === "string") {
    pushUrls(value, into);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectFromValue(item, into, depth + 1);
    return;
  }
  if (typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) {
      collectFromValue(item, into, depth + 1);
    }
  }
}

function trimUrl(url: string): string {
  return url.replace(/[.,);]+$/g, "");
}

function unique(urls: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const url of urls) {
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}
