import type { Request, Response, Router } from "express";
import type { CamofoxSessionCoordinator } from "../camofoxSession.js";
import type { HermesApiRunner } from "../hermesApi.js";
import { pauseBrowserAgent, resumeBrowserAgent } from "../browserAgent.js";
import { isDirectLocalhostRequest } from "../httpLocalhost.js";
import { setHandoffAuthCookie, verifyArozosPassword, verifyOwnerHandoffSession } from "./boxAuth.js";
import { browserHandoffLockStub, publicHandoffView } from "./lock.js";
import {
  cancelHandoff,
  cancelPendingHandoffsForKanbanTask,
  completeHandoff,
  createHandoff,
  extendHandoffExpiry,
  touchHandoffOwnerActivity,
  getHandoffRecord,
  getPendingHandoff,
  getPendingHandoffPinUrl,
  handoffUrlForRecord,
  isBrowserHandoffLocked,
  setHandoffLastScan,
  type BrowserHandoffRecord,
} from "./store.js";
import {
  tryCompletePendingHandoffForOwnerSession,
  tryCompletePendingHandoffFromOwnerConfirm,
} from "./ownerHandoffConfirm.js";
import { verifyHandoffToken } from "./token.js";
import { cloudBrowserEnabled, touchCloudBrowser } from "../cloudBrowser.js";
import { heuristicOverlayScan } from "./formCatalog.js";
import { scanCatalogWithLlm } from "./formScan.js";
import { deliverSmsHandoffContinuation } from "./smsContinue.js";
import { checkShareChatRateLimit } from "../shareChat/rateLimit.js";

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function handoffTokenFromRequest(req: Request): { t: string; exp: string } | null {
  const t = readString(req.query.t) || readString((req.body as Record<string, unknown>)?.t);
  const exp = readString(req.query.exp) || readString((req.body as Record<string, unknown>)?.exp);
  if (!t || !exp) return null;
  return { t, exp };
}

function clientIp(req: Request): string {
  const xf = req.headers["x-forwarded-for"];
  if (typeof xf === "string" && xf.trim()) return xf.split(",")[0]!.trim();
  return req.ip || req.socket.remoteAddress || "unknown";
}

function suggestedBoxUser(): string {
  return (process.env.JOSHU_AROZ_USER ?? process.env.JOSHU_OWNER_EMAIL ?? "").trim();
}

function verifyHandoffLink(
  req: Request,
  id: string,
): { ok: true; exp: string; t: string } | { ok: false; status: number; error: string } {
  const tokenParts = handoffTokenFromRequest(req);
  if (!tokenParts) {
    return { ok: false, status: 401, error: "handoff_token_required" };
  }
  const verified = verifyHandoffToken(id, tokenParts.exp, tokenParts.t);
  if (!verified.ok) {
    return { ok: false, status: 401, error: verified.reason };
  }
  return { ok: true, exp: tokenParts.exp, t: tokenParts.t };
}

/** Phone picture: signed link plus the box-password cookie. A desktop login is not enough. */
export function browserHandoffViewerAllowed(req: Request): boolean {
  const id = readString(req.query.handoffId);
  if (!id) return false;
  return verifyHandoffAccess(req, id).ok;
}

function verifyHandoffAccess(
  req: Request,
  id: string,
): { ok: true } | { ok: false; status: number; error: string } {
  const link = verifyHandoffLink(req, id);
  if (!link.ok) return link;
  // SMS token is not enough — owner must type the box password for this handoff.
  return verifyOwnerHandoffSession(req, id, link.exp);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function sendHandoffLoginPage(
  res: Response,
  opts: { handoffId: string; token: string; exp: string; instructions: string; suggestedUser: string },
): void {
  const config = JSON.stringify({
    handoffId: opts.handoffId,
    token: opts.token,
    exp: opts.exp,
    suggestedUser: opts.suggestedUser,
  })
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e");
  const brief = escapeHtml(opts.instructions || "Finish this step in the shared browser.");
  res.setHeader("Cache-Control", "no-store");
  res.type("html").send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, maximum-scale=1" />
  <title>Sign in — Joshu</title>
  <base href="../" />
  <link rel="icon" href="joshu-mark.svg" type="image/svg+xml" />
  <link rel="stylesheet" href="design-system/typography.css" />
  <link rel="stylesheet" href="design-system/tokens.css" />
  <link rel="stylesheet" href="design-system/base.css" />
  <link rel="stylesheet" href="handoff-shell.css" />
</head>
<body class="handoff-gate-body">
  <main class="handoff-gate">
    <img class="handoff-gate-logo" src="joshu-mark.svg" alt="Joshu" width="36" height="36" />
    <h1>Sign in to continue</h1>
    <p class="handoff-gate-brief">${brief}</p>
    <p class="handoff-gate-hint">Enter your Joshu box username and password. A desktop session is not enough for this step.</p>
    <form id="handoff-login-form" class="handoff-gate-form" autocomplete="on">
      <label class="handoff-field">
        <span class="handoff-field-label">Username</span>
        <input id="handoff-user" name="username" type="text" autocomplete="username" required />
      </label>
      <label class="handoff-field">
        <span class="handoff-field-label">Password</span>
        <input id="handoff-pass" name="password" type="password" autocomplete="current-password" required />
      </label>
      <p id="handoff-login-error" class="handoff-gate-error" hidden></p>
      <button type="submit" class="handoff-btn handoff-btn-primary" id="handoff-login-submit">Sign in</button>
    </form>
  </main>
  <script id="handoff-config" type="application/json">${config}</script>
  <script type="module" src="handoff-login.js"></script>
</body>
</html>`);
}

/** Keep Camofox/CDP warm and reset cloud-browser idle while the owner is on handoff. */
async function touchBrowserKeepalive(camofoxSession: CamofoxSessionCoordinator): Promise<void> {
  await camofoxSession.listTabs().catch(() => undefined);
  if (cloudBrowserEnabled()) touchCloudBrowser();
}

type HandoffFieldCacheEntry = {
  pageKey: string;
  fast?: Record<string, unknown>;
  full?: Record<string, unknown>;
};

const handoffFieldCache = new Map<string, HandoffFieldCacheEntry>();

function isHandoffLocatorId(value: string): boolean {
  return /^f\d+-[eb]\d+$/.test(value);
}

function pendingHandoffOrError(
  projectRoot: string,
  id: string,
): { record: ReturnType<typeof getHandoffRecord> } | { error: string; status: number } {
  const record = getHandoffRecord(projectRoot, id);
  if (!record) return { error: "handoff_not_found", status: 404 };
  if (record.status !== "pending") return { error: "handoff_not_pending", status: 409 };
  return { record };
}

export function registerBrowserHandoffRoutes(
  router: Router,
  opts: {
    projectRoot: string;
    camofoxSession: CamofoxSessionCoordinator;
    runner: HermesApiRunner;
  },
): void {
  const { projectRoot, camofoxSession, runner } = opts;

  router.get("/api/browser-handoff/lock", (_req: Request, res: Response) => {
    if (!isDirectLocalhostRequest(_req)) {
      res.status(403).json({ error: "browser-handoff lock is localhost-only" });
      return;
    }
    const lock = isBrowserHandoffLocked(projectRoot);
    res.json({ ok: true, ...lock });
  });

  router.post("/api/browser-handoff/cancel-by-kanban-task", (req: Request, res: Response) => {
    if (!isDirectLocalhostRequest(req)) {
      res.status(403).json({ error: "browser-handoff cancel-by-kanban-task is localhost-only" });
      return;
    }
    const taskId = readString((req.body as Record<string, unknown>)?.task_id ?? (req.body as Record<string, unknown>)?.taskId);
    if (!taskId) {
      res.status(400).json({ error: "task_id is required" });
      return;
    }
    const cancelled = cancelPendingHandoffsForKanbanTask(projectRoot, taskId);
    if (cancelled.length > 0) void resumeBrowserAgent();
    res.json({ ok: true, cancelled: cancelled.map((r) => r.id) });
  });

  router.post("/api/browser-handoff/request", async (req: Request, res: Response) => {
    if (!isDirectLocalhostRequest(req)) {
      res.status(403).json({ error: "browser-handoff request is localhost-only" });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const instructions = readString(body.instructions);
    if (!instructions) {
      res.status(400).json({ error: "instructions is required" });
      return;
    }

    try {
      const tab = await camofoxSession.currentTab();
      if (!tab?.url || tab.url === "about:blank") {
        res.status(409).json({ error: "no_active_browser_tab", message: "Navigate to checkout before requesting handoff." });
        return;
      }

      let observation;
      try {
        observation = await camofoxSession.observe(tab);
      } catch {
        observation = undefined;
      }

      const record = createHandoff(projectRoot, {
        pageUrl: observation?.url ?? tab.url,
        pageTitle: observation?.title ?? tab.title ?? "",
        instructions,
        kanbanTaskId: readString(body.kanbanTaskId) || undefined,
        hermesSessionKey: readString(body.hermesSessionKey) || undefined,
      });
      // Owner has the tab. A running browser-use step must not click under them.
      void pauseBrowserAgent();

      res.json({
        ok: true,
        handoffId: record.id,
        status: record.status,
        url: handoffUrlForRecord(record),
        pageUrl: record.pageUrl,
        pageTitle: record.pageTitle,
        expiresAt: record.expiresAt,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.startsWith("browser_handoff_already_pending:")) {
        const existingId = message.split(":")[1] ?? "";
        res.status(409).json({ error: "browser_handoff_already_pending", handoffId: existingId });
        return;
      }
      res.status(500).json({ error: message });
    }
  });

  router.get("/api/browser-handoff/status/:id", (req: Request, res: Response) => {
    if (!isDirectLocalhostRequest(req)) {
      res.status(403).json({ error: "browser-handoff status is localhost-only" });
      return;
    }
    const id = readString(req.params.id);
    const record = getHandoffRecord(projectRoot, id);
    if (!record) {
      res.status(404).json({ error: "handoff_not_found" });
      return;
    }
    res.json({ ok: true, handoff: record });
  });

  router.post("/api/browser-handoff/:id/cancel", (req: Request, res: Response) => {
    if (!isDirectLocalhostRequest(req)) {
      res.status(403).json({ error: "browser-handoff cancel is localhost-only" });
      return;
    }
    const id = readString(req.params.id);
    const record = cancelHandoff(projectRoot, id);
    void resumeBrowserAgent();
    if (!record) {
      res.status(404).json({ error: "handoff_not_found" });
      return;
    }
    res.json({ ok: true, handoff: record });
  });

  /**
   * Owner confirmed completion via SMS/chat (not the handoff-page button).
   * Localhost-only — Hermes calls this when the owner says they are done.
   */
  router.post("/api/browser-handoff/:id/complete-confirmed", async (req: Request, res: Response) => {
    if (!isDirectLocalhostRequest(req)) {
      res.status(403).json({ error: "browser-handoff complete-confirmed is localhost-only" });
      return;
    }
    const id = readString(req.params.id);
    const existing = getHandoffRecord(projectRoot, id);
    if (!existing) {
      res.status(404).json({ error: "handoff_not_found" });
      return;
    }
    if (existing.status !== "pending") {
      res.status(409).json({ error: "handoff_not_pending", status: existing.status });
      return;
    }
    const record = completeHandoff(projectRoot, id);
    if (!record) {
      res.status(404).json({ error: "handoff_not_found" });
      return;
    }
    void resumeBrowserAgent();
    await touchBrowserKeepalive(camofoxSession);
    res.json({ ok: true, handoff: publicHandoffView(record) });
  });

  /** Complete pending handoff for owner session (SMS preflight / agent helper). */
  router.post("/api/browser-handoff/complete-pending-confirmed", async (req: Request, res: Response) => {
    if (!isDirectLocalhostRequest(req)) {
      res.status(403).json({ error: "browser-handoff complete-pending-confirmed is localhost-only" });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const hermesSessionKey =
      readString(body.hermesSessionKey) || readString(body.hermes_session_key) || undefined;
    const confirmBody = readString(body.body) || readString(body.owner_message);

    let record: BrowserHandoffRecord | null = null;
    if (hermesSessionKey) {
      record = tryCompletePendingHandoffForOwnerSession(projectRoot, hermesSessionKey);
    } else if (confirmBody) {
      record = tryCompletePendingHandoffFromOwnerConfirm(projectRoot, {
        body: confirmBody,
        hermesSessionKey,
      });
    } else {
      res.status(400).json({ error: "hermesSessionKey or owner_message is required" });
      return;
    }
    if (!record) {
      res.status(409).json({ error: "no_matching_pending_handoff" });
      return;
    }
    await touchBrowserKeepalive(camofoxSession);
    res.json({ ok: true, handoff: publicHandoffView(record) });
  });

  router.post("/api/browser-handoff/:id/heartbeat", async (req: Request, res: Response) => {
    const id = readString(req.params.id);
    const access = verifyHandoffAccess(req, id);
    if (!access.ok) {
      res.status(access.status).json({ error: access.error });
      return;
    }
    const record = extendHandoffExpiry(projectRoot, id);
    if (!record) {
      res.status(404).json({ error: "handoff_not_found" });
      return;
    }
    if (record.status !== "pending") {
      res.status(409).json({ error: "handoff_not_pending", status: record.status });
      return;
    }
    await touchBrowserKeepalive(camofoxSession);
    // OAuth popups can drop Playwright tab tracking while Firefox keeps running.
    const tab = await camofoxSession.currentTab().catch(() => undefined);
    if (!tab) {
      const pinUrl = getPendingHandoffPinUrl(projectRoot);
      if (pinUrl) {
        await camofoxSession.ensureTab(pinUrl).catch((err) => {
          console.warn("[browser-handoff] tab recovery failed:", err);
        });
      }
    }
    res.json({ ok: true, handoff: publicHandoffView(record) });
  });

  router.post("/api/browser-handoff/:id/complete", async (req: Request, res: Response) => {
    const id = readString(req.params.id);
    const access = verifyHandoffAccess(req, id);
    if (!access.ok) {
      res.status(access.status).json({ error: access.error });
      return;
    }
    const record = completeHandoff(projectRoot, id);
    if (!record) {
      res.status(404).json({ error: "handoff_not_found" });
      return;
    }
    void resumeBrowserAgent();
    await touchBrowserKeepalive(camofoxSession);
    res.json({ ok: true, handoff: publicHandoffView(record) });
    void deliverSmsHandoffContinuation(projectRoot, record, runner).catch((err) => {
      console.warn("[browser-handoff] SMS continuation error:", err);
    });
  });

  /** Cheap URL + control-shape key for auto-rescan. No LLM, no owner values, no locator stamps. */
  router.get("/api/browser-handoff/:id/page-key", async (req: Request, res: Response) => {
    const id = readString(req.params.id);
    const access = verifyHandoffAccess(req, id);
    if (!access.ok) {
      res.status(access.status).json({ error: access.error });
      return;
    }
    const pending = pendingHandoffOrError(projectRoot, id);
    if ("error" in pending) {
      res.status(pending.status).json({ error: pending.error });
      return;
    }
    try {
      touchHandoffOwnerActivity(projectRoot, id);
      await touchBrowserKeepalive(camofoxSession);
      const signature = await camofoxSession.readFormSignature();
      res.json({ ok: true, pageUrl: signature.url, pageTitle: signature.title, pageKey: signature.key });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(502).json({ error: message });
    }
  });

  /** Scan remote controls (AI labels only). Never includes owner-typed overlay values. */
  router.get("/api/browser-handoff/:id/form-fields", async (req: Request, res: Response) => {
    const id = readString(req.params.id);
    const access = verifyHandoffAccess(req, id);
    if (!access.ok) {
      res.status(access.status).json({ error: access.error });
      return;
    }
    const pending = pendingHandoffOrError(projectRoot, id);
    if ("error" in pending) {
      res.status(pending.status).json({ error: pending.error });
      return;
    }
    try {
      const fast = req.query.fast === "1";
      const signature = await camofoxSession.readFormSignature().catch(() => undefined);
      const pageKey = signature?.key ?? "";
      const cached = handoffFieldCache.get(id);
      if (cached && pageKey && cached.pageKey === pageKey) {
        const hit = fast ? cached.fast : cached.full;
        if (hit) {
          touchHandoffOwnerActivity(projectRoot, id);
          await touchBrowserKeepalive(camofoxSession);
          res.json(hit);
          return;
        }
      }

      const catalog = await camofoxSession.listFormFields();
      const overlay = fast ? heuristicOverlayScan(catalog) : await scanCatalogWithLlm(catalog);
      setHandoffLastScan(projectRoot, id, {
        fieldIds: overlay.fields.map((field) => field.id),
        primaryButtonId: overlay.primaryButtonId,
        scannedAt: new Date().toISOString(),
      });
      touchHandoffOwnerActivity(projectRoot, id);
      await touchBrowserKeepalive(camofoxSession);
      const body = {
        ok: true,
        fields: overlay.fields,
        primaryButtonId: overlay.primaryButtonId,
        primaryButtonLabel: overlay.primaryButtonLabel,
        source: overlay.source,
        pageUrl: signature?.url,
        pageTitle: signature?.title,
        pageKey: signature?.key,
      };
      if (pageKey) {
        const entry = handoffFieldCache.get(id) ?? { pageKey };
        entry.pageKey = pageKey;
        if (fast) entry.fast = body;
        else entry.full = body;
        handoffFieldCache.set(id, entry);
      }
      res.json(body);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(502).json({ error: message });
    }
  });

  /**
   * Fill stamped controls from the overlay. Owner values go Joshu → Camofox only.
   * Do not log req.body — it may contain passwords / OTPs / cards.
   */
  router.post("/api/browser-handoff/:id/fill-form", async (req: Request, res: Response) => {
    const id = readString(req.params.id);
    const access = verifyHandoffAccess(req, id);
    if (!access.ok) {
      res.status(access.status).json({ error: access.error });
      return;
    }
    const pending = pendingHandoffOrError(projectRoot, id);
    if ("error" in pending) {
      res.status(pending.status).json({ error: pending.error });
      return;
    }
    const record = pending.record;
    if (!record) {
      res.status(404).json({ error: "handoff_not_found" });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const rawFields = Array.isArray(body.fields) ? body.fields : [];
    const allowed = new Set(record.lastScan?.fieldIds ?? []);
    const fields: Array<{ id: string; value: string | boolean }> = [];
    for (const row of rawFields) {
      if (!row || typeof row !== "object") continue;
      const rec = row as Record<string, unknown>;
      const fieldId = readString(rec.id);
      if (!isHandoffLocatorId(fieldId)) continue;
      if (allowed.size > 0 && !allowed.has(fieldId)) continue;
      if (typeof rec.value === "boolean") {
        fields.push({ id: fieldId, value: rec.value });
        continue;
      }
      if (typeof rec.value === "string" && rec.value.length > 0) {
        fields.push({ id: fieldId, value: rec.value });
      }
    }
    const clickPrimary = body.clickPrimary === true;
    const fromScan = record.lastScan?.primaryButtonId ?? null;
    const buttonId =
      clickPrimary && fromScan && isHandoffLocatorId(fromScan) ? fromScan : null;
    if (fields.length === 0 && !buttonId) {
      res.status(400).json({ error: "nothing_to_fill" });
      return;
    }
    try {
      const result = await camofoxSession.fillForm({ fields, buttonId });
      touchHandoffOwnerActivity(projectRoot, id);
      await touchBrowserKeepalive(camofoxSession);
      res.json({
        ok: result.ok,
        filled: result.filled,
        missing: result.missing,
        clicked: result.clicked,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(502).json({ error: message });
    }
  });

  /** Step-up: box username/password, even if the owner already has an ArozOS desktop session. */
  router.post("/api/browser-handoff/:id/login", async (req: Request, res: Response) => {
    const id = readString(req.params.id);
    const link = verifyHandoffLink(req, id);
    if (!link.ok) {
      res.status(link.status).json({ error: link.error });
      return;
    }
    const record = getHandoffRecord(projectRoot, id);
    if (!record || record.status !== "pending") {
      res.status(404).json({ error: "handoff_not_found" });
      return;
    }
    const rate = checkShareChatRateLimit(`handoff-login:${clientIp(req)}`, {
      limit: 8,
      windowMs: 15 * 60 * 1000,
    });
    if (!rate.allowed) {
      res.status(429).json({ error: "rate_limited" });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const username = readString(body.username);
    const password = typeof body.password === "string" ? body.password : "";
    const result = await verifyArozosPassword(username, password);
    if (result === "unavailable") {
      res.status(502).json({ error: "box_login_unavailable" });
      return;
    }
    if (result !== "ok") {
      res.status(401).json({ error: "invalid_credentials" });
      return;
    }
    setHandoffAuthCookie(req, res, id, Number.parseInt(link.exp, 10), Date.parse(record.expiresAt));
    res.json({ ok: true });
  });

  router.get("/handoff/:id", (req: Request, res: Response) => {
    const id = readString(req.params.id);
    const link = verifyHandoffLink(req, id);
    if (!link.ok) {
      res.status(link.status).type("text/plain").send(`Handoff link invalid or expired (${link.error}).`);
      return;
    }
    const record = getHandoffRecord(projectRoot, id);
    if (!record) {
      res.status(404).type("text/plain").send("Handoff not found.");
      return;
    }
    if (record.status !== "pending") {
      res.status(409).type("text/plain").send(`Handoff is ${record.status}.`);
      return;
    }

    const session = verifyOwnerHandoffSession(req, id, link.exp);
    if (!session.ok) {
      sendHandoffLoginPage(res, {
        handoffId: record.id,
        token: link.t,
        exp: link.exp,
        instructions: record.instructions,
        suggestedUser: suggestedBoxUser(),
      });
      return;
    }

    const config = JSON.stringify({
      handoffId: record.id,
      token: link.t,
      exp: link.exp,
      instructions: record.instructions,
      pageUrl: record.pageUrl,
      pageTitle: record.pageTitle,
      expiresAt: record.expiresAt,
    })
      .replace(/</g, "\\u003c")
      .replace(/>/g, "\\u003e");

    res.setHeader("Cache-Control", "no-store");
    res.type("html").send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, maximum-scale=1" />
  <title>Joshu browser handoff</title>
  <base href="../" />
  <link rel="icon" href="joshu-mark.svg" type="image/svg+xml" />
  <link rel="stylesheet" href="design-system/typography.css" />
  <link rel="stylesheet" href="design-system/tokens.css" />
  <link rel="stylesheet" href="design-system/base.css" />
  <link rel="stylesheet" href="handoff-shell.css" />
</head>
<body>
  <div id="handoff-root"></div>
  <script id="handoff-config" type="application/json">${config}</script>
  <script type="module" src="handoff.js?v=ui-browser-22"></script>
</body>
</html>`);
  });
}

export { browserHandoffLockStub, getPendingHandoffPinUrl };
