/**
 * Hermes SOUL.md — companion persona from the control plane (quiz soul_md).
 * Loaded by Hermes alongside HERMES.md for agent personality.
 */

import fs from "node:fs";
import path from "node:path";
import { getHermesHomeDir } from "./hermesVoiceRuntime.js";

export const COMPANION_SOUL_MANAGED_MARKER = "<!-- joshu-managed: companion-soul -->";

/** Path to `$HERMES_HOME/SOUL.md`. */
export function hermesSoulFilePath(): string {
  return path.join(getHermesHomeDir(), "SOUL.md");
}

function buildSoulMarkdown(soulMd: string): string {
  const body = soulMd.trim();
  return `${COMPANION_SOUL_MANAGED_MARKER}\n\n${body}\n`;
}

/** Write or refresh SOUL.md when control plane supplies companion soul content. */
export function syncHermesSoulFile(soulMd: string | undefined): boolean {
  const trimmed = soulMd?.trim();
  if (!trimmed) return false;

  const dest = hermesSoulFilePath();
  const next = buildSoulMarkdown(trimmed);
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (fs.existsSync(dest)) {
      const current = fs.readFileSync(dest, "utf8");
      if (current === next) return false;
      // Preserve hand-edited SOUL files that are not Joshu-managed.
      if (!current.includes(COMPANION_SOUL_MANAGED_MARKER)) return false;
    }
    fs.writeFileSync(dest, next, { mode: 0o644 });
    return true;
  } catch (err) {
    console.warn(`[companion-soul] could not write ${dest}: ${(err as Error).message}`);
    return false;
  }
}

/** Force-write SOUL.md from control plane (provision / operator apply). */
export function writeHermesSoulFile(soulMd: string): boolean {
  const trimmed = soulMd.trim();
  if (!trimmed) return false;

  const dest = hermesSoulFilePath();
  const next = buildSoulMarkdown(trimmed);
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (fs.existsSync(dest)) {
      const current = fs.readFileSync(dest, "utf8");
      if (current === next) return false;
    }
    fs.writeFileSync(dest, next, { mode: 0o644 });
    return true;
  } catch (err) {
    console.warn(`[companion-soul] could not write ${dest}: ${(err as Error).message}`);
    return false;
  }
}
