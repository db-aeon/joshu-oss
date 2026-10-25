/**
 * Admin desktop login (openspec change admin-desktop-login).
 *
 * The control plane sends the signed instance agent command `desktop_login`.
 * The agent asks this route for a one-time code, and the control plane sends
 * the admin to `https://<box>/system/auth/joshu-login?code=…`. The ArozOS
 * handler of that page redeems the code here and signs the browser in as the
 * box owner for one hour. The owner password and the sessions of the owner do
 * not change.
 *
 * Both routes take only direct localhost requests: the agent and ArozOS run on
 * the box. A code works one time, only within CODE_TTL_MS, and only for the
 * owner user (`JOSHU_AROZ_USER`). Codes live in memory only.
 */
import { createHash, randomBytes } from "node:crypto";
import type { Request, Response, Router } from "express";
import { isDirectLocalhostRequest } from "./httpLocalhost.js";

export const DESKTOP_LOGIN_PATH = "/system/auth/joshu-login";
const CODE_TTL_MS = 2 * 60_000;

type PendingLogin = { username: string; adminEmail: string; expiresAt: number };

export class DesktopLoginCodes {
  /** Key: sha256 of the code, so the code itself is not kept. */
  private readonly pending = new Map<string, PendingLogin>();

  constructor(private readonly now: () => number = Date.now) {}

  private static key(code: string): string {
    return createHash("sha256").update(code).digest("hex");
  }

  private prune(): void {
    const now = this.now();
    for (const [key, login] of this.pending) {
      if (login.expiresAt <= now) this.pending.delete(key);
    }
  }

  issue(username: string, adminEmail: string): { code: string; expiresAt: number } {
    this.prune();
    const code = randomBytes(32).toString("base64url");
    const expiresAt = this.now() + CODE_TTL_MS;
    this.pending.set(DesktopLoginCodes.key(code), { username, adminEmail, expiresAt });
    return { code, expiresAt };
  }

  /** The login of the code, or null. A code works one time. */
  redeem(code: string): PendingLogin | null {
    this.prune();
    if (!code) return null;
    const key = DesktopLoginCodes.key(code);
    const login = this.pending.get(key);
    if (!login) return null;
    this.pending.delete(key);
    return login;
  }
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * POST /api/desktop-login/code   Body: { adminEmail } → { ok, url, expiresAt }
 * POST /api/desktop-login/redeem Body: { code } → { ok, username }
 */
export function registerDesktopLoginRoutes(
  router: Router,
  opts: { ownerUser: () => string; boxHost: () => string; codes?: DesktopLoginCodes },
): DesktopLoginCodes {
  const codes = opts.codes ?? new DesktopLoginCodes();

  router.post("/api/desktop-login/code", (req: Request, res: Response) => {
    if (!isDirectLocalhostRequest(req)) {
      res.status(403).json({ ok: false, error: "desktop-login is localhost-only" });
      return;
    }
    const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
    const adminEmail = readString(body.adminEmail) || "unknown admin";
    const ownerUser = opts.ownerUser().trim();
    const host = opts.boxHost().trim();
    if (!ownerUser || !host) {
      res.status(503).json({ ok: false, error: "JOSHU_AROZ_USER or CUSTOMER_DOMAIN is not set" });
      return;
    }
    const { code, expiresAt } = codes.issue(ownerUser, adminEmail);
    console.info(
      `[desktop-login] one-time login code made for ${adminEmail}, user ${ownerUser}, valid until ${new Date(expiresAt).toISOString()}`,
    );
    res.json({
      ok: true,
      url: `https://${host}${DESKTOP_LOGIN_PATH}?code=${encodeURIComponent(code)}`,
      expiresAt: new Date(expiresAt).toISOString(),
    });
  });

  router.post("/api/desktop-login/redeem", (req: Request, res: Response) => {
    if (!isDirectLocalhostRequest(req)) {
      res.status(403).json({ ok: false, error: "desktop-login is localhost-only" });
      return;
    }
    const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
    const login = codes.redeem(readString(body.code));
    if (!login) {
      console.warn("[desktop-login] a login code was refused (unknown, used, or expired)");
      res.status(401).json({ ok: false, error: "invalid_or_expired" });
      return;
    }
    console.info(`[desktop-login] ${login.adminEmail} signed in to the desktop as ${login.username} (one hour)`);
    res.json({ ok: true, username: login.username });
  });

  return codes;
}
