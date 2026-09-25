import fs from "node:fs";
import { randomUUID } from "node:crypto";

import { resolveJoshuPublicApiBase } from "../ownerChannel/publicUrl.js";
import { ensureBrowserHandoffDir, handoffRecordPath } from "./paths.js";
import { mintHandoffToken } from "./token.js";

export type BrowserHandoffStatus = "pending" | "completed" | "expired" | "cancelled";

/** Last overlay scan — locator ids only, never owner-typed values. */
export type BrowserHandoffLastScan = {
  fieldIds: string[];
  primaryButtonId: string | null;
  scannedAt: string;
};

export type BrowserHandoffRecord = {
  id: string;
  status: BrowserHandoffStatus;
  pageUrl: string;
  pageTitle: string;
  instructions: string;
  kanbanTaskId?: string;
  /** Hermes session that minted this handoff (e.g. sms:+1…:epoch). */
  hermesSessionKey?: string;
  createdAt: string;
  expiresAt: string;
  completedAt?: string;
  cancelledAt?: string;
  lastScan?: BrowserHandoffLastScan;
  /** Set after auto SMS continuation post-handoff (sms: sessions only). */
  smsContinuationDeliveredAt?: string;
};

const DEFAULT_TTL_MS = 45 * 60 * 1000;
const HEARTBEAT_EXTEND_MS = 15 * 60 * 1000;

function readRecordFile(projectRoot: string, id: string): BrowserHandoffRecord | null {
  const file = handoffRecordPath(projectRoot, id);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as BrowserHandoffRecord;
  } catch {
    return null;
  }
}

function writeRecord(projectRoot: string, record: BrowserHandoffRecord): void {
  ensureBrowserHandoffDir(projectRoot);
  fs.writeFileSync(handoffRecordPath(projectRoot, record.id), `${JSON.stringify(record, null, 2)}\n`, {
    mode: 0o600,
  });
}

function normalizeExpired(projectRoot: string, record: BrowserHandoffRecord): BrowserHandoffRecord {
  if (record.status !== "pending") return record;
  if (Date.now() <= Date.parse(record.expiresAt)) return record;
  const expired: BrowserHandoffRecord = { ...record, status: "expired" };
  writeRecord(projectRoot, expired);
  return expired;
}

export function getHandoffRecord(projectRoot: string, id: string): BrowserHandoffRecord | null {
  const record = readRecordFile(projectRoot, id);
  if (!record) return null;
  return normalizeExpired(projectRoot, record);
}

export function listHandoffRecords(projectRoot: string): BrowserHandoffRecord[] {
  const dir = ensureBrowserHandoffDir(projectRoot);
  const out: BrowserHandoffRecord[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const id = name.replace(/\.json$/, "");
    const record = getHandoffRecord(projectRoot, id);
    if (record) out.push(record);
  }
  return out;
}

export function getPendingHandoff(projectRoot: string): BrowserHandoffRecord | null {
  for (const record of listHandoffRecords(projectRoot)) {
    if (record.status === "pending") return record;
  }
  return null;
}

export function buildHandoffUrl(id: string, expiresAtMs: number): string {
  const base = resolveJoshuPublicApiBase();
  const token = mintHandoffToken(id, expiresAtMs);
  const params = new URLSearchParams({
    t: token,
    exp: String(expiresAtMs),
  });
  return `${base}/handoff/${encodeURIComponent(id)}?${params.toString()}`;
}

export type CreateHandoffInput = {
  pageUrl: string;
  pageTitle: string;
  instructions: string;
  kanbanTaskId?: string;
  hermesSessionKey?: string;
  ttlMs?: number;
};

export function createHandoff(projectRoot: string, input: CreateHandoffInput): BrowserHandoffRecord {
  const pending = getPendingHandoff(projectRoot);
  if (pending) {
    throw new Error(`browser_handoff_already_pending:${pending.id}`);
  }

  const now = Date.now();
  const ttlMs = input.ttlMs ?? DEFAULT_TTL_MS;
  const record: BrowserHandoffRecord = {
    id: randomUUID(),
    status: "pending",
    pageUrl: input.pageUrl,
    pageTitle: input.pageTitle,
    instructions: input.instructions.trim(),
    kanbanTaskId: input.kanbanTaskId?.trim() || undefined,
    hermesSessionKey: input.hermesSessionKey?.trim() || undefined,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString(),
  };
  writeRecord(projectRoot, record);
  return record;
}

export function extendHandoffExpiry(projectRoot: string, id: string): BrowserHandoffRecord | null {
  const record = getHandoffRecord(projectRoot, id);
  if (!record || record.status !== "pending") return record;
  const floorMs = Math.max(Date.parse(record.expiresAt), Date.now());
  const next = {
    ...record,
    expiresAt: new Date(floorMs + HEARTBEAT_EXTEND_MS).toISOString(),
  };
  writeRecord(projectRoot, next);
  return next;
}

export function completeHandoff(projectRoot: string, id: string): BrowserHandoffRecord | null {
  const record = getHandoffRecord(projectRoot, id);
  if (!record || record.status !== "pending") return record;
  const next: BrowserHandoffRecord = {
    ...record,
    status: "completed",
    completedAt: new Date().toISOString(),
  };
  writeRecord(projectRoot, next);
  return next;
}

export function setHandoffLastScan(
  projectRoot: string,
  id: string,
  scan: BrowserHandoffLastScan,
): BrowserHandoffRecord | null {
  const record = getHandoffRecord(projectRoot, id);
  if (!record || record.status !== "pending") return record;
  const next: BrowserHandoffRecord = {
    ...record,
    lastScan: {
      fieldIds: scan.fieldIds.filter((fieldId) => typeof fieldId === "string" && fieldId.length > 0),
      primaryButtonId: scan.primaryButtonId,
      scannedAt: scan.scannedAt,
    },
  };
  writeRecord(projectRoot, next);
  return next;
}

export function cancelHandoff(projectRoot: string, id: string): BrowserHandoffRecord | null {
  const record = getHandoffRecord(projectRoot, id);
  if (!record || record.status !== "pending") return record;
  const next: BrowserHandoffRecord = {
    ...record,
    status: "cancelled",
    cancelledAt: new Date().toISOString(),
  };
  writeRecord(projectRoot, next);
  return next;
}

/** Cancel all pending handoffs linked to a Kanban task (e.g. realtime-goal archive). */
export function cancelPendingHandoffsForKanbanTask(
  projectRoot: string,
  kanbanTaskId: string,
): BrowserHandoffRecord[] {
  const taskId = kanbanTaskId.trim();
  if (!taskId) return [];
  const cancelled: BrowserHandoffRecord[] = [];
  for (const record of listHandoffRecords(projectRoot)) {
    if (record.status !== "pending" || record.kanbanTaskId !== taskId) continue;
    const next = cancelHandoff(projectRoot, record.id);
    if (next?.status === "cancelled") cancelled.push(next);
  }
  return cancelled;
}

export function handoffUrlForRecord(record: BrowserHandoffRecord): string {
  return buildHandoffUrl(record.id, Date.parse(record.expiresAt));
}

/** True when agent browser writes/navigate must be blocked. */
export function isBrowserHandoffLocked(projectRoot: string): {
  locked: boolean;
  handoffId?: string;
  pageUrl?: string;
  instructions?: string;
} {
  const pending = getPendingHandoff(projectRoot);
  if (!pending) return { locked: false };
  return {
    locked: true,
    handoffId: pending.id,
    pageUrl: pending.pageUrl,
    instructions: pending.instructions,
  };
}

/** Pinned checkout URL while a handoff is pending (blocks start-URL bootstrap). */
export function getPendingHandoffPinUrl(projectRoot: string): string | undefined {
  return getPendingHandoff(projectRoot)?.pageUrl;
}

/** Recent SMS-originated handoff still in flight or just completed. */
export function markSmsContinuationDelivered(
  projectRoot: string,
  id: string,
): BrowserHandoffRecord | null {
  const record = getHandoffRecord(projectRoot, id);
  if (!record || record.smsContinuationDeliveredAt) return record;
  const next: BrowserHandoffRecord = {
    ...record,
    smsContinuationDeliveredAt: new Date().toISOString(),
  };
  writeRecord(projectRoot, next);
  return next;
}

export function hasRecentSmsHandoff(
  projectRoot: string,
  opts?: { nowMs?: number; withinMs?: number },
): boolean {
  const nowMs = opts?.nowMs ?? Date.now();
  const withinMs = opts?.withinMs ?? 60 * 60_000;
  for (const record of listHandoffRecords(projectRoot)) {
    const sessionKey = record.hermesSessionKey?.trim() ?? "";
    if (!sessionKey.startsWith("sms:")) continue;
    if (record.status !== "pending" && record.status !== "completed") continue;
    const anchorMs = Date.parse(record.completedAt ?? record.createdAt);
    if (!Number.isFinite(anchorMs) || nowMs - anchorMs >= withinMs) continue;
    return true;
  }
  return false;
}
