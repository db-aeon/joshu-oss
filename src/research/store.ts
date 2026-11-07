/**
 * The report store: each Research report is one folder `<files>/Research/<YYYY-MM-DD>-<topic slug>`
 * with `report.pdf`, `report.html`, `report.json`, and `stories.json`. The folder name is the report identifier.
 * Earlier Research reports are found by a scan of the folders, so no index can go stale.
 * Design decision D6 of change research-reports.
 */

import { themesEmailText } from "./themes/text.js";
import fs from "node:fs";
import path from "node:path";
import { resolveJoshuFilesPaths } from "../joshuFilesPaths.js";
import type { ReportText } from "./pipeline/write.js";
import type { Research, SourceState } from "./types.js";

export const RESEARCH_DIR_NAME = "Research";
export const REPORT_SCHEMA_VERSION = 2;
/** Report identifiers: a date and a topic slug, with an optional repeat suffix. */
export const REPORT_ID_PATTERN = /^\d{4}-\d{2}-\d{2}-[a-z0-9-]+$/;
const SLUG_MAX = 60;

export type ReportRoots = {
  /** `<files>`: the folder `joshu's files` of the owner. */
  filesRoot: string;
  /** The Desktop of the owner. Mail attachments are relative to it. */
  desktopRoot: string;
};

/**
 * The data file of one Research report (`report.json`, schema 2 since promise change P7): the plan,
 * the pages read, the facts, the social posts, and the text. The follow-up report of a later change
 * compares two of them. Pictures are stored as their source URLs, not as data.
 */
export type ReportData = {
  schemaVersion: number;
  id: string;
  topic: string;
  requestedAt: string;
  research: Research;
  text: ReportText;
  pictures: { section: number; pageUrl: string; site: string; alt: string }[];
};

export type StoredReport = {
  id: string;
  topic: string;
  requestedAt: string;
  summary: string;
  /**
   * The body of the email answer: the summary and the headline, first paragraph, and lead link of
   * each theme (change research-report-topics, D10), or the summary for an older report.
   */
  emailBody: string;
  sources: SourceState[];
  folder: string;
  pdfPath: string;
  /** PDF path relative to the Desktop, for mail attachments (`nylas_send_message`). */
  pdfDesktopPath: string;
  /** PDF path relative to `<files>`, for `desktop_open` with kind `file`. */
  pdfFilesPath: string;
};

/** The roots of the owner on this box, or null when the box has no owner Desktop. */
export function resolveReportRoots(projectRoot = process.cwd()): ReportRoots | null {
  const paths = resolveJoshuFilesPaths(projectRoot);
  return paths ? { filesRoot: paths.filesRoot, desktopRoot: paths.desktopRoot } : null;
}

export function researchDir(roots: ReportRoots): string {
  return path.join(roots.filesRoot, RESEARCH_DIR_NAME);
}

export function slugifyTopic(topic: string): string {
  const slug = topic
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, "");
  return slug || "topic";
}

/** A new report identifier: `<day>-<slug>`, then `-2`, `-3` when that folder exists. */
export function newReportId(roots: ReportRoots, topic: string, day: string): string {
  const base = `${day}-${slugifyTopic(topic)}`;
  const dir = researchDir(roots);
  if (!fs.existsSync(path.join(dir, base))) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!fs.existsSync(path.join(dir, candidate))) return candidate;
  }
}

/** The folder of a report identifier, or null when the identifier is not valid. */
export function reportFolder(roots: ReportRoots, id: string): string | null {
  if (!REPORT_ID_PATTERN.test(id)) return null;
  const dir = path.resolve(researchDir(roots));
  const folder = path.resolve(dir, id);
  return path.dirname(folder) === dir ? folder : null;
}

function storedFromData(roots: ReportRoots, data: ReportData): StoredReport {
  const folder = path.join(researchDir(roots), data.id);
  const pdfPath = path.join(folder, "report.pdf");
  return {
    id: data.id,
    topic: data.topic,
    requestedAt: data.requestedAt,
    summary: data.text.summary,
    emailBody: data.text.themes.some((t) => t.links) ? themesEmailText(data.text.overview, data.text.themes, { firstParagraph: true }) : data.text.summary,
    sources: data.research.sources,
    folder,
    pdfPath,
    pdfDesktopPath: path.relative(roots.desktopRoot, pdfPath).split(path.sep).join("/"),
    pdfFilesPath: `${RESEARCH_DIR_NAME}/${data.id}/report.pdf`,
  };
}

/**
 * Write the files of a Research report into a temporary folder, then rename it to the folder of the
 * report. A failure leaves no report folder. `stories` is `stories.json`, the stored stories that a
 * repeat request compares with (change recurring-research-reports, design decision D4).
 */
export async function saveReport(
  roots: ReportRoots,
  data: ReportData,
  html: string,
  writePdf: (htmlPath: string, pdfPath: string) => Promise<void>,
  stories?: unknown,
): Promise<StoredReport> {
  const dir = researchDir(roots);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(dir, ".tmp-"));
  try {
    const htmlPath = path.join(tmp, "report.html");
    fs.writeFileSync(htmlPath, html);
    fs.writeFileSync(path.join(tmp, "report.json"), `${JSON.stringify(data, null, 2)}\n`);
    if (stories) fs.writeFileSync(path.join(tmp, "stories.json"), `${JSON.stringify(stories, null, 2)}\n`);
    await writePdf(htmlPath, path.join(tmp, "report.pdf"));
    fs.renameSync(tmp, path.join(dir, data.id));
  } catch (err) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw err;
  }
  return storedFromData(roots, data);
}

/** Read one Research report by its identifier, or null. */
export function readReport(roots: ReportRoots, id: string): StoredReport | null {
  const folder = reportFolder(roots, id);
  if (!folder) return null;
  try {
    const data = JSON.parse(fs.readFileSync(path.join(folder, "report.json"), "utf8")) as ReportData;
    if (data.id !== id || !fs.existsSync(path.join(folder, "report.pdf"))) return null;
    return storedFromData(roots, data);
  } catch {
    return null;
  }
}

/** Every Research report of the owner, the newest first. */
export function listReports(roots: ReportRoots): StoredReport[] {
  const dir = researchDir(roots);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => REPORT_ID_PATTERN.test(name))
    .map((id) => readReport(roots, id))
    .filter((r): r is StoredReport => r !== null)
    .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !["the", "and", "of", "on", "about", "report", "research"].includes(w));
}

/**
 * Find earlier Research reports by topic words and by date. A query matches a report when each
 * of its words is in the topic or the identifier of the report, or when it names the day of the
 * report (`2026-11-02`). An empty query lists every Research report.
 */
export function findReports(roots: ReportRoots, query: string): StoredReport[] {
  const all = listReports(roots);
  const q = query.trim();
  if (!q) return all;
  const day = q.match(/\d{4}-\d{2}-\d{2}/)?.[0];
  const qWords = words(q.replace(/\d{4}-\d{2}-\d{2}/, ""));
  return all.filter((report) => {
    if (day && !report.id.startsWith(day)) return false;
    const haystack = new Set([...words(report.topic), ...words(report.id)]);
    return qWords.every((w) => haystack.has(w) || [...haystack].some((h) => h.startsWith(w) || w.startsWith(h)));
  });
}
