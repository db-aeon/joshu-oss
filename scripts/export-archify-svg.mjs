/**
 * Export the SVG of a checked Archify page through the Export menu of the page, in headless
 * Chromium. The technical reference embeds this SVG (docs/technical-reference/AGENTS.md).
 *
 * Usage: npx tsx scripts/export-archify-svg.mjs <page.html> <out.svg>
 */
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import { resolveChromiumBin } from "../src/research/pdf.ts";

const [htmlPath, outPath] = process.argv.slice(2);
if (!htmlPath || !outPath) {
  console.error("usage: npx tsx scripts/export-archify-svg.mjs <page.html> <out.svg>");
  process.exit(2);
}
const executablePath = resolveChromiumBin() ?? undefined;
const browser = await chromium.launch({ executablePath, headless: true });
try {
  const page = await browser.newPage({ acceptDownloads: true, viewport: { width: 1440, height: 900 } });
  await page.goto(`file://${path.resolve(htmlPath)}`);
  await page.getByRole("button", { name: "Export" }).first().click();
  const [download] = await Promise.all([page.waitForEvent("download"), page.locator('[data-format="svg"]').first().click()]);
  await download.saveAs(outPath);
  console.log(`${outPath}: ${fs.statSync(outPath).size} bytes`);
} finally {
  await browser.close();
}
