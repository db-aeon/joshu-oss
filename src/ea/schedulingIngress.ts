/**
 * Scheduling mail ingress — classify-and-forward only.
 * Meeting state lives on Kanban tasks (task_id); see schedulingCron.ts.
 */
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { connectorStatePath } from "../connectors/paths.js";
import { queueSchedulingIngressTask } from "./schedulingCron.js";
import { buildIngressEventId, parseEmailAddress } from "./schedulingTypes.js";

export { buildIngressEventId } from "./schedulingTypes.js";
import type { AfterMirrorThreadInput } from "./triageTypes.js";

export type SchedulingIngressEvent = {
  id: string;
  received_at: string;
  provider: AfterMirrorThreadInput["provider"];
  thread_id: string;
  account_key?: string;
  source_path: string;
  subject: string;
  from: string;
  from_email: string | null;
  message_id: string;
  status: "pending" | "processed";
  meeting_task_id: string | null;
  processed_at?: string;
};

export function schedulingIngressPath(filesRoot: string): string {
  return connectorStatePath(filesRoot, "scheduling-ingress.jsonl");
}

export async function readSchedulingIngressEvents(
  filesRoot: string,
): Promise<SchedulingIngressEvent[]> {
  const file = schedulingIngressPath(filesRoot);
  try {
    const raw = await readFile(file, "utf8");
    const events: SchedulingIngressEvent[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        events.push(JSON.parse(trimmed) as SchedulingIngressEvent);
      } catch {
        /* skip corrupt line */
      }
    }
    return events;
  } catch {
    return [];
  }
}

async function writeSchedulingIngressEvents(
  filesRoot: string,
  events: SchedulingIngressEvent[],
): Promise<void> {
  const file = schedulingIngressPath(filesRoot);
  await mkdir(path.dirname(file), { recursive: true });
  const body =
    events.length === 0 ? "" : `${events.map((e) => JSON.stringify(e)).join("\n")}\n`;
  await writeFile(file, body, "utf8");
}

export async function appendSchedulingIngressEvent(
  input: AfterMirrorThreadInput & { messageId: string },
): Promise<{ appended: boolean; event?: SchedulingIngressEvent; reason?: string }> {
  const messageId = input.messageId.trim();
  if (!messageId) {
    return { appended: false, reason: "missing_message_id" };
  }

  const eventId = buildIngressEventId(input.provider, input.threadId, messageId);
  const existing = await readSchedulingIngressEvents(input.filesRoot);
  if (existing.some((e) => e.id === eventId)) {
    return { appended: false, reason: "duplicate", event: existing.find((e) => e.id === eventId) };
  }

  const event: SchedulingIngressEvent = {
    id: eventId,
    received_at: input.receivedAt ?? new Date().toISOString(),
    provider: input.provider,
    thread_id: input.threadId,
    ...(input.accountKey ? { account_key: input.accountKey } : {}),
    source_path: input.sourcePath,
    subject: input.subject?.trim() ?? "",
    from: input.from?.trim() ?? "",
    from_email: parseEmailAddress(input.from),
    message_id: messageId,
    status: "pending",
    meeting_task_id: null,
  };

  const file = schedulingIngressPath(input.filesRoot);
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(event)}\n`, "utf8");

  console.info(
    `[ea-scheduling] ingress appended id=${eventId} thread=${input.provider}/${input.threadId}`,
  );
  return { appended: true, event };
}

export async function markSchedulingIngressProcessed(
  filesRoot: string,
  ids: string[],
  meetingTaskId?: string | null,
): Promise<number> {
  if (ids.length === 0) return 0;
  const idSet = new Set(ids);
  const now = new Date().toISOString();
  let count = 0;
  const events = await readSchedulingIngressEvents(filesRoot);
  for (const event of events) {
    if (!idSet.has(event.id)) continue;
    event.status = "processed";
    event.processed_at = now;
    if (meetingTaskId !== undefined) {
      event.meeting_task_id = meetingTaskId;
    }
    count += 1;
  }
  if (count > 0) {
    await writeSchedulingIngressEvents(filesRoot, events);
  }
  return count;
}

export async function countPendingIngressEvents(filesRoot: string): Promise<number> {
  const events = await readSchedulingIngressEvents(filesRoot);
  return events.filter((e) => e.status === "pending").length;
}

/** @deprecated Ingest no longer queues ea-sched-ingress — universal ea-mail-ingress only. */
export async function forwardSchedulingMail(
  input: AfterMirrorThreadInput & { messageId: string },
): Promise<void> {
  const messageId = input.messageId?.trim();
  if (!messageId) {
    console.warn(`[ea-scheduling] ingress skip missing message_id ${input.provider}/${input.threadId}`);
    return;
  }

  console.warn(
    `[ea-scheduling] forwardSchedulingMail is deprecated — ingest uses ea-mail-ingress only (${input.provider}/${input.threadId})`,
  );

  const result = await queueSchedulingIngressTask({ ...input, messageId }).catch((err) => {
    console.warn(`[ea-scheduling] ingress queue: ${(err as Error).message}`);
    return { queued: false, reason: "queue_error" as const };
  });

  if (result.reason === "existing_active") {
    console.info(
      `[ea-scheduling] ingress skip duplicate ${input.provider}/${input.threadId} message=${messageId}`,
    );
  }
}

/** @deprecated Legacy MD case id generator — do not use for new meetings. */
export function legacyBuildCaseId(subject?: string, from?: string): string {
  const email = parseEmailAddress(from);
  const slug = (value: string, max: number) =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, max);
  const who = slug(email?.split("@")[0] ?? "meet", 16);
  const topic = slug(subject ?? "scheduling", 20) || "scheduling";
  const day = new Date().toISOString().slice(0, 10);
  return `${topic}-${who}-${day}-${randomBytes(2).toString("hex")}`;
}

/** @deprecated Use meetingTaskIdempotencyKey. */
export function legacySchedulingCaseIdempotencyKey(caseId: string): string {
  return `ea-sched-${caseId}`;
}
