/**
 * RFC 5322 Message-ID header — stable across Gmail + Nylas copies of the same send.
 */
export type MailHeader = { name?: string; value?: string };

/** Normalize `<abc@mail.gmail.com>` → `abc@mail.gmail.com` (lowercase). */
export function normalizeRfcMessageId(raw?: string | null): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  const unwrapped = trimmed.replace(/^<+/, "").replace(/>+$/, "").trim().toLowerCase();
  if (!unwrapped || !unwrapped.includes("@")) return null;
  return unwrapped;
}

export function parseRfcMessageIdFromHeaders(headers: MailHeader[]): string | null {
  const key = "message-id";
  const hit = headers.find((h) => h.name?.toLowerCase() === key);
  return normalizeRfcMessageId(hit?.value);
}

/** Prefix for dedup / idempotency keys derived from RFC Message-ID. */
export function rfcMessageDedupKey(normalizedRfcId: string): string {
  return `rfc:${normalizedRfcId}`;
}
