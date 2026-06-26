import fs from "node:fs";
import path from "node:path";
import { joshuConfigDir } from "../nylas/paths.js";

export function ownerChannelDir(projectRoot = process.cwd()): string | null {
  const base = joshuConfigDir(projectRoot);
  if (!base) return null;
  return path.join(base, "owner-channel");
}

export function ownerChannelConfigPath(projectRoot = process.cwd()): string | null {
  const dir = ownerChannelDir(projectRoot);
  return dir ? path.join(dir, "owner-channel.json") : null;
}

export function ensureOwnerChannelDir(projectRoot = process.cwd()): string | null {
  const dir = ownerChannelDir(projectRoot);
  if (!dir) return null;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
