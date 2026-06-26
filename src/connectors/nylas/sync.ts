/**
 * Sync Nylas agent inbox + calendar into connector markdown mirrors.
 */
import path from "node:path";
import {
  fetchMessagesInThread,
  listEvents,
  listThreads,
} from "../../nylas/client.js";
import { readAgentGrant } from "../../nylas/store.js";
import {
  calendarEventsDir,
  connectorStatePath,
  mailThreadsDir,
  resolveConnectorPaths,
} from "../paths.js";
import {
  epochToIso,
  stripHtmlToText,
  truncateBody,
  writeCalendarEventMirror,
  writeMailThreadMirror,
  type MailThreadFrontmatter,
} from "../mirror.js";
import { buildNylasThreadMirrorBody } from "../nylasMirrorFormat.js";
import { readSyncState, writeSyncState } from "../state.js";
import { relativeFromFilesRoot, safeThreadFilename } from "../paths.js";
import {
  messageIdsUnchanged,
  readMirrorExternalId,
  readMirrorMessageIds,
} from "../mirrorRead.js";
import { createTriageStubAfterMirror } from "../../ea/triageStub.js";

export type NylasSyncResult = {
  ok: boolean;
  threadsWritten: number;
  eventsWritten: number;
  error?: string;
};

export async function syncNylasConnectors(
  projectRoot: string,
  opts: {
    messageLimit?: number;
    syncCalendar?: boolean;
    days?: number;
    classifyTriage?: boolean;
    skipTriageStubs?: boolean;
    syncMode?: "incremental" | "full";
  } = {},
): Promise<NylasSyncResult> {
  const paths = resolveConnectorPaths(projectRoot);
  if (!paths) {
    return { ok: false, threadsWritten: 0, eventsWritten: 0, error: "JOSHU_FILES_ROOT unavailable" };
  }

  const agent = readAgentGrant(projectRoot);
  if (!agent) {
    return { ok: false, threadsWritten: 0, eventsWritten: 0, error: "No Nylas agent mailbox provisioned" };
  }

  const incremental = opts.syncMode === "incremental";
  const days = opts.days ?? (incremental ? 1 : 7);
  const limit = opts.messageLimit ?? (incremental ? 40 : days >= 7 ? 100 : 40);
  let threadsWritten = 0;
  let eventsWritten = 0;

  try {
    const threadSummaries = await listThreads(agent.grantId, {
      limit,
      searchQueryNative: `newer_than:${days}d`,
    });
    const threadsDir = mailThreadsDir("nylas", paths.filesRoot);
    const syncedAt = new Date().toISOString();
    const classifyTriage = opts.classifyTriage !== false;
    const skipTriageStubs = opts.skipTriageStubs === true;

    for (const summary of threadSummaries) {
      const threadId = summary.id;
      const messageIds = summary.messageIds;
      if (messageIds.length === 0) continue;

      const mirrorPath = path.join(threadsDir, safeThreadFilename(threadId));
      const existingIds = await readMirrorMessageIds(mirrorPath);
      if (messageIdsUnchanged(existingIds, messageIds)) continue;

      const priorLatestMessageId = (await readMirrorExternalId(mirrorPath)) ?? undefined;
      const messages = await fetchMessagesInThread(agent.grantId, threadId, {
        messageIds,
      });
      if (messages.length === 0) continue;

      const latest = messages[messages.length - 1]!;
      const from = latest.fromName ? `${latest.fromName} <${latest.from}>` : latest.from;
      const { bodyMarkdown, threadMessages } = buildNylasThreadMirrorBody(messages);

      const fm: MailThreadFrontmatter = {
        source: "nylas",
        external_id: latest.id,
        thread_id: threadId,
        ...(latest.rfcMessageId ? { rfc_message_id: latest.rfcMessageId } : {}),
        from,
        to: latest.to,
        ...(latest.cc?.length ? { cc: latest.cc } : {}),
        date: epochToIso(latest.date),
        subject: latest.subject,
        labels: latest.unread ? ["unread"] : [],
        unread: latest.unread,
        synced_at: syncedAt,
        message_ids: messages.map((m) => m.id),
        thread_messages: threadMessages,
        message_count: messages.length,
      };

      const writtenPath = await writeMailThreadMirror({
        threadsDir,
        threadId,
        frontmatter: fm,
        bodyMarkdown,
      });
      threadsWritten += 1;
      const sourcePath = relativeFromFilesRoot(
        paths.filesRoot,
        writtenPath ?? mirrorPath,
      );
      await createTriageStubAfterMirror({
        filesRoot: paths.filesRoot,
        provider: "nylas",
        threadId,
        sourcePath,
        subject: latest.subject,
        from: from ?? undefined,
        to: latest.to,
        cc: latest.cc,
        receivedAt: epochToIso(latest.date),
        classify: classifyTriage,
        skipTriageStubs,
        projectRoot,
        messageId: latest.id,
        rfcMessageId: latest.rfcMessageId,
        priorLatestMessageId,
      }).catch((err) => {
        console.warn(`[nylas-sync] triage stub: ${(err as Error).message}`);
      });
    }

    if (opts.syncCalendar !== false) {
      const now = Math.floor(Date.now() / 1000);
      const week = (incremental ? 1 : 7) * 24 * 3600;
      let events: Awaited<ReturnType<typeof listEvents>> = [];
      try {
        events = await listEvents(agent.grantId, {
          start: now - week,
          end: now + week * 2,
          limit: 80,
        });
      } catch (err) {
        console.warn(`[nylas-sync] calendar list failed: ${(err as Error).message}`);
      }
      const eventsDir = calendarEventsDir("nylas", paths.filesRoot);
      for (const ev of events) {
        const startIso = epochToIso(ev.startTime);
        const endIso = epochToIso(ev.endTime);
        const body = [
          ev.description ? truncateBody(stripHtmlToText(ev.description), 6000) : "",
          ev.location ? `**Location:** ${ev.location}` : "",
        ]
          .filter(Boolean)
          .join("\n\n");
        await writeCalendarEventMirror({
          eventsDir,
          eventId: ev.id,
          frontmatter: {
            source: "nylas",
            external_id: ev.id,
            title: ev.title,
            start: startIso,
            end: endIso,
            location: ev.location,
            calendar_id: ev.calendarId,
            synced_at: syncedAt,
          },
          bodyMarkdown: body || "(no description)",
        });
        eventsWritten += 1;
      }
    }

    const statePath = connectorStatePath(paths.filesRoot, "nylas-sync.json");
    await writeSyncState(statePath, {
      lastSyncAt: syncedAt,
      threadsWritten,
      eventsWritten,
    });

    return { ok: true, threadsWritten, eventsWritten };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const statePath = connectorStatePath(paths.filesRoot, "nylas-sync.json");
    await writeSyncState(statePath, {
      lastSyncAt: new Date().toISOString(),
      lastError: message,
      threadsWritten,
      eventsWritten,
    }).catch(() => undefined);
    return { ok: false, threadsWritten, eventsWritten, error: message };
  }
}
