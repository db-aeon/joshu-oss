/**
 * Reverse-proxy Hermes Agent web dashboard under Joshu (e.g. /joshu/hermes-admin).
 * @see https://hermes-agent.nousresearch.com/docs/user-guide/features/web-dashboard
 */
import type { NextFunction, Request, Response } from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

function envTrim(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback;
}

export function isHermesDashboardEnabled(): boolean {
  return /^(1|true|yes)$/i.test(envTrim("JOSHU_HERMES_DASHBOARD_ENABLED", "true"));
}

/** VPS default: Caddy serves Hermes dashboard on its own hostname at :9119 root (no Joshu subpath proxy). */
export function isHermesDashboardDirectExposure(): boolean {
  const explicit = envTrim("JOSHU_HERMES_DASHBOARD_DIRECT");
  if (/^(0|false|no)$/i.test(explicit)) return false;
  if (/^(1|true|yes)$/i.test(explicit)) return true;
  return Boolean(envTrim("CUSTOMER_DOMAIN"));
}

export function hermesDashboardDirectHostname(): string | undefined {
  const explicit = envTrim("HERMES_DASHBOARD_DOMAIN");
  if (explicit) return explicit;
  const customer = envTrim("CUSTOMER_DOMAIN");
  if (!customer) return undefined;
  return `hermes-admin.${customer}`;
}

export function hermesDashboardTarget(): string {
  const host = envTrim("HERMES_DASHBOARD_HOST", "127.0.0.1");
  const port = envTrim("HERMES_DASHBOARD_PORT", "9119");
  return `http://${host}:${port}`;
}

/** Path segment only, e.g. /hermes-admin */
export function hermesDashboardPathSegment(): string {
  const raw = envTrim("JOSHU_HERMES_DASHBOARD_PATH", "/hermes-admin");
  const normalized = (raw.startsWith("/") ? raw : `/${raw}`).replace(/\/+$/, "");
  return normalized || "/hermes-admin";
}

export function hermesDashboardProxyPath(publicBasePath: string): string {
  const segment = hermesDashboardPathSegment();
  if (!publicBasePath) return segment;
  const base = publicBasePath.replace(/\/+$/, "");
  if (segment === base || segment.startsWith(`${base}/`)) return segment;
  return `${base}${segment}`.replace(/\/+$/, "") || "/";
}

export function hermesDashboardPublicUrl(publicBasePath: string): string | undefined {
  const explicit = envTrim("HERMES_DASHBOARD_PUBLIC_URL");
  if (explicit) return explicit;
  if (isHermesDashboardDirectExposure()) {
    const host = hermesDashboardDirectHostname();
    if (host) return `https://${host}`;
  }
  const domain = envTrim("CUSTOMER_DOMAIN");
  if (!domain) return undefined;
  const proxyPath = hermesDashboardProxyPath(publicBasePath);
  return `https://${domain}${proxyPath.startsWith("/") ? proxyPath : `/${proxyPath}`}`;
}

export async function probeHermesDashboardHealth(): Promise<{ ok: boolean; enabled: boolean }> {
  if (!isHermesDashboardEnabled()) return { ok: true, enabled: false };
  try {
    const res = await fetch(`${hermesDashboardTarget()}/api/status`, { signal: AbortSignal.timeout(5_000) });
    return { ok: res.ok, enabled: true };
  } catch {
    return { ok: false, enabled: true };
  }
}

function dashboardBasicAuthMiddleware(user: string, password: string) {
  const expected = Buffer.from(`${user}:${password}`, "utf8").toString("base64");
  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization ?? "";
    if (header === `Basic ${expected}`) {
      next();
      return;
    }
    res.setHeader("WWW-Authenticate", 'Basic realm="Hermes Admin"');
    res.status(401).send("Authentication required");
  };
}

export type HermesDashboardProxy = ReturnType<typeof createProxyMiddleware> & {
  upgrade?: (req: unknown, socket: unknown, head: unknown) => void;
};

export function buildHermesDashboardProxy(options: {
  proxyPath: string;
  publicBasePath: string;
}): { proxy: HermesDashboardProxy | undefined; authConfigured: boolean } {
  if (!isHermesDashboardEnabled()) {
    return { proxy: undefined, authConfigured: false };
  }

  const user = envTrim("JOSHU_HERMES_DASHBOARD_USER", "admin");
  const password = envTrim("JOSHU_HERMES_DASHBOARD_PASSWORD");
  const allowInsecure = /^(1|true|yes)$/i.test(envTrim("JOSHU_HERMES_DASHBOARD_ALLOW_INSECURE"));
  const authConfigured = Boolean(password);

  const normalizedProxyPath =
    (options.proxyPath.startsWith("/") ? options.proxyPath : `/${options.proxyPath}`).replace(/\/+$/, "") ||
    "/hermes-admin";
  const normalizedPublicPath = options.publicBasePath
    ? `${options.publicBasePath.replace(/\/+$/, "")}${hermesDashboardPathSegment()}`.replace(/\/+$/, "")
    : normalizedProxyPath;

  const pathRewrite: Record<string, string> = {
    [`^${escapeRegExp(normalizedProxyPath)}`]: "",
  };
  if (normalizedPublicPath !== normalizedProxyPath) {
    pathRewrite[`^${escapeRegExp(normalizedPublicPath)}`] = "";
  }

  const forwardedPrefix = normalizedPublicPath || normalizedProxyPath;

  const proxy = createProxyMiddleware({
    target: hermesDashboardTarget(),
    changeOrigin: true,
    // ws: false — do not subscribe to server "upgrade" with pathFilter '/'. WebSocket upgrades
    // are handled manually in server.ts (handleHermesDashboardUpgrade) at the full /joshu/hermes-admin path.
    ws: false,
    pathRewrite,
    on: {
      // Hermes rewrites index.html asset URLs when this header is set (web_server.py).
      proxyReq: (proxyReq) => {
        proxyReq.setHeader("X-Forwarded-Prefix", forwardedPrefix);
      },
    },
  }) as HermesDashboardProxy;

  return { proxy, authConfigured: authConfigured || allowInsecure };
}

export function registerHermesDashboardRoutes(
  router: import("express").Router,
  options: { proxyPath: string; publicBasePath: string },
): HermesDashboardProxy | undefined {
  const user = envTrim("JOSHU_HERMES_DASHBOARD_USER", "admin");
  const password = envTrim("JOSHU_HERMES_DASHBOARD_PASSWORD");
  const allowInsecure = /^(1|true|yes)$/i.test(envTrim("JOSHU_HERMES_DASHBOARD_ALLOW_INSECURE"));
  const direct = isHermesDashboardDirectExposure();
  const normalizedProxyPath =
    (options.proxyPath.startsWith("/") ? options.proxyPath : `/${options.proxyPath}`).replace(/\/+$/, "") ||
    "/hermes-admin";

  router.get("/api/hermes-dashboard/status", async (_req: Request, res: Response) => {
    const probe = await probeHermesDashboardHealth();
    res.json({
      enabled: probe.enabled,
      ok: probe.ok,
      directExposure: direct,
      urlPath: direct ? "/" : normalizedProxyPath,
      publicUrl: hermesDashboardPublicUrl(options.publicBasePath) ?? null,
      authRequired: Boolean(password) && !allowInsecure,
    });
  });

  if (direct) {
    if (!password && envTrim("CUSTOMER_DOMAIN")) {
      console.warn(
        "[joshu] Hermes dashboard direct mode: set JOSHU_HERMES_DASHBOARD_PASSWORD for Caddy basic auth on the admin hostname",
      );
    }
    return undefined;
  }

  const { proxy } = buildHermesDashboardProxy(options);
  if (!proxy) return undefined;

  const stack: Array<import("express").RequestHandler> = [];
  if (password && !allowInsecure) {
    stack.push(dashboardBasicAuthMiddleware(user, password));
  }
  stack.push(proxy);

  router.use(normalizedProxyPath, ...stack);

  if (!password && envTrim("CUSTOMER_DOMAIN")) {
    console.warn(
      "[joshu] Hermes dashboard is enabled but JOSHU_HERMES_DASHBOARD_PASSWORD is unset — set a password in instance.env",
    );
  }

  return proxy;
}

export function hermesDashboardUpgradePrefixes(proxyPath: string, publicBasePath: string): string[] {
  const prefixes = new Set<string>();
  const normalized = (proxyPath.startsWith("/") ? proxyPath : `/${proxyPath}`).replace(/\/+$/, "") || "/hermes-admin";
  prefixes.add(normalized);
  if (publicBasePath) {
    const withBase = `${publicBasePath.replace(/\/+$/, "")}${hermesDashboardPathSegment()}`.replace(/\/+$/, "");
    if (withBase) prefixes.add(withBase);
  }
  return [...prefixes].sort((a, b) => b.length - a.length);
}

export function handleHermesDashboardUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  proxy: HermesDashboardProxy | undefined,
  prefixes: string[],
): boolean {
  if (!proxy?.upgrade) return false;
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  for (const prefix of prefixes) {
    if (url.pathname === prefix || url.pathname.startsWith(`${prefix}/`)) {
      const rest = url.pathname.slice(prefix.length) || "/";
      req.url = (rest.startsWith("/") ? rest : `/${rest}`) + url.search;
      delete req.headers["sec-websocket-extensions"];
      proxy.upgrade(req, socket, head);
      return true;
    }
  }
  return false;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
