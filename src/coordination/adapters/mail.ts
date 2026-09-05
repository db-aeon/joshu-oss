import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { normalizeRfcMessageId } from "../../connectors/rfcMessageId.js";
import { mailThreadsDir, type ConnectorMailProvider } from "../../connectors/paths.js";
import { listGmailRegistryAccounts } from "../../connectors/composio/gmailAccounts.js";
import { parseEmailAddress } from "../../ea/schedulingTypes.js";
import {
  findOpenMeetingByThread,
  parseThreadIdFromTaskBody,
  threadIdInTaskSourcePaths,
  type SchedulingMeetingTaskSummary,
} from "../../ea/schedulingCron.js";
import type { OwnerReplyTaskSummary } from "../../ea/ownerReplyCron.js";
import { deriveScopeId, normalizeTopic } from "../scopeId.js";
import { listAllRegistryEntries, listRegistryForScope } from "../registry.js";
import type {
  ActiveCoordination,
  CoordinationCapability,
  CoordinationFacet,
  CoordinationScope,
  MailScopeInput,
  SpawnAllowedResult,
} from "../types.js";
import {
  EA_OWNER_REPLY_BOARD,
  EA_SCHEDULING_BOARD,
  boardForCapability,
  capabilityForBoard,
} from "../types.js";

export type EaTaskSummary = SchedulingMeetingTaskSummary | OwnerReplyTaskSummary;

function parseMirrorFrontmatter(raw: string): Record<string, unknown> | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/m.exec(raw);
  if (!match?.[1]) return null;
  try {
    return (YAML.parse(match[1]) as Record<string, unknown>) ?? {};
  } catch {
    return null;
  }
}

function normalizeEmailList(values?: string[]): string[] {
  if (!values?.length) return [];
  const out = new Set<string>();
  for (const raw of values) {
    const addr = parseEmailAddress(raw);
    if (addr) out.add(addr);
  }
  return [...out];
}

function collectParticipants(from?: string, to?: string[], cc?: string[]): string[] {
  const out = new Set<string>();
  const fromAddr = parseEmailAddress(from);
  if (fromAddr) out.add(fromAddr);
  for (const addr of [...normalizeEmailList(to), ...normalizeEmailList(cc)]) {
    out.add(addr);
  }
  return [...out].sort();
}

async function readMirrorMeta(
  filesRoot: string,
  sourcePath?: string,
): Promise<{
  threadId?: string;
  rfcMessageId?: string;
  from?: string;
  to?: string[];
  cc?: string[];
  subject?: string;
  provider?: string;
}> {
  if (!sourcePath?.trim()) return {};
  const absolute = path.isAbsolute(sourcePath)
    ? sourcePath
    : path.join(filesRoot, sourcePath);
  try {
    const raw = await readFile(absolute, "utf8");
    const fm = parseMirrorFrontmatter(raw);
    if (!fm) return {};
    return {
      threadId: typeof fm.thread_id === "string" ? fm.thread_id : undefined,
      rfcMessageId:
        typeof fm.rfc_message_id === "string"
          ? normalizeRfcMessageId(fm.rfc_message_id) ?? undefined
          : undefined,
      from: typeof fm.from === "string" ? fm.from : undefined,
      to: Array.isArray(fm.to) ? fm.to.filter((t): t is string => typeof t === "string") : undefined,
      cc: Array.isArray(fm.cc) ? fm.cc.filter((t): t is string => typeof t === "string") : undefined,
      subject: typeof fm.subject === "string" ? fm.subject : undefined,
      provider: typeof fm.source === "string" ? fm.source : undefined,
    };
  } catch {
    return {};
  }
}

/** Bounded scan for mirrors sharing the same RFC Message-ID (Gmail + Nylas). */
async function findThreadAliasesByRfc(
  filesRoot: string,
  rfcMessageId: string,
  projectRoot = process.cwd(),
): Promise<Array<{ threadId: string; provider: string; sourcePath: string }>> {
  const normalized = normalizeRfcMessageId(rfcMessageId);
  if (!normalized) return [];

  const hits: Array<{ threadId: string; provider: string; sourcePath: string }> = [];
  const providers: ConnectorMailProvider[] = ["nylas", "gmail"];

  for (const provider of providers) {
    if (provider === "gmail") {
      const accounts = await listGmailRegistryAccounts(projectRoot).catch(() => []);
      for (const account of accounts) {
        const dir = mailThreadsDir("gmail", filesRoot, account.accountKey);
        await scanDirForRfc(dir, filesRoot, normalized, provider, hits);
      }
      continue;
    }
    const dir = mailThreadsDir(provider, filesRoot);
    await scanDirForRfc(dir, filesRoot, normalized, provider, hits);
  }
  return hits;
}

async function scanDirForRfc(
  threadsDir: string,
  filesRoot: string,
  rfcMessageId: string,
  provider: string,
  hits: Array<{ threadId: string; provider: string; sourcePath: string }>,
): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(threadsDir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.endsWith(".md")) continue;
    const full = path.join(threadsDir, name);
    try {
      const raw = await readFile(full, "utf8");
      const fm = parseMirrorFrontmatter(raw);
      if (!fm) continue;
      const rfc =
        typeof fm.rfc_message_id === "string"
          ? normalizeRfcMessageId(fm.rfc_message_id)
          : null;
      if (rfc !== rfcMessageId) continue;
      const threadId =
        typeof fm.thread_id === "string" ? fm.thread_id : path.basename(name, ".md");
      const rel = path.relative(filesRoot, full).split(path.sep).join("/");
      hits.push({ threadId, provider, sourcePath: rel });
    } catch {
      /* skip unreadable mirror */
    }
  }
}

/** Resolve mail conversation scope — Meo-safe cross-provider thread alias union. */
export async function resolveMailCoordinationScope(
  input: MailScopeInput,
): Promise<CoordinationScope> {
  const threadId = input.threadId.trim();
  const mirror = await readMirrorMeta(input.filesRoot, input.sourcePath);
  const rfcMessageId = mirror.rfcMessageId;
  const subject = input.subject ?? mirror.subject;
  const from = input.from ?? mirror.from;
  const to = input.to ?? mirror.to;
  const cc = input.cc ?? mirror.cc;
  const provider = input.provider ?? mirror.provider ?? "nylas";

  const facets: CoordinationFacet[] = [
    {
      channel: "mail",
      key: threadId,
      provider,
      sourcePath: input.sourcePath,
      rfcMessageId,
    },
  ];
  const threadIds = new Set<string>([threadId]);
  const sourcePaths = new Set<string>();
  if (input.sourcePath?.trim()) sourcePaths.add(input.sourcePath.trim());

  if (mirror.threadId && mirror.threadId !== threadId) {
    threadIds.add(mirror.threadId);
    facets.push({
      channel: "mail",
      key: mirror.threadId,
      provider,
      sourcePath: input.sourcePath,
      rfcMessageId,
    });
  }

  if (rfcMessageId) {
    const aliases = await findThreadAliasesByRfc(
      input.filesRoot,
      rfcMessageId,
      input.projectRoot,
    );
    for (const alias of aliases) {
      threadIds.add(alias.threadId);
      sourcePaths.add(alias.sourcePath);
      facets.push({
        channel: "mail",
        key: alias.threadId,
        provider: alias.provider,
        sourcePath: alias.sourcePath,
        rfcMessageId,
      });
    }
  }

  const participants = collectParticipants(from, to, cc);
  const scopeId = deriveScopeId({
    facets,
    participants,
    topic: subject,
    rfcMessageId,
  });

  return {
    scopeId,
    channel: "mail",
    facets,
    participants,
    topic: normalizeTopic(subject) || undefined,
    projectSlug: input.projectSlug,
    threadIds: [...threadIds],
    sourcePaths: [...sourcePaths],
    rfcMessageId,
  };
}

/** True when an EA task body references any thread alias or source path in scope. */
export function taskBodyMatchesScope(body: string, scope: CoordinationScope): boolean {
  for (const threadId of scope.threadIds) {
    if (parseThreadIdFromTaskBody(body) === threadId) return true;
    if (threadIdInTaskSourcePaths(body, threadId)) return true;
  }
  for (const sourcePath of scope.sourcePaths) {
    if (sourcePath && body.includes(sourcePath)) return true;
  }
  if (scope.rfcMessageId && body.includes(scope.rfcMessageId)) return true;
  return false;
}

export function findOpenOwnerReplyByScope(
  tasks: OwnerReplyTaskSummary[],
  scope: CoordinationScope,
): OwnerReplyTaskSummary | undefined {
  return tasks.find((t) => {
    const body = t.body ?? "";
    if (!body.includes("kind: owner_reply") && !body.includes("owner_reply")) {
      /* board is owner-reply-only; accept bodies without explicit kind */
    }
    return taskBodyMatchesScope(body, scope);
  });
}

export function findOpenMeetingByScope(
  tasks: SchedulingMeetingTaskSummary[],
  scope: CoordinationScope,
): SchedulingMeetingTaskSummary | undefined {
  for (const threadId of scope.threadIds) {
    const hit = findOpenMeetingByThread(tasks, threadId);
    if (hit) return hit;
  }
  return tasks.find((t) => taskBodyMatchesScope(t.body ?? "", scope));
}

function inferCapabilityFromTaskBody(body: string, board: string): CoordinationCapability | null {
  if (body.includes("kind: owner_reply")) return "owner_deliverable";
  if (body.includes("kind: meeting")) return "meeting_negotiation";
  return capabilityForBoard(board);
}

export function activeFromKanbanTasks(
  scope: CoordinationScope,
  schedulingTasks: SchedulingMeetingTaskSummary[],
  ownerReplyTasks: OwnerReplyTaskSummary[],
): ActiveCoordination[] {
  const out: ActiveCoordination[] = [];
  const now = new Date().toISOString();

  for (const t of schedulingTasks) {
    const body = t.body ?? "";
    if (!taskBodyMatchesScope(body, scope)) continue;
    out.push({
      scopeId: scope.scopeId,
      capability: inferCapabilityFromTaskBody(body, EA_SCHEDULING_BOARD) ?? "meeting_negotiation",
      board: EA_SCHEDULING_BOARD,
      task_id: t.task_id,
      channel: "mail",
      created_at: now,
    });
  }
  for (const t of ownerReplyTasks) {
    const body = t.body ?? "";
    if (!taskBodyMatchesScope(body, scope)) continue;
    out.push({
      scopeId: scope.scopeId,
      capability: inferCapabilityFromTaskBody(body, EA_OWNER_REPLY_BOARD) ?? "owner_deliverable",
      board: EA_OWNER_REPLY_BOARD,
      task_id: t.task_id,
      channel: "mail",
      created_at: now,
    });
  }
  return out;
}

export async function listActiveCoordinationForScope(opts: {
  filesRoot: string;
  scope: CoordinationScope;
  schedulingTasks: SchedulingMeetingTaskSummary[];
  ownerReplyTasks: OwnerReplyTaskSummary[];
}): Promise<ActiveCoordination[]> {
  const fromKanban = activeFromKanbanTasks(
    opts.scope,
    opts.schedulingTasks,
    opts.ownerReplyTasks,
  );
  const fromRegistry = await listRegistryForScope(opts.filesRoot, opts.scope.scopeId);

  const byTask = new Map<string, ActiveCoordination>();
  for (const entry of [...fromRegistry, ...fromKanban]) {
    byTask.set(`${entry.board}:${entry.task_id}`, entry);
  }
  return [...byTask.values()];
}

/** Cross-capability mutex — blocks parallel ea-scheduling + ea-owner-reply on same scope. */
export function assertSpawnAllowed(opts: {
  scope: CoordinationScope;
  requestingBoard: string;
  capability: CoordinationCapability;
  active: ActiveCoordination[];
}): SpawnAllowedResult {
  const { scope, requestingBoard, capability, active } = opts;
  const sameBoard = active.filter((a) => a.board === requestingBoard && a.capability === capability);
  if (sameBoard.length > 0) {
    const hit = sameBoard[0]!;
    return {
      ok: false,
      conflict: {
        board: hit.board,
        task_id: hit.task_id,
        capability: hit.capability,
        reason: "existing_coordination",
        scopeId: scope.scopeId,
      },
    };
  }

  const crossBoard = active.filter((a) => a.capability !== capability);
  if (crossBoard.length > 0) {
    const hit = crossBoard[0]!;
    const reason =
      capability === "meeting_negotiation" && hit.capability === "owner_deliverable"
        ? "existing_owner_reply"
        : capability === "owner_deliverable" && hit.capability === "meeting_negotiation"
          ? "existing_scheduling"
          : "existing_coordination";
    return {
      ok: false,
      conflict: {
        board: hit.board,
        task_id: hit.task_id,
        capability: hit.capability,
        reason,
        scopeId: scope.scopeId,
      },
    };
  }

  return { ok: true };
}

export async function listAllActiveCoordination(filesRoot: string): Promise<ActiveCoordination[]> {
  return listAllRegistryEntries(filesRoot);
}

export { boardForCapability };
