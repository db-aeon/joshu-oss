/**
 * Shared browser hosted by Browser Use Cloud.
 * The box asks the control plane with its instance-agent token.
 * cdpUrl stays in this process (Playwright, Hermes, the sidecar).
 * liveUrl is only returned from the gated live-frame route.
 */
import { cloudBrowserEnabled as isCloudBrowserBackend } from "./browserBackend.js";
import { provisionEnvTrim } from "./provisionInstanceEnv.js";
import { instanceAgentBearerToken } from "./meteredProviders/config.js";
import { stopCloudBrowserActivePage } from "./cloudBrowserActivePage.js";

/** Standard 4:3 landscape — matches the local Chromium screencast. */
export const CLOUD_BROWSER_SCREEN = { width: 1024, height: 768 };
const RENEW_BEFORE_MS = 10 * 60 * 1000;
const DEFAULT_CLOUD_IDLE_MS = 300_000;
/** A session that answered a CDP probe this recently is trusted without re-probing. */
const LIVE_PROBE_TTL_MS = 30_000;
const LIVE_PROBE_TIMEOUT_MS = 3_000;

type CloudSession = {
  browserId: string;
  cdpUrl: string;
  liveUrl: string;
  timeoutAt: number;
};

/** Why Joshu stopped the Browser Use Cloud session. */
export type CloudBrowserStopReason = "idle" | "shutdown" | "orphan";

type Lifecycle = {
  idleMs: number;
  busy: () => boolean;
  onCdp: (cdpUrl: string) => Promise<void>;
  /** Called after Joshu stopped a session that was up. */
  onStop?: (reason: CloudBrowserStopReason) => void;
};

/** What the companion learns on its next browser_* call after an idle stop. */
export type CloudBrowserRestartNotice = {
  stoppedAt: string;
  idleMinutes: number;
  message: string;
};

/** A restart notice older than this is dropped: no plan of the companion still needs the old page. */
const RESTART_NOTICE_MAX_AGE_MS = 6 * 60 * 60 * 1000;

let session: CloudSession | null = null;
let lastTouch = 0;
let lastHermesBrowserActivity = 0;
/** When `session.cdpUrl` last answered /json/version (0 = never / unknown). */
let lastLiveProbeAt = 0;
/** Concurrent browser_* calls share one probe/ensure round trip. */
let liveEnsureInFlight: Promise<CloudSession> | null = null;
let chain: Promise<unknown> = Promise.resolve();
let lifecycle: Lifecycle | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let restartNotice: CloudBrowserRestartNotice | null = null;

function buildRestartNotice(stoppedAtMs: number, idleMs: number): CloudBrowserRestartNotice {
  const stoppedAt = new Date(stoppedAtMs).toISOString();
  const idleMinutes = Math.max(1, Math.round(idleMs / 60_000));
  return {
    stoppedAt,
    idleMinutes,
    message:
      `Joshu stopped the shared browser at ${stoppedAt} after ${idleMinutes} minutes with no activity, ` +
      "to save cost, and started a new browser for this call. The open tabs, carts, and half-filled forms " +
      "from before are gone; saved logins usually survive. The website did not cause this. If you were in " +
      "the middle of a checkout or a form, tell the owner plainly that Joshu's browser timed out, and stage " +
      "the page again. Call this tool again to continue.",
  };
}

/**
 * Returns the restart notice of the last idle stop once, then clears it.
 * The browser ensure route hands it to the next Hermes browser_* call.
 */
export function takeCloudBrowserRestartNotice(nowMs = Date.now()): CloudBrowserRestartNotice | null {
  const notice = restartNotice;
  restartNotice = null;
  if (!notice) return null;
  if (nowMs - Date.parse(notice.stoppedAt) > RESTART_NOTICE_MAX_AGE_MS) return null;
  return notice;
}

export function cloudBrowserEnabled(projectRoot = process.cwd()): boolean {
  return isCloudBrowserBackend(projectRoot);
}

/** Idle shutdown for Browser Use Cloud (separate from local BROWSER_IDLE_TIMEOUT_MS). */
export function cloudBrowserIdleTimeoutMs(): number {
  const raw = provisionEnvTrim("CLOUD_BROWSER_IDLE_TIMEOUT_MS") || process.env.CLOUD_BROWSER_IDLE_TIMEOUT_MS?.trim() || "";
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  const legacy = provisionEnvTrim("BROWSER_IDLE_TIMEOUT_MS") || process.env.BROWSER_IDLE_TIMEOUT_MS?.trim() || "";
  if (legacy) {
    const parsed = Number(legacy);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return DEFAULT_CLOUD_IDLE_MS;
}

/** True when Browser Use Cloud could be provisioned (control plane + instance agent token). */
export function cloudBrowserConfigured(): boolean {
  const base = controlPlaneBase();
  const token = bearer();
  return Boolean(base && token);
}

function controlPlaneBase(): string {
  return (provisionEnvTrim("CONTROL_PLANE_URL") || process.env.CONTROL_PLANE_URL || "").replace(/\/+$/, "");
}

function bearer(): string | null {
  try {
    return instanceAgentBearerToken();
  } catch {
    return null;
  }
}

export function touchCloudBrowser(): void {
  lastTouch = Date.now();
}

/** Hermes browser_* tool activity — keeps cloud session alive while workers drive the page. */
export function noteHermesBrowserActivity(): void {
  lastHermesBrowserActivity = Date.now();
  touchCloudBrowser();
}

export function hermesBrowserActivityRecent(withinMs: number): boolean {
  return lastHermesBrowserActivity > 0 && Date.now() - lastHermesBrowserActivity < withinMs;
}

export function cloudBrowserSessionActive(): boolean {
  return session !== null;
}

/** Stable id for the Browser Use session — use this to decide when to reload the live iframe. */
export function cloudBrowserId(): string {
  return session?.browserId || "";
}

/** Ignore one-shot page loads (ArozOS window restore). Require a second poll ~8s later. */
let liveFrameStreak = 0;
let lastLiveFramePollAt = 0;

export function noteLiveFramePoll(): { shouldEnsure: boolean } {
  const now = Date.now();
  if (lastLiveFramePollAt > 0 && now - lastLiveFramePollAt > 60_000) liveFrameStreak = 0;
  liveFrameStreak += 1;
  lastLiveFramePollAt = now;
  return { shouldEnsure: liveFrameStreak >= 2 };
}

export function cloudCdpUrl(): string {
  return session?.cdpUrl || "";
}

/** Viewer URL with the Browser Use toolbar hidden. Empty when no session is up. */
/**
 * Browser Use live view URL. With `browserChrome`, Browser Use shows its own
 * tab strip, back/forward/reload, and address bar (`ui=true`), so the owner
 * sees and switches every tab of the shared browser (jWeb on the desktop).
 * Without it, only the page shows (`ui=false`; the phone handoff page).
 */
export function cloudLiveFrameUrl(opts: { browserChrome?: boolean } = {}): string {
  if (!session?.liveUrl) return "";
  try {
    const url = new URL(session.liveUrl);
    url.searchParams.set("ui", opts.browserChrome ? "true" : "false");
    return url.toString();
  } catch {
    return "";
  }
}

function parseSessionBody(body: {
  browserId?: string;
  cdpUrl?: string;
  liveUrl?: string;
  timeoutAt?: string;
}): CloudSession {
  if (!body.browserId || !body.cdpUrl || !body.liveUrl) {
    throw new Error("cloud browser response incomplete");
  }
  const timeoutAt = Date.parse(body.timeoutAt || "");
  return {
    browserId: body.browserId,
    cdpUrl: body.cdpUrl,
    liveUrl: body.liveUrl,
    timeoutAt: Number.isFinite(timeoutAt) ? timeoutAt : Date.now() + 4 * 60 * 60 * 1000,
  };
}

async function cpFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const base = controlPlaneBase();
  const token = bearer();
  if (!base || !token) throw new Error("cloud browser is not configured");
  return fetch(`${base}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
  });
}

/** Read active Browser Use session from control plane (GET). */
export async function readCloudBrowserFromCp(): Promise<CloudSession | null> {
  if (!cloudBrowserConfigured()) return null;
  const res = await cpFetch("/api/instances/browser-use/browsers", {
    method: "GET",
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error || `cloud browser read ${res.status}`);
  }
  const body = (await res.json()) as {
    browserId?: string;
    cdpUrl?: string;
    liveUrl?: string;
    timeoutAt?: string;
  };
  return parseSessionBody(body);
}

async function postAction(action: "ensure" | "stop"): Promise<CloudSession | null> {
  const res = await cpFetch("/api/instances/browser-use/browsers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action }),
    signal: AbortSignal.timeout(45_000),
  });
  if (action === "stop") {
    if (!res.ok) throw new Error(`cloud browser stop ${res.status}`);
    return null;
  }
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error || `cloud browser ensure ${res.status}`);
  }
  const body = (await res.json()) as {
    browserId?: string;
    cdpUrl?: string;
    liveUrl?: string;
    timeoutAt?: string;
  };
  return parseSessionBody(body);
}

async function hydrateSession(next: CloudSession): Promise<void> {
  const changed = session?.cdpUrl !== next.cdpUrl;
  session = next;
  // The control plane just verified (or created) this browser.
  lastLiveProbeAt = Date.now();
  if (changed && lifecycle) await lifecycle.onCdp(next.cdpUrl);
  if (changed) console.log(`[cloud-browser] session ${next.browserId}`);
}

async function ensureOnce(): Promise<CloudSession> {
  touchCloudBrowser();
  const next = await postAction("ensure");
  if (!next) throw new Error("cloud browser ensure returned nothing");
  await hydrateSession(next);
  return next;
}

export function ensureCloudBrowser(): Promise<CloudSession> {
  const run = chain.then(ensureOnce, ensureOnce);
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function stopOnce(reason: CloudBrowserStopReason): Promise<void> {
  stopCloudBrowserActivePage();
  if (!cloudBrowserConfigured()) {
    session = null;
    lastTouch = 0;
    return;
  }
  const idleForMs = lastTouch > 0 ? Date.now() - lastTouch : 0;
  const remote = session ? session : await readCloudBrowserFromCp().catch(() => null);
  const wasUp = Boolean(remote || session);
  if (wasUp) {
    await postAction("stop");
    console.log(`[cloud-browser] stopped (${reason})`);
  }
  session = null;
  lastTouch = 0;
  if (!wasUp) return;
  // Only an idle stop loses pages that a companion may still count on; a
  // shutdown ends the companion turns too, and an orphan had no owner on this process.
  if (reason === "idle") restartNotice = buildRestartNotice(Date.now(), idleForMs);
  try {
    lifecycle?.onStop?.(reason);
  } catch (err) {
    console.warn("[cloud-browser] onStop:", (err as Error).message);
  }
}

/** Does the CDP discovery endpoint still answer? Browser Use returns 502 once a browser is gone. */
async function cdpEndpointAlive(cdpUrl: string): Promise<boolean> {
  const base = cdpUrl.replace(/^ws(s?):\/\//i, "http$1://").replace(/\/+$/, "");
  try {
    const res = await fetch(`${base}/json/version`, {
      signal: AbortSignal.timeout(LIVE_PROBE_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureLiveOnce(): Promise<CloudSession> {
  const current = session;
  if (current && current.timeoutAt > Date.now()) {
    if (Date.now() - lastLiveProbeAt < LIVE_PROBE_TTL_MS) return current;
    if (await cdpEndpointAlive(current.cdpUrl)) {
      lastLiveProbeAt = Date.now();
      return current;
    }
    console.warn(`[cloud-browser] session ${current.browserId} not answering CDP — re-ensuring`);
  }
  // Idle stop, Browser Use timeout, or restart: the control plane checks the
  // remote browser and recreates it on the same profile (logins survive).
  if (session === current) {
    session = null;
    lastLiveProbeAt = 0;
  }
  return ensureCloudBrowser();
}

/**
 * Wake-or-reuse for Hermes browser_* tools: returns a session whose CDP
 * endpoint is known to answer, provisioning a new one when the old browser
 * idled out or died. Always counts as Hermes browser activity.
 */
export function ensureLiveCloudBrowser(): Promise<CloudSession> {
  noteHermesBrowserActivity();
  if (!liveEnsureInFlight) {
    liveEnsureInFlight = ensureLiveOnce().finally(() => {
      liveEnsureInFlight = null;
    });
  }
  return liveEnsureInFlight;
}

export async function stopCloudBrowser(reason: CloudBrowserStopReason): Promise<void> {
  const stop = () => stopOnce(reason);
  const run = chain.then(stop, stop);
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  await run;
}

/**
 * Sync in-memory state with control plane — kills orphan browsers after restart
 * when nothing is busy (handoff, sidecar, recent Hermes browser tools).
 */
export async function reconcileCloudBrowserState(): Promise<void> {
  if (!lifecycle || !cloudBrowserConfigured()) return;
  const remote = await readCloudBrowserFromCp().catch((err) => {
    console.warn("[cloud-browser] reconcile read failed:", (err as Error).message);
    return null;
  });
  if (!remote) {
    session = null;
    return;
  }
  if (lifecycle.busy()) {
    await hydrateSession(remote);
    if (lastTouch === 0) touchCloudBrowser();
    return;
  }
  console.log(`[cloud-browser] reconcile stopping orphan session ${remote.browserId}`);
  await stopOnce("orphan");
}

/** Browser WebSocket URL from `<cdp URL>/json/version`. Empty when the browser gives none. */
export async function cloudBrowserWebSocketUrl(cdpUrl: string): Promise<string> {
  const base = cdpUrl.replace(/\/$/, "");
  const version = (await fetch(`${base}/json/version`).then((res) => res.json())) as {
    webSocketDebuggerUrl?: string;
  };
  return version.webSocketDebuggerUrl ?? "";
}

/** Stretch the window to the screen so the live view has no empty band. */
export async function fillCloudBrowserWindow(cdpUrl: string): Promise<void> {
  const base = cdpUrl.replace(/\/$/, "");
  const browserWsUrl = await cloudBrowserWebSocketUrl(cdpUrl);
  const list = (await fetch(`${base}/json/list`).then((res) => res.json())) as Array<{
    id?: string;
    type?: string;
    webSocketDebuggerUrl?: string;
  }>;
  const page = list.find((target) => target.type === "page" && target.id);
  if (!browserWsUrl || !page?.id) return;
  const socket = new WebSocket(browserWsUrl);
  let nextId = 0;
  const send = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => reject(new Error(`cdp timeout ${method}`)), 8_000);
      const onMessage = (event: MessageEvent) => {
        const message = JSON.parse(String(event.data)) as {
          id?: number;
          result?: Record<string, unknown>;
          error?: { message?: string };
        };
        if (message.id !== id) return;
        clearTimeout(timer);
        socket.removeEventListener("message", onMessage);
        if (message.error) reject(new Error(message.error.message || method));
        else resolve(message.result ?? {});
      };
      socket.addEventListener("message", onMessage);
      socket.send(JSON.stringify({ id, method, params }));
    });
  await new Promise<void>((resolve) => socket.addEventListener("open", () => resolve()));
  try {
    const win = (await send("Browser.getWindowForTarget", { targetId: page.id })) as {
      windowId?: number;
    };
    if (!win.windowId) return;
    await send("Browser.setWindowBounds", {
      windowId: win.windowId,
      bounds: {
        left: 0,
        top: 0,
        width: CLOUD_BROWSER_SCREEN.width,
        height: CLOUD_BROWSER_SCREEN.height,
        windowState: "normal",
      },
    });
  } finally {
    socket.close();
  }
}

export function startCloudBrowserLifecycle(opts: Lifecycle): void {
  lifecycle = opts;
  void reconcileCloudBrowserState().catch((err) => {
    console.warn("[cloud-browser] startup reconcile:", (err as Error).message);
  });
  if (timer) return;
  timer = setInterval(() => {
    void tick().catch((err) => {
      console.warn("[cloud-browser]", err instanceof Error ? err.message : err);
    });
  }, 30_000);
  timer.unref?.();
}

async function tick(): Promise<void> {
  if (!lifecycle) return;
  if (!session) {
    await reconcileCloudBrowserState();
    return;
  }
  const idleMs = lifecycle.idleMs;
  const idle = idleMs > 0 && lastTouch > 0 && Date.now() - lastTouch >= idleMs;
  if (idle && !lifecycle.busy()) {
    await stopCloudBrowser("idle");
    return;
  }
  if (session.timeoutAt - Date.now() < RENEW_BEFORE_MS) {
    await ensureCloudBrowser();
  }
}

/** Test hook — run one lifecycle tick now. */
export function runCloudBrowserTickForTests(): Promise<void> {
  return tick();
}

/** Test hook — make the next ensureLiveCloudBrowser() re-probe the CDP endpoint. */
export function expireCloudBrowserProbeForTests(): void {
  lastLiveProbeAt = 0;
}

/** Test hook — reset module state. */
export function resetCloudBrowserStateForTests(): void {
  session = null;
  lastTouch = 0;
  lastHermesBrowserActivity = 0;
  lastLiveProbeAt = 0;
  liveEnsureInFlight = null;
  restartNotice = null;
  chain = Promise.resolve();
  lifecycle = null;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
