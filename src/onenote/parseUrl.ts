/** Parsed identifiers from a OneNote Online / OneDrive Doc.aspx URL. */
export type ParsedOneNoteUrl = {
  notebookName?: string;
  sectionId?: string;
  pageTitle?: string;
  pageId?: string;
  /** Notebook file id from sourcedoc={...} when present. */
  sourcedoc?: string;
};

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const WD_TARGET_RE =
  /^target\((.+)\|([0-9a-f-]{36})\/(.+)\|([0-9a-f-]{36})\/?\)$/i;

/** OneDrive wd=target encodes slashes/parens as \/ and \) in page titles. */
export function normalizeWdPageTitle(raw: string): string {
  return raw
    .replace(/\\\//g, "/")
    .replace(/\\\)/g, ")")
    .replace(/\\\(/g, "(")
    .trim();
}

/**
 * Extract section/page IDs from OneDrive Doc.aspx `wd=target(...)` links.
 *
 * Example decoded target:
 *   WC Transition Notes.one|{sectionId}/<page title>|{pageId}/
 */
export function parseOneNoteUrl(url: string): ParsedOneNoteUrl {
  const result: ParsedOneNoteUrl = {};

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return result;
  }

  const sourcedoc = parsed.searchParams.get("sourcedoc");
  if (sourcedoc) {
    result.sourcedoc = sourcedoc.replace(/[{}]/g, "");
  }

  const wd = parsed.searchParams.get("wd");
  if (wd) {
    // URLSearchParams already percent-decodes; avoid double-decode (breaks \) in titles).
    const decoded = wd;
    const match = decoded.match(WD_TARGET_RE);
    if (match) {
      result.notebookName = match[1];
      result.sectionId = match[2];
      result.pageTitle = normalizeWdPageTitle(match[3] ?? "");
      result.pageId = match[4];
    }
  }

  // Fallback: scan query/path for bare UUIDs (page id is usually last).
  if (!result.pageId) {
    const hits = `${parsed.pathname}?${parsed.search}`.match(new RegExp(UUID_RE.source, "gi"));
    if (hits?.length) {
      result.pageId = hits[hits.length - 1];
    }
  }

  return result;
}

export function requirePageId(urlOrId: string): string {
  const trimmed = urlOrId.trim();
  if (UUID_RE.test(trimmed) && !trimmed.includes("/") && !trimmed.includes("?")) {
    return trimmed;
  }
  const parsed = parseOneNoteUrl(trimmed);
  if (!parsed.pageId) {
    throw new Error(
      "Could not find a OneNote page id in the URL. Pass --page-id directly or use a Doc.aspx wd=target(...) link.",
    );
  }
  return parsed.pageId;
}
