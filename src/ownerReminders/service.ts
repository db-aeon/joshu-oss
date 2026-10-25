/**
 * Owner reminders (spec owner-reminders): create, list, stop, run (fire), retire.
 * Each owner reminder runs as one Hermes cron job with no_agent=true and a script
 * that calls POST /api/owner-reminders/:id/fire. A run sends a fixed text on the
 * owner text channel; it never calls an LLM.
 */
import { randomUUID } from "node:crypto";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { callCronBridge, type CronBridgePayload, type CronBridgeResult } from "../hermesCronBridge.js";
import { callKanbanBridge } from "../hermesKanbanBridge.js";
import { sendOwnerText, type OwnerTextInput, type OwnerTextResult } from "../ownerTextChannel.js";
import { hermesHome } from "../proactive/boards.js";
import { checkReminderSchedule, resolveEndsAt } from "./schedule.js";
import { OwnerReminderStore, ownerReminderStateDir } from "./store.js";
import type { OwnerReminder, OwnerReminderRetireReason, OwnerReminderRun } from "./types.js";

export const MAX_ACTIVE_REMINDERS = 20;
export const MAX_TITLE_CHARS = 80;
export const MAX_TEXT_CHARS = 320;
export const MAX_RUNS = 20;
export const OWNER_REMINDER_JOB_PREFIX = "Owner reminder: ";
export const OWNER_REMINDER_SCRIPT_PREFIX = "owner-reminder-";
/** Kanban task statuses that close the linked task of an owner reminder. */
export const CLOSED_TASK_STATUSES = new Set(["done", "archived"]);

export type OwnerReminderDeps = {
  projectRoot: string;
  store: OwnerReminderStore;
  /** Hermes scripts directory (~/.hermes/scripts). */
  scriptsDir: string;
  cron: (payload: CronBridgePayload) => Promise<CronBridgeResult>;
  /** Status of a Kanban task; undefined when not found. Throws when the Kanban bridge fails. */
  taskStatus: (board: string, taskId: string) => Promise<string | undefined>;
  sendText: (input: OwnerTextInput) => Promise<OwnerTextResult>;
  now: () => Date;
};

export type OwnerReminderCreateInput = {
  title?: unknown;
  text?: unknown;
  schedule?: unknown;
  endsAt?: unknown;
  linkedTaskId?: unknown;
  linkedBoard?: unknown;
};

/** HTTP-shaped result: the routes send `body` with `status`. */
export type OwnerReminderResult = { status: number; body: Record<string, unknown> };

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function ownerReminderSms(reminder: Pick<OwnerReminder, "text">): string {
  return `Reminder: ${reminder.text} Reply DONE when it is done.`;
}

export function ownerReminderEmail(reminder: Pick<OwnerReminder, "id" | "title" | "text">): {
  subject: string;
  body: string;
} {
  return {
    subject: `Reminder: ${reminder.title}`,
    body:
      `${reminder.text}\n\n` +
      `Reply "done" when it is done, and I will stop this reminder.\n\n` +
      `Reminder id: ${reminder.id}`,
  };
}

/** Script that Hermes runs for one owner reminder (Hermes passes no arguments). */
export function ownerReminderScript(id: string): string {
  return `#!/usr/bin/env bash
# Owner reminder ${id} (Joshu). Generated file; Joshu deletes it when the owner reminder retires.
set -uo pipefail
PORT="\${JOSHU_API_PORT:-8788}"
BASE="\${JOSHU_API_BASE:-http://127.0.0.1:\${PORT}/joshu}"
out="$(curl -sS -X POST "\${BASE}/api/owner-reminders/${id}/fire" -H "Content-Type: application/json" -d '{}' -w '\\n%{http_code}')" || {
  echo "owner reminder ${id}: Joshu API unreachable" >&2
  exit 1
}
code="\${out##*$'\\n'}"
body="\${out%$'\\n'*}"
if [[ "\${code}" != 2* ]]; then
  echo "owner reminder ${id}: HTTP \${code} \${body}" >&2
  exit 1
fi
echo "\${body}"
`;
}

function pushRun(reminder: OwnerReminder, run: OwnerReminderRun): void {
  reminder.runs.push(run);
  if (reminder.runs.length > MAX_RUNS) reminder.runs.splice(0, reminder.runs.length - MAX_RUNS);
}

/**
 * Owner reminder that an SMS "DONE" stops: the active owner reminder with the
 * newest delivered SMS run, when that run is newer than the last nudge and
 * younger than the follow-up window (design decision 5).
 */
export function pickReminderForOwnerDone(
  reminders: OwnerReminder[],
  opts: { lastNudgeSentAt?: string | null; windowMs: number; nowMs: number },
): OwnerReminder | undefined {
  const nudgeMs = Date.parse(opts.lastNudgeSentAt ?? "");
  let best: { reminder: OwnerReminder; at: number } | undefined;
  for (const reminder of reminders) {
    if (reminder.status !== "active") continue;
    for (const run of reminder.runs) {
      if (run.result !== "delivered" || run.channel !== "sms") continue;
      const at = Date.parse(run.at);
      if (!Number.isFinite(at) || opts.nowMs - at >= opts.windowMs) continue;
      if (Number.isFinite(nudgeMs) && at <= nudgeMs) continue;
      if (!best || at > best.at) best = { reminder, at };
    }
  }
  return best?.reminder;
}

export class OwnerReminderService {
  constructor(private readonly deps: OwnerReminderDeps) {}

  async list(): Promise<OwnerReminder[]> {
    return (await this.deps.store.read()).reminders;
  }

  async create(input: OwnerReminderCreateInput): Promise<OwnerReminderResult> {
    const title = str(input.title);
    const text = str(input.text).replace(/\s+/g, " ");
    if (!title || title.length > MAX_TITLE_CHARS) {
      return { status: 400, body: { ok: false, error: `title is required (at most ${MAX_TITLE_CHARS} characters)` } };
    }
    if (!text || text.length > MAX_TEXT_CHARS) {
      return { status: 400, body: { ok: false, error: `text is required (at most ${MAX_TEXT_CHARS} characters)` } };
    }
    const schedule = checkReminderSchedule(input.schedule);
    if (!schedule.ok) return { status: 400, body: { ok: false, error: schedule.error } };
    const now = this.deps.now();
    const ends = resolveEndsAt(input.endsAt, schedule.kind, now);
    if (!ends.ok) return { status: 400, body: { ok: false, error: ends.error } };
    const taskId = str(input.linkedTaskId);
    const board = str(input.linkedBoard);
    if (Boolean(taskId) !== Boolean(board)) {
      return { status: 400, body: { ok: false, error: "linkedTaskId and linkedBoard go together" } };
    }

    const id = `r_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
    const reminder: OwnerReminder = {
      id,
      title,
      text,
      schedule: schedule.schedule,
      kind: schedule.kind,
      createdAt: now.toISOString(),
      ...(ends.endsAt ? { endsAt: ends.endsAt } : {}),
      ...(taskId ? { linkedTask: { board, taskId } } : {}),
      scriptName: `${OWNER_REMINDER_SCRIPT_PREFIX}${id}.sh`,
      status: "active",
      runs: [],
    };

    // Save the record before the Hermes cron job exists, so a first run always finds it.
    const admitted = await this.deps.store.transaction((state) => {
      const active = state.reminders.filter((r) => r.status === "active").length;
      if (active >= MAX_ACTIVE_REMINDERS) return { result: false, changed: false };
      state.reminders.push(reminder);
      return { result: true, changed: true };
    });
    if (!admitted) {
      return { status: 409, body: { ok: false, error: `at most ${MAX_ACTIVE_REMINDERS} owner reminders can be active` } };
    }

    const scriptPath = path.join(this.deps.scriptsDir, reminder.scriptName);
    let created: CronBridgeResult;
    try {
      await mkdir(this.deps.scriptsDir, { recursive: true });
      await writeFile(scriptPath, ownerReminderScript(id), { mode: 0o700 });
      await chmod(scriptPath, 0o700);
      created = await this.deps.cron({
        action: "create",
        name: `${OWNER_REMINDER_JOB_PREFIX}${title}`,
        schedule: schedule.schedule,
        script: reminder.scriptName,
        no_agent: true,
        deliver: "local",
        workdir: this.deps.projectRoot,
      });
    } catch (error) {
      created = { success: false, error: error instanceof Error ? error.message : String(error) };
    }
    const jobId = typeof created.job_id === "string" ? created.job_id : "";
    if (!created.success || !jobId) {
      await this.deps.store.transaction((state) => ({
        result: undefined,
        changed: removeById(state.reminders, id),
      }));
      await rm(scriptPath, { force: true }).catch(() => undefined);
      return {
        status: 502,
        body: { ok: false, error: `Hermes cron job not created: ${created.error ?? "unknown error"}` },
      };
    }

    const saved = await this.deps.store.transaction((state) => {
      const found = state.reminders.find((r) => r.id === id);
      if (found) found.cronJobId = jobId;
      return { result: structuredClone(found ?? reminder), changed: Boolean(found) };
    });
    console.info(`[owner-reminders] created ${id} job=${jobId} schedule="${schedule.schedule}"`);
    return { status: 201, body: { ok: true, reminder: saved } };
  }

  async stop(id: string, reason: "stopped" | "owner_done" = "stopped"): Promise<OwnerReminderResult> {
    const retired = await this.retire(id, reason);
    if (!retired) return { status: 404, body: { ok: false, error: `unknown owner reminder ${id}` } };
    return { status: 200, body: { ok: true, reminder: retired } };
  }

  /** One run of the Hermes cron job of an owner reminder (design decision 3). */
  async fire(id: string): Promise<OwnerReminderResult> {
    const reminder = (await this.deps.store.read()).reminders.find((r) => r.id === id);
    if (!reminder) return { status: 404, body: { ok: false, error: `unknown owner reminder ${id}` } };
    if (reminder.status !== "active") {
      if (reminder.retiredReason !== "one_time_failed") await this.removeHermesJob(reminder);
      return { status: 200, body: { ok: true, skipped: "retired", reason: reminder.retiredReason } };
    }

    const now = this.deps.now();
    if (reminder.endsAt && now.getTime() > Date.parse(reminder.endsAt)) {
      await this.retire(id, "ended", { at: now.toISOString(), result: "skipped", reason: "ended" });
      return { status: 200, body: { ok: true, skipped: "ended" } };
    }

    if (reminder.linkedTask) {
      const { board, taskId } = reminder.linkedTask;
      try {
        const status = await this.deps.taskStatus(board, taskId);
        if (status && CLOSED_TASK_STATUSES.has(status)) {
          await this.retire(id, "task_closed", { at: now.toISOString(), result: "skipped", reason: "task_closed" });
          return { status: 200, body: { ok: true, skipped: "task_closed", taskStatus: status } };
        }
      } catch (error) {
        // A missed reminder is worse than one extra reminder: send anyway.
        console.warn(`[owner-reminders] ${id} linked task check failed: ${(error as Error).message}`);
      }
    }

    const email = ownerReminderEmail(reminder);
    let sent: OwnerTextResult;
    try {
      sent = await this.deps.sendText({ sms: ownerReminderSms(reminder), emailSubject: email.subject, emailBody: email.body });
    } catch (error) {
      sent = { delivered: false, error: error instanceof Error ? error.message : String(error) };
    }
    const run: OwnerReminderRun = sent.delivered
      ? { at: now.toISOString(), result: "delivered", ...(sent.channel ? { channel: sent.channel } : {}) }
      : { at: now.toISOString(), result: "failed", error: sent.error ?? "unknown error" };

    if (reminder.kind === "one_time") {
      await this.retire(id, sent.delivered ? "one_time" : "one_time_failed", run);
    } else {
      await this.deps.store.transaction((state) => {
        const found = state.reminders.find((r) => r.id === id);
        if (found) pushRun(found, run);
        return { result: undefined, changed: Boolean(found) };
      });
    }

    if (!sent.delivered) {
      console.warn(`[owner-reminders] delivery failed id=${id} error=${run.error}`);
      return { status: 502, body: { ok: false, delivered: false, error: run.error } };
    }
    return { status: 200, body: { ok: true, delivered: true, channel: sent.channel } };
  }

  /** Retire after an SMS "DONE"; returns the retired owner reminder, if one matched. */
  async retireForOwnerDone(opts: {
    lastNudgeSentAt?: string | null;
    windowMs: number;
  }): Promise<OwnerReminder | undefined> {
    const reminders = await this.list();
    const match = pickReminderForOwnerDone(reminders, { ...opts, nowMs: this.deps.now().getTime() });
    if (!match) return undefined;
    return this.retire(match.id, "owner_done");
  }

  /**
   * Mark the record retired, then remove the Hermes cron job and delete the script.
   * A failed one-time run keeps its completed Hermes cron job, so the failure
   * report keeps showing the error.
   */
  private async retire(
    id: string,
    reason: OwnerReminderRetireReason,
    run?: OwnerReminderRun,
  ): Promise<OwnerReminder | undefined> {
    const at = this.deps.now().toISOString();
    const retired = await this.deps.store.transaction((state) => {
      const found = state.reminders.find((r) => r.id === id);
      if (!found) return { result: undefined, changed: false };
      if (run) pushRun(found, run);
      if (found.status === "active") {
        found.status = "retired";
        found.retiredAt = at;
        found.retiredReason = reason;
      }
      return { result: structuredClone(found), changed: true };
    });
    if (!retired) return undefined;
    if (reason !== "one_time_failed") await this.removeHermesJob(retired);
    console.info(`[owner-reminders] retired ${id} reason=${retired.retiredReason}`);
    return retired;
  }

  private async removeHermesJob(reminder: OwnerReminder): Promise<void> {
    if (reminder.cronJobId) {
      try {
        const removed = await this.deps.cron({ action: "remove", job_id: reminder.cronJobId });
        if (!removed.success && !/not found/i.test(String(removed.error ?? ""))) {
          console.warn(`[owner-reminders] remove job ${reminder.cronJobId} failed: ${removed.error}`);
        }
      } catch (error) {
        console.warn(`[owner-reminders] remove job ${reminder.cronJobId} failed: ${(error as Error).message}`);
      }
    }
    await rm(path.join(this.deps.scriptsDir, reminder.scriptName), { force: true }).catch(() => undefined);
  }
}

function removeById(reminders: OwnerReminder[], id: string): boolean {
  const index = reminders.findIndex((r) => r.id === id);
  if (index < 0) return false;
  reminders.splice(index, 1);
  return true;
}

let defaultService: OwnerReminderService | undefined;

/** Production service: cron bridge, Kanban bridge, owner text channel. */
export function ownerReminderService(projectRoot: string): OwnerReminderService {
  defaultService ??= new OwnerReminderService({
    projectRoot,
    store: new OwnerReminderStore(ownerReminderStateDir(projectRoot)),
    scriptsDir: path.join(hermesHome(), "scripts"),
    cron: callCronBridge,
    taskStatus: async (board, taskId) => {
      const shown = await callKanbanBridge({ action: "show", board, task_id: taskId });
      if (!shown.success) {
        if (/not found/i.test(String(shown.error ?? ""))) return undefined;
        throw new Error(String(shown.error ?? "kanban show failed"));
      }
      return shown.task?.status;
    },
    sendText: (input) => sendOwnerText(projectRoot, input),
    now: () => new Date(),
  });
  return defaultService;
}
