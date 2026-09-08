import type { Request } from "express";

function isLoopbackIp(ip: string): boolean {
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

/**
 * True only for direct loopback clients (cron, instance-agent, docker-internal curl).
 *
 * Plain `req.ip === 127.0.0.1` is **not** enough on VPS: Caddy reverse-proxies to
 * :8788, so every public request looks local. Reject when proxy headers are present
 * and require Host to be loopback / localhost.
 */
export function isDirectLocalhostRequest(req: Request): boolean {
  if (
    req.headers["x-forwarded-for"] ||
    req.headers["x-forwarded-host"] ||
    req.headers["x-real-ip"]
  ) {
    return false;
  }

  const remote = req.socket.remoteAddress ?? "";
  const ip = req.ip ?? "";
  if (!isLoopbackIp(remote) && !isLoopbackIp(ip)) return false;

  const hostHeader = (req.headers.host ?? "").toLowerCase();
  const host = hostHeader.split(":")[0] ?? "";
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

/**
 * Browser desktop APIs (files, CWM) must stay reachable via public Host through Caddy.
 * Gate: same-origin Sec-Fetch-Site + Cookie present (ArozOS login), or direct localhost.
 *
 * This blocks anonymous internet probes. It is **not** full ArozOS session validation —
 * a forged Cookie + Sec-Fetch-Site still passes. Follow-up: verify ArozOS session server-side.
 */
export function isDesktopBrowserOrLocalRequest(req: Request): boolean {
  if (isDirectLocalhostRequest(req)) return true;

  const customer = (process.env.CUSTOMER_DOMAIN ?? "").trim().toLowerCase();
  const host = (req.headers.host ?? "").toLowerCase().split(":")[0] ?? "";
  if (!customer || host !== customer) return false;

  const site = String(req.headers["sec-fetch-site"] ?? "")
    .trim()
    .toLowerCase();
  if (site !== "same-origin" && site !== "same-site") return false;

  const cookie = String(req.headers.cookie ?? "").trim();
  return cookie.length >= 8;
}
