/**
 * Per-share Slack channel registry for share-chat KB Q&A via Composio Slackbot.
 * One channel ↔ one share UUID (scoped answerer).
 */

import fs from "node:fs";
import path from "node:path";
import { joshuConfigDir } from "../nylas/paths.js";

export interface ShareSlackChannelConfig {
  shareUuid: string;
  channelId: string;
  channelName: string;
  /** Composio trigger instance id for CHANNEL_MESSAGE_RECEIVED (optional). */
  triggerInstanceId?: string;
  isPrivate: boolean;
  createdAt: string;
  updatedAt: string;
  enabled: boolean;
}

type RegistryFile = {
  version: 1;
  /** Keyed by share UUID (lowercase). */
  byShare: Record<string, ShareSlackChannelConfig>;
  /** Reverse index: channelId → shareUuid. */
  byChannel: Record<string, string>;
};

function registryDir(projectRoot = process.cwd()): string {
  const joshu = joshuConfigDir(projectRoot);
  if (joshu) return path.join(joshu, "share-chat");
  return path.join(projectRoot, ".local", "share-chat");
}

function registryPath(projectRoot = process.cwd()): string {
  return path.join(registryDir(projectRoot), "slack-channels.json");
}

function emptyRegistry(): RegistryFile {
  return { version: 1, byShare: {}, byChannel: {} };
}

function readRegistry(projectRoot = process.cwd()): RegistryFile {
  const p = registryPath(projectRoot);
  if (!fs.existsSync(p)) return emptyRegistry();
  try {
    const parsed = JSON.parse(fs.readFileSync(p, "utf8")) as RegistryFile;
    if (!parsed || parsed.version !== 1) return emptyRegistry();
    if (!parsed.byShare || typeof parsed.byShare !== "object") return emptyRegistry();
    if (!parsed.byChannel || typeof parsed.byChannel !== "object") {
      // Rebuild reverse index if missing
      const byChannel: Record<string, string> = {};
      for (const [shareUuid, row] of Object.entries(parsed.byShare)) {
        if (row?.channelId) byChannel[row.channelId] = shareUuid;
      }
      return { version: 1, byShare: parsed.byShare, byChannel };
    }
    return parsed;
  } catch {
    return emptyRegistry();
  }
}

function writeRegistry(reg: RegistryFile, projectRoot = process.cwd()): void {
  const dir = registryDir(projectRoot);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = registryPath(projectRoot) + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(reg, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, registryPath(projectRoot));
}

function shareKey(shareUuid: string): string {
  return shareUuid.trim().toLowerCase();
}

/**
 * Normalize + validate a Slack channel name.
 * Returns lowercase name or throws with a short reason.
 */
export function normalizeSlackChannelName(raw: string): string {
  let name = String(raw || "").trim().toLowerCase();
  // Allow leading # in UI
  if (name.startsWith("#")) name = name.slice(1);
  name = name.replace(/\s+/g, "-").replace(/_+/g, "-");
  name = name.replace(/[^a-z0-9-]/g, "");
  name = name.replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (!name) throw new Error("channel_name_required");
  if (name.length > 80) throw new Error("channel_name_too_long");
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(name) && name.length > 1) {
    throw new Error("channel_name_invalid");
  }
  if (name.length === 1 && !/^[a-z0-9]$/.test(name)) {
    throw new Error("channel_name_invalid");
  }
  return name;
}

/** Suggest a default channel name from a file/folder display name. */
export function suggestSlackChannelName(displayName: string): string {
  try {
    const base = displayName.replace(/\.[a-z0-9]+$/i, "");
    return normalizeSlackChannelName(base || "shared-files");
  } catch {
    return "shared-files";
  }
}

export function getShareSlackChannel(
  shareUuid: string,
  projectRoot = process.cwd(),
): ShareSlackChannelConfig | null {
  const key = shareKey(shareUuid);
  if (!key) return null;
  return readRegistry(projectRoot).byShare[key] || null;
}

export function getShareUuidForChannel(
  channelId: string,
  projectRoot = process.cwd(),
): string | null {
  const id = String(channelId || "").trim();
  if (!id) return null;
  return readRegistry(projectRoot).byChannel[id] || null;
}

export function listEnabledShareSlackChannels(
  projectRoot = process.cwd(),
): ShareSlackChannelConfig[] {
  return Object.values(readRegistry(projectRoot).byShare).filter((c) => c.enabled);
}

export function upsertShareSlackChannel(
  cfg: ShareSlackChannelConfig,
  projectRoot = process.cwd(),
): ShareSlackChannelConfig {
  const key = shareKey(cfg.shareUuid);
  if (!key) throw new Error("shareUuid required");
  if (!cfg.channelId?.trim()) throw new Error("channelId required");

  const reg = readRegistry(projectRoot);
  const existing = reg.byShare[key];

  // Enforce 1:1 — channel must not belong to another share
  const other = reg.byChannel[cfg.channelId];
  if (other && other !== key) {
    throw new Error("channel_already_mapped");
  }
  // If this share already mapped to a different channel, drop old reverse index
  if (existing?.channelId && existing.channelId !== cfg.channelId) {
    delete reg.byChannel[existing.channelId];
  }

  const row: ShareSlackChannelConfig = {
    ...cfg,
    shareUuid: key,
    channelId: cfg.channelId.trim(),
    channelName: cfg.channelName.trim(),
    updatedAt: new Date().toISOString(),
  };
  reg.byShare[key] = row;
  reg.byChannel[row.channelId] = key;
  writeRegistry(reg, projectRoot);
  return row;
}

export function unlinkShareSlackChannel(
  shareUuid: string,
  projectRoot = process.cwd(),
): ShareSlackChannelConfig | null {
  const key = shareKey(shareUuid);
  const reg = readRegistry(projectRoot);
  const existing = reg.byShare[key];
  if (!existing) return null;
  delete reg.byShare[key];
  if (reg.byChannel[existing.channelId] === key) {
    delete reg.byChannel[existing.channelId];
  }
  writeRegistry(reg, projectRoot);
  return existing;
}

export function publicSlackChannelStatus(
  shareUuid: string,
  projectRoot = process.cwd(),
): {
  configured: boolean;
  channelId?: string;
  channelName?: string;
  isPrivate?: boolean;
} {
  const row = getShareSlackChannel(shareUuid, projectRoot);
  if (!row || !row.enabled) return { configured: false };
  return {
    configured: true,
    channelId: row.channelId,
    channelName: row.channelName,
    isPrivate: row.isPrivate,
  };
}
