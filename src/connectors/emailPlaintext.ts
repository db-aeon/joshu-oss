/**
 * Prefer Gmail MIME text/plain; deterministically simplify HTML when plain is missing.
 * Gmail / Composio do not expose a "plaintext only" fetch — extraction is client-side.
 */

const HTML_ENTITY_MAP: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  "#39": "'",
};

/** True when a string is likely HTML markup, not human plain text. */
export function looksLikeHtml(text: string): boolean {
  const t = text.trim().slice(0, 512).toLowerCase();
  if (!t) return false;
  if (t.startsWith("<!doctype") || t.startsWith("<html")) return true;
  if (/<head[\s>]/i.test(t) || /<body[\s>]/i.test(t)) return true;
  const tagCount = (t.match(/<[a-z][a-z0-9]*[\s>]/gi) ?? []).length;
  return tagCount >= 2;
}

function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    const key = body.toLowerCase();
    if (HTML_ENTITY_MAP[key] !== undefined) return HTML_ENTITY_MAP[key]!;
    if (key.startsWith("#x")) {
      const code = Number.parseInt(key.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (key.startsWith("#")) {
      const code = Number.parseInt(key.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return match;
  });
}

/**
 * Deterministic HTML → readable plain text (no external deps).
 * Preserves paragraph breaks better than tag-stripping alone.
 */
export function htmlToPlainText(html: string): string {
  let s = html
    .replace(/\r\n/g, "\n")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, "");

  s = s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|table|section|article|blockquote)>/gi, "\n")
    .replace(/<(p|div|tr|li|h[1-6]|table|section|article|blockquote)(\s[^>]*)?>/gi, "\n");

  s = s.replace(/<[^>]+>/g, " ");
  s = decodeHtmlEntities(s);
  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n[ \t]+/g, "\n");
  s = s.replace(/[ \t]{2,}/g, " ");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

/** Normalize plain text part (fix CRLF, trim trailing spaces per line). */
export function normalizePlainText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export type CollectedMimeBodies = {
  plain: string[];
  html: string[];
};

function decodeBase64Url(raw: string): string {
  const normalized = raw.replace(/-/g, "+").replace(/_/g, "/");
  const pad = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  return Buffer.from(normalized + pad, "base64").toString("utf8");
}

function partDecodedBody(part: Record<string, unknown>): string {
  const body = part.body as Record<string, unknown> | undefined;
  const data = typeof body?.data === "string" ? body.data : "";
  if (!data) return "";
  try {
    return decodeBase64Url(data);
  } catch {
    return "";
  }
}

function collectFromParts(parts: unknown[], out: CollectedMimeBodies): void {
  for (const p of parts) {
    if (!p || typeof p !== "object") continue;
    const part = p as Record<string, unknown>;
    const mime = typeof part.mimeType === "string" ? part.mimeType.toLowerCase() : "";
    const nested = part.parts;
    if (Array.isArray(nested)) {
      collectFromParts(nested, out);
      continue;
    }
    const text = partDecodedBody(part);
    if (!text.trim()) continue;
    if (mime === "text/plain") out.plain.push(text);
    else if (mime === "text/html") out.html.push(text);
  }
}

/** Walk Gmail API payload tree; prefer text/plain parts over HTML. */
export function collectBodiesFromPayload(payload: Record<string, unknown>): CollectedMimeBodies {
  const out: CollectedMimeBodies = { plain: [], html: [] };
  if (Array.isArray(payload.parts)) {
    collectFromParts(payload.parts, out);
  }
  const rootMime = typeof payload.mimeType === "string" ? payload.mimeType.toLowerCase() : "";
  const rootBody = partDecodedBody(payload);
  if (rootBody.trim()) {
    if (rootMime === "text/plain") out.plain.push(rootBody);
    else if (rootMime === "text/html") out.html.push(rootBody);
    else if (looksLikeHtml(rootBody)) out.html.push(rootBody);
    else out.plain.push(rootBody);
  }
  return out;
}

/** Pick best human-readable body from collected MIME parts. */
export function resolveBodyFromMime(collected: CollectedMimeBodies): string {
  const plainJoined = collected.plain.map(normalizePlainText).filter(Boolean).join("\n\n").trim();
  if (plainJoined) return plainJoined;

  if (collected.html.length === 0) return "";

  const bestHtml = collected.html.reduce((a, b) => (b.length > a.length ? b : a), "");
  return htmlToPlainText(bestHtml);
}

/** Normalize a direct string field from Composio (may be plain or HTML). */
export function normalizeDirectBodyField(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  if (looksLikeHtml(trimmed)) return htmlToPlainText(trimmed);
  return normalizePlainText(trimmed);
}
