/**
 * HTML email signature for joshu companions.
 *
 * Nylas accepts HTML in `body` by default (`is_plaintext: false`). Signatures can
 * also be stored on a grant via POST /v3/grants/{id}/signatures and referenced with
 * `signature_id` at send time — we inline HTML for agent outbound mail.
 */

export type JoshuEmailSignatureInput = {
  /** Companion / joshu display name. */
  name: string;
  /** fal Ideogram portrait URL (must be publicly reachable). */
  portraitImageUrl?: string;
  /** Owner display name — role line becomes "{owner}'s Joshu". */
  ownerDisplayName?: string;
  /** Short role line under the name (overrides owner-based default). */
  roleLine?: string;
  /** Hide the "Get your Joshu" CTA link (e.g. referral already in email body). */
  hideSignupCta?: boolean;
};

const JOSHU_SIGNUP_URL = "https://joshu.me";

/** True when a string is likely HTML markup, not human plain text. */
function looksLikeHtml(text: string): boolean {
  const t = text.trim().slice(0, 512).toLowerCase();
  if (!t) return false;
  if (t.startsWith("<!doctype") || t.startsWith("<html")) return true;
  if (/<head[\s>]/i.test(t) || /<body[\s>]/i.test(t)) return true;
  const tagCount = (t.match(/<[a-z][a-z0-9]*[\s>]/gi) ?? []).length;
  return tagCount >= 2;
}

/** Role line under the companion name, e.g. "Owner Name's Joshu". */
export function formatJoshuSignatureRoleLine(ownerDisplayName?: string): string {
  const owner = ownerDisplayName?.trim();
  if (!owner) return "Joshu";
  return `${owner}'s Joshu`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Brand tokens — inline for email client compatibility. */
const INK = "#0d0d0d";
const INK_MUTED = "#5c534c";
const PAPER = "#f5f0eb";
const ACTION = "#0057ff";
const ROSE = "#c8a2a6";

/**
 * Table-based HTML signature (photo + name) aligned with joshu brand guidelines.
 */
export function buildJoshuEmailSignatureHtml(input: JoshuEmailSignatureInput): string {
  const name = escapeHtml(input.name.trim() || "Your joshu");
  const role = escapeHtml(
    input.roleLine?.trim() || formatJoshuSignatureRoleLine(input.ownerDisplayName),
  );
  const photo = input.portraitImageUrl?.trim();

  const photoCell = photo
    ? `<td style="padding-right:16px;vertical-align:top;width:80px;">
        <img src="${escapeHtml(photo)}" alt="${name}" width="80" height="80"
          style="display:block;width:80px;height:80px;object-fit:cover;border:1px solid ${ROSE};" />
      </td>`
    : `<td style="padding-right:16px;vertical-align:top;width:80px;">
        <div style="width:80px;height:80px;background:${PAPER};border:1px solid ${ROSE};"></div>
      </td>`;

  const ctaText = `Get your Joshu: ${JOSHU_SIGNUP_URL}`;
  const ctaLine = input.hideSignupCta
    ? ""
    : `<p style="margin:6px 0 0;font-size:12px;line-height:1.4;">
        <a href="${JOSHU_SIGNUP_URL}" style="color:${ACTION};text-decoration:none;">${escapeHtml(ctaText)}</a>
      </p>`;

  return `<table cellpadding="0" cellspacing="0" border="0" role="presentation"
    style="margin:0;font-family:Arial,Helvetica,sans-serif;color:${INK};max-width:420px;">
    <tr>
      ${photoCell}
      <td style="vertical-align:top;border-left:1px solid ${ROSE};padding-left:16px;">
        <p style="margin:0;font-size:16px;line-height:1.3;font-weight:600;color:${INK};">${name}</p>
        <p style="margin:4px 0 0;font-size:13px;line-height:1.4;color:${INK_MUTED};">${role}</p>
        ${ctaLine}
      </td>
    </tr>
  </table>`;
}

const BODY_FONT =
  "font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:" + INK;
const LINK_STYLE = `color:${ACTION};text-decoration:underline;`;
const P_STYLE = "margin:0 0 16px;";

/**
 * Peel trailing sentence punctuation that clients often leave glued to a URL.
 * Keeps balanced closing parens that belong to the URL path.
 */
function splitTrailingUrlPunct(raw: string): { url: string; trail: string } {
  let url = raw;
  let trail = "";
  while (url.length > 1) {
    const last = url.slice(-1);
    if (!/[.,;:!?)]$/.test(last)) break;
    if (last === ")") {
      const opens = (url.match(/\(/g) ?? []).length;
      const closes = (url.match(/\)/g) ?? []).length;
      if (opens >= closes) break;
    }
    trail = last + trail;
    url = url.slice(0, -1);
  }
  return { url, trail };
}

function hrefForBareUrl(url: string): string {
  return url.startsWith("www.") ? `https://${url}` : url;
}

function linkHtml(href: string, label: string): string {
  return `<a href="${escapeHtml(href)}" style="${LINK_STYLE}">${escapeHtml(label)}</a>`;
}

/**
 * Inline markdown subset for agent mail: [label](url), bare URLs, **bold**, *italic*, `code`.
 * Placeholders protect links across escapeHtml so URLs stay clickable in HTML clients.
 */
function formatInlineEmailText(text: string): string {
  const stashed: string[] = [];
  const stash = (html: string): string => {
    const i = stashed.length;
    stashed.push(html);
    return `@@JOSHU_EMAIL_TOKEN_${i}@@`;
  };

  let s = text;

  // Markdown links first so the URL inside is not double-linkified.
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+|www\.[^)\s]+)\)/gi, (_m, label: string, rawHref: string) => {
    const { url, trail } = splitTrailingUrlPunct(rawHref);
    return stash(linkHtml(hrefForBareUrl(url), label)) + trail;
  });

  // Bare http(s) / www URLs (common in agent drafts that skip markdown links).
  s = s.replace(/\bhttps?:\/\/[^\s<>"']+|\bwww\.[^\s<>"']+/gi, (raw) => {
    const { url, trail } = splitTrailingUrlPunct(raw);
    return stash(linkHtml(hrefForBareUrl(url), url)) + trail;
  });

  s = escapeHtml(s);

  // Inline code (already escaped).
  s = s.replace(/`([^`]+)`/g, '<code style="font-family:Menlo,Consolas,monospace;font-size:13px;">$1</code>');

  // Bold then italic (avoid matching the inner stars of **bold**).
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  s = s.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<em>$1</em>");
  s = s.replace(/(?<![A-Za-z0-9_])_([^_\n]+)_(?![A-Za-z0-9_])/g, "<em>$1</em>");

  s = s.replace(/@@JOSHU_EMAIL_TOKEN_(\d+)@@/g, (_m, idx: string) => stashed[Number(idx)] ?? "");
  return s;
}

function isUnorderedListBlock(lines: string[]): boolean {
  const nonempty = lines.filter((l) => l.trim());
  return nonempty.length > 0 && nonempty.every((l) => /^\s*[-*]\s+\S/.test(l));
}

function isOrderedListBlock(lines: string[]): boolean {
  const nonempty = lines.filter((l) => l.trim());
  return nonempty.length > 0 && nonempty.every((l) => /^\s*\d+\.\s+\S/.test(l));
}

/**
 * One blank-line-delimited block → paragraph, list, or soft heading.
 * `olStart` is the number of the first item when the block is an ordered list.
 */
function renderEmailBlock(paragraph: string, olStart = 1): string {
  const lines = paragraph.split("\n");

  if (isUnorderedListBlock(lines)) {
    const items = lines
      .filter((l) => l.trim())
      .map((l) => {
        const content = l.replace(/^\s*[-*]\s+/, "");
        return `<li style="margin:0 0 4px;">${formatInlineEmailText(content)}</li>`;
      })
      .join("");
    return `<ul style="${P_STYLE}padding-left:24px;">${items}</ul>`;
  }

  if (isOrderedListBlock(lines)) {
    const items = lines
      .filter((l) => l.trim())
      .map((l) => {
        const content = l.replace(/^\s*\d+\.\s+/, "");
        return `<li style="margin:0 0 4px;">${formatInlineEmailText(content)}</li>`;
      })
      .join("");
    const start = olStart === 1 ? "" : ` start="${olStart}"`;
    return `<ol${start} style="${P_STYLE}padding-left:24px;">${items}</ol>`;
  }

  // Soft headings: "# Title" on its own line (agents often draft in markdown).
  const heading = paragraph.trim().match(/^(#{1,3})\s+(.+)$/);
  if (heading && !paragraph.includes("\n")) {
    const level = heading[1]?.length ?? 1;
    const size = level === 1 ? 18 : level === 2 ? 16 : 15;
    return `<p style="${P_STYLE}font-size:${size}px;font-weight:600;">${formatInlineEmailText(heading[2] ?? "")}</p>`;
  }

  const withBreaks = lines.map((line) => formatInlineEmailText(line)).join("<br>");
  return `<p style="${P_STYLE}">${withBreaks}</p>`;
}

/**
 * Convert plain text / light markdown to email-safe HTML.
 * Agents often pass markdown in Nylas `body`; without this, clients show raw `**` / bare URLs.
 */
export function plainTextToSimpleEmailHtml(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return `<div style="${BODY_FONT};"></div>`;
  }

  // Agents often put a blank line between numbered items ("1. A\n\n2. B"), which splits
  // one list into many blocks. Each block keeps its written number, and a block that
  // follows a list and repeats a number ("1." each time) continues the count.
  let nextOrdinal: number | null = null;
  const inner = trimmed
    .split(/\n{2,}/)
    .map((block) => {
      const lines = block.split("\n");
      if (!isOrderedListBlock(lines)) {
        nextOrdinal = null;
        return renderEmailBlock(block);
      }
      const itemCount = lines.filter((l) => l.trim()).length;
      const written = Number(/^\s*(\d+)\./.exec(lines.find((l) => l.trim()) ?? "")?.[1] ?? "1");
      const start = nextOrdinal !== null && written < nextOrdinal ? nextOrdinal : written;
      nextOrdinal = start + itemCount;
      return renderEmailBlock(block, start);
    })
    .join("");
  return `<div style="${BODY_FONT};">${inner}</div>`;
}

/** Append the joshu signature below the message body (HTML). */
export function appendJoshuEmailSignatureHtml(
  bodyHtml: string,
  signature: JoshuEmailSignatureInput,
): string {
  const body = bodyHtml.trim();
  return `${body}
<hr style="border:none;border-top:1px solid ${ROSE};margin:24px 0;" />
${buildJoshuEmailSignatureHtml(signature)}`;
}

/** Build a signed outbound message from plain text or simple HTML. */
export function buildJoshuSignedEmailHtml(
  body: string,
  signature: JoshuEmailSignatureInput,
): string {
  const bodyHtml = looksLikeHtml(body) ? body.trim() : plainTextToSimpleEmailHtml(body);
  return appendJoshuEmailSignatureHtml(bodyHtml, signature);
}

/** Short test message body with signature appended (HTML). */
export function buildJoshuSignatureTestEmailHtml(
  signature: JoshuEmailSignatureInput,
  opts?: { previewLine?: string },
): string {
  const preview = escapeHtml(
    opts?.previewLine?.trim() ||
      "This is a test message from the joshu portal. The signature below is what recipients would see on emails from your joshu.",
  );

  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:${INK};">
  <p style="margin:0 0 16px;">${preview}</p>
  <hr style="border:none;border-top:1px solid ${ROSE};margin:24px 0;" />
  ${buildJoshuEmailSignatureHtml(signature)}
</div>`;
}
