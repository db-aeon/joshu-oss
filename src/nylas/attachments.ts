/**
 * Resolve outbound Nylas attachments from box-local paths (Hermes Desktop sandbox).
 */
import fs from "node:fs";
import path from "node:path";

/** Prepared attachment for Nylas SDK (direct mode). */
export type NylasSendAttachment = {
  filename: string;
  contentType: string;
  content: Buffer;
  size: number;
};

/** JSON-safe attachment for control-plane relay. */
export type NylasSendAttachmentWire = {
  filename: string;
  contentType: string;
  contentBase64: string;
  size: number;
};

const DEFAULT_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const DEFAULT_MAX_ATTACHMENTS = 5;

const MIME_BY_EXT: Record<string, string> = {
  pdf: "application/pdf",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ppt: "application/vnd.ms-powerpoint",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  doc: "application/msword",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  txt: "text/plain",
  csv: "text/csv",
  md: "text/markdown",
  zip: "application/zip",
};

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function maxAttachmentBytes(): number {
  const raw = process.env.JOSHU_NYLAS_MAX_ATTACHMENT_BYTES?.trim();
  if (!raw) return DEFAULT_MAX_ATTACHMENT_BYTES;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_ATTACHMENT_BYTES;
}

function maxAttachments(): number {
  const raw = process.env.JOSHU_NYLAS_MAX_ATTACHMENTS?.trim();
  if (!raw) return DEFAULT_MAX_ATTACHMENTS;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_ATTACHMENTS;
}

function guessContentType(filePath: string, override?: string): string {
  const trimmed = override?.trim();
  if (trimmed) return trimmed;
  const ext = path.extname(filePath).replace(/^\./, "").toLowerCase();
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

function basenameFromPath(filePath: string): string {
  const base = path.basename(filePath);
  return base || "attachment";
}

/** Normalize agent path to a file under desktopRoot (path traversal safe). */
export function resolveAttachmentPath(desktopRoot: string, rawPath: string): string {
  const trimmed = rawPath.trim();
  if (!trimmed) throw new Error("attachment path is empty");

  const sandbox = path.resolve(desktopRoot);
  let candidate: string;
  if (path.isAbsolute(trimmed)) {
    candidate = path.resolve(trimmed);
  } else {
    const rel = trimmed.replace(/^Desktop[/\\]/i, "").replace(/^\.[/\\]/, "");
    candidate = path.resolve(sandbox, rel);
  }

  if (candidate !== sandbox && !candidate.startsWith(`${sandbox}${path.sep}`)) {
    throw new Error(`attachment path must be under Desktop sandbox: ${rawPath}`);
  }
  if (!fs.existsSync(candidate)) {
    throw new Error(`attachment not found: ${rawPath}`);
  }
  const stat = fs.statSync(candidate);
  if (!stat.isFile()) {
    throw new Error(`attachment is not a file: ${rawPath}`);
  }
  return candidate;
}

function parseAttachmentEntry(raw: unknown): { path: string; filename?: string; contentType?: string } {
  if (typeof raw === "string") {
    const pathValue = raw.trim();
    if (!pathValue) throw new Error("attachment path is empty");
    return { path: pathValue };
  }
  if (raw && typeof raw === "object") {
    const row = raw as Record<string, unknown>;
    const pathValue = readString(row.path) || readString(row.file) || readString(row.filePath);
    if (!pathValue) throw new Error("attachment object requires path");
    return {
      path: pathValue,
      filename: readString(row.filename) || readString(row.name) || undefined,
      contentType: readString(row.contentType) || readString(row.content_type) || undefined,
    };
  }
  throw new Error("attachment must be a path string or { path, filename?, contentType? }");
}

/** Load attachments from MCP/REST payload paths relative to ArozOS Desktop. */
export function loadNylasSendAttachments(
  raw: unknown,
  desktopRoot: string | null | undefined,
): NylasSendAttachment[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    throw new Error("attachments must be an array");
  }
  if (raw.length === 0) return [];
  if (!desktopRoot) {
    throw new Error("JOSHU_DESKTOP_ROOT unavailable — cannot resolve attachment paths");
  }

  const limit = maxAttachments();
  if (raw.length > limit) {
    throw new Error(`at most ${limit} attachments per send`);
  }

  const maxBytes = maxAttachmentBytes();
  const out: NylasSendAttachment[] = [];

  for (const entry of raw) {
    const spec = parseAttachmentEntry(entry);
    const resolved = resolveAttachmentPath(desktopRoot, spec.path);
    const stat = fs.statSync(resolved);
    if (stat.size > maxBytes) {
      throw new Error(
        `attachment too large (${stat.size} bytes; max ${maxBytes}): ${spec.path}`,
      );
    }
    const content = fs.readFileSync(resolved);
    out.push({
      filename: spec.filename || basenameFromPath(resolved),
      contentType: guessContentType(resolved, spec.contentType),
      content,
      size: content.length,
    });
  }

  return out;
}

export function attachmentWireFromBuffer(att: NylasSendAttachment): NylasSendAttachmentWire {
  return {
    filename: att.filename,
    contentType: att.contentType,
    contentBase64: att.content.toString("base64"),
    size: att.size,
  };
}

export function attachmentSummaryNames(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const names: string[] = [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      names.push(basenameFromPath(entry.trim()));
      continue;
    }
    if (entry && typeof entry === "object") {
      const row = entry as Record<string, unknown>;
      const name =
        readString(row.filename) ||
        readString(row.name) ||
        basenameFromPath(readString(row.path) || readString(row.file) || "attachment");
      names.push(name);
    }
  }
  return names.length > 0 ? names : undefined;
}
