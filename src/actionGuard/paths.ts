import fs from "node:fs";
import path from "node:path";
import { joshuConfigDir } from "../nylas/paths.js";

export function actionGuardDir(projectRoot = process.cwd()): string | null {
  const base = joshuConfigDir(projectRoot);
  if (!base) return null;
  return path.join(base, "action-guard");
}

export function actionGuardPolicyPath(projectRoot = process.cwd()): string | null {
  const dir = actionGuardDir(projectRoot);
  return dir ? path.join(dir, "policy.json") : null;
}

export function actionGuardPendingDir(projectRoot = process.cwd()): string | null {
  const dir = actionGuardDir(projectRoot);
  return dir ? path.join(dir, "pending") : null;
}

export function actionGuardTelegramPath(projectRoot = process.cwd()): string | null {
  const dir = actionGuardDir(projectRoot);
  return dir ? path.join(dir, "telegram.json") : null;
}

export function actionGuardAuditPath(projectRoot = process.cwd()): string | null {
  const dir = actionGuardDir(projectRoot);
  return dir ? path.join(dir, "audit.jsonl") : null;
}

export function ensureActionGuardDir(projectRoot = process.cwd()): string | null {
  const dir = actionGuardDir(projectRoot);
  if (!dir) return null;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const pending = path.join(dir, "pending");
  fs.mkdirSync(pending, { recursive: true, mode: 0o700 });
  return dir;
}

/** Local Composio MCP guard proxy URL written into Hermes config when guard is on. */
export function resolveComposioMcpGuardProxyUrl(): string {
  const base = (process.env.JOSHU_COMPOSIO_MCP_GUARD_URL || "http://127.0.0.1:8796").replace(/\/+$/, "");
  return `${base}/mcp`;
}
