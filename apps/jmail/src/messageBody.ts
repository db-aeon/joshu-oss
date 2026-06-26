/** Detect whether Nylas returned an HTML body (full doc or fragment). */
export function isHtmlEmailBody(body: string): boolean {
  const sample = body.trim().slice(0, 8000);
  if (/^<!doctype html|^<html[\s>]/i.test(sample)) return true;
  return /<(div|table|p|br|span|blockquote|style|a|h[1-6]|ul|ol|li|td|tr|img|body)\b/i.test(sample);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Turn bare URLs in plain text into safe links. */
function linkifyPlainText(text: string): string {
  const urlRe = /(\bhttps?:\/\/[^\s<]+|\bwww\.[^\s<]+)/gi;
  return escapeHtml(text).replace(urlRe, (url) => {
    const href = url.startsWith("www.") ? `https://${url}` : url;
    return `<a href="${href}" target="_blank" rel="noopener noreferrer">${url}</a>`;
  });
}

const EMAIL_DOC_STYLES = `
  body {
    font-family: ui-sans-serif, system-ui, sans-serif;
    font-size: 14px;
    line-height: 1.5;
    margin: 12px;
    color: #111;
    word-wrap: break-word;
  }
  img { max-width: 100%; height: auto; }
  a { color: #0057ff; }
  blockquote {
    margin: 0.5em 0 0.5em 0.75em;
    padding-left: 0.75em;
    border-left: 2px solid #ccc;
    color: #555;
  }
`;

/** Build a srcDoc-safe HTML document for iframe rendering. */
export function prepareEmailBodyDocument(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return "";

  if (isHtmlEmailBody(trimmed)) {
    if (/^<!doctype html|^<html[\s>]/i.test(trimmed)) return trimmed;
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><base target="_blank" rel="noopener noreferrer"><style>${EMAIL_DOC_STYLES}</style></head><body>${trimmed}</body></html>`;
  }

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>${EMAIL_DOC_STYLES} body { white-space: pre-wrap; }</style></head><body>${linkifyPlainText(body)}</body></html>`;
}
