import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { resolveJoshuFilesPaths } from "../joshuFilesPaths.js";
import type {
  SessionThread,
  SessionThreadState,
  SessionThreadTurn,
  SessionThreadTurnSource,
} from "./types.js";

const DEFAULT_MAX_TURNS = 12;
const DEFAULT_TTL_MS = 48 * 60 * 60_000;

const EMPTY_STATE: SessionThreadState = { version: 1, threads: {} };

/**
 * One write chain per threads.json file, shared by every store instance in the
 * process (the broker and the owner text channel each make one).
 */
const transactionTails = new Map<string, Promise<unknown>>();

function stateDirectory(projectRoot: string): string {
  const explicit = process.env.JOSHU_REALTIME_GOALS_STATE_DIR?.trim();
  if (explicit) return path.resolve(explicit);
  const filesRoot = resolveJoshuFilesPaths(projectRoot)?.filesRoot;
  return filesRoot
    ? path.join(filesRoot, ".joshu", "realtime-goals")
    : path.join(projectRoot, ".local", "realtime-goals");
}

function maxTurns(): number {
  const raw = Number.parseInt(process.env.JOSHU_REALTIME_GOALS_THREAD_MAX_TURNS ?? "", 10);
  return Number.isFinite(raw) && raw >= 2 ? raw : DEFAULT_MAX_TURNS;
}

function ttlMs(): number {
  const raw = Number.parseInt(process.env.JOSHU_REALTIME_GOALS_THREAD_TTL_HOURS ?? "", 10);
  const hours = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TTL_MS / 3_600_000;
  return hours * 3_600_000;
}

function normalizeState(value: unknown): SessionThreadState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...EMPTY_STATE, threads: {} };
  }
  const parsed = value as Partial<SessionThreadState>;
  const threads =
    parsed.threads && typeof parsed.threads === "object" && !Array.isArray(parsed.threads)
      ? parsed.threads
      : {};
  return { version: 1, threads };
}

function trimThread(thread: SessionThread): SessionThread {
  const cutoff = Date.now() - ttlMs();
  const fresh = thread.turns.filter((turn) => Date.parse(turn.at) >= cutoff);
  const bounded = fresh.slice(-maxTurns());
  return {
    sessionKey: thread.sessionKey,
    turns: bounded,
    updatedAt: thread.updatedAt,
    ...(thread.activeGoalId ? { activeGoalId: thread.activeGoalId } : {}),
    ...(thread.activeGoalSetAt ? { activeGoalSetAt: thread.activeGoalSetAt } : {}),
  };
}

export function formatSessionThreadForPrompt(
  turns: SessionThreadTurn[],
  limit = maxTurns(),
): string {
  if (turns.length === 0) return "(empty)";
  return turns
    .slice(-limit)
    .map((turn) => {
      const speaker = turn.role === "owner" ? "Owner" : "Box";
      return `${speaker}: ${turn.text.replace(/\s+/g, " ").slice(0, 400)}`;
    })
    .join("\n");
}

/**
 * Durable bounded owner↔box transcript keyed by stable sessionKey.
 */
export class SessionThreadStore {
  private readonly file: string;

  constructor(projectRoot: string) {
    const dir = stateDirectory(projectRoot);
    this.file = path.join(dir, "threads.json");
  }

  private async readUnlocked(): Promise<SessionThreadState> {
    try {
      return normalizeState(JSON.parse(await readFile(this.file, "utf8")));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return { version: 1, threads: {} };
      throw new Error(`session thread read failed: ${(error as Error).message}`);
    }
  }

  private async writeUnlocked(state: SessionThreadState): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, this.file);
  }

  private async transaction<T>(
    mutate: (
      state: SessionThreadState,
    ) => Promise<{ result: T; changed: boolean }> | { result: T; changed: boolean },
  ): Promise<T> {
    let resolveResult!: (value: T | PromiseLike<T>) => void;
    let rejectResult!: (reason?: unknown) => void;
    const result = new Promise<T>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });

    const tail = (transactionTails.get(this.file) ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        try {
          const state = await this.readUnlocked();
          const next = await mutate(state);
          if (next.changed) await this.writeUnlocked(state);
          resolveResult(next.result);
        } catch (error) {
          rejectResult(error);
        }
      });
    transactionTails.set(this.file, tail);
    return result;
  }

  async getTurns(sessionKey: string): Promise<SessionThreadTurn[]> {
    const state = await this.readUnlocked();
    const thread = state.threads[sessionKey];
    return thread ? trimThread(thread).turns : [];
  }

  async appendTurn(
    sessionKey: string,
    turn: Omit<SessionThreadTurn, "at"> & { at?: string },
  ): Promise<boolean> {
    return this.transaction((state) => {
      const at = turn.at ?? new Date().toISOString();
      const existing = state.threads[sessionKey];
      const thread: SessionThread = existing ?? {
        sessionKey,
        turns: [],
        updatedAt: at,
      };
      if (
        turn.messageId &&
        thread.turns.some((item) => item.messageId && item.messageId === turn.messageId)
      ) {
        return { result: false, changed: false };
      }
      thread.turns.push({
        at,
        role: turn.role,
        text: turn.text.slice(0, 4_000),
        source: turn.source,
        ...(turn.messageId ? { messageId: turn.messageId } : {}),
        ...(turn.goalId ? { goalId: turn.goalId } : {}),
      });
      thread.updatedAt = at;
      state.threads[sessionKey] = trimThread(thread);
      return { result: true, changed: true };
    });
  }

  async recordOwnerTurn(
    sessionKey: string,
    text: string,
    messageId?: string,
  ): Promise<boolean> {
    return this.appendTurn(sessionKey, {
      role: "owner",
      text,
      source: "inbound",
      ...(messageId ? { messageId } : {}),
    });
  }

  async recordBoxTurn(
    sessionKey: string,
    text: string,
    source: SessionThreadTurnSource,
    goalId?: string,
  ): Promise<boolean> {
    return this.appendTurn(sessionKey, {
      role: "box",
      text,
      source,
      ...(goalId ? { goalId } : {}),
    });
  }

  async getActiveGoal(
    sessionKey: string,
  ): Promise<{ goalId: string; setAt: string } | undefined> {
    const thread = (await this.readUnlocked()).threads[sessionKey];
    const goalId = thread?.activeGoalId?.trim();
    if (!goalId) return undefined;
    return {
      goalId,
      setAt: thread?.activeGoalSetAt ?? thread?.updatedAt ?? new Date().toISOString(),
    };
  }

  async setActiveGoal(sessionKey: string, goalId: string): Promise<void> {
    const trimmed = goalId.trim();
    if (!trimmed) return;
    await this.transaction((state) => {
      const at = new Date().toISOString();
      const thread = state.threads[sessionKey] ?? {
        sessionKey,
        turns: [],
        updatedAt: at,
      };
      thread.activeGoalId = trimmed;
      thread.activeGoalSetAt = at;
      thread.updatedAt = at;
      state.threads[sessionKey] = trimThread(thread);
      return { result: undefined, changed: true };
    });
  }

  async clearActiveGoal(sessionKey: string): Promise<void> {
    await this.transaction((state) => {
      const thread = state.threads[sessionKey];
      if (!thread?.activeGoalId) return { result: undefined, changed: false };
      delete thread.activeGoalId;
      delete thread.activeGoalSetAt;
      thread.updatedAt = new Date().toISOString();
      state.threads[sessionKey] = trimThread(thread);
      return { result: undefined, changed: true };
    });
  }
}
