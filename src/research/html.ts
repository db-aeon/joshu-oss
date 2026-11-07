/** Escape text for HTML and SVG text and attribute values. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Brand colors of Joshu (the same tokens as `@joshu/email-signature`). */
export const BRAND = {
  ink: "#0d0d0d",
  inkMuted: "#5c534c",
  paper: "#f5f0eb",
  rose: "#c8a2a6",
  action: "#0057ff",
  rule: "#ddd3c9",
} as const;
