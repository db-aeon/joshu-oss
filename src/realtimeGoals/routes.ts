import type { Request, Response, Router } from "express";

import {
  isDirectLocalhostRequest,
  verifyArozosDesktopSession,
} from "../httpLocalhost.js";
import { isDeferCapableChannel } from "./channelPolicy.js";
import type { RealtimeGoalBroker } from "./broker.js";
import type {
  RealtimeGoalChannel,
  RealtimeGoalOrigin,
} from "./types.js";

const CHANNELS = new Set<RealtimeGoalChannel>([
  "sms",
  "jchat",
  "agui",
  "browser_voice",
  "pstn_voice",
  "slack",
  "telegram",
]);

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function hasInternalServiceAuth(req: Request): boolean {
  if (!isDirectLocalhostRequest(req)) return false;
  const expected = process.env.HERMES_API_KEY?.trim();
  const authorization = String(req.headers.authorization ?? "");
  return Boolean(expected && authorization === `Bearer ${expected}`);
}

function parseOrigin(value: unknown): RealtimeGoalOrigin | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const channel = readString(raw.channel) as RealtimeGoalChannel;
  const sessionKey = readString(raw.sessionKey);
  if (!CHANNELS.has(channel) || !sessionKey) return undefined;
  return {
    channel,
    sessionKey,
    ...(readString(raw.sessionId) ? { sessionId: readString(raw.sessionId) } : {}),
    ...(readString(raw.messageId) ? { messageId: readString(raw.messageId) } : {}),
    ...(readString(raw.replyAddress)
      ? { replyAddress: readString(raw.replyAddress) }
      : {}),
    ...(readString(raw.threadId) ? { threadId: readString(raw.threadId) } : {}),
    ...(readString(raw.appId) ? { appId: readString(raw.appId) } : {}),
  };
}

export function registerRealtimeGoalRoutes(
  router: Router,
  broker: RealtimeGoalBroker,
): void {
  /** Internal voice-realtime and Hermes plugin admission endpoint. */
  router.post("/api/realtime-goals/route", async (req: Request, res: Response) => {
    if (!hasInternalServiceAuth(req)) {
      res.status(403).json({ error: "internal service authentication required" });
      return;
    }
    const origin = parseOrigin(req.body?.origin);
    const text = readString(req.body?.text);
    if (!origin || !text) {
      res.status(400).json({ error: "origin and text are required" });
      return;
    }
    res.json(await broker.route({ origin, text }));
  });

  /** Agent-callable fallback after an initially synchronous turn discovers long work. */
  router.post("/api/realtime-goals/defer", async (req: Request, res: Response) => {
    if (!hasInternalServiceAuth(req)) {
      res.status(403).json({ error: "internal service authentication required" });
      return;
    }
    const origin = parseOrigin(req.body?.origin);
    const text = readString(req.body?.text);
    if (!origin || !text) {
      res.status(400).json({ error: "origin and text are required" });
      return;
    }
    if (!isDeferCapableChannel(origin.channel)) {
      res.status(400).json({
        ok: false,
        error: `realtime_goal_defer is unavailable on channel ${origin.channel}`,
      });
      return;
    }
    try {
      const goal = await broker.defer({ origin, text }, readString(req.body?.title));
      res.json({
        ok: true,
        goalId: goal.id,
        reply: goal.intakeReply,
        releaseAt: goal.releaseAt,
      });
    } catch (error) {
      res.status(400).json({ ok: false, error: (error as Error).message });
    }
  });

  router.post("/api/realtime-goals/context", async (req: Request, res: Response) => {
    if (!hasInternalServiceAuth(req)) {
      res.status(403).json({ error: "internal service authentication required" });
      return;
    }
    const origin = parseOrigin(req.body?.origin);
    if (!origin) {
      res.status(400).json({ error: "origin is required" });
      return;
    }
    const setupMention = req.body?.setupMention === true;
    res.json({ context: (await broker.buildHermesContextSnapshot(origin, { setupMention })) ?? null });
  });

  router.post("/api/realtime-goals/thread/box", async (req: Request, res: Response) => {
    if (!hasInternalServiceAuth(req)) {
      res.status(403).json({ error: "internal service authentication required" });
      return;
    }
    const origin = parseOrigin(req.body?.origin);
    const text = readString(req.body?.text);
    const source = readString(req.body?.source);
    const goalId = readString(req.body?.goalId);
    if (!origin || !text) {
      res.status(400).json({ error: "origin and text are required" });
      return;
    }
    const allowed = new Set(["broker", "delivery", "hermes"]);
    if (!allowed.has(source)) {
      res.status(400).json({ error: "source must be broker, delivery, or hermes" });
      return;
    }
    await broker.recordBoxTurn(
      origin,
      text,
      source as "broker" | "delivery" | "hermes",
      goalId || undefined,
    );
    res.json({ ok: true });
  });

  /** Embedded AG-UI clients poll this durable queue while their chat panel is mounted. */
  router.get("/api/realtime-goals/surface-events", async (req, res) => {
    if (!(await verifyArozosDesktopSession(req))) {
      res.status(403).json({ error: "desktop session only" });
      return;
    }
    const sessionKey = readString(req.query.sessionKey);
    if (!sessionKey) {
      res.status(400).json({ error: "sessionKey is required" });
      return;
    }
    res.json({ events: await broker.listSurfaceEvents(sessionKey) });
  });

  router.post("/api/realtime-goals/surface-events/:eventId/consume", async (req, res) => {
    if (!(await verifyArozosDesktopSession(req))) {
      res.status(403).json({ error: "desktop session only" });
      return;
    }
    const sessionKey = readString(req.body?.sessionKey);
    const eventId = readString(req.params.eventId);
    if (!sessionKey || !eventId) {
      res.status(400).json({ error: "sessionKey and eventId are required" });
      return;
    }
    res.json({ ok: await broker.consumeSurfaceEvent(sessionKey, eventId) });
  });

  router.get("/api/realtime-goals/:goalId", async (req, res) => {
    if (!hasInternalServiceAuth(req)) {
      res.status(403).json({ error: "internal service authentication required" });
      return;
    }
    const goal = await broker.store.get(req.params.goalId);
    if (!goal) {
      res.status(404).json({ error: "goal not found" });
      return;
    }
    res.json({ goal });
  });
}
