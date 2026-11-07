/**
 * Report links (glossary: Report link): the signed public link that opens the PDF of one Research
 * report without a sign-in. The signature is HMAC-SHA256 over the report identifier with a per-box
 * secret, cut to 128 bits and written in base64url, so the report link has only ASCII characters
 * and no `;`. Design decision D10 of change research-reports.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { joshuConfigDir } from "../nylas/paths.js";
import { resolveJoshuPublicApiBase } from "../ownerChannel/publicUrl.js";
import { readReport, REPORT_ID_PATTERN, resolveReportRoots, type ReportRoots, type StoredReport } from "./store.js";

const SIGNATURE_BYTES = 16;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{22}$/;
/** Matches the path of a report link inside any text, for example an outbox message. */
const LINK_IN_TEXT = /\/api\/research\/r\/(\d{4}-\d{2}-\d{2}-[a-z0-9-]+)\/([A-Za-z0-9_-]{22})\/report\.pdf/g;
/**
 * The identifiers of report updates: the path of the folder of the update under
 * `<files>/Research/`, for a repeat request and for a recurring report (change
 * recurring-research-reports, design decision D9).
 */
export const UPDATE_ID_PATTERNS = [
  /^\d{4}-\d{2}-\d{2}-[a-z0-9-]+\/updates\/\d{4}-\d{2}-\d{2}-\d{4}$/,
  /^Recurring\/[a-z0-9-]+\/updates\/\d{4}-\d{2}-\d{2}-\d{4}$/,
] as const;
const UPDATE_LINK_IN_TEXT = /\/api\/research\/u\/((?:Recurring\/)?[a-z0-9-]+\/updates\/\d{4}-\d{2}-\d{2}-\d{4})\/([A-Za-z0-9_-]{22})\/update\.pdf/g;

export function isUpdateId(id: string): boolean {
  return UPDATE_ID_PATTERNS.some((p) => p.test(id));
}

export function linkSecretPath(projectRoot = process.cwd()): string {
  const base = joshuConfigDir(projectRoot) ?? path.join(projectRoot, ".joshu");
  return path.join(base, "research", "link-secret");
}

/** The per-box secret of the report links. Made at the first use: 32 random bytes, mode 0600. */
export function reportLinkSecret(projectRoot = process.cwd()): Buffer {
  const file = linkSecretPath(projectRoot);
  try {
    const hex = fs.readFileSync(file, "utf8").trim();
    if (/^[0-9a-f]{64}$/.test(hex)) return Buffer.from(hex, "hex");
  } catch {
    /* made below */
  }
  const secret = randomBytes(32);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${secret.toString("hex")}\n`, { mode: 0o600 });
  return secret;
}

export function signReportId(secret: Buffer, id: string): string {
  return createHmac("sha256", secret).update(id).digest().subarray(0, SIGNATURE_BYTES).toString("base64url");
}

export function verifyReportSignature(secret: Buffer, id: string, signature: string): boolean {
  if (!(REPORT_ID_PATTERN.test(id) || isUpdateId(id)) || !SIGNATURE_PATTERN.test(signature)) return false;
  const expected = Buffer.from(signReportId(secret, id));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** The report link of one Research report. */
export function reportLink(id: string, secret: Buffer, publicBase = resolveJoshuPublicApiBase()): string {
  return `${publicBase.replace(/\/+$/, "")}/api/research/r/${id}/${signReportId(secret, id)}/report.pdf`;
}

/** The report link of the PDF of one report update. */
export function updateLink(id: string, secret: Buffer, publicBase = resolveJoshuPublicApiBase()): string {
  return `${publicBase.replace(/\/+$/, "")}/api/research/u/${id}/${signReportId(secret, id)}/update.pdf`;
}

/** The PDF of a report update of a signed link, or null when the signature is wrong or the PDF is gone. */
export function resolveSignedUpdate(roots: ReportRoots, secret: Buffer, id: string, signature: string): string | null {
  if (!isUpdateId(id) || !verifyReportSignature(secret, id, signature)) return null;
  const dir = path.resolve(roots.filesRoot, "Research");
  const pdf = path.resolve(dir, id, "update.pdf");
  // The patterns allow no "..", and the resolved path must stay in the folder Research.
  if (!pdf.startsWith(`${dir}${path.sep}`) || !fs.existsSync(pdf)) return null;
  return pdf;
}

/** The Research report of a signed link, or null when the signature is wrong or the report is gone. */
export function resolveSignedReport(
  roots: ReportRoots,
  secret: Buffer,
  id: string,
  signature: string,
): StoredReport | null {
  if (!verifyReportSignature(secret, id, signature)) return null;
  return readReport(roots, id);
}

/** The Research reports whose report links appear in `text`, each one once. */
export function reportsLinkedInText(roots: ReportRoots, secret: Buffer, text: string): StoredReport[] {
  const out: StoredReport[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(LINK_IN_TEXT)) {
    const [, id, signature] = match;
    if (!id || !signature || seen.has(id)) continue;
    const report = resolveSignedReport(roots, secret, id, signature);
    if (report) {
      seen.add(id);
      out.push(report);
    }
  }
  return out;
}

/**
 * The PDFs of the Research reports whose report links are in an owner outbox text. The Slack
 * and Telegram senders upload them with the text (design decision D9). Never throws.
 */
export function reportFilesInText(
  projectRoot: string,
  text: string,
): { path: string; filename: string; title: string }[] {
  if (!text.includes("/api/research/r/") && !text.includes("/api/research/u/")) return [];
  try {
    const roots = resolveReportRoots(projectRoot);
    if (!roots) return [];
    const secret = reportLinkSecret(projectRoot);
    const updates: { path: string; filename: string; title: string }[] = [];
    for (const [, id, signature] of text.matchAll(UPDATE_LINK_IN_TEXT)) {
      const pdf = id && signature ? resolveSignedUpdate(roots, secret, id, signature) : null;
      if (pdf && !updates.some((u) => u.path === pdf)) updates.push({ path: pdf, filename: `${id!.replace(/\//g, "-")}.pdf`, title: "Report update" });
    }
    return [
      ...reportsLinkedInText(roots, secret, text).map((report) => ({
        path: report.pdfPath,
        filename: `${report.id}.pdf`,
        title: `Research report: ${report.topic}`,
      })),
      ...updates,
    ];
  } catch {
    return [];
  }
}
