/**
 * The themes as text for a channel (change research-report-topics, design decision D10). The email
 * of a report update has the summary and every theme with its paragraphs, its lead link, and its
 * other links; the email of a Research report has the summary and the first paragraph of each
 * theme. A text message, Slack, and Telegram get the summary and one line for each theme with its
 * headline and its lead link. Citations such as `[F12]` are left out, because the links of the
 * theme follow its paragraphs. Email text is light markdown for `buildJoshuSignedEmailHtml`.
 */

import type { ReportSection, ThemeLink } from "../pipeline/write.js";
import type { ReportChannel } from "../recurring/types.js";

/** A text without its fact citations. */
export function withoutCitations(text: string): string {
  return text.replace(/\s*\[F\d+\]/g, "").replace(/ +([.,;:!?])/g, "$1").trim();
}

function md(text: string): string {
  return text.replace(/([[\]])/g, "\\$1");
}

function linkName(link: ThemeLink): string {
  return `${link.site}${link.counter ? `, ${link.counter}` : ""}`;
}

/** The lead link and the other links of a theme as markdown lines. */
function linkLines(links: ThemeLink[] = []): string[] {
  const [lead, ...more] = links;
  if (!lead) return [];
  return [
    `[${md(lead.title)}](${lead.url}) (${md(linkName(lead))})`,
    ...(more.length ? [`More: ${more.map((l) => `[${md(linkName(l))}](${l.url})`).join(", ")}`] : []),
  ];
}

/**
 * The themes as light markdown for an email. `firstParagraph` keeps only the first paragraph of each
 * theme and the lead link (the email of a Research report, whose PDF has the rest).
 */
export function themesEmailText(summary: string, themes: ReportSection[], opts: { firstParagraph?: boolean } = {}): string {
  const out: string[] = [withoutCitations(summary)];
  for (const theme of themes) {
    const paragraphs = theme.body.split(/\n\s*\n/).map(withoutCitations).filter(Boolean);
    const links = linkLines(theme.links);
    out.push(`### ${theme.title}`, ...(opts.firstParagraph ? paragraphs.slice(0, 1) : paragraphs), ...(opts.firstParagraph ? links.slice(0, 1) : links).filter(Boolean));
  }
  return out.filter(Boolean).join("\n\n");
}

/** The summary and one line for each theme with its headline and its lead link: a text message, Slack, or Telegram. */
export function themesShortText(summary: string, themes: ReportSection[], channel: Exclude<ReportChannel, "email">): string {
  const lines = themes.map((t) => {
    const lead = t.links?.[0];
    if (channel === "slack") return `• *${t.title}*${lead ? ` <${lead.url}|${lead.site}>` : ""}`;
    return `• ${t.title}${lead ? `: ${lead.url}` : ""}`;
  });
  return [withoutCitations(summary), lines.join("\n")].filter(Boolean).join("\n\n");
}

/** The text of a report update on its channel. */
export function themesText(summary: string, themes: ReportSection[], channel: ReportChannel): string {
  return channel === "email" ? themesEmailText(summary, themes) : themesShortText(summary, themes, channel);
}
