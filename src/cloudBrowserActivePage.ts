/**
 * Active page of the Browser Use live view (terms: openspec/glossary.md).
 *
 * Browser Use changes the active page only on CDP `Target.activateTarget`. It
 * does not change the active page when a page opens or closes. This module
 * keeps one browser WebSocket open for the session and sets the active page:
 * a new page with an opener (a sign-in popup) becomes the active page, and when
 * the active page closes, its opener (else the newest open page) becomes the
 * active page. Spec: shared-browser (change live-view-follow-popup).
 *
 * The module does not touch the idle timer of the cloud browser.
 */
import { cloudBrowserWebSocketUrl } from "./cloudBrowser.js";

type TargetInfo = { targetId?: string; type?: string; openerId?: string };

type CdpMessage = {
  id?: number;
  method?: string;
  params?: { targetInfo?: TargetInfo; targetId?: string };
  result?: { targetInfos?: TargetInfo[] };
};

type ActivePageOptions = {
  /** Wait before a new connect after the WebSocket closes. */
  reconnectDelayMs?: number;
  /** Connects in a row that can fail before the module waits for the next session. */
  maxReconnects?: number;
};

const GET_TARGETS_ID = 1;

class ActivePageFollower {
  private socket: WebSocket | null = null;
  private stopped = false;
  private failures = 0;
  private nextId = GET_TARGETS_ID;
  private timer: NodeJS.Timeout | null = null;
  private activePageId = "";
  private readonly openerOf = new Map<string, string>();
  /** Target ids of open pages. New pages go to the end, so the last entry is the newest page. */
  private openOrder: string[] = [];
  private readonly reconnectDelayMs: number;
  private readonly maxReconnects: number;

  constructor(
    private readonly cdpUrl: string,
    opts: ActivePageOptions,
  ) {
    this.reconnectDelayMs = opts.reconnectDelayMs ?? 2_000;
    this.maxReconnects = opts.maxReconnects ?? 5;
  }

  start(): void {
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.socket?.close();
    this.socket = null;
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    let url = "";
    try {
      url = await cloudBrowserWebSocketUrl(this.cdpUrl);
    } catch {
      url = "";
    }
    if (this.stopped) return;
    if (!url) {
      this.scheduleReconnect();
      return;
    }
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.addEventListener("open", () => {
      this.failures = 0;
      this.activePageId = "";
      this.openerOf.clear();
      this.openOrder = [];
      // Read the open pages first. Then the replayed targetCreated events of
      // setDiscoverTargets do not count as new pages.
      this.nextId = GET_TARGETS_ID;
      socket.send(JSON.stringify({ id: GET_TARGETS_ID, method: "Target.getTargets" }));
    });
    socket.addEventListener("message", (event) => this.onMessage(String(event.data)));
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.failures += 1;
    if (this.failures > this.maxReconnects) {
      console.warn(`[cloud-browser] active page: no CDP connection after ${this.maxReconnects} tries`);
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.connect();
    }, this.reconnectDelayMs);
    this.timer.unref?.();
  }

  private send(method: string, params: Record<string, unknown> = {}): void {
    this.nextId += 1;
    this.socket?.send(JSON.stringify({ id: this.nextId, method, params }));
  }

  private onMessage(raw: string): void {
    let message: CdpMessage;
    try {
      message = JSON.parse(raw) as CdpMessage;
    } catch {
      return;
    }
    if (message.id === GET_TARGETS_ID) {
      const pages = (message.result?.targetInfos ?? []).filter((info) => info.type === "page" && info.targetId);
      for (const info of pages) {
        this.openOrder.push(info.targetId!);
        if (info.openerId) this.openerOf.set(info.targetId!, info.openerId);
      }
      this.activePageId = this.openOrder[0] ?? "";
      this.send("Target.setDiscoverTargets", { discover: true });
      return;
    }
    switch (message.method) {
      case "Target.targetCreated":
        this.onPageCreated(message.params?.targetInfo);
        return;
      case "Target.targetDestroyed":
        this.onPageDestroyed(message.params?.targetId ?? "");
        return;
      case "BrowserUse.activeTargetChanged":
        if (message.params?.targetId) this.activePageId = message.params.targetId;
        return;
      default:
        return;
    }
  }

  private onPageCreated(info: TargetInfo | undefined): void {
    const id = info?.targetId ?? "";
    if (!id || info?.type !== "page" || this.openOrder.includes(id)) return;
    this.openOrder.push(id);
    if (!info.openerId) return;
    this.openerOf.set(id, info.openerId);
    this.activate(id);
  }

  private onPageDestroyed(id: string): void {
    if (!this.openOrder.includes(id)) return;
    this.openOrder = this.openOrder.filter((openId) => openId !== id);
    const opener = this.openerOf.get(id);
    this.openerOf.delete(id);
    if (id !== this.activePageId) return;
    this.activePageId = "";
    const next = opener && this.openOrder.includes(opener) ? opener : this.openOrder.at(-1);
    if (next) this.activate(next);
  }

  private activate(id: string): void {
    this.activePageId = id;
    console.log(`[cloud-browser] active page ${id}`);
    this.send("Target.activateTarget", { targetId: id });
  }
}

let follower: ActivePageFollower | null = null;

/** Follow the pages of a new Browser Use Cloud session. Stops the follower of the previous session. */
export function startCloudBrowserActivePage(cdpUrl: string, opts: ActivePageOptions = {}): void {
  stopCloudBrowserActivePage();
  follower = new ActivePageFollower(cdpUrl, opts);
  follower.start();
}

export function stopCloudBrowserActivePage(): void {
  follower?.stop();
  follower = null;
}

/** Test hook: is a follower running? */
export function cloudBrowserActivePageRunning(): boolean {
  return follower !== null;
}
