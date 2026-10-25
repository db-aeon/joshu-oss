import type { Request, Response, Router } from "express";
import type { HermesApiRunner } from "../hermesApi.js";
import { readSyncState } from "./state.js";
import {
  connectorStatePath,
  gmailSyncStatePath,
  googleCalendarRootDir,
  mailThreadsDir,
  resolveConnectorPaths,
  type ConnectorMailProvider,
} from "./paths.js";
import { searchCalendarMirror, searchMailMirror, searchMailMirrorAcrossDirs } from "./search.js";
import {
  readConnectorCronJobs,
  writeConnectorCronJobs,
  runConnectorCronJobNow,
  type ConnectorCronJob,
} from "./scheduler.js";
import { isComposioEnabled } from "../composioApi.js";
import { agentRestWriteBlocked } from "../actionGuard/agentRestGate.js";
import { readAgentGrant } from "../nylas/store.js";
import { isNylasConfigured } from "../nylas/config.js";
import {
  getMailMirrorStats,
  getGmailMirrorStatsForAccount,
  getAllGoogleCalendarMirrorStats,
  getGoogleCalendarMirrorStats,
} from "./mirrorStats.js";
import { readMirrorThreadByMessageId } from "./mirrorRead.js";
import { isGmailConnected, runMailSync } from "./syncHelpers.js";
import {
  fetchGmailAttachmentData,
  fetchGmailMessageById,
  fetchGmailThreadMessages,
  replyGmailThread,
  sendGmailEmail,
} from "./composio/gmail.js";
import { epochMsToIso } from "./composio/gmailBodies.js";
import { fetchGmailAttachmentToProject, GmailAttachmentError } from "./composio/gmailAttachments.js";
import {
  listGmailRegistryAccounts,
  resolveGmailAccount,
  getDefaultGmailAccount,
} from "./composio/gmailAccounts.js";
import {
  fetchGoogleCalendarEventsForAccount,
  fetchGoogleCalendarFreeSlots,
  type GoogleCalendarFreeSlotsResult,
} from "./composio/calendar.js";
import {
  createOwnerCalendarEvent,
  getOwnerCalendarEvent,
  fetchOwnerCalendarEvents,
  fetchOwnerFreeSlots,
  updateOwnerCalendarEvent,
  type OwnerCalendarEventInput,
  type OwnerCalendarEventReadResult,
  type OwnerCalendarWriteResult,
} from "./composio/calendarOwner.js";
import { combineCalendarFreeBusy } from "./composio/calendarAvailability.js";
import {
  getDefaultCalendarAccount,
  isAnyGoogleCalendarConnected,
  listCalendarRegistryAccounts,
} from "./composio/calendarAccounts.js";
import {
  isAnyOnenoteConnected,
  listOnenoteRegistryAccounts,
} from "./composio/onenoteAccounts.js";
import {
  fetchOnenotePageFromUrl,
  fetchOnenotePageHtml,
  listOnenoteSectionPages,
} from "./composio/onenote.js";
import { parseOneNoteUrl, requirePageId } from "../onenote/parseUrl.js";
import { COMPOSIO_ONENOTE_TOOLKIT_VERSION } from "./composio/onenoteConfig.js";
import { COMPOSIO_GOOGLECALENDAR_TOOLKIT_VERSION } from "./composio/googleCalendarConfig.js";
import { localDateDayBounds } from "../nylas/localSlot.js";
import {
  buildOwnerTimeAnchorPayload,
  enrichCalendarEventsWithTimeContext,
  getOwnerTimeAnchor,
} from "../ownerLocalTime.js";
import { refreshConnectorsRegistry } from "./registry.js";
import { ownerChannelStatus } from "../ownerChannel/config.js";
import { isActionGuardEnabled, loadActionGuardPolicy } from "../actionGuard/policy.js";
import { registerMeteredProviderRoutes } from "./meteredProviderRoutes.js";

function parseEmailAddress(raw: string): string {
  const trimmed = raw.trim();
  const angle = /<([^>]+)>/.exec(trimmed);
  return (angle?.[1] ?? trimmed).trim();
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readLimit(value: unknown, fallback = 25): number {
  const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(100, Math.floor(n));
}

function readDays(value: unknown): number | undefined {
  const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.min(30, Math.floor(n));
}

function parseSyncBody(body: Record<string, unknown>): {
  limit?: number;
  days?: number;
  ifEmpty?: boolean;
  connectedAccountId?: string;
  syncMode?: "incremental" | "full";
} {
  const syncModeRaw = readString(body.syncMode);
  const syncMode =
    syncModeRaw === "incremental" || syncModeRaw === "full" ? syncModeRaw : undefined;
  return {
    limit: body.limit != null ? readLimit(body.limit, 40) : undefined,
    days: readDays(body.days),
    ifEmpty: body.ifEmpty === true,
    connectedAccountId: readString(body.connectedAccountId) || undefined,
    syncMode,
  };
}

/** Default cron-style incremental unless caller passes explicit `days` (full window). */
function resolveMailSyncMode(syncOpts: ReturnType<typeof parseSyncBody>): "incremental" | "full" {
  if (syncOpts.syncMode) return syncOpts.syncMode;
  return syncOpts.days != null ? "full" : "incremental";
}

function readConnectedAccountId(req: Request, body?: Record<string, unknown>): string | undefined {
  const fromQuery = readString(req.query.connectedAccountId);
  if (fromQuery) return fromQuery;
  if (body) return readString(body.connectedAccountId) || undefined;
  return undefined;
}

function mailProviderFromParam(raw: string): ConnectorMailProvider | null {
  if (raw === "nylas" || raw === "gmail") return raw;
  return null;
}

function readStringList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const items = value.map((v) => readString(v)).filter(Boolean);
    return items.length > 0 ? items : undefined;
  }
  const raw = readString(value);
  if (!raw) return undefined;
  const items = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function readMinutes(value: unknown): number | undefined {
  const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.min(480, Math.floor(n));
}

function filterIntervalsByMinDuration(
  intervals: Array<{ start: string; end: string }>,
  minMinutes: number,
): Array<{ start: string; end: string }> {
  const minMs = minMinutes * 60 * 1000;
  return intervals.filter((interval) => {
    const startMs = Date.parse(interval.start);
    const endMs = Date.parse(interval.end);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return false;
    return endMs - startMs >= minMs;
  });
}

export function registerConnectorRoutes(
  router: Router,
  opts: { projectRoot: string; runner?: HermesApiRunner },
): void {
  const { projectRoot } = opts;
  void opts.runner;

  router.get("/api/connectors/status", async (_req: Request, res: Response) => {
    const paths = resolveConnectorPaths(projectRoot);
    const agent = readAgentGrant(projectRoot);
    let nylasState = {};
    let nylasMirror = { threadCount: 0, empty: true };
    if (paths) {
      nylasState = await readSyncState(connectorStatePath(paths.filesRoot, "nylas-sync.json"));
      nylasMirror = await getMailMirrorStats(projectRoot, "nylas");
    }

    const registry = await refreshConnectorsRegistry(projectRoot);
    const gmailAccounts = await Promise.all(
      registry.gmail.accounts.map(async (account) => {
        const mirror = await getGmailMirrorStatsForAccount(projectRoot, account.accountKey);
        let sync = {};
        if (paths) {
          sync = await readSyncState(gmailSyncStatePath(paths.filesRoot, account.accountKey));
        }
        return {
          connectedAccountId: account.connectedAccountId,
          accountKey: account.accountKey,
          email: account.email,
          label: account.label,
          enabled: account.enabled,
          isDefault: account.isDefault,
          sync,
          mirror: { threadCount: mirror.threadCount, empty: mirror.empty },
        };
      }),
    );

    const gmailConnected = gmailAccounts.length > 0;
    const defaultAccount = gmailAccounts.find((a) => a.isDefault) ?? gmailAccounts[0];
    const gmailMirror = await getMailMirrorStats(projectRoot, "gmail");

    const googleCalendarRegistryAccounts = registry.googleCalendar?.accounts ?? [];
    const googleCalendarMirrorAll = await getAllGoogleCalendarMirrorStats(projectRoot);
    const googleCalendarAccounts = googleCalendarRegistryAccounts.map((account) => {
      const mirror = googleCalendarMirrorAll.find((a) => a.accountKey === account.accountKey) ?? {
        eventCount: 0,
        empty: true,
        eventsDir: null,
      };
      return {
        connectedAccountId: account.connectedAccountId,
        accountKey: account.accountKey,
        email: account.email,
        label: account.label,
        enabled: account.enabled,
        isDefault: account.isDefault,
        mirror: { eventCount: mirror.eventCount, empty: mirror.empty },
      };
    });
    const googleCalendarMirror = await getGoogleCalendarMirrorStats(projectRoot);
    const onenoteAccounts = registry.onenote?.accounts ?? [];
    const defaultOnenote = onenoteAccounts.find((a) => a.isDefault) ?? onenoteAccounts[0];

    res.json({
      filesRoot: paths?.filesRoot,
      registry,
      nylas: {
        configured: isNylasConfigured(),
        provisioned: Boolean(agent),
        email: agent?.email,
        sync: nylasState,
        mirror: nylasMirror,
      },
      gmail: {
        enabled: isComposioEnabled(),
        connected: gmailConnected,
        email: defaultAccount?.email,
        toolkitVersion: process.env.JOSHU_COMPOSIO_GMAIL_TOOLKIT_VERSION?.trim() || "20260506_01",
        accounts: gmailAccounts,
        mirror: gmailMirror,
      },
      googleCalendar: {
        enabled: isComposioEnabled(),
        connected: googleCalendarAccounts.length > 0,
        email: googleCalendarAccounts.find((a) => a.isDefault)?.email ?? googleCalendarAccounts[0]?.email,
        toolkitVersion: COMPOSIO_GOOGLECALENDAR_TOOLKIT_VERSION,
        accounts: googleCalendarAccounts,
        mirror: googleCalendarMirror,
      },
      onenote: {
        enabled: isComposioEnabled(),
        connected: onenoteAccounts.length > 0,
        label: defaultOnenote?.label,
        toolkitVersion: COMPOSIO_ONENOTE_TOOLKIT_VERSION,
        accounts: onenoteAccounts,
      },
      cron: { jobs: await readConnectorCronJobs(projectRoot) },
      ownerChannel: {
        ...ownerChannelStatus(projectRoot),
        gateEnabled: isActionGuardEnabled(projectRoot),
        gateMode: ownerChannelStatus(projectRoot).gateMode ?? loadActionGuardPolicy(projectRoot).gateMode,
      },
    });
  });

  router.get("/api/connectors/mail/:provider/mirror", async (req: Request, res: Response) => {
    const provider = mailProviderFromParam(readString(req.params.provider));
    if (!provider) {
      res.status(400).json({ error: "provider must be nylas or gmail" });
      return;
    }
    const stats = await getMailMirrorStats(projectRoot, provider);
    res.json({ provider, ...stats });
  });

  router.post("/api/connectors/mail/:provider/sync", async (req: Request, res: Response) => {
    const provider = mailProviderFromParam(readString(req.params.provider));
    if (!provider) {
      res.status(400).json({ error: "provider must be nylas or gmail" });
      return;
    }
    if (provider === "gmail" && !isComposioEnabled()) {
      res.status(503).json({ error: "Composio is not configured" });
      return;
    }
    if (provider === "gmail" && !(await isGmailConnected(projectRoot))) {
      res.status(404).json({ error: "Gmail is not connected — open Connectors app" });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const syncOpts = parseSyncBody(body);
    const syncMode = resolveMailSyncMode(syncOpts);
    const result = await runMailSync(projectRoot, provider, {
      days: syncOpts.days ?? (syncMode === "incremental" ? 1 : 7),
      messageLimit: syncOpts.limit,
      ifEmpty: syncOpts.ifEmpty,
      syncCalendar:
        provider === "nylas"
          ? true
          : syncMode === "full" && syncOpts.days != null,
      connectedAccountId: syncOpts.connectedAccountId,
      syncMode,
    });
    if (!result.ok) {
      res.status(502).json(result);
      return;
    }
    res.json(result);
  });

  // Legacy paths (keep for scripts / MCP)
  router.post("/api/connectors/mail/nylas/sync", async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const syncOpts = parseSyncBody(body);
    const syncMode = resolveMailSyncMode(syncOpts);
    const result = await runMailSync(projectRoot, "nylas", {
      days: syncOpts.days ?? (syncMode === "incremental" ? 1 : 7),
      messageLimit: syncOpts.limit,
      ifEmpty: syncOpts.ifEmpty,
      syncCalendar: true,
      syncMode,
    });
    if (!result.ok) {
      res.status(502).json(result);
      return;
    }
    res.json(result);
  });

  router.post("/api/connectors/mail/gmail/sync", async (req: Request, res: Response) => {
    if (!isComposioEnabled()) {
      res.status(503).json({ error: "Composio is not configured" });
      return;
    }
    if (!(await isGmailConnected(projectRoot))) {
      res.status(404).json({ error: "Gmail is not connected — open Connectors app" });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const syncOpts = parseSyncBody(body);
    const syncMode = resolveMailSyncMode(syncOpts);
    const result = await runMailSync(projectRoot, "gmail", {
      days: syncOpts.days,
      messageLimit: syncOpts.limit,
      ifEmpty: syncOpts.ifEmpty,
      syncCalendar: syncMode === "full" && syncOpts.days != null,
      connectedAccountId: syncOpts.connectedAccountId,
      syncMode,
    });
    if (!result.ok) {
      res.status(502).json(result);
      return;
    }
    res.json(result);
  });

  router.get("/api/connectors/mail/:provider/search", async (req: Request, res: Response) => {
    const provider = mailProviderFromParam(readString(req.params.provider));
    if (!provider) {
      res.status(400).json({ error: "provider must be nylas or gmail" });
      return;
    }
    const paths = resolveConnectorPaths(projectRoot);
    if (!paths) {
      res.status(503).json({ error: "JOSHU_FILES_ROOT unavailable" });
      return;
    }
    const q = readString(req.query.q);
    const unreadOnly = req.query.unread === "true";
    const limit = readLimit(req.query.limit, 50);
    const connectedAccountId = readConnectedAccountId(req);

    if (provider === "gmail") {
      const accounts = await listGmailRegistryAccounts(projectRoot);
      const scoped = connectedAccountId
        ? accounts.filter((a) => a.connectedAccountId === connectedAccountId)
        : accounts;
      const threadsDirs = scoped.map((a) => mailThreadsDir("gmail", paths.filesRoot, a.accountKey));
      const hits = await searchMailMirrorAcrossDirs({
        threadsDirs,
        filesRoot: paths.filesRoot,
        query: q,
        limit,
      });
      res.json({ hits, query: q || undefined, provider, connectedAccountId: connectedAccountId || undefined });
      return;
    }

    const hits = await searchMailMirror({
      threadsDir: mailThreadsDir(provider, paths.filesRoot),
      filesRoot: paths.filesRoot,
      query: q,
      unreadOnly,
      limit,
    });
    res.json({ hits, query: q || undefined, provider });
  });

  router.get("/api/connectors/mail/nylas/search", async (req: Request, res: Response) => {
    const paths = resolveConnectorPaths(projectRoot);
    if (!paths) {
      res.status(503).json({ error: "JOSHU_FILES_ROOT unavailable" });
      return;
    }
    const q = readString(req.query.q);
    const unreadOnly = req.query.unread === "true";
    const limit = readLimit(req.query.limit, 25);
    const hits = await searchMailMirror({
      threadsDir: mailThreadsDir("nylas", paths.filesRoot),
      filesRoot: paths.filesRoot,
      query: q,
      unreadOnly,
      limit,
    });
    res.json({ hits, query: q || undefined });
  });

  router.get("/api/connectors/mail/gmail/search", async (req: Request, res: Response) => {
    const paths = resolveConnectorPaths(projectRoot);
    if (!paths) {
      res.status(503).json({ error: "JOSHU_FILES_ROOT unavailable" });
      return;
    }
    const q = readString(req.query.q);
    const limit = readLimit(req.query.limit, 25);
    const connectedAccountId = readConnectedAccountId(req);
    const accounts = await listGmailRegistryAccounts(projectRoot);
    const scoped = connectedAccountId
      ? accounts.filter((a) => a.connectedAccountId === connectedAccountId)
      : accounts;
    const threadsDirs = scoped.map((a) => mailThreadsDir("gmail", paths.filesRoot, a.accountKey));
    const hits = await searchMailMirrorAcrossDirs({
      threadsDirs,
      filesRoot: paths.filesRoot,
      query: q,
      limit,
    });
    res.json({ hits, query: q || undefined, connectedAccountId: connectedAccountId || undefined });
  });

  router.get("/api/connectors/mail/:provider/messages/:messageId", async (req: Request, res: Response) => {
    const provider = mailProviderFromParam(readString(req.params.provider));
    const messageId = readString(req.params.messageId);
    if (!provider || !messageId) {
      res.status(400).json({ error: "provider and messageId required" });
      return;
    }

    const connectedAccountId = readConnectedAccountId(req);
    const mirror = await readMirrorThreadByMessageId(projectRoot, provider, messageId, {
      connectedAccountId,
    });
    let threadId = mirror?.threadId;
    let subject = mirror?.subject;
    let from = mirror?.from;
    let to = mirror?.to;
    let dateEpoch = mirror?.date ? Math.floor(Date.parse(mirror.date) / 1000) : undefined;
    let unread = mirror?.unread;
    let id = mirror?.externalId ?? messageId;
    let threadMessages = mirror?.threadMessages ?? [];

    const gmailLive =
      provider === "gmail" && isComposioEnabled() && (await isGmailConnected(projectRoot));

    const gmailAccount =
      provider === "gmail"
        ? (await resolveGmailAccount(projectRoot, connectedAccountId ?? mirror?.connectedAccountId)) ??
          (await getDefaultGmailAccount(projectRoot))
        : null;
    const gmailCtx = gmailAccount
      ? { connectedAccountId: gmailAccount.connectedAccountId }
      : null;

    if (gmailLive && gmailCtx && threadId) {
      try {
        const liveThread = await fetchGmailThreadMessages(projectRoot, threadId, gmailCtx);
        if (liveThread.length > 0) {
          threadMessages = liveThread.map((m) => ({
            id: m.id,
            date: epochMsToIso(m.messageTimestamp),
            dateEpoch: m.messageTimestamp ? Math.floor(m.messageTimestamp / 1000) : undefined,
            from: m.from,
            subject: m.subject,
            body: m.body || m.snippet || "",
          }));
          const latest = liveThread[liveThread.length - 1]!;
          id = latest.id;
          subject = latest.subject ?? subject;
          from = latest.from ?? from;
          if (latest.messageTimestamp) dateEpoch = Math.floor(latest.messageTimestamp / 1000);
          unread = latest.unread ?? unread;
        }
      } catch {
        /* mirror thread messages */
      }
    } else if (gmailLive && gmailCtx) {
      try {
        const live = await fetchGmailMessageById(projectRoot, messageId, gmailCtx);
        if (live) {
          id = live.id;
          threadId = live.threadId ?? threadId;
          subject = live.subject ?? subject;
          from = live.from ?? from;
          if (live.messageTimestamp) dateEpoch = Math.floor(live.messageTimestamp / 1000);
          unread = live.unread ?? unread;
          if (threadMessages.length === 0) {
            threadMessages = [
              {
                id: live.id,
                date: epochMsToIso(live.messageTimestamp),
                dateEpoch: live.messageTimestamp ? Math.floor(live.messageTimestamp / 1000) : undefined,
                from: live.from,
                subject: live.subject,
                body: live.body || live.snippet || "",
              },
            ];
          }
        }
      } catch {
        /* fall back to mirror */
      }
    }

    const body =
      threadMessages.length > 0
        ? threadMessages.map((m) => m.body).filter(Boolean).join("\n\n---\n\n")
        : mirror?.body ?? "";

    if (!mirror && provider === "gmail" && threadMessages.length === 0) {
      res.status(404).json({ error: "Message not found — try Sync mirror or check Gmail connection" });
      return;
    }
    if (!mirror && provider === "nylas") {
      res.status(404).json({ error: "Message not found in local mirror — try Sync mirror" });
      return;
    }

    res.json({
      message: {
        id,
        threadId,
        subject,
        from,
        to,
        date: dateEpoch,
        body,
        snippet: (threadMessages[threadMessages.length - 1]?.body || body || "").slice(0, 200),
        unread,
        messageCount: threadMessages.length || mirror?.messageCount || 1,
      },
      threadMessages,
    });
  });

  // Read-only for the mailbox; writes only under <files>/Projects/<slug>/attachments/ (no agentRestWriteBlocked).
  router.post("/api/connectors/mail/gmail/attachments/fetch", async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const messageId = readString(body.messageId ?? body.message_id);
    if (!messageId) {
      res.status(400).json({ error: "messageId required" });
      return;
    }
    if (!isComposioEnabled()) {
      res.status(503).json({ error: "Composio is not configured" });
      return;
    }
    const paths = resolveConnectorPaths(projectRoot);
    if (!paths) {
      res.status(503).json({ error: "JOSHU_FILES_ROOT unavailable" });
      return;
    }
    const requestedAccountId = readConnectedAccountId(req, body);
    const mirror = requestedAccountId
      ? null
      : await readMirrorThreadByMessageId(projectRoot, "gmail", messageId).catch(() => null);
    const account = requestedAccountId
      ? await resolveGmailAccount(projectRoot, requestedAccountId)
      : ((await resolveGmailAccount(projectRoot, mirror?.connectedAccountId)) ??
        (await getDefaultGmailAccount(projectRoot)));
    if (!account) {
      res.status(404).json({
        error: requestedAccountId
          ? `Gmail account ${requestedAccountId} is not connected`
          : "No Gmail account connected — open Connectors app",
      });
      return;
    }
    const ctx = { connectedAccountId: account.connectedAccountId };

    try {
      const result = await fetchGmailAttachmentToProject(
        {
          filesRoot: paths.filesRoot,
          desktopRoot: paths.desktopRoot,
          messageId,
          attachmentId: readString(body.attachmentId ?? body.attachment_id) || undefined,
          filename: readString(body.filename ?? body.fileName) || undefined,
          projectSlug: readString(body.projectSlug ?? body.project_slug) || undefined,
        },
        {
          listAttachments: async (id) => {
            const live = await fetchGmailMessageById(projectRoot, id, ctx);
            if (!live) throw new GmailAttachmentError(`message ${id} not found in Gmail`, 404);
            return live.attachments ?? [];
          },
          getAttachment: (att) => fetchGmailAttachmentData(projectRoot, ctx, att),
        },
      );
      res.json({ ok: true, accountEmail: account.email, ...result });
    } catch (err) {
      if (err instanceof GmailAttachmentError) {
        res.status(err.status).json({
          error: err.message,
          ...(err.attachments ? { attachments: err.attachments } : {}),
        });
        return;
      }
      res.status(502).json({ error: (err as Error).message });
    }
  });

  router.post("/api/connectors/mail/gmail/send", async (req: Request, res: Response) => {
    if (agentRestWriteBlocked(req)) {
      res.status(403).json({
        error:
          "Principal Gmail send is disabled for agents. Use mcp_joshu_connectors_nylas_send_message (agent mailbox).",
      });
      return;
    }
    if (!isComposioEnabled()) {
      res.status(503).json({ error: "Composio is not configured" });
      return;
    }
    if (!(await isGmailConnected(projectRoot))) {
      res.status(404).json({ error: "Gmail is not connected" });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const connectedAccountId = readConnectedAccountId(req, body);
    const account = await resolveGmailAccount(projectRoot, connectedAccountId);
    if (!account) {
      res.status(400).json({ error: "connectedAccountId is required when multiple Gmail accounts exist" });
      return;
    }
    const to = readString(body.to);
    const subject = readString(body.subject);
    const mailBody = readString(body.body);
    if (!to || !subject || !mailBody) {
      res.status(400).json({ error: "to, subject, and body are required" });
      return;
    }
    try {
      const result = await sendGmailEmail(
        projectRoot,
        { connectedAccountId: account.connectedAccountId },
        {
          to,
          subject,
          body: mailBody,
          cc: Array.isArray(body.cc) ? body.cc.filter((c): c is string => typeof c === "string") : undefined,
          bcc: Array.isArray(body.bcc) ? body.bcc.filter((c): c is string => typeof c === "string") : undefined,
          isHtml: body.isHtml === true,
        },
      );
      res.json({ ok: true, messageId: result.messageId });
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/api/connectors/mail/gmail/reply", async (req: Request, res: Response) => {
    if (agentRestWriteBlocked(req)) {
      res.status(403).json({
        error:
          "Principal Gmail reply is disabled for agents. Use mcp_joshu_connectors_nylas_send_message (agent mailbox).",
      });
      return;
    }
    if (!isComposioEnabled()) {
      res.status(503).json({ error: "Composio is not configured" });
      return;
    }
    if (!(await isGmailConnected(projectRoot))) {
      res.status(404).json({ error: "Gmail is not connected" });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const connectedAccountId = readConnectedAccountId(req, body);
    const account = await resolveGmailAccount(projectRoot, connectedAccountId);
    if (!account) {
      res.status(400).json({ error: "connectedAccountId is required when multiple Gmail accounts exist" });
      return;
    }
    const threadId = readString(body.threadId);
    const mailBody = readString(body.body);
    const recipientEmail = parseEmailAddress(readString(body.recipientEmail) || readString(body.to));
    if (!threadId || !mailBody || !recipientEmail) {
      res.status(400).json({ error: "threadId, body, and recipientEmail (or to) are required" });
      return;
    }
    try {
      await replyGmailThread(
        projectRoot,
        { connectedAccountId: account.connectedAccountId },
        {
          threadId,
          body: mailBody,
          recipientEmail,
          cc: Array.isArray(body.cc) ? body.cc.filter((c): c is string => typeof c === "string") : undefined,
          bcc: Array.isArray(body.bcc) ? body.bcc.filter((c): c is string => typeof c === "string") : undefined,
          isHtml: body.isHtml === true,
        },
      );
      res.json({ ok: true });
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get("/api/connectors/mail/nylas/sync-state", async (_req: Request, res: Response) => {
    const paths = resolveConnectorPaths(projectRoot);
    if (!paths) {
      res.status(503).json({ error: "JOSHU_FILES_ROOT unavailable" });
      return;
    }
    res.json({ state: await readSyncState(connectorStatePath(paths.filesRoot, "nylas-sync.json")) });
  });

  router.get("/api/connectors/calendar/google/search", async (req: Request, res: Response) => {
    const paths = resolveConnectorPaths(projectRoot);
    if (!paths) {
      res.status(503).json({ error: "JOSHU_FILES_ROOT unavailable" });
      return;
    }
    const q = readString(req.query.q);
    const limit = readLimit(req.query.limit, 25);
    const hits = await searchCalendarMirror({
      eventsDir: googleCalendarRootDir(paths.filesRoot),
      filesRoot: paths.filesRoot,
      query: q,
      limit,
    });
    res.json({ hits, query: q || undefined });
  });

  /** Live owner calendar (Composio Google Calendar) — source of truth for availability. */
  router.get("/api/connectors/calendar/google/events", async (req: Request, res: Response) => {
    if (!isComposioEnabled()) {
      res.status(503).json({ error: "Composio is not configured" });
      return;
    }
    if (!(await isAnyGoogleCalendarConnected(projectRoot))) {
      res.status(404).json({ error: "Google Calendar is not connected — open Connectors app" });
      return;
    }

    const connectedAccountId = readString(req.query.connectedAccountId);
    const date = readString(req.query.date);
    const timezone = readString(req.query.timezone) || readString(req.query.timeZone);
    let timeMin: string | undefined;
    let timeMax: string | undefined;
    if (date && timezone) {
      const bounds = localDateDayBounds(date, timezone);
      timeMin = new Date(bounds.start * 1000).toISOString();
      timeMax = new Date(bounds.end * 1000).toISOString();
    }
    // Optional cap on the merged event list. Composio gets no limit (GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS
    // has no max_results), so without `limit` the list has all events in the window.
    const limit = req.query.limit != null ? readLimit(req.query.limit, 120) : undefined;
    const fetchOpts = {
      daysBack: readDays(req.query.daysBack) ?? 1,
      daysForward: readDays(req.query.daysForward) ?? 14,
      ...(timeMin && timeMax ? { timeMin, timeMax } : {}),
    };
    const timeAnchor = getOwnerTimeAnchor(projectRoot);
    const eventTimezone = timezone || timeAnchor.timezone;
    const availabilityNote =
      "Event titles do NOT determine busy/free. Use GET /api/connectors/calendar/google/free-slots (or google_calendar_find_free_slots MCP). events[].blocksAvailability=false means Google 'Show as free' (transparent) — does not occupy FreeBusy.";

    // No connectedAccountId: merge the events of all calendar accounts.
    if (!connectedAccountId) {
      try {
        const owner = await fetchOwnerCalendarEvents(projectRoot, fetchOpts, limit);
        res.json({
          ok: true,
          source: "live_composio",
          accounts: owner.accounts,
          incomplete: owner.incomplete,
          count: owner.events.length,
          timeAnchor: buildOwnerTimeAnchorPayload(timeAnchor),
          events: enrichCalendarEventsWithTimeContext(owner.events, eventTimezone, timeAnchor),
          availabilityNote: owner.incomplete
            ? `${availabilityNote} INCOMPLETE: a calendar account failed (see accounts[]); its events are missing.`
            : availabilityNote,
        });
      } catch (err) {
        res.status(502).json({ error: (err as Error).message });
      }
      return;
    }

    const accounts = await listCalendarRegistryAccounts(projectRoot);
    const account =
      accounts.find((a) => a.connectedAccountId === connectedAccountId) ??
      (await getDefaultCalendarAccount(projectRoot));
    if (!account) {
      res.status(404).json({ error: "No Google Calendar account" });
      return;
    }

    try {
      const events = await fetchGoogleCalendarEventsForAccount(
        projectRoot,
        { connectedAccountId: account.connectedAccountId },
        fetchOpts,
      );
      res.json({
        ok: true,
        source: "live_composio",
        accountKey: account.accountKey,
        email: account.email,
        count: events.length,
        timeAnchor: buildOwnerTimeAnchorPayload(timeAnchor),
        events: enrichCalendarEventsWithTimeContext(events, eventTimezone, timeAnchor),
        availabilityNote,
      });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  /** Live Google FreeBusy — authoritative for owner availability (respects transparent events). */
  router.get("/api/connectors/calendar/google/free-slots", async (req: Request, res: Response) => {
    if (!isComposioEnabled()) {
      res.status(503).json({ error: "Composio is not configured" });
      return;
    }
    if (!(await isAnyGoogleCalendarConnected(projectRoot))) {
      res.status(404).json({ error: "Google Calendar is not connected — open Connectors app" });
      return;
    }

    const connectedAccountId = readString(req.query.connectedAccountId);
    const date = readString(req.query.date);
    const timezone =
      readString(req.query.timezone) ||
      readString(req.query.timeZone) ||
      getOwnerTimeAnchor(projectRoot).timezone;
    const items = readStringList(req.query.items);
    const minDurationMinutes = readMinutes(req.query.minDurationMinutes) ?? 30;

    let timeMin = readString(req.query.timeMin) || readString(req.query.time_min);
    let timeMax = readString(req.query.timeMax) || readString(req.query.time_max);
    if (date && timezone && (!timeMin || !timeMax)) {
      const bounds = localDateDayBounds(date, timezone);
      timeMin = new Date(bounds.start * 1000).toISOString();
      timeMax = new Date(bounds.end * 1000).toISOString();
    }
    if (!timeMin || !timeMax) {
      res.status(400).json({
        error: "timeMin+timeMax (or date+timezone) required",
      });
      return;
    }

    // No connectedAccountId: owner availability across all calendar accounts.
    let source: Record<string, unknown>;
    let slots: GoogleCalendarFreeSlotsResult;
    let incomplete = false;
    try {
      if (!connectedAccountId) {
        const owner = await fetchOwnerFreeSlots(projectRoot, { items, timeMin, timeMax, timezone });
        const { accounts, incomplete: ownerIncomplete, ...rest } = owner;
        slots = rest;
        incomplete = ownerIncomplete;
        source = { accounts, incomplete };
      } else {
        const accounts = await listCalendarRegistryAccounts(projectRoot);
        const account =
          accounts.find((a) => a.connectedAccountId === connectedAccountId) ??
          (await getDefaultCalendarAccount(projectRoot));
        if (!account) {
          res.status(404).json({ error: "No Google Calendar account" });
          return;
        }
        slots = await fetchGoogleCalendarFreeSlots(
          projectRoot,
          { connectedAccountId: account.connectedAccountId },
          { items, timeMin, timeMax, timezone },
        );
        source = { accountKey: account.accountKey, email: account.email };
      }
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
      return;
    }

    const timeAnchor = getOwnerTimeAnchor(projectRoot);
    const combined = combineCalendarFreeBusy(slots.calendars, slots.timeMin, slots.timeMax);
    const calendars = Object.fromEntries(
      Object.entries(slots.calendars).map(([id, cal]) => [
        id,
        {
          ...cal,
          free: filterIntervalsByMinDuration(cal.free, minDurationMinutes),
        },
      ]),
    );
    calendars.combined = {
      busy: combined.busy,
      free: filterIntervalsByMinDuration(combined.free, minDurationMinutes),
    };
    const availabilityNote = connectedAccountId
      ? "busy/free from Google FreeBusy API across queried calendars of ONE calendar account. Use calendars.combined for scheduling (union of busy on all items). Transparent events (Show as free) are NOT in busy[]."
      : "busy/free from Google FreeBusy API across all calendar accounts (accounts[]). Use calendars.combined for scheduling (union of busy on all calendars). Transparent events (Show as free) are NOT in busy[]. Default items per calendar account: primary + owner personalEmail + selected Gmail calendars.";
    res.json({
      ok: true,
      source: "live_composio",
      tool: "GOOGLECALENDAR_FIND_FREE_SLOTS",
      ...source,
      timeAnchor: buildOwnerTimeAnchorPayload(timeAnchor),
      minDurationMinutes,
      ...slots,
      calendars,
      availabilityNote: incomplete
        ? `${availabilityNote} INCOMPLETE: a calendar account failed (see accounts[]); its busy time is missing. Tell the owner before you book.`
        : availabilityNote,
    });
  });

  /** Create an owner calendar event with the calendar account that can write the target calendar. */
  router.post("/api/connectors/calendar/google/events", async (req: Request, res: Response) => {
    if (!isComposioEnabled()) {
      res.status(503).json({ error: "Composio is not configured" });
      return;
    }
    try {
      sendCalendarResult(res, await createOwnerCalendarEvent(projectRoot, readCalendarEventInput(req.body)));
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  /** Update (patch) an owner calendar event. Only the given fields change. */
  router.patch("/api/connectors/calendar/google/events/:eventId", async (req: Request, res: Response) => {
    if (!isComposioEnabled()) {
      res.status(503).json({ error: "Composio is not configured" });
      return;
    }
    try {
      const eventId = String(req.params.eventId ?? "");
      sendCalendarResult(
        res,
        await updateOwnerCalendarEvent(projectRoot, eventId, readCalendarEventInput(req.body)),
      );
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  /** Read one owner calendar event with its guests and meeting link. */
  router.get("/api/connectors/calendar/google/events/:eventId", async (req: Request, res: Response) => {
    if (!isComposioEnabled()) {
      res.status(503).json({ error: "Composio is not configured" });
      return;
    }
    try {
      const result = await getOwnerCalendarEvent(projectRoot, String(req.params.eventId ?? ""), {
        calendarId: readString(req.query.calendarId),
        connectedAccountId: readString(req.query.connectedAccountId) || undefined,
        timezone: readString(req.query.timezone) || undefined,
      });
      sendCalendarResult(res, result);
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  router.get("/api/connectors/onenote/accounts", async (_req: Request, res: Response) => {
    if (!isComposioEnabled()) {
      res.status(503).json({ error: "Composio is not configured" });
      return;
    }
    try {
      const accounts = await listOnenoteRegistryAccounts(projectRoot);
      res.json({ ok: true, accounts, toolkitVersion: COMPOSIO_ONENOTE_TOOLKIT_VERSION });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  router.get("/api/connectors/onenote/page-content", async (req: Request, res: Response) => {
    if (!isComposioEnabled()) {
      res.status(503).json({ error: "Composio is not configured" });
      return;
    }
    if (!(await isAnyOnenoteConnected(projectRoot))) {
      res.status(404).json({ error: "OneNote is not connected — open Connectors app" });
      return;
    }
    const url = readString(req.query.url);
    const pageIdRaw = readString(req.query.pageId);
    const connectedAccountId = readConnectedAccountId(req);
    const includeIds = readString(req.query.includeIds) === "true";
    const format = readString(req.query.format) || "json";

    try {
      let pageId = pageIdRaw;
      let parsed = url ? parseOneNoteUrl(url) : {};
      if (!pageId && url) pageId = requirePageId(url);
      if (!pageId) {
        res.status(400).json({ error: "pageId or url query parameter is required" });
        return;
      }

      const html = await fetchOnenotePageHtml(projectRoot, {
        pageId,
        connectedAccountId,
        includeIds,
      });

      if (format === "html") {
        res.type("text/html").send(html);
        return;
      }
      res.json({
        ok: true,
        source: "live_composio",
        tool: "ONENOTE_GET_ONENOTE_USER_PAGE_CONTENT",
        pageId,
        parsed,
        html,
      });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  router.post("/api/connectors/onenote/fetch-url", async (req: Request, res: Response) => {
    if (!isComposioEnabled()) {
      res.status(503).json({ error: "Composio is not configured" });
      return;
    }
    if (!(await isAnyOnenoteConnected(projectRoot))) {
      res.status(404).json({ error: "OneNote is not connected — open Connectors app" });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const url = readString(body.url);
    if (!url) {
      res.status(400).json({ error: "url is required" });
      return;
    }
    const connectedAccountId = readString(body.connectedAccountId) || undefined;
    const includeIds = body.includeIds === true;
    const format = readString(body.format) || "json";

    try {
      const result = await fetchOnenotePageFromUrl(projectRoot, {
        url,
        connectedAccountId,
        includeIds,
      });
      if (format === "html") {
        res.type("text/html").send(result.html);
        return;
      }
      res.json({ ok: true, source: "live_composio", ...result });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  router.get("/api/connectors/onenote/sections/:sectionId/pages", async (req: Request, res: Response) => {
    if (!isComposioEnabled()) {
      res.status(503).json({ error: "Composio is not configured" });
      return;
    }
    if (!(await isAnyOnenoteConnected(projectRoot))) {
      res.status(404).json({ error: "OneNote is not connected — open Connectors app" });
      return;
    }
    const sectionId = readString(req.params.sectionId);
    if (!sectionId) {
      res.status(400).json({ error: "sectionId is required" });
      return;
    }
    const connectedAccountId = readConnectedAccountId(req);
    const limit = readLimit(req.query.limit, 50);

    try {
      const pages = await listOnenoteSectionPages(projectRoot, {
        sectionId,
        connectedAccountId,
        limit,
      });
      res.json({
        ok: true,
        source: "live_composio",
        tool: "ONENOTE_LIST_ME_ONENOTE_SECTIONS_PAGES4",
        sectionId,
        pages,
      });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  router.get("/api/connectors/cron/jobs", async (_req: Request, res: Response) => {
    res.json({ jobs: await readConnectorCronJobs(projectRoot) });
  });

  router.put("/api/connectors/cron/jobs", async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { jobs?: unknown };
    if (!Array.isArray(body.jobs)) {
      res.status(400).json({ error: "jobs array required" });
      return;
    }
    const jobs = body.jobs as ConnectorCronJob[];
    await writeConnectorCronJobs(projectRoot, jobs);
    res.json({ ok: true, jobs });
  });

  router.post("/api/connectors/cron/jobs/:jobId/run", async (req: Request, res: Response) => {
    const jobId = readString(req.params.jobId);
    if (!jobId) {
      res.status(400).json({ error: "jobId required" });
      return;
    }
    const result = await runConnectorCronJobNow(projectRoot, jobId);
    if (!result.ok) {
      res.status(502).json(result);
      return;
    }
    res.json(result);
  });

  registerMeteredProviderRoutes(router, projectRoot, opts.runner);
}

function readCalendarEventInput(raw: unknown): OwnerCalendarEventInput {
  const body = (raw ?? {}) as Record<string, unknown>;
  const str = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim() ? value.trim() : undefined;
  const attendees = Array.isArray(body.attendees)
    ? body.attendees.filter((a): a is string => typeof a === "string" && a.trim() !== "").map((a) => a.trim())
    : undefined;
  const transparency = body.transparency === "transparent" || body.transparency === "opaque" ? body.transparency : undefined;
  return {
    calendarId: str(body.calendarId) ?? "",
    summary: str(body.summary),
    start: str(body.start),
    end: str(body.end),
    timezone: str(body.timezone) ?? str(body.timeZone),
    endTimezone: str(body.endTimezone) ?? str(body.endTimeZone),
    attendees,
    description: str(body.description),
    location: str(body.location),
    sendUpdates: str(body.sendUpdates),
    // Omitted: the Joshu API decides (wantsMeetingRoom).
    createMeetingRoom: typeof body.createMeetingRoom === "boolean" ? body.createMeetingRoom : undefined,
    transparency,
    connectedAccountId: str(body.connectedAccountId),
  };
}

type CalendarResult = OwnerCalendarWriteResult | OwnerCalendarEventReadResult;

const CALENDAR_ERROR_STATUS: Record<Exclude<CalendarResult, { ok: true }>["kind"], number> = {
  invalid: 400,
  unknown_account: 400,
  primary_ambiguous: 400,
  no_writer: 409,
  no_reader: 409,
  not_found: 404,
  // Success-shaped stub, as for other denied actions: the companion must not retry.
  denied: 200,
  error: 502,
};

function sendCalendarResult(res: Response, result: CalendarResult): void {
  if (result.ok) {
    res.json(result);
    return;
  }
  if (result.kind === "denied") {
    res.json({ ok: false, denied: true, message: result.message });
    return;
  }
  const hint = result.writableCalendars?.length
    ? `${result.kind === "no_reader" ? "Readable" : "Writable"} calendars: ${result.writableCalendars
        .map((w) => `${w.email ?? w.accountKey}: ${w.calendars.join(", ") || "(none)"}`)
        .join("; ")}`
    : undefined;
  res.status(CALENDAR_ERROR_STATUS[result.kind]).json({
    error: result.message,
    reason: result.kind,
    ...(hint ? { hint } : {}),
    ...(result.writableCalendars ? { writableCalendars: result.writableCalendars } : {}),
  });
}
