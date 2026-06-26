import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { actionGuardPendingDir, ensureActionGuardDir } from "./paths.js";

export type PendingDecision = "approved" | "denied" | "timeout";

export type PendingRequest = {
  id: string;
  actionId: string;
  summary: Record<string, unknown>;
  createdAt: string;
  expiresAt: string;
  status: "pending" | PendingDecision;
  /** When the Slack approval prompt was delivered (for Y/N reply matching). */
  slackNotifiedAt?: string;
};

type Waiter = {
  resolve: (decision: PendingDecision) => void;
  timer: ReturnType<typeof setTimeout>;
};

const waiters = new Map<string, Waiter>();

function pendingFile(projectRoot: string, id: string): string | null {
  const dir = actionGuardPendingDir(projectRoot);
  return dir ? `${dir}/${id}.json` : null;
}

export function writePending(req: PendingRequest, projectRoot = process.cwd()): void {
  ensureActionGuardDir(projectRoot);
  const file = pendingFile(projectRoot, req.id);
  if (!file) return;
  fs.writeFileSync(file, `${JSON.stringify(req, null, 2)}\n`, { mode: 0o600 });
}

export function readPending(id: string, projectRoot = process.cwd()): PendingRequest | null {
  const file = pendingFile(projectRoot, id);
  if (!file || !fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as PendingRequest;
  } catch {
    return null;
  }
}

export function updatePendingStatus(
  id: string,
  status: PendingDecision,
  projectRoot = process.cwd(),
): PendingRequest | null {
  const req = readPending(id, projectRoot);
  if (!req) return null;
  req.status = status;
  writePending(req, projectRoot);
  return req;
}

export function markPendingSlackNotified(id: string, projectRoot = process.cwd()): void {
  const req = readPending(id, projectRoot);
  if (!req || req.status !== "pending") return;
  req.slackNotifiedAt = new Date().toISOString();
  writePending(req, projectRoot);
}

export function createPending(
  actionId: string,
  summary: Record<string, unknown>,
  timeoutMs: number,
  projectRoot = process.cwd(),
): PendingRequest {
  const now = Date.now();
  const req: PendingRequest = {
    id: randomUUID(),
    actionId,
    summary,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + timeoutMs).toISOString(),
    status: "pending",
  };
  writePending(req, projectRoot);
  return req;
}

export function waitForPendingDecision(
  id: string,
  timeoutMs: number,
  projectRoot = process.cwd(),
): Promise<PendingDecision> {
  const existing = readPending(id, projectRoot);
  if (existing && existing.status !== "pending") {
    return Promise.resolve(existing.status as PendingDecision);
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiters.delete(id);
      updatePendingStatus(id, "timeout", projectRoot);
      resolve("timeout");
    }, timeoutMs);

    waiters.set(id, { resolve, timer });
  });
}

export function resolvePending(id: string, decision: "approved" | "denied", projectRoot = process.cwd()): boolean {
  const req = readPending(id, projectRoot);
  if (!req || req.status !== "pending") return false;

  updatePendingStatus(id, decision, projectRoot);
  const waiter = waiters.get(id);
  if (waiter) {
    clearTimeout(waiter.timer);
    waiters.delete(id);
    waiter.resolve(decision);
  }
  return true;
}

export function cleanupPending(id: string, projectRoot = process.cwd()): void {
  const file = pendingFile(projectRoot, id);
  if (file && fs.existsSync(file)) {
    try {
      fs.unlinkSync(file);
    } catch {
      /* ignore */
    }
  }
}
