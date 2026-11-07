/**
 * Images and videos through the content router (change content-router, design decision D7).
 * `POST /api/router/media` is the endpoint of the Hermes plugin `joshu-media`: it calls the content
 * router with capability `image.generate` or `video.generate` (provider endpoint `auto`, or the one
 * that a hint names), waits for the result, saves the file on the Desktop of the owner, and returns
 * the path. The box holds no fal.ai key for this: the content router reaches fal.ai and takes the
 * cost from the usage wallet.
 */

import type { Request, Response, Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import net from "node:net";
import { verifyArozosDesktopSession } from "../httpLocalhost.js";
import { resolveReportRoots } from "../research/store.js";
import { boxRouterClient, RouterError, type RouterClient, type RouterUnavailable } from "./client.js";

export type MediaKind = "image" | "video";

export const MEDIA_CAPABILITY: Record<MediaKind, string> = { image: "image.generate", video: "video.generate" };

/** A video can take minutes; an image takes seconds. */
export const MEDIA_TIMEOUT_MS: Record<MediaKind, number> = { image: 3 * 60_000, video: 10 * 60_000 };
const MAX_BYTES: Record<MediaKind, number> = { image: 25 * 1024 * 1024, video: 200 * 1024 * 1024 };

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
};

export type MediaRequest = {
  kind: MediaKind;
  prompt: string;
  /** A provider endpoint id that a hint names, for example a Seedance endpoint. Default: `auto`. */
  endpoint?: string;
  /** Inputs of the provider endpoint besides the prompt, for example `aspect_ratio` or `duration`. */
  options?: Record<string, unknown>;
};

export type MediaResult =
  | { ok: true; path: string; desktopPath: string; url: string; endpoint: string; channel: string; costUsd: number }
  | { ok: false; status: number; error: string; kind?: string };

export type MediaDeps = {
  client: RouterClient | null;
  unavailable?: RouterUnavailable;
  /** The Desktop of the owner. */
  desktopRoot: string | null;
  fetchImpl?: typeof fetch;
  /** The IP addresses of a host name. Tests pass a fake. Default: the DNS of the box. */
  lookup?: (host: string) => Promise<string[]>;
  now?: () => Date;
};

/** The most redirects that a download follows; the box checks the host of each one. */
const MAX_REDIRECTS = 3;

function ipv4Private(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number) as [number, number];
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

/** True for a loopback, private, link-local, shared, multicast, or unspecified address. */
export function privateAddress(ip: string): boolean {
  const kind = net.isIP(ip);
  if (kind === 4) return ipv4Private(ip);
  if (kind !== 6) return true;
  const v = ip.toLowerCase();
  const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return ipv4Private(mapped[1]!);
  return v === "::" || v === "::1" || /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || /^ff/.test(v) || v.startsWith("::ffff:");
}

async function defaultLookup(host: string): Promise<string[]> {
  return (await dnsLookup(host, { all: true })).map((a) => a.address);
}

/**
 * Check a link before the download: https only, and a host whose addresses are all public, so a
 * reply cannot make the box fetch from itself or from the private network. Returns an error text.
 */
export async function checkDownloadUrl(raw: string, lookup: (host: string) => Promise<string[]> = defaultLookup): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "the link is not valid";
  }
  if (url.protocol !== "https:") return "the link is not https";
  if (url.username || url.password) return "the link has a user name";
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return `the host ${host} is not public`;
  let addresses: string[];
  try {
    addresses = net.isIP(host) ? [host] : await lookup(host);
  } catch {
    return `the host ${host} has no address`;
  }
  if (!addresses.length || addresses.some(privateAddress)) return `the host ${host} is not public`;
  return null;
}

/**
 * Download a file with the checks of `checkDownloadUrl` on the link and on each redirect, and a
 * byte limit on the header and on the stream. Returns the bytes and the media type, or an error text.
 */
export async function downloadMedia(
  first: string,
  maxBytes: number,
  deadline: number,
  fetchImpl: typeof fetch = fetch,
  lookup?: (host: string) => Promise<string[]>,
): Promise<{ bytes: Buffer; type: string } | { error: string }> {
  let url = first;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const bad = await checkDownloadUrl(url, lookup);
    if (bad) return { error: bad };
    const res = await fetchImpl(url, { redirect: "manual", signal: AbortSignal.timeout(Math.max(10_000, deadline - Date.now())) });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      await res.body?.cancel().catch(() => undefined);
      if (!location) return { error: `redirect ${res.status} has no location` };
      url = new URL(location, url).toString();
      continue;
    }
    if (!res.ok) return { error: `the download answered ${res.status}` };
    const declared = Number(res.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > maxBytes) {
      await res.body?.cancel().catch(() => undefined);
      return { error: "the file is too large" };
    }
    const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (!res.body) return { error: "the file is empty" };
    const chunks: Buffer[] = [];
    let total = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { error: "the file is too large" };
      }
      chunks.push(Buffer.from(value));
    }
    return { bytes: Buffer.concat(chunks), type };
  }
  return { error: "too many redirects" };
}

/** The URL of the file in a fal reply: `images[0].url`, `image.url`, or `video.url`. */
export function mediaUrlOf(body: unknown, kind: MediaKind): string {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const urlOf = (v: unknown) => (v && typeof v === "object" && typeof (v as { url?: unknown }).url === "string" ? (v as { url: string }).url : "");
  if (kind === "video") return urlOf(b.video) || (Array.isArray(b.videos) ? urlOf(b.videos[0]) : "");
  return (Array.isArray(b.images) ? urlOf(b.images[0]) : "") || urlOf(b.image);
}

/** The request of a body of `POST /api/router/media`, or an error text. */
export function parseMediaRequest(raw: unknown): MediaRequest | string {
  const b = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const kind = b.kind === "image" || b.kind === "video" ? b.kind : null;
  if (!kind) return "kind must be image or video";
  const prompt = typeof b.prompt === "string" ? b.prompt.trim() : "";
  if (!prompt) return "prompt is required";
  const endpoint = typeof b.endpoint === "string" && b.endpoint.trim() && b.endpoint.trim() !== "auto" ? b.endpoint.trim() : undefined;
  const options = b.options && typeof b.options === "object" && !Array.isArray(b.options) ? (b.options as Record<string, unknown>) : {};
  return { kind, prompt, ...(endpoint ? { endpoint } : {}), options };
}

function stamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
}

/** Make one image or video and save it on the Desktop. Never throws. */
export async function makeMedia(request: MediaRequest, deps: MediaDeps): Promise<MediaResult> {
  if (!deps.client) {
    return { ok: false, status: 503, error: `the content router is not set up on this box (${deps.unavailable ?? "content router off"})` };
  }
  if (!deps.desktopRoot) return { ok: false, status: 500, error: "the box has no owner Desktop" };
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = MEDIA_TIMEOUT_MS[request.kind];
  const deadline = Date.now() + timeoutMs;
  // A provider endpoint that a hint names must be one that the router catalog lists for this
  // capability, so that a request cannot reach any other paid endpoint.
  if (request.endpoint) {
    const detail = await deps.client.endpoint(request.endpoint, deadline).catch(() => null);
    if (!detail || !detail.capabilities?.includes(MEDIA_CAPABILITY[request.kind])) {
      return { ok: false, status: 400, error: `${request.endpoint} is not a provider endpoint of ${MEDIA_CAPABILITY[request.kind]} in the router catalog`, kind: "unknown endpoint" };
    }
  }
  let reply;
  try {
    reply = await deps.client.call(
      {
        endpoint: request.endpoint ?? "auto",
        capability: MEDIA_CAPABILITY[request.kind],
        params: { ...request.options, prompt: request.prompt },
      },
      deadline,
      { timeoutMs },
    );
  } catch (err) {
    if (err instanceof RouterError) {
      const status = err.kind === "usage wallet empty" ? 402 : err.kind === "unknown endpoint" ? 404 : err.kind === "rate limited" ? 429 : 502;
      return { ok: false, status, error: err.message, kind: err.kind };
    }
    return { ok: false, status: 502, error: (err as Error).message };
  }
  const url = mediaUrlOf(reply.body, request.kind);
  if (!url) return { ok: false, status: 502, error: `the reply of ${reply.endpoint} has no ${request.kind} link` };

  let downloaded: Awaited<ReturnType<typeof downloadMedia>>;
  try {
    downloaded = await downloadMedia(url, MAX_BYTES[request.kind], deadline, fetchImpl, deps.lookup);
  } catch (err) {
    return { ok: false, status: 502, error: `the ${request.kind} download failed: ${(err as Error).message}` };
  }
  if ("error" in downloaded) return { ok: false, status: 502, error: `the ${request.kind} download failed: ${downloaded.error}` };
  const { bytes, type } = downloaded;
  if (!bytes.length) return { ok: false, status: 502, error: `the ${request.kind} file is empty` };
  const fromUrl = url.split("?")[0]!.toLowerCase().match(/\.(png|jpe?g|webp|gif|mp4|webm|mov)$/)?.[1]?.replace("jpeg", "jpg");
  const ext = EXTENSIONS[type] ?? fromUrl ?? (request.kind === "image" ? "png" : "mp4");
  const name = `${request.kind}-${stamp((deps.now ?? (() => new Date()))())}-${randomBytes(3).toString("hex")}.${ext}`;
  const file = path.join(deps.desktopRoot, name);
  fs.mkdirSync(deps.desktopRoot, { recursive: true });
  fs.writeFileSync(file, bytes);
  return { ok: true, path: file, desktopPath: name, url, endpoint: reply.endpoint, channel: reply.channel, costUsd: reply.cost_usd };
}

export type RouterMediaRouteDeps = {
  projectRoot: string;
  /** Tests only. */
  media?: (request: MediaRequest) => Promise<MediaResult>;
  allowRequest?: (req: Request) => boolean | Promise<boolean>;
};

/** `POST /api/router/media`: the desktop session of the owner or direct localhost (the Hermes plugin). */
export function registerRouterMediaRoutes(router: Router, deps: RouterMediaRouteDeps): void {
  const allowed = deps.allowRequest ?? verifyArozosDesktopSession;
  router.post("/api/router/media", async (req: Request, res: Response) => {
    if (!(await allowed(req))) {
      res.status(403).json({ ok: false, error: "forbidden" });
      return;
    }
    const request = parseMediaRequest(req.body);
    if (typeof request === "string") {
      res.status(400).json({ ok: false, error: request });
      return;
    }
    const make =
      deps.media ??
      ((r: MediaRequest) => {
        const box = boxRouterClient(deps.projectRoot);
        return makeMedia(r, {
          client: box.client,
          ...(box.client ? {} : { unavailable: box.reason }),
          desktopRoot: resolveReportRoots(deps.projectRoot)?.desktopRoot ?? null,
        });
      });
    const result = await make(request);
    if (!result.ok) {
      res.status(result.status).json({ ok: false, error: result.error, ...(result.kind ? { kind: result.kind } : {}) });
      return;
    }
    res.json(result);
  });
}
