/**
 * Outbound HTTP proxy URL from repo PROXY_* vars (same as Camofox / Decodo).
 * Override with HTTPS_PROXY or MS_GRAPH_PROXY_URL.
 */

function envTrim(name: string): string {
  return process.env[name]?.trim() || "";
}

function explicitProxyUrl(): string | undefined {
  const url = envTrim("MS_GRAPH_PROXY_URL") || envTrim("HTTPS_PROXY") || envTrim("HTTP_PROXY");
  return url || undefined;
}

function proxyHost(): string | undefined {
  return envTrim("PROXY_BACKCONNECT_HOST") || envTrim("PROXY_HOST") || undefined;
}

/** All proxy ports from PROXY_PORTS range/list, or a single backconnect/port. Empty = no proxy. */
export function listProxyPorts(): number[] {
  if (explicitProxyUrl()) return [0];

  const host = proxyHost();
  if (!host) return [];

  const backconnectPort = envTrim("PROXY_BACKCONNECT_PORT");
  if (backconnectPort) return [Number(backconnectPort)];

  const single = envTrim("PROXY_PORT");
  if (single) return [Number(single)];

  const ports = envTrim("PROXY_PORTS");
  if (!ports) return [8080];

  if (ports.includes("-")) {
    const [rawLo, rawHi] = ports.split("-", 2);
    const lo = Number(rawLo);
    const hi = Number(rawHi);
    if (Number.isFinite(lo) && Number.isFinite(hi)) {
      const min = Math.min(lo, hi);
      const max = Math.max(lo, hi);
      return Array.from({ length: max - min + 1 }, (_, i) => min + i);
    }
  }

  return ports
    .split(",")
    .map((p) => Number(p.trim()))
    .filter((p) => Number.isFinite(p));
}

/** Pick a proxy port for parallel worker `workerId` (round-robin across pool). */
export function proxyPortForWorker(workerId: number): number | undefined {
  const ports = listProxyPorts();
  if (ports.length === 0) return undefined;
  return ports[workerId % ports.length]!;
}

/** Build http://[user:pass@]host:port for Node fetch (undici ProxyAgent). */
export function resolveOutboundProxyUrlForPort(port: number): string | undefined {
  if (port === 0) return explicitProxyUrl();

  const host = proxyHost();
  if (!host) return explicitProxyUrl();

  const user = envTrim("PROXY_USERNAME");
  const pass = envTrim("PROXY_PASSWORD");
  const auth =
    user.length > 0
      ? `${encodeURIComponent(user)}:${encodeURIComponent(pass)}@`
      : "";
  return `http://${auth}${host}:${port}`;
}

/** Random port from pool (single-request fallback). */
export function resolveOutboundProxyUrl(): string | undefined {
  const ports = listProxyPorts();
  if (ports.length === 0) return undefined;
  const port = ports[Math.floor(Math.random() * ports.length)]!;
  return resolveOutboundProxyUrlForPort(port);
}

/** Redact credentials for logs. */
export function redactProxyUrl(url: string): string {
  return url.replace(/\/\/([^:@/]+):([^@/]+)@/, "//***:***@");
}
