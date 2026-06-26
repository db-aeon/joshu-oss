import fs from "node:fs";
import { actionGuardAuditPath, ensureActionGuardDir } from "./paths.js";

export type AuditEntry = {
  at: string;
  pendingId: string;
  actionId: string;
  decision: "approved" | "denied" | "timeout" | "skipped" | "unavailable";
  summary?: Record<string, unknown>;
};

export function appendAuditEntry(entry: AuditEntry, projectRoot = process.cwd()): void {
  ensureActionGuardDir(projectRoot);
  const file = actionGuardAuditPath(projectRoot);
  if (!file) return;
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}
