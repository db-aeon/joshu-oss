import fs from "node:fs";
import path from "node:path";
import { syncHermesContextFile } from "../hermesContextFile.js";
import { joshuConfigDir } from "./paths.js";

export interface NylasAgentRecord {
  grantId: string;
  email: string;
  createdAt: string;
}

function agentFile(projectRoot: string): string | null {
  const dir = joshuConfigDir(projectRoot);
  if (!dir) return null;
  return path.join(dir, "nylas", "agent.json");
}

export function readAgentGrant(projectRoot = process.cwd()): NylasAgentRecord | null {
  const file = agentFile(projectRoot);
  if (!file || !fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as NylasAgentRecord;
  } catch {
    return null;
  }
}

export function writeAgentGrant(record: NylasAgentRecord, projectRoot = process.cwd()): boolean {
  const file = agentFile(projectRoot);
  if (!file) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(record, null, 2), { mode: 0o600 });
  syncHermesContextFile(projectRoot);
  return true;
}
