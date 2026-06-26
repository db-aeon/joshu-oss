/**
 * Canonical paths for connector markdown mirrors under JOSHU_FILES_ROOT.
 */
import path from "node:path";
import { resolveJoshuFilesPaths, type JoshuFilesPaths } from "../joshuFilesPaths.js";

export const CONNECTORS_ROOT = "connectors";
export const CONNECTORS_STATE_DIR = path.join(CONNECTORS_ROOT, "_state");

export type ConnectorMailProvider = "nylas" | "gmail";
export type ConnectorCalendarProvider = "nylas" | "google";

export function resolveConnectorPaths(projectRoot = process.cwd()): JoshuFilesPaths | null {
  return resolveJoshuFilesPaths(projectRoot);
}

/** Nylas: connectors/mail/nylas/threads. Gmail: connectors/mail/gmail/{accountKey}/threads. */
export function mailThreadsDir(
  provider: ConnectorMailProvider,
  filesRoot: string,
  accountKey?: string,
): string {
  if (provider === "gmail") {
    const key = accountKey?.trim() || "default";
    return path.join(filesRoot, CONNECTORS_ROOT, "mail", "gmail", key, "threads");
  }
  return path.join(filesRoot, CONNECTORS_ROOT, "mail", provider, "threads");
}

/** Pre-migration flat layout (connectors/mail/gmail/threads). */
export function gmailLegacyThreadsDir(filesRoot: string): string {
  return path.join(filesRoot, CONNECTORS_ROOT, "mail", "gmail", "threads");
}

export function gmailSyncStatePath(filesRoot: string, accountKey: string): string {
  const safe = accountKey.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80) || "default";
  return path.join(filesRoot, CONNECTORS_STATE_DIR, `gmail-sync.${safe}.json`);
}

/** Nylas: connectors/calendar/nylas/events. Google: connectors/calendar/google/{accountKey}/events. */
export function calendarEventsDir(
  provider: ConnectorCalendarProvider,
  filesRoot: string,
  accountKey?: string,
): string {
  if (provider === "google" && accountKey?.trim()) {
    return path.join(filesRoot, CONNECTORS_ROOT, "calendar", "google", accountKey.trim(), "events");
  }
  return path.join(filesRoot, CONNECTORS_ROOT, "calendar", provider, "events");
}

/** Pre-migration flat layout (connectors/calendar/google/events). */
export function googleCalendarLegacyEventsDir(filesRoot: string): string {
  return path.join(filesRoot, CONNECTORS_ROOT, "calendar", "google", "events");
}

export function googleCalendarRootDir(filesRoot: string): string {
  return path.join(filesRoot, CONNECTORS_ROOT, "calendar", "google");
}

export function connectorStatePath(filesRoot: string, name: string): string {
  return path.join(filesRoot, CONNECTORS_STATE_DIR, name);
}

/** Relative path from JOSHU_FILES_ROOT for gbrain slugs. */
export function relativeFromFilesRoot(filesRoot: string, absolutePath: string): string {
  const rel = path.relative(filesRoot, absolutePath);
  return rel.split(path.sep).join("/");
}

export function safeThreadFilename(threadId: string): string {
  const safe = threadId.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120);
  return `${safe || "thread"}.md`;
}

export function safeEventFilename(eventId: string): string {
  const safe = eventId.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120);
  return `${safe || "event"}.md`;
}
