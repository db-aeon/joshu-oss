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
import { joshuConfigDir } from "../nylas/paths.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Read assistant display name without importing joshuIdentity (avoids circular deps). */
function resolveAssistantName(projectRoot = process.cwd()): string {
  const fromEnv = process.env.JOSHU_NAME?.trim();
  if (fromEnv) return fromEnv;
  try {
    const dir = joshuConfigDir(projectRoot);
    if (dir) {
      const idPath = path.join(dir, "identity.json");
      if (fs.existsSync(idPath)) {
        const parsed = JSON.parse(fs.readFileSync(idPath, "utf8")) as { name?: string };
        if (parsed?.name?.trim()) return parsed.name.trim();
      }
    }
  } catch {
    /* ignore */
  }
  return "Companion";
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

/**
 * Slack Events API needs the raw body for signature verification.
 * Register this BEFORE `express.json()`.
 */
export function registerShareChatSlackEventsRoute(router: Router): void {
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
    const identityName = resolveAssistantName();
    html = html
      .replaceAll("{{SHARE_UUID}}", escapeHtml(scope.uuid))
      .replaceAll("{{DISPLAY_NAME}}", escapeHtml(scope.displayName))
      .replaceAll("{{ASSISTANT_NAME}}", escapeHtml(identityName))
      .replaceAll("{{IS_FOLDER}}", scope.isFolder ? "folder" : "file");
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
    res.json({
      ok: true,
      uuid: scope.uuid,
      displayName: scope.displayName,
      isFolder: scope.isFolder,
      permission: scope.permission,
      chatEnabled: true,
      assistantName: resolveAssistantName(),
      scopeWarning: "Answers only from the shared files",
      slack: publicSlackStatus(shareUuid),
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
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function notFoundHtml(chatDisabled = false): string {
  const title = chatDisabled ? "Chat sharing off" : "Share not found";
  const body = chatDisabled
    ? "The owner turned off chat sharing for these files. Ask them for a new link if you still need access."
    : "This chat link is invalid, expired, or sharing was turned off.";
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>${title}</title>
<style>
  body{font-family:system-ui,sans-serif;background:#f5f0eb;color:#0d0d0d;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
  .card{background:#fff;border:1px solid rgba(0,0,0,.12);padding:28px 32px;max-width:420px;border-radius:2px}
  h1{font-size:18px;margin:0 0 8px} p{margin:0;opacity:.75;font-size:14px;line-height:1.4}
</style></head>
<body><div class="card"><h1>${title}</h1>
<p>${body}</p></div></body></html>`;
}
