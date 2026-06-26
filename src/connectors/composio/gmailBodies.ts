/**
 * Extract plain text, dates, and addresses from Composio / Gmail API message payloads.
 */
import {
  collectBodiesFromPayload,
  looksLikeHtml,
  normalizeDirectBodyField,
  resolveBodyFromMime,
} from "../emailPlaintext.js";

export type GmailHeader = { name?: string; value?: string };

function headersFromRow(row: Record<string, unknown>): GmailHeader[] {
  const direct = row.headers;
  if (Array.isArray(direct)) return direct as GmailHeader[];
  const payload = row.payload as Record<string, unknown> | undefined;
  if (Array.isArray(payload?.headers)) return payload.headers as GmailHeader[];
  return [];
}

export function parseHeaderValue(headers: GmailHeader[], name: string): string | undefined {
  const key = name.toLowerCase();
  const hit = headers.find((h) => h.name?.toLowerCase() === key);
  return hit?.value?.trim() || undefined;
}

/** Normalize Gmail/Composio timestamps to milliseconds since epoch. */
export function coerceToEpochMs(value: unknown): number | undefined {
  if (value == null) return undefined;
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value > 1e12) return Math.floor(value);
    if (value > 1e9) return Math.floor(value * 1000);
    return undefined;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    if (/^\d+$/.test(trimmed)) return coerceToEpochMs(Number(trimmed));
    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function epochMsToIso(ms: number | undefined): string | undefined {
  if (ms == null || !Number.isFinite(ms)) return undefined;
  return new Date(ms).toISOString();
}

export function formatMessageDateLabel(ms: number | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "Unknown date";
  return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/**
 * Best-effort plain text body. Gmail has no plaintext-only API — we prefer MIME
 * text/plain, then simplified HTML, then Composio direct fields (with HTML cleanup).
 */
export function extractMessageBody(row: Record<string, unknown>): string {
  const payload = row.payload as Record<string, unknown> | undefined;
  if (payload) {
    const fromMime = resolveBodyFromMime(collectBodiesFromPayload(payload));
    if (fromMime) return fromMime;
  }

  // Composio convenience fields — order prefers explicit plain aliases first.
  const fieldOrder = ["textPlain", "text_plain", "messageText", "message_text", "body", "preview"] as const;
  for (const key of fieldOrder) {
    const val = row[key];
    if (typeof val !== "string" || !val.trim()) continue;
    const normalized = normalizeDirectBodyField(val);
    if (normalized && !looksLikeHtml(normalized)) return normalized;
  }

  // Last pass: HTML in body/preview after failed MIME walk.
  for (const key of ["body", "preview"] as const) {
    const val = row[key];
    if (typeof val === "string" && val.trim()) {
      const normalized = normalizeDirectBodyField(val);
      if (normalized) return normalized;
    }
  }

  const data = row.data as Record<string, unknown> | undefined;
  if (data && typeof data.body === "string") {
    const normalized = normalizeDirectBodyField(data.body);
    if (normalized) return normalized;
  }

  return typeof row.snippet === "string" ? row.snippet.trim() : "";
}

/** Split RFC To/Cc/Bcc header or Composio recipient fields into bare emails. */
export function parseEmailList(raw: string): string[] {
  const out = new Set<string>();
  for (const part of raw.split(/[,;]/)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const angle = /<([^>]+)>/.exec(trimmed);
    const addr = (angle ? angle[1]! : trimmed).trim().toLowerCase();
    if (addr.includes("@")) out.add(addr);
  }
  return [...out];
}

function recipientListFromRowField(value: unknown): string[] {
  if (typeof value === "string" && value.trim()) return parseEmailList(value);
  if (!Array.isArray(value)) return [];
  const emails: string[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      emails.push(...parseEmailList(item));
      continue;
    }
    if (item && typeof item === "object") {
      const row = item as Record<string, unknown>;
      const email =
        typeof row.email === "string"
          ? row.email
          : typeof row.emailAddress === "string"
            ? row.emailAddress
            : typeof row.address === "string"
              ? row.address
              : "";
      if (email.trim()) emails.push(email.trim().toLowerCase());
    }
  }
  return emails;
}

/** To / Cc / Bcc from Gmail headers or Composio payload fields. */
export function parseRecipientAddresses(
  row: Record<string, unknown>,
  headerName: "To" | "Cc" | "Bcc",
): string[] {
  const headers = headersFromRow(row);
  const fromHeader = parseHeaderValue(headers, headerName);
  if (fromHeader) return parseEmailList(fromHeader);

  const key = headerName.toLowerCase();
  const direct = row[key] ?? row[`${key}Recipients`] ?? row[`${key}_recipients`];
  if (direct != null) return recipientListFromRowField(direct);

  const payload = row.payload as Record<string, unknown> | undefined;
  if (payload?.[key] != null) return recipientListFromRowField(payload[key]);

  return [];
}

export function parseSender(row: Record<string, unknown>): string | undefined {
  if (typeof row.sender === "string") return row.sender;
  if (typeof row.from === "string") return row.from;
  const headers = headersFromRow(row);
  const from = parseHeaderValue(headers, "From");
  if (from) return from;
  const fromField = row.from as Record<string, unknown> | undefined;
  if (fromField && typeof fromField.email === "string") {
    const name = typeof fromField.name === "string" ? fromField.name : "";
    return name ? `${name} <${fromField.email}>` : fromField.email;
  }
  return undefined;
}

export function parseSubject(row: Record<string, unknown>): string | undefined {
  if (typeof row.subject === "string" && row.subject.trim()) return row.subject.trim();
  const headers = headersFromRow(row);
  return parseHeaderValue(headers, "Subject");
}

export function parseRfcMessageId(row: Record<string, unknown>): string | undefined {
  const headers = headersFromRow(row);
  const fromHeaders = parseHeaderValue(headers, "Message-ID");
  if (fromHeaders) return fromHeaders;
  if (typeof row.messageIdHeader === "string") return row.messageIdHeader;
  if (typeof row.message_id_header === "string") return row.message_id_header;
  return undefined;
}

/** Gmail internalDate is ms since epoch; Composio may alias as time / messageTimestamp. */
export function parseInternalDate(row: Record<string, unknown>): number | undefined {
  const candidates = [
    row.messageTimestamp,
    row.internalDate,
    row.internal_date,
    row.time,
    row.timestamp,
    row.receivedTime,
    row.received_time,
    row.date,
  ];
  for (const c of candidates) {
    const ms = coerceToEpochMs(c);
    if (ms != null) return ms;
  }
  const headers = headersFromRow(row);
  const dateHdr = parseHeaderValue(headers, "Date");
  if (dateHdr) return coerceToEpochMs(dateHdr);
  return undefined;
}

// Re-export for tests and mirror helpers.
export { htmlToPlainText, looksLikeHtml, normalizePlainText } from "../emailPlaintext.js";
