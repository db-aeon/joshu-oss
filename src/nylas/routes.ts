import type { Request, Response, Router } from "express";
import {
  createAgentAccount,
  createEvent,
  destroyEvent,
  getEvent,
  getMessage,
  listEvents,
  listMessages,
  sendMessage,
  updateEvent,
  updateMessage,
} from "./client.js";
import { isNylasConfigured } from "./config.js";
import { DEFAULT_ASSISTANT_NAME, readAgentProfile, updateAgentProfile, type NylasAgentProfile } from "./profile.js";
import { resolveJoshuIdentity } from "../joshuIdentity.js";
import { resolveEventWindow, resolveListEventsWindow, type LocalSlotInput } from "./localSlot.js";
import { buildJoshuSignedEmailHtml } from "../email/joshuEmailSignature.js";
import { readAgentGrant, writeAgentGrant } from "./store.js";
import { parseOptionalRecipients, parseRequiredTo } from "./recipients.js";
import { agentRestWriteBlocked } from "../actionGuard/agentRestGate.js";
import { gateNylasSendRequest, isJmailOwnerSend } from "../actionGuard/nylasSendGate.js";
import { respondNylasSendGate } from "../actionGuard/nylasSendGateResponse.js";
import { resolveJoshuFilesPaths } from "../joshuFilesPaths.js";
import { resolveOutboundMailAuthorization } from "../ea/agentAuthorization.js";
import { buildReplySubjectMismatchError, replySubjectsMatch } from "./replySubject.js";

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function slotInputFromRecord(raw: Record<string, unknown>): LocalSlotInput {
  return {
    date: readString(raw.date) || undefined,
    startLocal: readString(raw.startLocal) || readString(raw.start_local) || readString(raw.startTimeLocal) || undefined,
    endLocal: readString(raw.endLocal) || readString(raw.end_local) || readString(raw.endTimeLocal) || undefined,
    timezone: readString(raw.timezone) || readString(raw.timeZone) || undefined,
    startTime: readNumber(raw.startTime ?? raw.start),
    endTime: readNumber(raw.endTime ?? raw.end),
  };
}

function slotInputFromQuery(query: Request["query"]): LocalSlotInput {
  const q = query as Record<string, unknown>;
  return slotInputFromRecord(q);
}

function parseParticipantList(
  raw: unknown,
): Array<{ email: string; name?: string }> | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: Array<{ email: string; name?: string }> = [];
  for (const p of raw) {
    if (!p || typeof p !== "object") continue;
    const row = p as Record<string, unknown>;
    const email = readString(row.email);
    if (!email) continue;
    const name = readString(row.name);
    out.push(name ? { email, name } : { email });
  }
  return out.length > 0 ? out : undefined;
}

export function registerNylasRoutes(router: Router, opts: { projectRoot: string }): void {
  router.get("/api/nylas/status", (_req: Request, res: Response) => {
    const agent = readAgentGrant(opts.projectRoot);
    res.json({
      configured: isNylasConfigured(),
      agent: agent
        ? { provisioned: true, grantId: agent.grantId, email: agent.email, createdAt: agent.createdAt }
        : { provisioned: false },
      profile: readAgentProfile(opts.projectRoot),
    });
  });

  router.post("/api/nylas/agent", async (req: Request, res: Response) => {
    if (!isNylasConfigured()) {
      res.status(503).json({ error: "Set NYLAS_API_KEY on the Joshu server" });
      return;
    }
    const email = readString((req.body as { email?: unknown })?.email);
    if (!email) {
      res.status(400).json({ error: "email is required (e.g. agent@yourdomain.com)" });
      return;
    }
    try {
      const record = await createAgentAccount(email);
      writeAgentGrant(record, opts.projectRoot);
      updateAgentProfile({ assistantEmail: record.email }, opts.projectRoot);
      res.json({ ok: true, agent: record });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  /** Import a grant created by the control plane (signup provisioning). */
  router.post("/api/nylas/agent/import", async (req: Request, res: Response) => {
    const body = req.body as { grantId?: unknown; email?: unknown };
    const grantId = readString(body.grantId);
    const email = readString(body.email);
    if (!grantId || !email) {
      res.status(400).json({ error: "grantId and email are required" });
      return;
    }
    const record = {
      grantId,
      email,
      createdAt: new Date().toISOString(),
    };
    writeAgentGrant(record, opts.projectRoot);
    updateAgentProfile({ assistantEmail: email }, opts.projectRoot);
    res.json({ ok: true, agent: record });
  });

  router.post("/api/nylas/messages/send", async (req: Request, res: Response) => {
    const agent = readAgentGrant(opts.projectRoot);
    if (!agent) {
      res.status(404).json({ error: "No agent mailbox — provision via jMail first" });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const subject = readString(body.subject);
    const text = readString(body.body);
    let to: ReturnType<typeof parseRequiredTo>;
    let cc: ReturnType<typeof parseOptionalRecipients>;
    let bcc: ReturnType<typeof parseOptionalRecipients>;
    try {
      to = parseRequiredTo(body.to);
      cc = parseOptionalRecipients(body.cc, "cc");
      bcc = parseOptionalRecipients(body.bcc, "bcc");
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }
    if (!subject || !text) {
      res.status(400).json({ error: "subject and body are required" });
      return;
    }
    const replyToMessageId = readString(body.replyToMessageId) || undefined;
    const sourcePath = readString(body.sourcePath) || readString(body.source_path) || undefined;
    if (!isJmailOwnerSend(req) && (replyToMessageId || sourcePath)) {
      const filesRoot = resolveJoshuFilesPaths(opts.projectRoot)?.filesRoot ?? null;
      const auth = await resolveOutboundMailAuthorization({
        filesRoot,
        projectRoot: opts.projectRoot,
        replyToMessageId,
        sourcePath,
      });
      if (!auth?.agent_authorized) {
        res.status(403).json({
          error: "mail_send_not_authorized",
          reason: auth?.reason ?? "not_copied_or_delegated",
        });
        return;
      }
    }
    // Fail (do not mutate) when a reply would fork Gmail threading via subject decoration.
    // Runs before action guard so the owner is not asked to approve a send that cannot thread.
    if (replyToMessageId) {
      try {
        const parent = await getMessage(agent.grantId, replyToMessageId);
        const expectedSubject = (parent.subject ?? "").trim();
        if (expectedSubject && !replySubjectsMatch(subject, expectedSubject)) {
          res.status(400).json(
            buildReplySubjectMismatchError({ got: subject, expected: expectedSubject }),
          );
          return;
        }
      } catch (err) {
        res.status(400).json({
          error: "reply_parent_message_unavailable",
          reason: (err as Error).message,
          hint: "replyToMessageId must be a Nylas message id that exists in the agent mailbox. Use the message_id / external_id from the thread mirror.",
        });
        return;
      }
    }
    const gate = await gateNylasSendRequest(req, body, opts.projectRoot);
    if (!respondNylasSendGate(res, gate)) {
      return;
    }
    try {
      const identity = resolveJoshuIdentity(opts.projectRoot);
      const bodyHtml = buildJoshuSignedEmailHtml(text, {
        name: identity.name,
        portraitImageUrl: identity.imageUrl ?? undefined,
        ownerDisplayName: identity.owner.displayName,
      });
      const id = await sendMessage(agent.grantId, {
        from: agent.email,
        to,
        cc,
        bcc,
        subject,
        body: bodyHtml,
        replyToMessageId,
      });
      res.json({ ok: true, messageId: id, from: agent.email, to: to.map((r) => r.email), cc: cc?.map((r) => r.email) });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  router.get("/api/nylas/messages", async (req: Request, res: Response) => {
    const agent = readAgentGrant(opts.projectRoot);
    if (!agent) {
      res.status(404).json({ error: "No agent mailbox provisioned" });
      return;
    }
    const limit = Number(req.query.limit ?? 25);
    const unread = req.query.unread === "true";
    const search = readString(req.query.q) || readString(req.query.search_query_native);
    try {
      const messages = await listMessages(agent.grantId, {
        limit: Number.isFinite(limit) ? limit : 25,
        unread,
        searchQueryNative: search || undefined,
      });
      res.json({ messages, grantId: agent.grantId, email: agent.email });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  router.get("/api/nylas/messages/:messageId", async (req: Request, res: Response) => {
    const agent = readAgentGrant(opts.projectRoot);
    if (!agent) {
      res.status(404).json({ error: "No agent mailbox provisioned" });
      return;
    }
    const messageId = readString(req.params.messageId);
    if (!messageId) {
      res.status(400).json({ error: "messageId is required" });
      return;
    }
    try {
      const message = await getMessage(agent.grantId, messageId);
      res.json({ message, email: agent.email });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  router.patch("/api/nylas/messages/:messageId", async (req: Request, res: Response) => {
    const agent = readAgentGrant(opts.projectRoot);
    if (!agent) {
      res.status(404).json({ error: "No agent mailbox provisioned" });
      return;
    }
    const messageId = readString(req.params.messageId);
    if (!messageId) {
      res.status(400).json({ error: "messageId is required" });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch: { unread?: boolean; starred?: boolean } = {};
    if (typeof body.unread === "boolean") patch.unread = body.unread;
    if (typeof body.starred === "boolean") patch.starred = body.starred;
    if (Object.keys(patch).length === 0) {
      res.status(400).json({ error: "Provide unread and/or starred booleans" });
      return;
    }
    try {
      const message = await updateMessage(agent.grantId, messageId, patch);
      res.json({ ok: true, message });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  router.post("/api/nylas/test-send", async (req: Request, res: Response) => {
    const agent = readAgentGrant(opts.projectRoot);
    if (!agent) {
      res.status(404).json({ error: "No agent mailbox" });
      return;
    }
    const to = readString((req.body as { to?: unknown })?.to);
    if (!to) {
      res.status(400).json({ error: "to is required (recipient email)" });
      return;
    }
    const testBody = {
      to,
      subject: "Joshu agent mailbox test",
      body: "This is a test message from your Nylas Agent Account.",
    };
    const gate = await gateNylasSendRequest(req, testBody, opts.projectRoot);
    if (!respondNylasSendGate(res, gate)) {
      return;
    }
    try {
      const identity = resolveJoshuIdentity(opts.projectRoot);
      const bodyHtml = buildJoshuSignedEmailHtml(
        "This is a test message from your Nylas Agent Account.",
        {
          name: identity.name,
          portraitImageUrl: identity.imageUrl ?? undefined,
          ownerDisplayName: identity.owner.displayName,
        },
      );
      const id = await sendMessage(agent.grantId, {
        from: agent.email,
        to: [{ email: to }],
        subject: "Joshu agent mailbox test",
        body: bodyHtml,
      });
      res.json({ ok: true, messageId: id, from: agent.email, to });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  router.get("/api/nylas/events", async (req: Request, res: Response) => {
    const agent = readAgentGrant(opts.projectRoot);
    if (!agent) {
      res.status(404).json({ error: "No agent mailbox provisioned" });
      return;
    }
    const limit = readNumber(req.query.limit) ?? 50;
    const calendarId = readString(req.query.calendar_id) || readString(req.query.calendarId) || "primary";
    let start: number;
    let end: number;
    try {
      const window = resolveListEventsWindow(slotInputFromQuery(req.query));
      start = window.start;
      end = window.end;
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }
    try {
      const events = await listEvents(agent.grantId, { calendarId, start, end, limit });
      res.json({ events, grantId: agent.grantId, email: agent.email, calendarId, start, end });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  router.get("/api/nylas/events/:eventId", async (req: Request, res: Response) => {
    const agent = readAgentGrant(opts.projectRoot);
    if (!agent) {
      res.status(404).json({ error: "No agent mailbox provisioned" });
      return;
    }
    const eventId = readString(req.params.eventId);
    if (!eventId) {
      res.status(400).json({ error: "eventId is required" });
      return;
    }
    const calendarId = readString(req.query.calendar_id) || readString(req.query.calendarId) || "primary";
    try {
      const event = await getEvent(agent.grantId, eventId, calendarId);
      res.json({ event, email: agent.email });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  router.post("/api/nylas/events", async (req: Request, res: Response) => {
    if (agentRestWriteBlocked(req)) {
      res.status(403).json({
        error:
          "Nylas calendar writes are disabled for agents. Book on owner Google Calendar via Composio GOOGLECALENDAR_CREATE_EVENT.",
      });
      return;
    }
    const agent = readAgentGrant(opts.projectRoot);
    if (!agent) {
      res.status(404).json({ error: "No agent mailbox provisioned" });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const title = readString(body.title);
    let startTime: number;
    let endTime: number;
    let timezone: string | undefined;
    try {
      const window = resolveEventWindow(slotInputFromRecord(body));
      startTime = window.startTime;
      endTime = window.endTime;
      timezone = window.timezone;
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }
    if (!title) {
      res.status(400).json({ error: "title is required" });
      return;
    }
    const participants = parseParticipantList(body.participants);

    try {
      const event = await createEvent(agent.grantId, {
        calendarId: readString(body.calendarId) || readString(body.calendar_id) || "primary",
        title,
        startTime,
        endTime,
        timezone,
        description: readString(body.description) || undefined,
        location: readString(body.location) || undefined,
        participants,
        notifyParticipants: typeof body.notifyParticipants === "boolean" ? body.notifyParticipants : undefined,
      });
      res.json({ ok: true, event });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  router.patch("/api/nylas/events/:eventId", async (req: Request, res: Response) => {
    if (agentRestWriteBlocked(req)) {
      res.status(403).json({
        error:
          "Nylas calendar writes are disabled for agents. Update owner Google Calendar via Composio GOOGLECALENDAR_PATCH_EVENT.",
      });
      return;
    }
    const agent = readAgentGrant(opts.projectRoot);
    if (!agent) {
      res.status(404).json({ error: "No agent mailbox provisioned" });
      return;
    }
    const eventId = readString(req.params.eventId);
    if (!eventId) {
      res.status(400).json({ error: "eventId is required" });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const participants = parseParticipantList(body.participants);
    let startTime: number | undefined;
    let endTime: number | undefined;
    let timezone: string | undefined;
    const hasSlotFields =
      readNumber(body.startTime) != null ||
      readNumber(body.endTime) != null ||
      readString(body.date) ||
      readString(body.startLocal) ||
      readString(body.endLocal);
    if (hasSlotFields) {
      try {
        const window = resolveEventWindow(slotInputFromRecord(body));
        startTime = window.startTime;
        endTime = window.endTime;
        timezone = window.timezone;
      } catch (err) {
        res.status(400).json({ error: (err as Error).message });
        return;
      }
    }

    try {
      const event = await updateEvent(agent.grantId, eventId, {
        calendarId: readString(body.calendarId) || readString(body.calendar_id) || "primary",
        title: readString(body.title) || undefined,
        startTime,
        endTime,
        timezone: timezone ?? (readString(body.timezone) || undefined),
        description: readString(body.description) || undefined,
        location: readString(body.location) || undefined,
        participants,
        notifyParticipants: typeof body.notifyParticipants === "boolean" ? body.notifyParticipants : undefined,
      });
      res.json({ ok: true, event });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  router.delete("/api/nylas/events/:eventId", async (req: Request, res: Response) => {
    if (agentRestWriteBlocked(req)) {
      res.status(403).json({ error: "Delete actions are disabled for agents." });
      return;
    }
    const agent = readAgentGrant(opts.projectRoot);
    if (!agent) {
      res.status(404).json({ error: "No agent mailbox provisioned" });
      return;
    }
    const eventId = readString(req.params.eventId);
    if (!eventId) {
      res.status(400).json({ error: "eventId is required" });
      return;
    }
    const calendarId = readString(req.query.calendar_id) || readString(req.query.calendarId) || "primary";
    try {
      await destroyEvent(agent.grantId, eventId, calendarId);
      res.json({ ok: true });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  router.get("/api/nylas/profile", (_req: Request, res: Response) => {
    res.json({ profile: readAgentProfile(opts.projectRoot) });
  });

  router.post("/api/nylas/profile", (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const defaults = resolveJoshuIdentity(opts.projectRoot);
    const fields: NylasAgentProfile = {
      ownerName: readString(body.ownerName),
      assistantName: readString(body.assistantName) || defaults.name || DEFAULT_ASSISTANT_NAME,
      assistantEmail: readString(body.assistantEmail),
      primaryWorkEmail: readString(body.primaryWorkEmail),
      personalEmail: readString(body.personalEmail),
      timezone: readString(body.timezone),
      targetMarket: readString(body.targetMarket),
      targetGeography: readString(body.targetGeography),
      spendingThreshold: readString(body.spendingThreshold),
      urgentChannel: readString(body.urgentChannel),
      workingHoursStart: readString(body.workingHoursStart),
      workingHoursEnd: readString(body.workingHoursEnd),
    };
    const ok = updateAgentProfile(fields, opts.projectRoot);
    if (!ok) {
      res.status(404).json({ error: "Could not write agent profile — is ArozOS data available?" });
      return;
    }
    res.json({ ok: true, profile: readAgentProfile(opts.projectRoot) });
  });

  /** @deprecated Use POST /api/nylas/profile */
  router.post("/api/nylas/tools", (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const defaults = resolveJoshuIdentity(opts.projectRoot);
    const ok = updateAgentProfile(
      {
        ownerName: readString(body.ownerName),
        assistantName: readString(body.assistantName) || defaults.name || DEFAULT_ASSISTANT_NAME,
        assistantEmail: readString(body.assistantEmail),
        primaryWorkEmail: readString(body.primaryWorkEmail),
        personalEmail: readString(body.personalEmail),
        timezone: readString(body.timezone),
        targetMarket: readString(body.targetMarket),
        targetGeography: readString(body.targetGeography),
        spendingThreshold: readString(body.spendingThreshold),
        urgentChannel: readString(body.urgentChannel),
        workingHoursStart: readString(body.workingHoursStart),
        workingHoursEnd: readString(body.workingHoursEnd),
      },
      opts.projectRoot,
    );
    if (!ok) {
      res.status(404).json({ error: "Could not write agent profile — is ArozOS data available?" });
      return;
    }
    res.json({ ok: true, profile: readAgentProfile(opts.projectRoot) });
  });
}
