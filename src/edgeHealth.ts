/**
 * The edge check of GET /api/instance/health: can a request from the internet reach the box?
 *
 * On a Compose host, Caddy serves the box domain with TLS on port 443. In single-container
 * mode (change single-container-mode), Caddy serves plain HTTP on port 8080 inside the stack
 * container, and cloudflared connects the box to a Cloudflare Tunnel, so the check probes
 * port 8080 and the ready endpoint of cloudflared instead of port 443.
 */

/** Plain HTTP port of Caddy in single-container mode (deploy/scripts/render-caddyfile.sh). */
export const SINGLE_CONTAINER_EDGE_PORT = 8080;
/** Metrics server of cloudflared (deploy/scripts/vps-start.sh, JOSHU_TUNNEL_METRICS_PORT). */
export const DEFAULT_TUNNEL_METRICS_PORT = 20241;

export interface EdgeCheckPlan {
  /** False when the box serves no edge, so the edge never fails health. */
  expected: boolean;
  /** Loopback port that must accept a TCP connection. */
  tcpPort: number;
  /** URL that must answer 200 when a Cloudflare Tunnel is configured. */
  tunnelReadyUrl: string | null;
}

/** `read` returns the trimmed value of a variable, or "" when it is unset. */
export function edgeCheckPlan(read: (name: string) => string): EdgeCheckPlan {
  if (read("JOSHU_DATA_ROOT")) {
    const metricsPort = Number(read("JOSHU_TUNNEL_METRICS_PORT")) || DEFAULT_TUNNEL_METRICS_PORT;
    return {
      expected: true,
      tcpPort: SINGLE_CONTAINER_EDGE_PORT,
      tunnelReadyUrl: read("CLOUDFLARE_TUNNEL_TOKEN") ? `http://127.0.0.1:${metricsPort}/ready` : null,
    };
  }
  return { expected: Boolean(read("CUSTOMER_DOMAIN")), tcpPort: 443, tunnelReadyUrl: null };
}

export interface EdgeProbes {
  tcp: (port: number) => Promise<boolean>;
  /** True when the URL answers with status 200. */
  http200: (url: string) => Promise<boolean>;
}

export async function probeEdge(plan: EdgeCheckPlan, probes: EdgeProbes): Promise<boolean> {
  if (!plan.expected) return true;
  const [portOk, tunnelOk] = await Promise.all([
    probes.tcp(plan.tcpPort),
    plan.tunnelReadyUrl ? probes.http200(plan.tunnelReadyUrl) : Promise.resolve(true),
  ]);
  return portOk && tunnelOk;
}
