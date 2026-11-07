/**
 * Print the HTML page of a Research report to the PDF with one short headless Chromium run.
 * The run has its own temporary profile, cannot reach the network, and never uses the shared
 * browser that the owner sees in jWeb. Design decision D5 of change research-reports.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ResearchStepError } from "./errors.js";

/** Time limit of the PDF render (design decision D12). A render takes about one second. */
export const RENDER_TIMEOUT_MS = 30_000;

const CHROMIUM_CANDIDATES = [
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
];

/** The Chromium binary: `JOSHU_REPORT_CHROMIUM_BIN`, then the image path, then a local browser. */
export function resolveChromiumBin(): string | null {
  const fromEnv = process.env.JOSHU_REPORT_CHROMIUM_BIN?.trim();
  if (fromEnv) return fromEnv;
  return CHROMIUM_CANDIDATES.find((bin) => fs.existsSync(bin)) ?? null;
}

/** Chromium arguments for one print. The proxy points at a closed local port, so no request leaves the box. */
export function chromiumPrintArgs(htmlPath: string, pdfPath: string, profileDir: string): string[] {
  return [
    "--headless",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-extensions",
    "--no-first-run",
    "--no-pdf-header-footer",
    `--user-data-dir=${profileDir}`,
    "--proxy-server=http://127.0.0.1:9",
    "--proxy-bypass-list=<-loopback>",
    `--print-to-pdf=${pdfPath}`,
    pathToFileURL(htmlPath).href,
  ];
}

/** Print `htmlPath` to `pdfPath`. Throws `ResearchStepError` ("render"). */
export async function renderPdf(
  htmlPath: string,
  pdfPath: string,
  opts: { timeoutMs?: number; chromiumBin?: string } = {},
): Promise<void> {
  const bin = opts.chromiumBin ?? resolveChromiumBin();
  if (!bin) throw new ResearchStepError("render", "Chromium is not installed on the box");
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "joshu-report-chromium-"));
  const timeoutMs = opts.timeoutMs ?? RENDER_TIMEOUT_MS;
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(bin, chromiumPrintArgs(htmlPath, pdfPath, profileDir), {
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-2000);
      });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new ResearchStepError("render", `the PDF render ran longer than ${Math.round(timeoutMs / 1000)} seconds`));
      }, timeoutMs);
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(new ResearchStepError("render", err.message));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else {
          const last = stderr.split(/\r?\n/).filter((l) => l && !/dbus/i.test(l)).pop() ?? "";
          reject(new ResearchStepError("render", `Chromium exited with code ${code}${last ? `: ${last}` : ""}`));
        }
      });
    });
    const size = fs.existsSync(pdfPath) ? fs.statSync(pdfPath).size : 0;
    if (size === 0) throw new ResearchStepError("render", "Chromium wrote no PDF");
  } finally {
    fs.rmSync(profileDir, { recursive: true, force: true });
  }
}
