/**
 * Public share-chat HTTP routes + static UI.
 *
 *   GET  /share-chat/:shareUuid
 *   GET  /api/share-chat/:shareUuid/status
 *   POST /api/share-chat/:shareUuid/message
 *   POST /api/share-chat/:shareUuid/enable   (desktop Share To dialog)
 *   POST /api/share-chat/:shareUuid/disable  (desktop Share To dialog)
 *   POST /api/share-chat/:shareUuid/slack/configure
 *   GET  /api/share-chat/:shareUuid/slack/manifest
 *   POST /api/share-chat/slack/events/:shareUuid
 *   GET  /api/share-chat/:shareUuid/slack/channel
 *   POST /api/share-chat/:shareUuid/slack/channel
 *   POST /api/share-chat/:shareUuid/slack/channel/unlink
 *   POST /api/share-chat/composio/triggers
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Request, Response, Router } from "express";
import express from "express";
import { resolveShareScope } from "./shareScope.js";
import { queryScopedBrain } from "./scopedBrain.js";
import { answerShareChatQuestion, streamShareChatAnswer } from "./answer.js";
import { checkShareChatRateLimit } from "./rateLimit.js";
import {
  isShareChatEnabled,
  setShareChatEnabled,
} from "./chatFlags.js";
import {
  buildSlackAppManifest,
  deleteShareSlackBot,
  getShareSlackBot,
  publicSlackStatus,
  upsertShareSlackBot,
} from "./slackRegistry.js";
import { handleShareSlackEvent, verifySlackRequestSignature } from "./slackEvents.js";
import {
  handleSlackbotEventsRequest,
  slackbotEventsRequestUrl,
} from "./slackbotEvents.js";
import {
  getShareSlackChannel,
  normalizeSlackChannelName,
  publicSlackChannelStatus,
  suggestSlackChannelName,
  unlinkShareSlackChannel,
  upsertShareSlackChannel,
} from "./slackChannels.js";
import {
  createChannelMessageTrigger,
  createSlackbotChannel,
  deleteTriggerInstance,
  inviteOwnerToSlackbotChannel,
  isComposioSlackbotConnected,
  sendSlackbotMessage,
} from "./composioSlackbot.js";
import { handleComposioShareChatTrigger } from "./composioTriggers.js";
import { isComposioEnabled } from "../composioApi.js";
import { composioClient } from "../connectors/composio/client.js";
import { formatJoshuSignatureRoleLine } from "../email/joshuEmailSignature.js";
import { resolveJoshuIdentity } from "../joshuIdentity.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Companion identity for public share-chat chrome (email-signature language).
 * Prefer full portrait (`imageUrl`) to match outbound mail; fall back to avatar.
 */
function resolveShareChatPersona(projectRoot = process.cwd()): {
  name: string;
  roleLine: string;
  portraitUrl: string | null;
} {
  const identity = resolveJoshuIdentity(projectRoot);
  const portraitUrl =
    identity.imageUrl?.trim() || identity.avatarUrl?.trim() || null;
  return {
    name: identity.name.trim() || "Companion",
    roleLine: formatJoshuSignatureRoleLine(identity.owner.displayName),
    portraitUrl,
  };
}

/** Photo cell HTML for the signature-style identity lockup. */
function identityPhotoHtml(name: string, portraitUrl: string | null): string {
  const safeName = escapeHtml(name);
  if (portraitUrl) {
    return `<img class="jp-identity-img" src="${escapeHtml(portraitUrl)}" alt="${safeName}" width="72" height="72" decoding="async" />`;
  }
  const initial = escapeHtml((name.trim().charAt(0) || "?").toUpperCase());
  return `<span class="jp-identity-fallback" aria-hidden="true">${initial}</span>`;
}

function uiHtmlPath(): string {
  // Prefer apps/share-chat (source), fall back to bundled copy beside this module.
  const candidates = [
    path.resolve(process.cwd(), "apps/share-chat/index.html"),
    path.resolve(__dirname, "../../apps/share-chat/index.html"),
    path.resolve(__dirname, "ui/index.html"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return candidates[0]!;
}

function clientKey(req: Request): string {
  const xf = req.headers["x-forwarded-for"];
  if (typeof xf === "string" && xf.trim()) return xf.split(",")[0]!.trim();
  return req.ip || req.socket.remoteAddress || "unknown";
}

function adminConfigured(): boolean {
  return Boolean(process.env.JOSHU_SHARE_CHAT_ADMIN_KEY?.trim() || process.env.JOSHU_READ_API_KEY?.trim());
}

function requireShareChatAdmin(req: Request, res: Response): boolean {
  const expected =
    process.env.JOSHU_SHARE_CHAT_ADMIN_KEY?.trim() || process.env.JOSHU_READ_API_KEY?.trim() || "";
  if (!expected) {
    // Local/dev convenience: allow configure when no admin key is set.
    return true;
  }
  const auth = req.headers.authorization || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const header = typeof req.headers["x-joshu-share-chat-admin"] === "string"
    ? req.headers["x-joshu-share-chat-admin"].trim()
    : "";
  if (bearer === expected || header === expected) return true;
  res.status(401).json({ error: "unauthorized", hint: "Pass Bearer token (JOSHU_SHARE_CHAT_ADMIN_KEY or JOSHU_READ_API_KEY)." });
  return false;
}

function publicBase(req: Request): string {
  const proto = (req.headers["x-forwarded-proto"] as string) || req.protocol || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost";
  const basePath = (process.env.PUBLIC_BASE_PATH || "").replace(/\/+$/, "");
  return `${proto}://${host}${basePath}`;
}

/** Path prefix for same-origin assets under Joshu (e.g. `/joshu`). */
function publicPathPrefix(): string {
  return (process.env.PUBLIC_BASE_PATH || "").replace(/\/+$/, "");
}

function publicPagesCssPath(): string | null {
  const candidates = [
    path.resolve(process.cwd(), "arozos/web-overlays-vanilla/joshu-public-pages.css"),
    path.resolve(__dirname, "../../arozos/web-overlays-vanilla/joshu-public-pages.css"),
    path.resolve(process.cwd(), "apps/share-chat/joshu-public-pages.css"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * Slack Events API needs the raw body for signature verification.
 * Register this BEFORE `express.json()`.
 */
export function registerShareChatSlackEventsRoute(router: Router): void {
  // Composio Slackbot channels: one Events URL for all mapped shares (preferred over Composio ingress).
  router.post(
    "/api/share-chat/slackbot/events",
    express.raw({ type: "*/*", limit: "256kb" }),
    async (req: Request, res: Response) => {
      const rawBody = Buffer.isBuffer(req.body)
        ? req.body.toString("utf8")
        : typeof req.body === "string"
          ? req.body
          : "";
      const timestamp = String(req.headers["x-slack-request-timestamp"] || "");
      const signature = String(req.headers["x-slack-signature"] || "");
      try {
        const result = await handleSlackbotEventsRequest({
          rawBody,
          timestamp,
          signature,
        });
        res.status(result.status).json(result.body);
      } catch (err) {
        console.error(
          "[share-chat/slackbot-events]",
          err instanceof Error ? err.message : String(err),
        );
        res.status(500).json({ error: "slackbot_events_failed" });
      }
    },
  );

  router.post(
    "/api/share-chat/slack/events/:shareUuid",
    express.raw({ type: "*/*", limit: "256kb" }),
    async (req: Request, res: Response) => {
      const shareUuid = String(req.params.shareUuid || "").trim();
      const bot = getShareSlackBot(shareUuid);
      if (!bot) {
        res.status(404).json({ error: "slack_bot_not_configured" });
        return;
      }

      const rawBody = Buffer.isBuffer(req.body)
        ? req.body.toString("utf8")
        : typeof req.body === "string"
          ? req.body
          : "";
      const timestamp = String(req.headers["x-slack-request-timestamp"] || "");
      const signature = String(req.headers["x-slack-signature"] || "");

      if (
        !verifySlackRequestSignature({
          signingSecret: bot.signingSecret,
          timestamp,
          rawBody,
          signature,
        })
      ) {
        res.status(401).json({ error: "invalid_signature" });
        return;
      }

      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(rawBody) as Record<string, unknown>;
      } catch {
        res.status(400).json({ error: "invalid_json" });
        return;
      }

      try {
        const result = await handleShareSlackEvent({
          shareUuid,
          bot,
          payload,
        });
        res.status(result.status).json(result.body);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[share-chat/slack]", msg);
        res.status(500).json({ error: "slack_handler_failed" });
      }
    },
  );
}

/**
 * Composio trigger webhooks (Slackbot CHANNEL_MESSAGE_RECEIVED).
 * Register BEFORE `express.json()`. Requires COMPOSIO_WEBHOOK_SECRET from the Composio dashboard.
 */
export function registerShareChatComposioTriggersRoute(router: Router): void {
  router.post(
    "/api/share-chat/composio/triggers",
    express.raw({ type: "*/*", limit: "512kb" }),
    async (req: Request, res: Response) => {
      const secret = process.env.COMPOSIO_WEBHOOK_SECRET?.trim() || "";
      if (!secret) {
        res.status(503).json({
          error: "composio_webhook_secret_missing",
          hint: "Set COMPOSIO_WEBHOOK_SECRET from the Composio project webhook settings.",
        });
        return;
      }
      if (!isComposioEnabled()) {
        res.status(503).json({ error: "composio_disabled" });
        return;
      }

      const rawBody = Buffer.isBuffer(req.body)
        ? req.body.toString("utf8")
        : typeof req.body === "string"
          ? req.body
          : "";
      const id = String(req.headers["webhook-id"] || "");
      const signature = String(req.headers["webhook-signature"] || "");
      const timestamp = String(req.headers["webhook-timestamp"] || "");

      try {
        const composio = composioClient();
        const verified = await composio.triggers.verifyWebhook({
          id,
          payload: rawBody,
          secret,
          signature,
          timestamp,
        });
        // Ack fast; answer asynchronously so Composio does not time out.
        res.status(200).json({ ok: true });
        void handleComposioShareChatTrigger(verified.payload).catch((err) => {
          console.error(
            "[share-chat/composio]",
            err instanceof Error ? err.message : String(err),
          );
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn("[share-chat/composio] webhook verify failed:", msg);
        res.status(401).json({ error: "invalid_signature" });
      }
    },
  );
}

function sseSend(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function parseMessageBody(req: Request): string {
  return typeof req.body?.message === "string"
    ? req.body.message
    : typeof req.body?.text === "string"
      ? req.body.text
      : "";
}

/** Desktop Share To / chat_share dialog calls — not for anonymous public guests. */
function isLikelyDesktopMutator(req: Request): boolean {
  const site = String(req.headers["sec-fetch-site"] || "");
  if (site === "same-origin" || site === "same-site") return true;
  const referer = String(req.headers.referer || "");
  if (/\/SystemAO\/file_system\//i.test(referer)) return true;
  const host = String(req.headers.host || "");
  const origin = String(req.headers.origin || "");
  if (host && origin && (origin === `http://${host}` || origin === `https://${host}`)) return true;
  return false;
}

/**
 * Public chat is available only when the ArozOS share is valid and chat sharing
 * has not been explicitly turned off. Missing flag = allow (legacy shares).
 */
function assertPublicShareChat(shareUuid: string) {
  const scope = resolveShareScope(shareUuid);
  if (!scope || !scope.valid) {
    return { ok: false as const, reason: "not_found" as const, scope: null };
  }
  if (!isShareChatEnabled(shareUuid)) {
    return { ok: false as const, reason: "chat_disabled" as const, scope: null };
  }
  return { ok: true as const, reason: null, scope };
}

/** Soft-protect enable/disable: desktop same-origin, or admin key when set. */
function allowChatFlagMutation(req: Request, res: Response): boolean {
  if (isLikelyDesktopMutator(req)) return true;
  const expected =
    process.env.JOSHU_SHARE_CHAT_ADMIN_KEY?.trim() || process.env.JOSHU_READ_API_KEY?.trim() || "";
  if (!expected) {
    res.status(403).json({
      error: "forbidden",
      hint: "Call from the desktop Chat sharing dialog (same-origin), or set JOSHU_SHARE_CHAT_ADMIN_KEY.",
    });
    return false;
  }
  return requireShareChatAdmin(req, res);
}

export function registerShareChatRoutes(router: Router): void {
  router.get("/share-chat/assets/joshu-public-pages.css", (_req: Request, res: Response) => {
    const cssPath = publicPagesCssPath();
    if (!cssPath) {
      res.status(404).type("text").send("joshu-public-pages.css missing");
      return;
    }
    res.type("text/css").send(fs.readFileSync(cssPath, "utf8"));
  });

  router.get("/share-chat/:shareUuid", (req: Request, res: Response) => {
    const shareUuid = String(req.params.shareUuid || "").trim();
    const gate = assertPublicShareChat(shareUuid);
    if (!gate.ok || !gate.scope) {
      res.status(404).type("html").send(notFoundHtml(gate.reason === "chat_disabled"));
      return;
    }
    const scope = gate.scope;
    const htmlPath = uiHtmlPath();
    if (!fs.existsSync(htmlPath)) {
      res.status(500).type("text").send("Share chat UI missing. Expected apps/share-chat/index.html");
      return;
    }
    let html = fs.readFileSync(htmlPath, "utf8");
    const persona = resolveShareChatPersona();
    const assetBase = publicPathPrefix() || "";
    html = html
      .replaceAll("{{SHARE_UUID}}", escapeHtml(scope.uuid))
      .replaceAll("{{DISPLAY_NAME}}", escapeHtml(scope.displayName))
      .replaceAll("{{ASSISTANT_NAME}}", escapeHtml(persona.name))
      .replaceAll("{{ROLE_LINE}}", escapeHtml(persona.roleLine))
      .replaceAll("{{IDENTITY_PHOTO_HTML}}", identityPhotoHtml(persona.name, persona.portraitUrl))
      .replaceAll("{{IS_FOLDER}}", scope.isFolder ? "folder" : "file")
      .replaceAll("{{ASSET_BASE}}", escapeHtml(assetBase));
    res.type("html").send(html);
  });

  router.get("/api/share-chat/:shareUuid/status", (req: Request, res: Response) => {
    const shareUuid = String(req.params.shareUuid || "").trim();
    const gate = assertPublicShareChat(shareUuid);
    if (!gate.ok || !gate.scope) {
      res.status(404).json({
        ok: false,
        error: gate.reason === "chat_disabled" ? "chat_disabled" : "not_found",
      });
      return;
    }
    const scope = gate.scope;
    const persona = resolveShareChatPersona();
    res.json({
      ok: true,
      uuid: scope.uuid,
      displayName: scope.displayName,
      isFolder: scope.isFolder,
      permission: scope.permission,
      chatEnabled: true,
      assistantName: persona.name,
      roleLine: persona.roleLine,
      portraitUrl: persona.portraitUrl,
      scopeWarning: "Answers only from the shared files",
      slack: publicSlackStatus(shareUuid),
      slackChannel: publicSlackChannelStatus(shareUuid),
    });
  });

  // Owner dialog: mark chat sharing on (after ArozOS share/new).
  router.post("/api/share-chat/:shareUuid/enable", (req: Request, res: Response) => {
    if (!allowChatFlagMutation(req, res)) return;
    const shareUuid = String(req.params.shareUuid || "").trim();
    if (!shareUuid) {
      res.status(400).json({ error: "share_uuid_required" });
      return;
    }
    const scope = resolveShareScope(shareUuid);
    if (!scope || !scope.valid) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    setShareChatEnabled(shareUuid, true);
    res.json({ ok: true, enabled: true, uuid: shareUuid });
  });

  // Owner dialog: mark chat sharing off (usually after ArozOS share/delete).
  router.post("/api/share-chat/:shareUuid/disable", (req: Request, res: Response) => {
    if (!allowChatFlagMutation(req, res)) return;
    const shareUuid = String(req.params.shareUuid || "").trim();
    if (!shareUuid) {
      res.status(400).json({ error: "share_uuid_required" });
      return;
    }
    setShareChatEnabled(shareUuid, false);
    res.json({ ok: true, enabled: false, uuid: shareUuid });
  });

  router.post("/api/share-chat/:shareUuid/message", async (req: Request, res: Response) => {
    const shareUuid = String(req.params.shareUuid || "").trim();
    const gate = assertPublicShareChat(shareUuid);
    if (!gate.ok || !gate.scope) {
      res.status(404).json({
        error: gate.reason === "chat_disabled" ? "chat_disabled" : "not_found",
      });
      return;
    }
    const scope = gate.scope;

    const rate = checkShareChatRateLimit(`web:${shareUuid}:${clientKey(req)}`, {
      limit: 30,
      windowMs: 60_000,
    });
    if (!rate.allowed) {
      res.setHeader("Retry-After", String(rate.retryAfterSec));
      res.status(429).json({ error: "rate_limited", retryAfterSec: rate.retryAfterSec });
      return;
    }

    const message = parseMessageBody(req);
    if (!message.trim()) {
      res.status(400).json({ error: "message_required" });
      return;
    }
    if (message.length > 4000) {
      res.status(400).json({ error: "message_too_long", max: 4000 });
      return;
    }

    // SSE stream when requested (UI default). Non-stream JSON kept for Slack/tools.
    const wantsStream =
      req.query.stream === "1" ||
      req.query.stream === "true" ||
      String(req.headers.accept || "").includes("text/event-stream");

    if (wantsStream) {
      res.set({
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.flushHeaders?.();

      const controller = new AbortController();
      res.on("close", () => controller.abort());

      try {
        sseSend(res, "status", {
          phase: "searching",
          message: "Searching the shared files…",
        });
        const brain = await queryScopedBrain(message, scope);
        if (controller.signal.aborted) return;

        sseSend(res, "status", {
          phase: "reading",
          message: brain.evidence.length
            ? `Found ${brain.evidence.length} passage${brain.evidence.length === 1 ? "" : "s"} — assembling an answer…`
            : "No matching passages yet — checking the shared files on disk…",
        });
        sseSend(res, "evidence", {
          count: brain.evidence.length,
          titles: brain.evidence.slice(0, 6).map((e) => e.title.replace(/\s+§\d+$/, "")),
        });

        const answered = await streamShareChatAnswer({
          question: message,
          scope,
          evidence: brain.evidence,
          signal: controller.signal,
          onStatus: (phase, statusMessage) => {
            if (!controller.signal.aborted) {
              sseSend(res, "status", { phase, message: statusMessage });
            }
          },
          onDelta: (chunk) => {
            if (!controller.signal.aborted) {
              sseSend(res, "delta", { text: chunk });
            }
          },
        });
        if (controller.signal.aborted) return;

        sseSend(res, "done", {
          ok: true,
          answer: answered.answer,
          citations: answered.citations,
          refused: answered.refused,
          assistantName: answered.assistantName,
          evidenceCount: brain.evidence.length,
          model: answered.model,
        });
        res.write("event: end\ndata: {}\n\n");
        res.end();
      } catch (err) {
        if (controller.signal.aborted) return;
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[share-chat/stream]", msg);
        sseSend(res, "error", { error: "answer_failed" });
        res.end();
      }
      return;
    }

    try {
      const brain = await queryScopedBrain(message, scope);
      const answered = await answerShareChatQuestion(message, scope, brain.evidence);
      res.json({
        ok: true,
        answer: answered.answer,
        citations: answered.citations,
        refused: answered.refused,
        assistantName: answered.assistantName,
        evidenceCount: brain.evidence.length,
        model: answered.model,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[share-chat]", msg);
      res.status(500).json({ error: "answer_failed" });
    }
  });

  router.post("/api/share-chat/:shareUuid/slack/configure", (req: Request, res: Response) => {
    if (!requireShareChatAdmin(req, res)) return;
    const shareUuid = String(req.params.shareUuid || "").trim();
    const scope = resolveShareScope(shareUuid);
    if (!scope || !scope.valid) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    const body = req.body || {};
    if (body.delete === true || body.action === "delete") {
      deleteShareSlackBot(shareUuid);
      res.json({ ok: true, configured: false });
      return;
    }

    try {
      const cfg = upsertShareSlackBot({
        shareUuid,
        botToken: String(body.botToken || ""),
        signingSecret: String(body.signingSecret || ""),
        appToken: body.appToken ? String(body.appToken) : undefined,
        botDisplayName: body.botDisplayName ? String(body.botDisplayName) : scope.displayName,
        allowedUserIds: body.allowedUserIds,
        allowedChannelIds: body.allowedChannelIds,
      });
      res.json({
        ok: true,
        configured: true,
        status: publicSlackStatus(shareUuid),
        eventsUrl: `${publicBase(req)}/api/share-chat/slack/events/${encodeURIComponent(cfg.shareUuid)}`,
        adminKeyRequired: adminConfigured(),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: msg });
    }
  });

  router.get("/api/share-chat/:shareUuid/slack/manifest", (req: Request, res: Response) => {
    const shareUuid = String(req.params.shareUuid || "").trim();
    const scope = resolveShareScope(shareUuid);
    if (!scope || !scope.valid) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const eventsUrl = `${publicBase(req)}/api/share-chat/slack/events/${encodeURIComponent(shareUuid)}`;
    const manifest = buildSlackAppManifest(shareUuid, scope.displayName, eventsUrl);
    res.json({ ok: true, eventsUrl, manifest });
  });

  // --- Composio Slackbot KB channel (1:1 share ↔ channel) ---

  router.get("/api/share-chat/:shareUuid/slack/channel", async (req: Request, res: Response) => {
    const shareUuid = String(req.params.shareUuid || "").trim();
    const scope = resolveShareScope(shareUuid);
    if (!scope || !scope.valid) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const status = publicSlackChannelStatus(shareUuid);
    let slackbotConnected = false;
    try {
      slackbotConnected = await isComposioSlackbotConnected();
    } catch {
      slackbotConnected = false;
    }
    let subscribe: ReturnType<
      typeof import("./triggerSubscribe.js").getShareChatSlackbotSubscribeStatus
    > | null = null;
    try {
      const mod = await import("./triggerSubscribe.js");
      subscribe = mod.getShareChatSlackbotSubscribeStatus();
    } catch {
      subscribe = null;
    }
    res.json({
      ok: true,
      ...status,
      suggestedName: suggestSlackChannelName(scope.displayName),
      displayName: scope.displayName,
      slackbotConnected,
      composioEnabled: isComposioEnabled(),
      connectorsSlackbotUrl: "/connectors/index.html#slackbot",
      subscribe,
    });
  });

  router.post("/api/share-chat/:shareUuid/slack/channel", async (req: Request, res: Response) => {
    if (!allowChatFlagMutation(req, res)) return;
    const shareUuid = String(req.params.shareUuid || "").trim();
    const scope = resolveShareScope(shareUuid);
    if (!scope || !scope.valid) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    if (!isComposioEnabled()) {
      res.status(400).json({ error: "composio_disabled" });
      return;
    }
    if (!(await isComposioSlackbotConnected())) {
      res.status(400).json({
        error: "composio_slackbot_required",
        hint: "Connect Slackbot in Connectors (custom Slack app auth config). This is separate from user Slack.",
      });
      return;
    }

    const existing = getShareSlackChannel(shareUuid);
    if (existing?.enabled) {
      res.status(409).json({
        error: "channel_already_mapped",
        channelId: existing.channelId,
        channelName: existing.channelName,
      });
      return;
    }

    let channelName: string;
    try {
      const rawName =
        typeof req.body?.name === "string" && req.body.name.trim()
          ? req.body.name
          : suggestSlackChannelName(scope.displayName);
      channelName = normalizeSlackChannelName(rawName);
    } catch (err) {
      const code = err instanceof Error ? err.message : "channel_name_invalid";
      res.status(400).json({ error: code });
      return;
    }

    try {
      const created = await createSlackbotChannel({ name: channelName, isPrivate: true });
      // Private channels only include the bot until we invite humans — invite the owner so they see it.
      const invite = await inviteOwnerToSlackbotChannel(created.channelId);
      if (invite.error) {
        console.warn(
          "[share-chat/slack/channel] owner invite:",
          invite.error,
          "emailsTried=",
          invite.emailsTried.join(","),
        );
      }

      let triggerInstanceId: string | undefined;
      let triggerError: string | undefined;
      try {
        triggerInstanceId = await createChannelMessageTrigger({ channelId: created.channelId });
      } catch (trigErr) {
        triggerError = trigErr instanceof Error ? trigErr.message : String(trigErr);
        console.warn("[share-chat/slack/channel] trigger create failed:", triggerError);
      }

      const now = new Date().toISOString();
      const row = upsertShareSlackChannel({
        shareUuid,
        channelId: created.channelId,
        channelName: created.channelName,
        triggerInstanceId,
        isPrivate: created.isPrivate,
        createdAt: now,
        updatedAt: now,
        enabled: true,
      });

      // Soft-enable chat sharing if the owner only created a Slack channel.
      setShareChatEnabled(shareUuid, true);

      const inviteHint = invite.invitedUserIds.length
        ? "You should see it in Slack now."
        : "If you do not see it yet, ask a Slack admin to invite you (private channels are hidden until you are a member).";
      const intro =
        `This channel answers questions about *${scope.displayName}* (shared files only).\n` +
        `Post a message here — no @mention needed. Invite teammates from Slack as needed.`;
      try {
        await sendSlackbotMessage({ channel: row.channelId, text: intro });
      } catch (introErr) {
        console.warn(
          "[share-chat/slack/channel] intro message failed:",
          introErr instanceof Error ? introErr.message : String(introErr),
        );
      }

      const needsTeamRead =
        Boolean(triggerError) &&
        /team:read|missing_scope/i.test(triggerError || "");
      res.json({
        ok: true,
        configured: true,
        channelId: row.channelId,
        channelName: row.channelName,
        isPrivate: row.isPrivate,
        triggerInstanceId: row.triggerInstanceId || null,
        triggerError: triggerError || null,
        triggerHint: needsTeamRead
          ? "Message listening failed: Slack bot token is missing team:read. Add that bot scope in the Slack app → reinstall → Disconnect & reconnect Slackbot in Connectors → Create channel again (or Save credentials to rebind)."
          : triggerError
            ? "Channel created, but message triggers failed — questions will not get replies until this is fixed."
            : null,
        invitedUserIds: invite.invitedUserIds,
        inviteHint,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === "channel_name_taken") {
        res.status(409).json({
          error: "channel_name_taken",
          hint: "That Slack channel name is already taken. Pick a different name.",
        });
        return;
      }
      console.error("[share-chat/slack/channel]", msg);
      res.status(500).json({ error: msg });
    }
  });

  // Repair: invite owner into an already-created private Slackbot channel.
  router.post("/api/share-chat/:shareUuid/slack/channel/invite-owner", async (req: Request, res: Response) => {
    if (!allowChatFlagMutation(req, res)) return;
    const shareUuid = String(req.params.shareUuid || "").trim();
    const existing = getShareSlackChannel(shareUuid);
    if (!existing?.channelId) {
      res.status(404).json({ error: "channel_not_configured" });
      return;
    }
    const invite = await inviteOwnerToSlackbotChannel(existing.channelId);
    res.json({
      ok: !invite.error || invite.invitedUserIds.length > 0,
      channelId: existing.channelId,
      channelName: existing.channelName,
      ...invite,
    });
  });

  router.post("/api/share-chat/:shareUuid/slack/channel/unlink", async (req: Request, res: Response) => {
    if (!allowChatFlagMutation(req, res)) return;
    const shareUuid = String(req.params.shareUuid || "").trim();
    const existing = getShareSlackChannel(shareUuid);
    if (!existing) {
      res.json({ ok: true, configured: false });
      return;
    }
    if (existing.triggerInstanceId) {
      await deleteTriggerInstance(existing.triggerInstanceId);
    }
    unlinkShareSlackChannel(shareUuid);
    res.json({ ok: true, configured: false, unlinkedChannelId: existing.channelId });
  });
}

function notFoundHtml(chatDisabled = false): string {
  const title = chatDisabled ? "Chat sharing off" : "Share not found";
  const body = chatDisabled
    ? "The owner turned off chat sharing for these files. Ask them for a new link if you still need access."
    : "This chat link is invalid, expired, or sharing was turned off.";
  const assetBase = publicPathPrefix() || "";
  const cssHref = `${assetBase}/share-chat/assets/joshu-public-pages.css`;
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<link rel="icon" href="/img/public/joshu-icon.svg" type="image/svg+xml">
<link rel="stylesheet" href="${escapeHtml(cssHref)}">
</head>
<body class="jp-public">
  <div class="jp-public-shell">
    <main class="jp-public-panel">
      <img class="jp-public-brand" src="/img/public/joshu-wordmark.svg" alt="Joshu">
      <p class="jp-public-eyebrow">Chat with files</p>
      <h1 class="jp-public-title">${escapeHtml(title)}</h1>
      <p class="jp-public-lede">${escapeHtml(body)}</p>
    </main>
    <footer class="jp-public-footer"><strong>Joshu</strong> · File chat by <a href="https://joshu.me" target="_blank" rel="noopener noreferrer">joshu.me</a></footer>
  </div>
</body></html>`;
}
