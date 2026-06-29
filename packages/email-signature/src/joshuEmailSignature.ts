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

/** Convert plain text to simple email-safe HTML (inline styles, paragraph breaks). */
export function plainTextToSimpleEmailHtml(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:${INK};"></div>`;
  }

  const paragraphs = trimmed.split(/\n{2,}/);
  const inner = paragraphs
    .map((paragraph) => {
      const lines = escapeHtml(paragraph).split("\n").join("<br>");
      return `<p style="margin:0 0 16px;">${lines}</p>`;
    })
    .join("");

  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:${INK};">${inner}</div>`;
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
