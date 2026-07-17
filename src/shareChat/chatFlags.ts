/**
 * Per-share chat enablement (defense in depth alongside ArozOS share validity).
 *
 * Stored next to Slack bot registry under `.joshu/share-chat/` (or `.local/share-chat/`).
 *
 * Semantics:
 * - Missing UUID: chat allowed if the ArozOS share is still valid (legacy / first open).
 * - enabled: true: chat allowed.
 * - enabled: false: chat denied even if the share UUID still exists.
 */

import fs from "node:fs";
import path from "node:path";
import { joshuConfigDir } from "../nylas/paths.js";

type ChatFlagsFile = {
  version: 1;
  shares: Record<string, { enabled: boolean; updatedAt: string }>;
};

function flagsDir(projectRoot = process.cwd()): string {
  const joshu = joshuConfigDir(projectRoot);
  if (joshu) return path.join(joshu, "share-chat");
  return path.join(projectRoot, ".local", "share-chat");
}

function flagsPath(projectRoot = process.cwd()): string {
  return path.join(flagsDir(projectRoot), "chat-flags.json");
}

function readFlags(projectRoot = process.cwd()): ChatFlagsFile {
  try {
    const raw = fs.readFileSync(flagsPath(projectRoot), "utf8");
    const parsed = JSON.parse(raw) as ChatFlagsFile;
    if (!parsed || typeof parsed !== "object") return { version: 1, shares: {} };
    if (!parsed.shares || typeof parsed.shares !== "object") return { version: 1, shares: {} };
    return { version: 1, shares: parsed.shares };
  } catch {
    return { version: 1, shares: {} };
  }
}

function writeFlags(data: ChatFlagsFile, projectRoot = process.cwd()): void {
  const dir = flagsDir(projectRoot);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(flagsPath(projectRoot), `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

/** Explicit flag only — null when never set. */
export function getShareChatFlag(shareUuid: string, projectRoot = process.cwd()): boolean | null {
  const uuid = String(shareUuid || "").trim();
  if (!uuid) return null;
  const entry = readFlags(projectRoot).shares[uuid];
  if (!entry || typeof entry.enabled !== "boolean") return null;
  return entry.enabled;
}

/**
 * Whether guests may use public chat for this UUID (callers must still resolve
 * the ArozOS share). Missing flag = allow while the share is valid.
 */
export function isShareChatEnabled(shareUuid: string, projectRoot = process.cwd()): boolean {
  const flag = getShareChatFlag(shareUuid, projectRoot);
  if (flag === null) return true;
  return flag === true;
}

export function setShareChatEnabled(
  shareUuid: string,
  enabled: boolean,
  projectRoot = process.cwd(),
): void {
  const uuid = String(shareUuid || "").trim();
  if (!uuid) throw new Error("shareUuid required");
  const data = readFlags(projectRoot);
  data.shares[uuid] = {
    enabled: Boolean(enabled),
    updatedAt: new Date().toISOString(),
  };
  writeFlags(data, projectRoot);
}

export function clearShareChatFlag(shareUuid: string, projectRoot = process.cwd()): void {
  const uuid = String(shareUuid || "").trim();
  if (!uuid) return;
  const data = readFlags(projectRoot);
  if (!(uuid in data.shares)) return;
  delete data.shares[uuid];
  writeFlags(data, projectRoot);
}
