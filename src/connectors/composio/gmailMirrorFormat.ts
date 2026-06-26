/**
 * Render and parse Gmail thread markdown mirrors (one file per thread).
 */
import type { GmailMessageSummary } from "./gmail.js";
import { formatMessageDateLabel } from "./gmailBodies.js";

export type GmailThreadMessageMeta = {
  id: string;
  date?: string;
  from?: string;
  subject?: string;
};

export function buildGmailThreadMirrorBody(messages: GmailMessageSummary[]): {
  bodyMarkdown: string;
  threadMessages: GmailThreadMessageMeta[];
} {
  const threadMessages: GmailThreadMessageMeta[] = [];
  const bodyParts: string[] = [];

  for (const m of messages) {
    const dateIso =
      m.messageTimestamp != null ? new Date(m.messageTimestamp).toISOString() : undefined;
    const when = formatMessageDateLabel(m.messageTimestamp);
    const from = m.from ?? "unknown";
    const subject = m.subject ?? "(no subject)";
    const text = (m.body || m.snippet || "").trim();

    threadMessages.push({
      id: m.id,
      date: dateIso,
      from: m.from,
      subject: m.subject,
    });
    bodyParts.push(`### ${when} — ${from}\n\n**Subject:** ${subject}\n\n${text}`);
  }

  return {
    bodyMarkdown: bodyParts.join("\n\n---\n\n"),
    threadMessages,
  };
}

export type ParsedThreadSection = {
  whenLabel: string;
  from: string;
  subject?: string;
  body: string;
};

/** Parse ### heading sections written by buildGmailThreadMirrorBody. */
export function parseGmailThreadMirrorSections(bodyMarkdown: string): ParsedThreadSection[] {
  const chunks = bodyMarkdown.split(/\n\n---\n\n/).map((c) => c.trim()).filter(Boolean);
  const out: ParsedThreadSection[] = [];

  for (const chunk of chunks) {
    const lines = chunk.split(/\r?\n/);
    const heading = lines[0] ?? "";
    const match = /^### (.+?) — (.+)$/.exec(heading);
    if (!match) {
      out.push({ whenLabel: "", from: "", body: chunk });
      continue;
    }
    let rest = lines.slice(1).join("\n").trim();
    let subject: string | undefined;
    const subjMatch = /^\*\*Subject:\*\* (.+?)(?:\r?\n\r?\n|\n\n)/.exec(rest);
    if (subjMatch) {
      subject = subjMatch[1]?.trim();
      rest = rest.slice(subjMatch[0].length).trim();
    }
    out.push({
      whenLabel: match[1]!.trim(),
      from: match[2]!.trim(),
      subject,
      body: rest,
    });
  }
  return out;
}
