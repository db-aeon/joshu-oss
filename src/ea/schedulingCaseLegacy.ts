/**
 * @deprecated Read-only access to legacy Projects/.../scheduling/*.md case files.
 * New scheduling uses Kanban meeting tasks (task_id) + schedulingIngress.ts.
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { connectorStatePath } from "../connectors/paths.js";
import type { TriageProvider } from "./triageTypes.js";

export type LegacySchedulingCaseState =
  | "open"
  | "proposing"
  | "awaiting_reply"
  | "confirmed"
  | "cancelled";

export type LegacyLinkedThread = {
  provider: TriageProvider;
  account_key?: string;
  thread_id: string;
  source_path: string;
  last_message_at: string;
};

export type LegacySchedulingCaseFrontmatter = {
  state: LegacySchedulingCaseState;
  case_id: string;
  project_slug: string;
  subject: string;
  participants: string[];
  linked_threads: LegacyLinkedThread[];
  calendar_event_id: string | null;
  waiting_on: string | null;
  handler_queued: boolean;
  needs_handler?: boolean;
};

export type LegacySchedulingCaseRecord = {
  absolutePath: string;
  relativePath: string;
  frontmatter: LegacySchedulingCaseFrontmatter;
  body: string;
};

const TERMINAL_STATES = new Set<LegacySchedulingCaseState>(["confirmed", "cancelled"]);

function parseCaseMarkdown(
  raw: string,
  absolutePath: string,
  filesRoot: string,
): LegacySchedulingCaseRecord {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/u.exec(raw);
  const parsed = match?.[1]
    ? (YAML.parse(match[1]) as Partial<LegacySchedulingCaseFrontmatter>)
    : {};
  const fm: LegacySchedulingCaseFrontmatter = {
    state: (parsed.state as LegacySchedulingCaseState) ?? "open",
    case_id: String(parsed.case_id ?? path.basename(absolutePath, ".md")),
    project_slug: String(parsed.project_slug ?? "other"),
    subject: String(parsed.subject ?? ""),
    participants: Array.isArray(parsed.participants)
      ? parsed.participants.map((p) => String(p))
      : [],
    linked_threads: Array.isArray(parsed.linked_threads)
      ? (parsed.linked_threads as LegacyLinkedThread[])
      : [],
    calendar_event_id:
      parsed.calendar_event_id == null ? null : String(parsed.calendar_event_id),
    waiting_on: parsed.waiting_on == null ? null : String(parsed.waiting_on),
    handler_queued: Boolean(parsed.handler_queued),
    ...(parsed.needs_handler != null ? { needs_handler: Boolean(parsed.needs_handler) } : {}),
  };
  return {
    absolutePath,
    relativePath: path.relative(filesRoot, absolutePath).split(path.sep).join("/"),
    frontmatter: fm,
    body: match?.[2]?.trim() ?? "",
  };
}

export async function listLegacySchedulingCaseRecords(
  filesRoot: string,
): Promise<LegacySchedulingCaseRecord[]> {
  const projectsDir = path.join(filesRoot, "Projects");
  const records: LegacySchedulingCaseRecord[] = [];
  let projectSlugs: string[] = [];
  try {
    projectSlugs = await readdir(projectsDir);
  } catch {
    return records;
  }
  for (const slug of projectSlugs) {
    if (slug.startsWith("_")) continue;
    const schedulingDir = path.join(projectsDir, slug, "scheduling");
    let files: string[] = [];
    try {
      files = await readdir(schedulingDir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      const absolutePath = path.join(schedulingDir, file);
      try {
        const raw = await readFile(absolutePath, "utf8");
        records.push(parseCaseMarkdown(raw, absolutePath, filesRoot));
      } catch {
        /* skip */
      }
    }
  }
  return records;
}

export function isLegacyCaseTerminal(state: LegacySchedulingCaseState): boolean {
  return TERMINAL_STATES.has(state);
}

export async function readLegacySchedulingCase(
  filesRoot: string,
  relativePath: string,
): Promise<LegacySchedulingCaseRecord | null> {
  const absolutePath = path.join(filesRoot, relativePath);
  try {
    const raw = await readFile(absolutePath, "utf8");
    return parseCaseMarkdown(raw, absolutePath, filesRoot);
  } catch {
    return null;
  }
}

type CaseQueuedMarker = {
  queuedAt: string;
  kanban_task_id?: string;
  caseRelativePath: string;
};

async function readCaseHandlerMarker(
  filesRoot: string,
  caseId: string,
): Promise<CaseQueuedMarker | null> {
  const markerPath = connectorStatePath(filesRoot, `scheduling-case-queued.${caseId}.json`);
  try {
    const raw = await readFile(markerPath, "utf8");
    return JSON.parse(raw) as CaseQueuedMarker;
  } catch {
    return null;
  }
}

export async function findLegacySchedulingCaseById(
  filesRoot: string,
  caseId: string,
): Promise<LegacySchedulingCaseRecord | null> {
  const marker = await readCaseHandlerMarker(filesRoot, caseId);
  if (marker?.caseRelativePath) {
    const fromMarker = await readLegacySchedulingCase(filesRoot, marker.caseRelativePath);
    if (fromMarker && fromMarker.frontmatter.case_id === caseId) return fromMarker;
  }
  for (const record of await listLegacySchedulingCaseRecords(filesRoot)) {
    if (record.frontmatter.case_id === caseId) return record;
  }
  return null;
}
