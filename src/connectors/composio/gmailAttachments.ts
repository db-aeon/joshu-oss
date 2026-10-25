/**
 * Gmail mail attachments: attachment metadata from Composio / Gmail API message payloads,
 * and on-demand fetch of one mail attachment into a project folder.
 * Spec: openspec mail-attachments (change gmail-attachments).
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { normalizeProjectSlug } from "../../ea/mailTypes.js";
import type { MailAttachmentMeta } from "../mirror.js";
import { parseHeaderValue, type GmailHeader } from "./gmailBodies.js";

/** Attachment metadata of one mail attachment (camelCase for code; mirror uses MailAttachmentMeta). */
export type GmailAttachment = {
  filename: string;
  contentType?: string;
  size?: number;
  messageId: string;
  attachmentId: string;
  partId?: string;
};

/** Same default as JOSHU_NYLAS_MAX_ATTACHMENT_BYTES, so a fetched file can be sent again. */
export const DEFAULT_GMAIL_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export function gmailMaxAttachmentBytes(): number {
  const raw = process.env.JOSHU_GMAIL_MAX_ATTACHMENT_BYTES?.trim();
  if (!raw) return DEFAULT_GMAIL_MAX_ATTACHMENT_BYTES;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_GMAIL_MAX_ATTACHMENT_BYTES;
}

/** Error with an HTTP status for the Joshu API endpoint. */
export class GmailAttachmentError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly attachments?: GmailAttachment[],
  ) {
    super(message);
  }
}

function readStr(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readSize(value: unknown): number | undefined {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Inline images (signature logos, pasted pictures) are not mail attachments. */
function isInlineImage(part: Record<string, unknown>, contentType: string): boolean {
  if (!contentType.toLowerCase().startsWith("image/")) return false;
  const headers = Array.isArray(part.headers) ? (part.headers as GmailHeader[]) : [];
  const disposition = parseHeaderValue(headers, "Content-Disposition") ?? "";
  return /^\s*inline\b/i.test(disposition);
}

/** Walk the MIME tree. Returns the number of file parts seen, inline images included. */
function collectFromPayload(
  part: Record<string, unknown>,
  messageId: string,
  out: GmailAttachment[],
): number {
  let seen = 0;
  const filename = readStr(part.filename);
  const body = asRecord(part.body);
  const attachmentId = readStr(body?.attachmentId ?? body?.attachment_id);
  const contentType = readStr(part.mimeType ?? part.mime_type);
  if (filename && attachmentId) seen += 1;
  if (filename && attachmentId && !isInlineImage(part, contentType)) {
    out.push({
      filename,
      ...(contentType ? { contentType } : {}),
      ...(readSize(body?.size) != null ? { size: readSize(body?.size) } : {}),
      messageId,
      attachmentId,
      ...(readStr(part.partId) ? { partId: readStr(part.partId) } : {}),
    });
  }
  if (Array.isArray(part.parts)) {
    for (const child of part.parts) {
      const rec = asRecord(child);
      if (rec) seen += collectFromPayload(rec, messageId, out);
    }
  }
  return seen;
}

function collectFromAttachmentList(
  list: unknown,
  messageId: string,
  out: GmailAttachment[],
): void {
  if (!Array.isArray(list)) return;
  for (const item of list) {
    const rec = asRecord(item);
    if (!rec) continue;
    const filename = readStr(rec.filename ?? rec.fileName ?? rec.name);
    const attachmentId = readStr(rec.attachmentId ?? rec.attachment_id ?? rec.id);
    if (!filename || !attachmentId) continue;
    const contentType = readStr(rec.mimeType ?? rec.mime_type ?? rec.contentType);
    const size = readSize(rec.size);
    out.push({
      filename,
      ...(contentType ? { contentType } : {}),
      ...(size != null ? { size } : {}),
      messageId,
      attachmentId,
    });
  }
}

/**
 * Attachment metadata of one Gmail message. Reads the MIME tree of `payload`;
 * when the MIME tree has no file part at all, reads the Composio field `attachmentList`
 * (which cannot tell inline images from mail attachments).
 */
export function parseGmailAttachments(row: Record<string, unknown>, messageId: string): GmailAttachment[] {
  const out: GmailAttachment[] = [];
  const payload = asRecord(row.payload);
  const seen = payload ? collectFromPayload(payload, messageId, out) : 0;
  if (seen === 0) {
    collectFromAttachmentList(row.attachmentList ?? row.attachment_list ?? row.attachments, messageId, out);
  }
  return out;
}

/** Front matter shape (snake_case) for `thread_messages[].attachments`. */
export function toMirrorAttachmentMeta(att: GmailAttachment): MailAttachmentMeta {
  return {
    filename: att.filename,
    ...(att.contentType ? { content_type: att.contentType } : {}),
    ...(att.size != null ? { size: att.size } : {}),
    message_id: att.messageId,
    attachment_id: att.attachmentId,
  };
}

export function formatAttachmentSize(size: number | undefined): string {
  if (size == null) return "size unknown";
  if (size < 1024) return `${size} bytes`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/** Body list under the text of one message in the mail mirror. Empty string when no mail attachments. */
export function formatAttachmentListMarkdown(attachments: GmailAttachment[] | undefined): string {
  if (!attachments?.length) return "";
  const lines = attachments.map(
    (a) =>
      `- ${a.filename} (${a.contentType ?? "unknown type"}, ${formatAttachmentSize(a.size)}) — gmail_fetch_attachment messageId=${a.messageId}`,
  );
  return `**Attachments:**\n${lines.join("\n")}`;
}

/** Select by attachment id, then file name (exact, then without case), then the only mail attachment. */
export function selectGmailAttachment(
  attachments: GmailAttachment[],
  opts: { attachmentId?: string; filename?: string },
): GmailAttachment | null {
  const attachmentId = opts.attachmentId?.trim();
  const filename = opts.filename?.trim();
  if (attachmentId) {
    const byId = attachments.find((a) => a.attachmentId === attachmentId);
    if (byId) return byId;
    // Gmail can return a new attachment id on a later read; fall back to the file name
    // or to the only mail attachment.
    if (!filename) {
      if (attachments.length === 1) return attachments[0]!;
      throw new GmailAttachmentError(
        `attachment id not found on message; attachments: ${listNames(attachments)}`,
        404,
        attachments,
      );
    }
  }
  if (filename) {
    const exact = attachments.find((a) => a.filename === filename);
    if (exact) return exact;
    const lower = filename.toLowerCase();
    const loose = attachments.find((a) => a.filename.toLowerCase() === lower);
    if (loose) return loose;
    throw new GmailAttachmentError(
      `no attachment named ${JSON.stringify(filename)} on message; attachments: ${listNames(attachments)}`,
      404,
      attachments,
    );
  }
  return attachments.length === 1 ? attachments[0]! : null;
}

function listNames(attachments: GmailAttachment[]): string {
  return attachments.length > 0 ? attachments.map((a) => a.filename).join(", ") : "(none)";
}

/** Safe base name: no folder parts, no "..", only [A-Za-z0-9._- ] characters, at most 120 characters. */
export function safeAttachmentFilename(raw: string): string {
  const base = raw.split(/[/\\]/).pop() ?? "";
  let safe = base.replace(/[^A-Za-z0-9._ -]+/g, "_").trim();
  safe = safe.replace(/^\.+/, "");
  if (safe.length > 120) {
    const ext = path.extname(safe).slice(0, 20);
    safe = `${safe.slice(0, 120 - ext.length)}${ext}`;
  }
  return safe || "attachment";
}

type DecodedAttachment = { bytes: Buffer } | { url: string };

const URL_KEYS = ["s3url", "s3Url", "s3_url", "url", "downloadUrl", "download_url"] as const;
const BASE64_RE = /^[A-Za-z0-9+/_=\-\s]+$/;

function findDecoded(value: unknown, depth: number): DecodedAttachment | null {
  const rec = asRecord(value);
  if (!rec || depth > 4) return null;
  for (const key of URL_KEYS) {
    const url = readStr(rec[key]);
    if (/^https?:\/\//i.test(url)) return { url };
  }
  const data = rec.data;
  if (typeof data === "string" && data.trim() && BASE64_RE.test(data)) {
    return { bytes: Buffer.from(data.replace(/\s+/g, ""), "base64") };
  }
  for (const key of ["data", "file", "attachment", "response_data"]) {
    const nested = findDecoded(rec[key], depth + 1);
    if (nested) return nested;
  }
  return null;
}

/**
 * Read the GMAIL_GET_ATTACHMENT response: base64 / base64url text in `data`,
 * or a file object with a download URL (Composio file output without automatic download).
 */
export function decodeGmailAttachmentResponse(data: unknown): DecodedAttachment {
  const found = findDecoded(data, 0);
  if (found) return found;
  const keys = asRecord(data) ? Object.keys(asRecord(data)!).join(", ") : typeof data;
  throw new GmailAttachmentError(
    `GMAIL_GET_ATTACHMENT response has no file data (keys: ${keys})`,
    502,
  );
}

function tooLarge(size: number, maxBytes: number, filename: string): GmailAttachmentError {
  return new GmailAttachmentError(
    `attachment too large (${size} bytes; max ${maxBytes}): ${filename}`,
    413,
  );
}

/** Download a URL and stop when the bytes go above maxBytes. */
export async function downloadWithLimit(
  url: string,
  maxBytes: number,
  filename: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Buffer> {
  const res = await fetchImpl(url);
  if (!res.ok) {
    throw new GmailAttachmentError(`attachment download failed: HTTP ${res.status}`, 502);
  }
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge(declared, maxBytes, filename);
  if (!res.body) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw tooLarge(buf.length, maxBytes, filename);
    return buf;
  }
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = res.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge(total, maxBytes, filename);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

async function sameBytes(filePath: string, bytes: Buffer): Promise<boolean> {
  const info = await stat(filePath);
  if (info.size !== bytes.length) return false;
  const existing = await readFile(filePath);
  return existing.equals(bytes);
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/**
 * Write bytes to <filesRoot>/Projects/<project slug>/attachments/<safe name>.
 * Same bytes under the same name → keep the file. Different bytes → add -2, -3, … before the extension.
 */
export async function saveAttachmentToProject(opts: {
  filesRoot: string;
  projectSlug?: string;
  filename: string;
  bytes: Buffer;
}): Promise<{ absolutePath: string; path: string; projectSlug: string; savedFilename: string; alreadyPresent: boolean }> {
  const projectSlug = normalizeProjectSlug(opts.projectSlug);
  const dir = path.join(opts.filesRoot, "Projects", projectSlug, "attachments");
  await mkdir(dir, { recursive: true });
  const safe = safeAttachmentFilename(opts.filename);
  const ext = path.extname(safe);
  const stem = ext ? safe.slice(0, -ext.length) : safe;

  for (let n = 1; n <= 1000; n++) {
    const name = n === 1 ? safe : `${stem}-${n}${ext}`;
    const absolutePath = path.join(dir, name);
    const rel = path.relative(opts.filesRoot, absolutePath).split(path.sep).join("/");
    if (await exists(absolutePath)) {
      if (await sameBytes(absolutePath, opts.bytes)) {
        return { absolutePath, path: rel, projectSlug, savedFilename: name, alreadyPresent: true };
      }
      continue;
    }
    const tmp = path.join(dir, `.${name}.${randomUUID().slice(0, 8)}.tmp`);
    await writeFile(tmp, opts.bytes);
    await rename(tmp, absolutePath);
    return { absolutePath, path: rel, projectSlug, savedFilename: name, alreadyPresent: false };
  }
  throw new GmailAttachmentError(`too many files named ${safe} in ${dir}`, 409);
}

export type GmailAttachmentFetchDeps = {
  /** Live mail attachments of the message (GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID). */
  listAttachments: (messageId: string) => Promise<GmailAttachment[]>;
  /** Raw GMAIL_GET_ATTACHMENT response data. */
  getAttachment: (att: GmailAttachment) => Promise<unknown>;
  fetchImpl?: typeof fetch;
};

export type GmailAttachmentFetchResult =
  | { saved: false; messageId: string; attachments: GmailAttachment[]; hint: string }
  | {
      saved: true;
      messageId: string;
      attachmentId: string;
      filename: string;
      savedFilename: string;
      contentType?: string;
      size: number;
      projectSlug: string;
      /** Relative to JOSHU_FILES_ROOT. */
      path: string;
      /** Relative to the Desktop root — pass to nylas_send_message attachments. */
      desktopPath?: string;
      alreadyPresent: boolean;
    };

/** Fetch one mail attachment of a Gmail message into the project folder (design decisions 3–7). */
export async function fetchGmailAttachmentToProject(
  opts: {
    filesRoot: string;
    desktopRoot?: string;
    messageId: string;
    attachmentId?: string;
    filename?: string;
    projectSlug?: string;
    maxBytes?: number;
  },
  deps: GmailAttachmentFetchDeps,
): Promise<GmailAttachmentFetchResult> {
  const maxBytes = opts.maxBytes ?? gmailMaxAttachmentBytes();
  const attachments = await deps.listAttachments(opts.messageId);
  if (attachments.length === 0) {
    throw new GmailAttachmentError(`message ${opts.messageId} has no attachments`, 404, attachments);
  }
  const selected = selectGmailAttachment(attachments, {
    attachmentId: opts.attachmentId,
    filename: opts.filename,
  });
  if (!selected) {
    return {
      saved: false,
      messageId: opts.messageId,
      attachments,
      hint: "Call again with filename or attachmentId to save one attachment.",
    };
  }
  if (selected.size != null && selected.size > maxBytes) {
    throw tooLarge(selected.size, maxBytes, selected.filename);
  }

  const decoded = decodeGmailAttachmentResponse(await deps.getAttachment(selected));
  const bytes =
    "bytes" in decoded
      ? decoded.bytes
      : await downloadWithLimit(decoded.url, maxBytes, selected.filename, deps.fetchImpl);
  if (bytes.length > maxBytes) throw tooLarge(bytes.length, maxBytes, selected.filename);

  const saved = await saveAttachmentToProject({
    filesRoot: opts.filesRoot,
    projectSlug: opts.projectSlug,
    filename: selected.filename,
    bytes,
  });
  const desktopPath = opts.desktopRoot
    ? path.relative(opts.desktopRoot, saved.absolutePath).split(path.sep).join("/")
    : undefined;
  return {
    saved: true,
    messageId: selected.messageId,
    attachmentId: selected.attachmentId,
    filename: selected.filename,
    savedFilename: saved.savedFilename,
    ...(selected.contentType ? { contentType: selected.contentType } : {}),
    size: bytes.length,
    projectSlug: saved.projectSlug,
    path: saved.path,
    ...(desktopPath && !desktopPath.startsWith("..") ? { desktopPath } : {}),
    alreadyPresent: saved.alreadyPresent,
  };
}
