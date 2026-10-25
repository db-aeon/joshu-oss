import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { resolveJoshuFilesPaths } from "../joshuFilesPaths.js";
import {
  isRealtimeGoalActive,
  realtimeGoalSessionKey,
  type RealtimeGoalDeliveryKind,
  type RealtimeGoalInboxRecord,
  type RealtimeGoalRecord,
  type RealtimeGoalState,
  type RealtimeGoalVoiceCallbackOutcome,
} from "./types.js";

/** Delivery states that end automatic delivery for the current content. */
function deliveryFinished(goal: RealtimeGoalRecord): boolean {
  const state = goal.delivery.state;
  return state === "delivered" || state === "suppressed" || state === "parked" || state === "outbox";
}

/** Hash kind+text so duplicate completion SMS can be suppressed idempotently. */
export function realtimeGoalDeliveryContentKey(
  kind: RealtimeGoalDeliveryKind,
  text: string,
): string {
  return createHash("sha256").update(`${kind}\n${text}`).digest("hex").slice(0, 32);
}

const EMPTY_STATE: RealtimeGoalState = { version: 1, goals: [] };

function stateDirectory(projectRoot: string): string {
  const explicit = process.env.JOSHU_REALTIME_GOALS_STATE_DIR?.trim();
  if (explicit) return path.resolve(explicit);
  const filesRoot = resolveJoshuFilesPaths(projectRoot)?.filesRoot;
  return filesRoot
    ? path.join(filesRoot, ".joshu", "realtime-goals")
    : path.join(projectRoot, ".local", "realtime-goals");
}

function normalizeState(value: unknown): RealtimeGoalState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...EMPTY_STATE };
  const parsed = value as Partial<RealtimeGoalState>;
  const owner =
    parsed.owner && typeof parsed.owner === "object" && parsed.owner.presence
      ? parsed.owner
      : undefined;
  return {
    version: 1,
    goals: Array.isArray(parsed.goals) ? parsed.goals : [],
    inbox: Array.isArray(parsed.inbox) ? parsed.inbox : [],
    ...(Array.isArray(parsed.outbox) ? { outbox: parsed.outbox } : {}),
    ...(owner ? { owner } : {}),
  };
}

/**
 * Small, process-serialized JSON registry.
 *
 * Kanban owns execution state. This file owns intake, source idempotency, and
 * same-channel delivery cursors, and is persisted on the owner's Files volume.
 */
export class RealtimeGoalStore {
  private readonly dir: string;

  /** Directory holding state.json (and sibling files such as inline-jobs.json). */
  get directory(): string {
    return this.dir;
  }
  private readonly file: string;
  private transactionTail: Promise<unknown> = Promise.resolve();

  constructor(projectRoot: string) {
    this.dir = stateDirectory(projectRoot);
    this.file = path.join(this.dir, "state.json");
  }

  /** The parsed state and the file text it came from (undefined when the file is missing). */
  private async readUnlocked(): Promise<{ state: RealtimeGoalState; text?: string }> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return { state: { ...EMPTY_STATE, goals: [] } };
      throw new Error(`realtime goal state read failed: ${(error as Error).message}`);
    }
    try {
      return { state: normalizeState(JSON.parse(text)), text };
    } catch (error) {
      throw new Error(`realtime goal state read failed: ${(error as Error).message}`);
    }
  }

  /**
   * Write the state unless it serializes to the text already on disk. The
   * broker ticks every few seconds, and each rewrite is a rename under the
   * owner's Desktop that file watchers see (File Brain reindexed nonstop).
   */
  private async writeUnlocked(state: RealtimeGoalState, previousText?: string): Promise<void> {
    const inboxCutoff = Date.now() - 7 * 24 * 60 * 60_000;
    state.inbox = (state.inbox ?? []).filter(
      (item) =>
        (!item.processedAt && !item.recoveryNotifiedAt) ||
        Date.parse(item.receivedAt) >= inboxCutoff,
    );
    const text = `${JSON.stringify(state, null, 2)}\n`;
    if (text === previousText) return;
    await mkdir(this.dir, { recursive: true });
    const temp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temp, text, { mode: 0o600 });
    await rename(temp, this.file);
  }

  async read(): Promise<RealtimeGoalState> {
    return this.transaction(async (state) => ({ result: structuredClone(state), changed: false }));
  }

  /**
   * Copy state.json aside once per tag before a schema migration writes it.
   * Returns the backup path, or undefined when there was nothing to back up.
   */
  async backupOnce(tag: string): Promise<string | undefined> {
    const backup = `${this.file}.bak-${tag}`;
    try {
      await readFile(backup);
      return undefined;
    } catch {
      /* not backed up yet */
    }
    try {
      await copyFile(this.file, backup);
      return backup;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async transaction<T>(
    mutate: (state: RealtimeGoalState) => Promise<{ result: T; changed: boolean }> | { result: T; changed: boolean },
  ): Promise<T> {
    let resolveResult!: (value: T | PromiseLike<T>) => void;
    let rejectResult!: (reason?: unknown) => void;
    const result = new Promise<T>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });

    this.transactionTail = this.transactionTail
      .catch(() => undefined)
      .then(async () => {
        try {
          const { state, text } = await this.readUnlocked();
          const next = await mutate(state);
          if (next.changed) await this.writeUnlocked(state, text);
          resolveResult(next.result);
        } catch (error) {
          rejectResult(error);
        }
      });
    return result;
  }

  async get(goalId: string): Promise<RealtimeGoalRecord | undefined> {
    const state = await this.read();
    return state.goals.find((goal) => goal.id === goalId);
  }

  async findBySource(originKey: string, sourceMessageId: string): Promise<RealtimeGoalRecord | undefined> {
    const state = await this.read();
    return state.goals.find(
      (goal) =>
        realtimeGoalSessionKey(goal.origin) === originKey &&
        (goal.sourceMessageId === sourceMessageId ||
          goal.handledSourceIds?.includes(sourceMessageId)),
    );
  }

  /**
   * Active goals across every channel the owner uses (owner-scoped trunk). The
   * box has one owner, so a phone request is visible from SMS and vice versa.
   */
  async listActiveForOwner(): Promise<RealtimeGoalRecord[]> {
    const state = await this.read();
    return state.goals
      .filter((goal) => isRealtimeGoalActive(goal))
      .sort((a, b) =>
        (b.ownerInteractedAt ?? b.createdAt).localeCompare(
          a.ownerInteractedAt ?? a.createdAt,
        ),
      );
  }

  /** Done/failed goals finished since `sinceMs` on any channel (newest first). */
  async listRecentFinishedForOwner(sinceMs: number): Promise<RealtimeGoalRecord[]> {
    const state = await this.read();
    return state.goals
      .filter((goal) => goal.status === "done" || goal.status === "failed")
      .filter((goal) => Date.parse(goal.updatedAt) >= sinceMs)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** Recent done/blocked goals that may reopen when the active pointer is stale. */
  async listContinuableForSession(
    originKey: string,
    ttlMs: number,
  ): Promise<RealtimeGoalRecord[]> {
    const cutoff = Date.now() - ttlMs;
    const state = await this.read();
    return state.goals
      .filter((goal) => realtimeGoalSessionKey(goal.origin) === originKey)
      .filter((goal) => goal.status === "done" || goal.status === "blocked")
      .filter((goal) => Date.parse(goal.updatedAt) >= cutoff)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async listOutstanding(): Promise<RealtimeGoalRecord[]> {
    const state = await this.read();
    return state.goals.filter(
      (goal) => {
        if (
          goal.status === "cancelled" &&
          !goal.kanbanTaskId &&
          goal.releaseAt &&
          Date.parse(goal.releaseAt) <= Date.now() &&
          !goal.cancellationReconciledAt
        ) {
          return true;
        }
        if (goal.status === "queued" || goal.status === "releasing" || goal.status === "cancelling") {
          return true;
        }
        if (!goal.kanbanTaskId || goal.status === "cancelled") return false;
        const taskTerminal = goal.status === "done" || goal.status === "failed";
        return !taskTerminal || !deliveryFinished(goal);
      },
    );
  }

  async insert(goal: RealtimeGoalRecord): Promise<RealtimeGoalRecord> {
    return this.transaction((state) => {
      const duplicate = state.goals.find(
        (item) =>
          realtimeGoalSessionKey(item.origin) === realtimeGoalSessionKey(goal.origin) &&
          item.sourceMessageId === goal.sourceMessageId,
      );
      if (duplicate) return { result: duplicate, changed: false };
      state.goals.push(goal);
      return { result: goal, changed: true };
    });
  }

  async update(
    goalId: string,
    mutate: (goal: RealtimeGoalRecord) => void,
  ): Promise<RealtimeGoalRecord | undefined> {
    return this.transaction((state) => {
      const goal = state.goals.find((item) => item.id === goalId);
      if (!goal) return { result: undefined, changed: false };
      mutate(goal);
      goal.updatedAt = new Date().toISOString();
      return { result: structuredClone(goal), changed: true };
    });
  }

  async reserveInbound(record: RealtimeGoalInboxRecord): Promise<void> {
    await this.transaction((state) => {
      state.inbox ??= [];
      if (state.inbox.some((item) => item.id === record.id)) {
        return { result: undefined, changed: false };
      }
      state.inbox.push(record);
      return { result: undefined, changed: true };
    });
  }

  async completeInbound(id: string): Promise<void> {
    await this.transaction((state) => {
      const item = state.inbox?.find((candidate) => candidate.id === id);
      if (!item || item.processedAt) return { result: undefined, changed: false };
      item.processedAt = new Date().toISOString();
      return { result: undefined, changed: true };
    });
  }

  async listStaleInbound(minAgeMs: number): Promise<RealtimeGoalInboxRecord[]> {
    const state = await this.read();
    const cutoff = Date.now() - minAgeMs;
    return (state.inbox ?? []).filter(
      (item) =>
        !item.processedAt &&
        !item.recoveryNotifiedAt &&
        Date.parse(item.receivedAt) <= cutoff,
    );
  }

  async markInboundRecoveryNotified(id: string): Promise<void> {
    await this.transaction((state) => {
      const item = state.inbox?.find((candidate) => candidate.id === id);
      if (!item || item.recoveryNotifiedAt) return { result: undefined, changed: false };
      item.recoveryNotifiedAt = new Date().toISOString();
      return { result: undefined, changed: true };
    });
  }
}
