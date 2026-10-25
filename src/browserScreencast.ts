/**
 * Page.startScreencast for the shared Chromium tab, plus CDP input for handoff.
 * Xvfb stays so Chromium has a screen. jWeb reads the page over CDP, not from the X screen.
 */
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer } from "ws";
import { normalizedPointToCss } from "./browserScreencastCoords.js";
import { viewportForBox } from "./browserViewport.js";

type CdpSocket = WebSocket;

type FrameMeta = {
  deviceWidth: number;
  deviceHeight: number;
  offsetTop?: number;
  offsetLeft?: number;
  pageScaleFactor?: number;
};

type ScreencastOpts = {
  cdpHttpUrl: string;
  inputAllowed: () => boolean;
};

type ClientMsg = {
  type?: string;
  phase?: string;
  nx?: number;
  ny?: number;
  button?: number;
  deltaX?: number;
  deltaY?: number;
  key?: string;
  code?: string;
  text?: string;
  width?: number;
  height?: number;
};

export class BrowserScreencastHub {
  private readonly cdpHttpUrl: string;
  private readonly inputAllowed: () => boolean;
  private readonly wss = new WebSocketServer({ noServer: true });
  private cdp: CdpSocket | null = null;
  private nextId = 1;
  private stopped = false;
  private pageId = "";
  private lastMeta: FrameMeta = { deviceWidth: 0, deviceHeight: 0 };
  private lastFrameAt = 0;
  private lastPayload = "";
  private attachedAt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private viewport = { width: 1024, height: 768 };
  private readonly pendingCdp = new Map<number, (result: { windowId?: number }) => void>();

  constructor(opts: ScreencastOpts) {
    this.cdpHttpUrl = opts.cdpHttpUrl.replace(/\/+$/, "");
    this.inputAllowed = opts.inputAllowed;
    this.wss.on("connection", (socket) => {
      if (this.lastPayload && socket.readyState === WebSocket.OPEN) socket.send(this.lastPayload);
      socket.on("message", (raw) => {
        this.onClientMessage(socket, raw.toString());
      });
    });
    void this.ensurePage();
    setInterval(() => {
      void this.ensurePage();
    }, 2000);
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.wss.emit("connection", ws, req);
    });
    return true;
  }

  private sendCdp(method: string, params: Record<string, unknown> = {}): number {
    const id = this.nextId++;
    this.cdp?.send(JSON.stringify({ id, method, params }));
    return id;
  }

  private async ensurePage(): Promise<void> {
    if (this.stopped) return;
    try {
      const listRes = await fetch(`${this.cdpHttpUrl}/json/list`, { signal: AbortSignal.timeout(4000) });
      if (!listRes.ok) throw new Error(`json/list ${listRes.status}`);
      const list = (await listRes.json()) as Array<{ id?: string; type?: string; url?: string; webSocketDebuggerUrl?: string }>;
      const pages = list.filter(
        (target) => target.type === "page" && target.webSocketDebuggerUrl && !String(target.url || "").startsWith("chrome://"),
      );
      const page = pages[pages.length - 1];
      if (!page?.webSocketDebuggerUrl) throw new Error("no page target");
      const same = this.cdp && this.pageId === page.id && this.cdp.readyState !== WebSocket.CLOSED;
      const stale =
        this.attachedAt > 0 &&
        Date.now() - this.attachedAt > 8000 &&
        (this.lastFrameAt === 0 || Date.now() - this.lastFrameAt > 8000);
      if (same && !stale) return;
      this.attach(page.id || "", page.webSocketDebuggerUrl);
    } catch (err) {
      console.warn("[screencast] waiting for CDP:", err instanceof Error ? err.message : err);
      this.scheduleReconnect();
    }
  }

  private attach(pageId: string, wsUrl: string): void {
    this.cdp?.close();
    this.pageId = pageId;
    const socket = new WebSocket(wsUrl);
    this.cdp = socket;
    socket.on("open", () => {
      this.attachedAt = Date.now();
      console.log(`[screencast] attached ${pageId}`);
      this.startScreencast();
    });
    socket.on("message", (raw) => this.onCdpMessage(raw.toString()));
    socket.on("close", () => {
      if (this.cdp !== socket) return;
      this.cdp = null;
      this.scheduleReconnect();
    });
    socket.on("error", () => socket.close());
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.ensurePage();
    }, 1500);
  }

  private onCdpMessage(raw: string): void {
    let msg: {
      method?: string;
      params?: {
        data?: string;
        sessionId?: number;
        metadata?: FrameMeta;
      };
    };
    try {
      msg = JSON.parse(raw) as typeof msg;
    } catch {
      return;
    }
    const anyMsg = msg as { id?: number; error?: unknown; method?: string; result?: { windowId?: number } };
    if (anyMsg.id && this.pendingCdp.has(anyMsg.id)) {
      const done = this.pendingCdp.get(anyMsg.id);
      this.pendingCdp.delete(anyMsg.id);
      if (!anyMsg.error && done) done(anyMsg.result ?? {});
    }
    if (anyMsg.error) {
      console.warn(`[screencast] cdp error ${JSON.stringify(anyMsg.error)}`);
    }
    if (msg.method && msg.method !== "Page.screencastFrame" && msg.method !== "Page.screencastVisibilityChanged") {
      console.log(`[screencast] cdp ${msg.method} ${JSON.stringify(msg.params ?? {}).slice(0, 180)}`);
    }
    if (msg.method !== "Page.screencastFrame" || !msg.params?.data) return;
    if (typeof msg.params.sessionId === "number") {
      this.sendCdp("Page.screencastFrameAck", { sessionId: msg.params.sessionId });
    }
    const metadata = msg.params.metadata ?? { deviceWidth: 0, deviceHeight: 0 };
    if (metadata.deviceWidth > 0 && metadata.deviceHeight > 0) this.lastMeta = metadata;
    if (this.lastFrameAt === 0) {
      console.log(`[screencast] first frame ${metadata.deviceWidth}x${metadata.deviceHeight}`);
    }
    this.lastFrameAt = Date.now();
    const payload = JSON.stringify({ type: "frame", data: msg.params.data, metadata: this.lastMeta });
    this.lastPayload = payload;
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(payload);
    }
  }

  private onClientMessage(socket: WebSocket, raw: string): void {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(raw) as ClientMsg;
    } catch {
      return;
    }
    if (msg.type === "viewport") {
      this.applyViewerBox(Number(msg.width), Number(msg.height));
      return;
    }
    if (!this.inputAllowed()) {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "rejected" }));
      return;
    }
    if (!this.cdp || this.cdp.readyState !== WebSocket.OPEN) return;
    if (msg.type === "pointer" || msg.type === "wheel") {
      const point = normalizedPointToCss(
        Number(msg.nx),
        Number(msg.ny),
        this.lastMeta.deviceWidth,
        this.lastMeta.deviceHeight,
      );
      if (!point) return;
      if (msg.type === "wheel") {
        this.sendCdp("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: point.x,
          y: point.y,
          deltaX: Number(msg.deltaX) || 0,
          deltaY: Number(msg.deltaY) || 0,
        });
        return;
      }
      const phase = msg.phase === "up" ? "mouseReleased" : msg.phase === "move" ? "mouseMoved" : "mousePressed";
      this.sendCdp("Input.dispatchMouseEvent", {
        type: phase,
        x: point.x,
        y: point.y,
        button: msg.button === 2 ? "right" : "left",
        clickCount: phase === "mousePressed" ? 1 : 0,
      });
      return;
    }
    if (msg.type === "key") {
      const down = msg.phase !== "up";
      this.sendCdp("Input.dispatchKeyEvent", {
        type: down ? (msg.text ? "keyDown" : "rawKeyDown") : "keyUp",
        key: msg.key || "",
        code: msg.code || "",
        text: down ? msg.text || "" : "",
        windowsVirtualKeyCode: msg.key === "Enter" ? 13 : msg.key === "Backspace" ? 8 : 0,
      });
    }
  }

  /** Match the shared page to the viewer's shape without growing the pixel budget. */
  private applyViewerBox(boxWidth: number, boxHeight: number): void {
    const next = viewportForBox(boxWidth, boxHeight);
    if (!next || !this.cdp || this.cdp.readyState !== WebSocket.OPEN) return;
    const prevRatio = this.viewport.width / this.viewport.height;
    const nextRatio = next.width / next.height;
    if (Math.abs(prevRatio - nextRatio) < 0.06 && Math.abs(this.viewport.width - next.width) < 48) return;
    this.viewport = next;
    console.log(`[screencast] viewport ${next.width}x${next.height} for viewer ${Math.round(boxWidth)}x${Math.round(boxHeight)}`);
    this.sendCdp("Emulation.setDeviceMetricsOverride", {
      width: next.width,
      height: next.height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const requestId = this.sendCdp("Browser.getWindowForTarget", { targetId: this.pageId });
    this.pendingCdp.set(requestId, (result) => {
      if (!result.windowId) return;
      this.sendCdp("Browser.setWindowBounds", {
        windowId: result.windowId,
        bounds: {
          left: 0,
          top: 0,
          width: next.width,
          height: next.height,
          windowState: "normal",
        },
      });
    });
    this.startScreencast();
  }

  private startScreencast(): void {
    this.sendCdp("Page.startScreencast", {
      format: "jpeg",
      quality: 55,
      maxWidth: this.viewport.width,
      maxHeight: this.viewport.height,
      everyNthFrame: 1,
    });
  }
}

export function screencastWsPath(publicBasePath: string): string {
  const base = publicBasePath.replace(/\/+$/, "");
  return `${base}/api/browser/screencast`;
}
