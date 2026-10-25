/**
 * Handoff of an owner Gmail reply to the open tracks of its thread
 * (openspec/glossary.md; spec gmail-sync, change gmail-owner-reply-handoff).
 * Delivery only: the worker of each track judges the reply.
 */
import { callKanbanBridge, type KanbanBridgeCall } from "../hermesKanbanBridge.js";
import { listKanbanBoardSlugs } from "../proactive/boards.js";
import { resolveJoshuAgentEmails } from "./ingestFilters.js";
import { findOpenMailTracksByThreadOnBoards, handoffMailToTrackTask } from "./mailCron.js";
import { parseEmailAddress } from "./mailTypes.js";

export type OwnerGmailReplyInput = {
  filesRoot: string;
  projectRoot: string;
  threadId: string;
  /** Mail mirror path relative to the files root. */
  sourcePath: string;
  messageId: string;
  from?: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  accountEmail?: string;
};

export type OwnerGmailReplyResult = {
  /** Task ids of the tracks that got the handoff. */
  handedOff: string[];
  skipped?: "companion_recipient" | "no_open_track";
};

/**
 * The sync hands off only when it triages (not Day 0), and only when the thread had a
 * mail mirror before: a track can reference a thread only after a prior mail mirror.
 */
export function shouldHandoffOwnerGmailReply(opts: {
  priorMirrorMessageIds: string[] | null;
  classifyTriage: boolean;
  skipTriageStubs: boolean;
}): boolean {
  return Boolean(opts.priorMirrorMessageIds?.length) && opts.classifyTriage && !opts.skipTriageStubs;
}

export function ownerGmailReplyHandoffSummary(accountEmail?: string): string {
  const account = accountEmail?.trim() ? ` (${accountEmail.trim()})` : "";
  return `The owner sent a reply on this thread from owner Gmail${account}. The companion was not a recipient. Read the newest message of the mail mirror.`;
}

export async function handoffOwnerGmailReply(
  input: OwnerGmailReplyInput,
  deps: { bridge?: KanbanBridgeCall; boards?: string[]; agentEmails?: Set<string> } = {},
): Promise<OwnerGmailReplyResult> {
  // The companion inbox gets the same email when the companion is a recipient; mail ingress handles it there.
  const agentEmails = deps.agentEmails ?? resolveJoshuAgentEmails(input.projectRoot);
  const recipients = [...(input.to ?? []), ...(input.cc ?? []), ...(input.bcc ?? [])];
  if (recipients.some((raw) => agentEmails.has(parseEmailAddress(raw) ?? ""))) {
    return { handedOff: [], skipped: "companion_recipient" };
  }

  const bridge = deps.bridge ?? callKanbanBridge;
  const tracks = await findOpenMailTracksByThreadOnBoards(
    input.threadId,
    deps.boards ?? listKanbanBoardSlugs(),
    bridge,
  );
  const handedOff: string[] = [];
  for (const track of tracks) {
    if ((track.body ?? "").includes(`message_id: ${input.messageId}`)) continue;
    const result = await handoffMailToTrackTask(
      {
        filesRoot: input.filesRoot,
        projectSlug: track.project_slug ?? "",
        taskId: track.task_id,
        sourcePath: input.sourcePath,
        messageId: input.messageId,
        from: input.from,
        summary: ownerGmailReplyHandoffSummary(input.accountEmail),
      },
      bridge,
    );
    if (result.ok) handedOff.push(track.task_id);
    else console.warn(`[gmail-sync] owner reply handoff failed task=${track.task_id}: ${result.error}`);
  }
  return tracks.length > 0 ? { handedOff } : { handedOff, skipped: "no_open_track" };
}
