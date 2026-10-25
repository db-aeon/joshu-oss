import fs from "node:fs";
import { randomUUID } from "node:crypto";

import type { CloudBrowserStopReason } from "../cloudBrowser.js";
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
  /** Last owner interaction on the handoff page (heartbeat, overlay poll, fill). */
  lastOwnerActivityAt?: string;
  /** First owner interaction on the handoff page. Unset = the owner has not opened the link yet. */
  ownerOpenedAt?: string;
  /** Joshu stopped the shared browser while this handoff was pending or soon after it ended. */
  browserStoppedAt?: string;
  browserStopReason?: CloudBrowserStopReason;
  completedAt?: string;
  cancelledAt?: string;
  lastScan?: BrowserHandoffLastScan;
  /** Set after auto SMS continuation post-handoff (sms: sessions only). */
  smsContinuationDeliveredAt?: string;
};

const DEFAULT_TTL_MS = 45 * 60 * 1000;
const HEARTBEAT_EXTEND_MS = 15 * 60 * 1000;
/** Absolute cap from createdAt — heartbeats cannot push expiresAt past this. */
const MAX_TTL_MS = 3 * 60 * 60 * 1000;
/**
 * After the owner opened the handoff page, a pending handoff keeps Browser Use
 * Cloud alive only while owner activity is this recent. An unopened handoff keeps
 * it alive until the link expires. Agent handoff lock is unchanged (still pending
 * until complete/expiry).
 */
const OWNER_ACTIVITY_MS = 10 * 60 * 1000;

function readEnvMs(primary: string, fallback: number, legacy?: string): number {
  const raw =
    process.env[primary]?.trim() ||
    (legacy ? process.env[legacy]?.trim() : "") ||
    "";
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function handoffMaxTtlMs(): number {
  return readEnvMs("HANDOFF_MAX_TTL_MS", MAX_TTL_MS, "JOSHU_HANDOFF_MAX_TTL_MS");
}

export function handoffOwnerActivityMs(): number {
  return readEnvMs(
    "HANDOFF_OWNER_ACTIVITY_MS",
    OWNER_ACTIVITY_MS,
    "JOSHU_HANDOFF_OWNER_ACTIVITY_MS",
  );
}

function handoffHeartbeatExtendMs(): number {
  return readEnvMs(
    "HANDOFF_HEARTBEAT_EXTEND_MS",
    HEARTBEAT_EXTEND_MS,
    "JOSHU_HANDOFF_HEARTBEAT_EXTEND_MS",
  );
}

function maxHandoffExpiresAtMs(record: BrowserHandoffRecord): number {
  const createdMs = Date.parse(record.createdAt);
  if (!Number.isFinite(createdMs)) return Date.now() + handoffMaxTtlMs();
  return createdMs + handoffMaxTtlMs();
}

function handoffOwnerActivityAt(record: BrowserHandoffRecord): number {
  const raw = record.lastOwnerActivityAt ?? record.createdAt;
  const at = Date.parse(raw);
  return Number.isFinite(at) ? at : Date.parse(record.createdAt);
}

/**
 * True when a pending handoff should block cloud-browser idle shutdown: until the
 * link expires while the owner has not opened it (the staged page must still be
 * there when they do), then only while the owner was active recently.
 */
export function pendingHandoffBlocksCloudBrowser(projectRoot: string): boolean {
  const pending = getPendingHandoff(projectRoot);
  if (!pending) return false;
  if (!pending.ownerOpenedAt) return true;
  return Date.now() - handoffOwnerActivityAt(pending) < handoffOwnerActivityMs();
}

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
    expiresAt: new Date(Math.min(now + ttlMs, now + handoffMaxTtlMs())).toISOString(),
    lastOwnerActivityAt: new Date(now).toISOString(),
  };
  writeRecord(projectRoot, record);
  return record;
}

/** Owner is on the handoff page — refresh activity without extending link expiry. */
export function touchHandoffOwnerActivity(
  projectRoot: string,
  id: string,
): BrowserHandoffRecord | null {
  const record = getHandoffRecord(projectRoot, id);
  if (!record || record.status !== "pending") return record;
  const now = new Date().toISOString();
  const next = { ...record, lastOwnerActivityAt: now, ownerOpenedAt: record.ownerOpenedAt ?? now };
  writeRecord(projectRoot, next);
  return next;
}

export function extendHandoffExpiry(projectRoot: string, id: string): BrowserHandoffRecord | null {
  const record = getHandoffRecord(projectRoot, id);
  if (!record || record.status !== "pending") return record;
  const now = Date.now();
  const floorMs = Math.max(Date.parse(record.expiresAt), now);
  const cappedExp = Math.min(floorMs + handoffHeartbeatExtendMs(), maxHandoffExpiresAtMs(record));
  const nowIso = new Date(now).toISOString();
  const next = {
    ...record,
    expiresAt: new Date(cappedExp).toISOString(),
    lastOwnerActivityAt: nowIso,
    ownerOpenedAt: record.ownerOpenedAt ?? nowIso,
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

/** A handoff that ended this recently still gets the stop stamp: its staged page was lost with the browser. */
const BROWSER_STOP_STAMP_WINDOW_MS = 60 * 60 * 1000;

function handoffEndedAtMs(record: BrowserHandoffRecord): number {
  const raw =
    record.status === "completed"
      ? record.completedAt
      : record.status === "cancelled"
        ? record.cancelledAt
        : record.expiresAt;
  return Date.parse(raw ?? "");
}

/**
 * Joshu stopped the shared browser: stamp each handoff whose staged page went with
 * it (pending, or ended within the last hour), so browser_handoff_status can tell
 * the companion the true reason.
 */
export function markHandoffsBrowserStopped(
  projectRoot: string,
  reason: CloudBrowserStopReason,
  nowMs = Date.now(),
): BrowserHandoffRecord[] {
  const stamped: BrowserHandoffRecord[] = [];
  for (const record of listHandoffRecords(projectRoot)) {
    if (record.browserStoppedAt) continue;
    if (record.status !== "pending") {
      const endedMs = handoffEndedAtMs(record);
      if (!Number.isFinite(endedMs) || nowMs - endedMs > BROWSER_STOP_STAMP_WINDOW_MS) continue;
    }
    const next: BrowserHandoffRecord = {
      ...record,
      browserStoppedAt: new Date(nowMs).toISOString(),
      browserStopReason: reason,
    };
    writeRecord(projectRoot, next);
    stamped.push(next);
  }
  return stamped;
}

function browserStopSentence(record: BrowserHandoffRecord): string {
  const why =
    record.browserStopReason === "idle"
      ? "because nothing used it, to save cost"
      : "because the Joshu service restarted";
  return (
    `Joshu stopped the shared browser at ${record.browserStoppedAt} ${why}, so the staged page ` +
    "(for example a cart or a half-filled form) is gone. The website did not cause this."
  );
}

/** Plain status for the companion (browser_handoff_status `message`). */
export function handoffStatusMessage(record: BrowserHandoffRecord): string {
  const stopped = record.browserStoppedAt ? ` ${browserStopSentence(record)}` : "";
  const restage = " Tell the owner plainly what happened, and offer to stage the page again.";
  switch (record.status) {
    case "pending":
      if (record.browserStoppedAt) {
        return (
          "The owner opened the browser handoff page and then left it idle." +
          stopped +
          " Cancel this browser handoff before you use the browser again." +
          restage
        );
      }
      if (!record.ownerOpenedAt) {
        return (
          "The owner has not opened the browser handoff link yet. Joshu keeps the shared browser " +
          `with the staged page until the link expires at ${record.expiresAt}.`
        );
      }
      return `The owner opened the browser handoff page and has not finished yet. The link expires at ${record.expiresAt}.`;
    case "completed":
      return `The owner finished the step on the browser handoff page at ${record.completedAt}.${stopped}`;
    case "cancelled":
      return `The browser handoff was cancelled at ${record.cancelledAt}.${stopped}`;
    case "expired":
      return (
        `The browser handoff link expired at ${record.expiresAt} before the owner finished.` +
        (stopped ||
          " Joshu stops the shared browser a few minutes after the link expires, so the staged page may be gone.") +
        restage
      );
  }
}
