/**
 * Render Nylas thread messages into connector mirror markdown (same ### layout as Gmail).
 */
import { epochToIso, stripHtmlToText, truncateBody, type MailThreadMessageMeta } from "./mirror.js";
import type { NylasMessageDetail } from "../nylas/client.js";

export function buildNylasThreadMirrorBody(messages: NylasMessageDetail[]): {
  bodyMarkdown: string;
  threadMessages: MailThreadMessageMeta[];
} {
  const threadMessages: MailThreadMessageMeta[] = [];
  const bodyParts: string[] = [];

  for (const m of messages) {
    const from = m.fromName ? `${m.fromName} <${m.from}>` : (m.from ?? "unknown");
    const when = epochToIso(m.date) ?? "";
    const subject = m.subject ?? "(no subject)";
    const raw = m.body ? stripHtmlToText(m.body) : (m.snippet ?? "");
    const text = truncateBody(raw, 4000);

    threadMessages.push({
      id: m.id,
      date: epochToIso(m.date),
      from,
      subject: m.subject,
    });
    bodyParts.push(`### ${when} — ${from}\n\n**Subject:** ${subject}\n\n${text}`);
  }

  return {
    bodyMarkdown: bodyParts.join("\n\n---\n\n"),
    threadMessages,
  };
}
