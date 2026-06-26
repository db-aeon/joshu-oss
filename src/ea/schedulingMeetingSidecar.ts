/**
 * Optional meeting metadata backup keyed by Kanban task_id.
 * Canonical negotiation state lives on the Kanban task; sidecar is for calendar_event_id etc.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { meetingSidecarPath } from "./schedulingCron.js";

export type MeetingSidecar = {
  task_id: string;
  calendar_event_id: string | null;
  source_paths: string[];
  participants: string[];
  timezone: string | null;
  updated_at: string;
};

export async function readMeetingSidecar(
  filesRoot: string,
  taskId: string,
): Promise<MeetingSidecar | null> {
  try {
    const raw = await readFile(meetingSidecarPath(filesRoot, taskId), "utf8");
    return JSON.parse(raw) as MeetingSidecar;
  } catch {
    return null;
  }
}

export async function writeMeetingSidecar(
  filesRoot: string,
  taskId: string,
  patch: Partial<Omit<MeetingSidecar, "task_id" | "updated_at">>,
): Promise<MeetingSidecar> {
  const existing = (await readMeetingSidecar(filesRoot, taskId)) ?? {
    task_id: taskId,
    calendar_event_id: null,
    source_paths: [],
    participants: [],
    timezone: null,
    updated_at: new Date().toISOString(),
  };

  const next: MeetingSidecar = {
    ...existing,
    ...patch,
    task_id: taskId,
    source_paths: patch.source_paths ?? existing.source_paths,
    participants: patch.participants ?? existing.participants,
    updated_at: new Date().toISOString(),
  };

  const file = meetingSidecarPath(filesRoot, taskId);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}
