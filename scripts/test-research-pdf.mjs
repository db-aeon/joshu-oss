/**
 * Integration test of the PDF render of a Research report (change research-reports, task 4.1) and
 * of a report update (change recurring-research-reports, task 5.2).
 * Needs Chromium (the box image has /usr/bin/chromium) and `pdffonts` (poppler-utils). Skips
 * when either is missing, so the unit test run passes without them; run it by hand where both
 * are installed: `npx tsx scripts/test-research-pdf.mjs`.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { embeddedFontCss } from "../src/research/fonts.ts";
import { makeResearchReport } from "../src/research/make.ts";
import { renderPdf, resolveChromiumBin } from "../src/research/pdf.ts";
import { renderReportHtml } from "../src/research/template.ts";
import { renderUpdatePdf } from "../src/research/recurring/updatePdf.ts";
import { fakeDeps } from "./lib/research-test-fakes.mjs";

const bin = resolveChromiumBin();
const pdffonts = spawnSync("pdffonts", ["-v"]).error ? null : "pdffonts";
if (!bin || !pdffonts) {
  console.log(`skip research PDF test: ${!bin ? "no Chromium" : "no pdffonts"}`);
  process.exit(0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "research-pdf-"));
try {
  // The research and text of a whole run with the fakes, rendered with the embedded fonts.
  const roots = { desktopRoot: tmp, filesRoot: path.join(tmp, "files") };
  fs.mkdirSync(roots.filesRoot);
  const made = await makeResearchReport("/unused", "Electric bike subscriptions", fakeDeps(roots).deps);
  const { research, text } = JSON.parse(fs.readFileSync(path.join(made.folder, "report.json"), "utf8"));
  const html = renderReportHtml({ research, text, pictures: new Map(), companionName: "Mina", ownerDisplayName: "Maya Ross", fontCss: embeddedFontCss(), reportId: made.id });
  const htmlPath = path.join(tmp, "report.html");
  const pdfPath = path.join(tmp, "report.pdf");
  fs.writeFileSync(htmlPath, html);
  const started = Date.now();
  await renderPdf(htmlPath, pdfPath, { chromiumBin: bin });
  const seconds = (Date.now() - started) / 1000;
  assert.ok(fs.statSync(pdfPath).size > 10_000, "PDF written");

  const out = spawnSync(pdffonts, [pdfPath], { encoding: "utf8" }).stdout;
  const rows = out.split("\n").slice(2).filter((l) => l.trim());
  assert.ok(rows.length > 0, "PDF has fonts");
  for (const row of rows) {
    const name = row.split(/\s+/)[0];
    assert.match(name, /Newsreader|WorkSans|Work-Sans|Work Sans|Silkscreen/i, `only report fonts, found ${name}`);
    assert.match(row, /\byes\s+yes\s+yes\b|\byes\s+yes\s+no\b/, `font embedded: ${row}`);
  }
  console.log(`ok PDF render in ${seconds.toFixed(1)} s with embedded fonts: ${rows.map((r) => r.split(/\s+/)[0]).join(", ")}`);

  // A report update of a recurring report, with two report updates for the chart.
  const updates = path.join(roots.filesRoot, "Research", "Recurring", "robots", "updates");
  const story = (run, n) => ({ id: "S1", laneId: "l1", title: "Army orders humanoid robots", summary: "The Army signed a contract.", status: n === 1 ? "new" : "developing", sources: ["Web and news", "Reddit"], items: [{ url: `https://news.example/${run}`, source: "web", sourceLabel: "news.example", title: "Army contract", firstRun: run }], newItems: [`https://news.example/${run}`] });
  for (const [n, run] of [[1, "2026-10-30-0700"], [2, "2026-10-31-0700"]]) {
    fs.mkdirSync(path.join(updates, run), { recursive: true });
    fs.writeFileSync(path.join(updates, run, "update.json"), JSON.stringify({ schemaVersion: 1, run, name: "Robots", kind: "recurring", parentId: "rr_0000aaaa", period: { from: "2026-10-23T00:00:00.000Z", to: "2026-10-30T14:00:00.000Z" }, lanes: [{ id: "l1", topic: "humanoid robots", starting: n === 1, sources: ["web"] }], stories: [story(run, n)], sources: [{ name: "web", label: "Web (Exa)", state: "returned items", engineStatus: "ok" }] }));
  }
  const pdf = await renderUpdatePdf(roots, "Recurring/robots/updates/2026-10-31-0700", { writePdf: (h, p) => renderPdf(h, p, { chromiumBin: bin }) });
  const updateFonts = spawnSync(pdffonts, [pdf.pdfPath], { encoding: "utf8" }).stdout.split("\n").slice(2).filter((l) => l.trim());
  assert.ok(updateFonts.length > 0 && updateFonts.every((row) => /\byes\s+yes\s+(yes|no)\b/.test(row)), "the report update PDF has embedded fonts");
  console.log(`ok report update PDF with embedded fonts: ${updateFonts.map((r) => r.split(/\s+/)[0]).join(", ")}`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
