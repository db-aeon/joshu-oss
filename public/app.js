import { connectScreencast } from "./screencast-client.js";
import { mountCloudLiveFrame } from "./cloud-live-frame.js?v=ui-browser-22";
import { attachVncClipboard } from "./vnc-clipboard.js";
import { configureNovncRfb, loadNovncRfb, preferVncLocalGestures } from "./vnc-client.js";
import { attachVncLocalGestures } from "./vnc-gestures.js";
import { attachVncScrollBridge } from "./vnc-scroll.js";
import { attachJChatBubble } from "./jchat-bubble.js";

const $ = (sel) => document.querySelector(sel);

function readMaxWidthPx(root = document.documentElement) {
  const raw = getComputedStyle(root).getPropertyValue("--joshu-vnc-max-width").trim();
  if (!raw || raw === "none") return Infinity;
  const probe = document.createElement("div");
  probe.style.cssText = "position:absolute;visibility:hidden;pointer-events:none";
  probe.style.width = raw;
  root.appendChild(probe);
  const px = probe.getBoundingClientRect().width;
  probe.remove();
  return px > 0 ? px : Infinity;
}

function layoutLetterboxedScreen(hostEl, screenEl, { width: fbW, height: fbH, maxWidthPx = Infinity } = {}) {
  if (!hostEl || !screenEl || !(fbW > 0 && fbH > 0)) return null;
  const rect = hostEl.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return null;
  const aspect = fbW / fbH;
  let w = Math.min(rect.width, maxWidthPx);
  let h = rect.height;
  if (w / h > aspect) w = h * aspect;
  else h = w / aspect;
  w = Math.max(1, Math.floor(w));
  h = Math.max(1, Math.floor(h));
  const px = `${w}px`;
  const py = `${h}px`;
  screenEl.style.flex = `0 0 ${px}`;
  screenEl.style.width = px;
  screenEl.style.height = py;
  screenEl.style.maxWidth = px;
  screenEl.style.maxHeight = py;
  return { width: w, height: h, aspect: w / h };
}

const STORAGE_KEY = "joshu-hitl-camofox-state";
const DEBUG_VNC = new URLSearchParams(window.location.search).get("debugVnc") === "1";
const CAMOFOX_FRAMEBUFFER = { width: 1024, height: 768 };

const els = {
  status: $("#status"),
  restartCamofox: $("#restart-camofox"),
  vncFrame: $("#vnc-frame"),
  vncScreen: $("#vnc-screen"),
  vncDebug: $("#vnc-debug"),
  vncStatus: $("#vnc-status"),
  vncIndicator: $("#vnc-indicator"),
  chromeVncLabel: $("#chrome-vnc-label"),
  chromeVncStatus: $("#chrome-vnc-status"),
  reloadVnc: $("#reload-vnc"),
  openVnc: $("#open-vnc"),
  vncPasteRemote: $("#vnc-paste-remote"),
  vncCopyRemote: $("#vnc-copy-remote"),
  vncClipboardText: $("#vnc-clipboard-text"),
  vncClipboardHint: $("#vnc-clipboard-hint"),
  sessionPill: $("#session-pill"),
  forgetSession: $("#forget-session"),
  initialUrl: $("#initial-url"),
  urlForm: $("#url-form"),
  urlBar: $("#url-bar"),
  urlGo: $("#url-go"),
  settingsModal: $("#settings-modal"),
  openSettings: $("#open-settings"),
  closeSettings: $("#close-settings"),
};

const state = {
  sessionId: null,
  RFB: null,
  rfb: null,
  intentionalRfbDisconnect: null,
  novnc: null,
  vncClipboardDetach: null,
  vncScrollDetach: null,
  vncGestureDetach: null,
  vncReconnectAfter: 0,
  vncAutoConnectDone: false,
  cloudFrame: null,
  urlBarEditing: false,
  urlBarDirty: false,
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

function setVncStatus(label, cls = "") {
  const line = label ? `VNC: ${label}` : "VNC: disconnected";
  const short = label || "off";
  els.vncStatus.textContent = line;
  if (els.vncIndicator) {
    els.vncIndicator.className = `vnc-indicator ${cls}`.trim();
  }
  if (els.chromeVncLabel) {
    els.chromeVncLabel.textContent = short;
  }
  if (els.chromeVncStatus) {
    els.chromeVncStatus.title = line;
    els.chromeVncStatus.setAttribute("aria-label", line);
  }
}

function setUrlBar(url, { force = false } = {}) {
  if (!els.urlBar) return;
  if (!force && (state.urlBarEditing || state.urlBarDirty)) return;
  els.urlBar.value = url || "";
}

function openSettingsModal() {
  if (!els.settingsModal) return;
  els.settingsModal.hidden = false;
  document.body.classList.add("modal-open");
  els.closeSettings?.focus();
}

function closeSettingsModal() {
  if (!els.settingsModal) return;
  els.settingsModal.hidden = true;
  document.body.classList.remove("modal-open");
  els.openSettings?.focus();
}

function persistState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    sessionId: state.sessionId,
  }));
}

function loadPersistedState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (typeof saved.sessionId === "string") state.sessionId = saved.sessionId;
  } catch {
    localStorage.removeItem(STORAGE_KEY);
  }
}

function setSession(id) {
  state.sessionId = id || null;
  persistState();
  els.sessionPill.textContent = id ? `Session ${id.slice(0, 8)}…` : "No Hermes session";
  els.sessionPill.classList.toggle("has-session", Boolean(id));
}

function buildWebsocketUrl(pathOrUrl) {
  if (/^wss?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  const base = document.baseURI || window.location.href;
  try {
    const u = new URL(pathOrUrl, base);
    u.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return u.toString();
  } catch {
    const path = pathOrUrl.startsWith("/") ? pathOrUrl : `/${pathOrUrl}`;
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${window.location.host}${path}`;
  }
}

async function loadRfb(clientBaseUrl) {
  if (state.RFB) return state.RFB;
  state.RFB = await loadNovncRfb(clientBaseUrl);
  return state.RFB;
}

function disconnectVnc({ clear = true } = {}) {
  if (state.vncClipboardDetach) {
    state.vncClipboardDetach();
    state.vncClipboardDetach = null;
  }
  if (state.vncScrollDetach) {
    state.vncScrollDetach();
    state.vncScrollDetach = null;
  }
  if (state.vncGestureDetach) {
    state.vncGestureDetach();
    state.vncGestureDetach = null;
  }
  const rfb = state.rfb;
  state.rfb = null;
  if (rfb) {
    state.intentionalRfbDisconnect = rfb;
    rfb.disconnect();
  }
  if (clear) els.vncScreen.replaceChildren();
}

function applyFramebufferAspect(width, height) {
  if (!(width > 0 && height > 0)) return;
  CAMOFOX_FRAMEBUFFER.width = width;
  CAMOFOX_FRAMEBUFFER.height = height;
  layoutVncScreen();
}

function layoutFillScreen(screenEl) {
  if (!screenEl) return;
  screenEl.style.flex = "1 1 auto";
  screenEl.style.width = "100%";
  screenEl.style.height = "100%";
  screenEl.style.maxWidth = "100%";
  screenEl.style.maxHeight = "100%";
}

function layoutVncScreen() {
  if (state.screencast || state.cloudFrame) {
    layoutFillScreen(els.vncScreen);
    return null;
  }
  return layoutLetterboxedScreen(els.vncFrame, els.vncScreen, {
    width: CAMOFOX_FRAMEBUFFER.width,
    height: CAMOFOX_FRAMEBUFFER.height,
    maxWidthPx: readMaxWidthPx(),
  });
}

function syncVncScale() {
  layoutVncScreen();
  if (!state.rfb?.scaleViewport) return;
  window.dispatchEvent(new Event("resize"));
  updateVncDebug();
}

function updateVncDebug() {
  if (!DEBUG_VNC || !els.vncDebug) return;
  const frame = els.vncFrame?.getBoundingClientRect();
  const screen = els.vncScreen?.getBoundingClientRect();
  const rfb = state.rfb;
  const box = layoutVncScreen();
  const aspect = screen ? screen.width / Math.max(1, screen.height) : 0;
  const target = CAMOFOX_FRAMEBUFFER.width / CAMOFOX_FRAMEBUFFER.height;
  const lines = [
    `frame: ${frame ? `${Math.round(frame.width)}×${Math.round(frame.height)}` : "—"}`,
    `screen: ${screen ? `${Math.round(screen.width)}×${Math.round(screen.height)} (aspect ${aspect.toFixed(3)})` : "—"}`,
    `target aspect: ${target.toFixed(3)} (${CAMOFOX_FRAMEBUFFER.width}×${CAMOFOX_FRAMEBUFFER.height})`,
    box ? `layout: ${box.width}×${box.height}` : "layout: —",
  ];
  if (rfb) {
    lines.push(`fb: ${rfb._fbWidth ?? "?"}×${rfb._fbHeight ?? "?"}`);
    lines.push(`scale: ${rfb._display?.scale ?? "?"}`);
  }
  els.vncDebug.hidden = false;
  els.vncDebug.textContent = lines.join("\n");
  console.debug("[joshu vnc]", Object.fromEntries(lines.map((l) => l.split(": "))));
}

async function installCamofoxShimOnce() {
  await fetch("api/camofox/shim", { method: "POST", cache: "no-store" }).catch(() => undefined);
}

function camofoxHandoffOperational(camofox) {
  const h = camofox?.health;
  return (h?.activeTabs ?? 0) > 0;
}

function camofoxBrowserReady(camofox) {
  const h = camofox?.health;
  return Boolean(h?.browserConnected && h?.browserRunning);
}

let lastCamofoxWarmAt = 0;
async function maybeWarmCamofoxBrowser(data) {
  if (data?.liveView?.mode === "cloud") return false;
  if (camofoxHandoffOperational(data?.camofox)) return false;
  const now = Date.now();
  if (now - lastCamofoxWarmAt < 15_000) {
    if (!state.rfb) setVncStatus("starting Camofox browser…", "warn");
    return false;
  }
  lastCamofoxWarmAt = now;
  if (!state.rfb) setVncStatus("starting Camofox browser…", "warn");
  const res = await fetch("api/camofox/fit-viewport", { method: "POST", cache: "no-store" }).catch(() => undefined);
  if (!res?.ok) return false;
  state.vncReconnectAfter = 0;
  state.vncAutoConnectDone = false;
  return true;
}

function connectScreencastView(websocketPath) {
  if (state.screencast && state.screencastPath === websocketPath) return;
  state.screencast?.close();
  disconnectVnc({ clear: false });
  state.screencastPath = websocketPath;
  layoutFillScreen(els.vncScreen);
  state.screencast = connectScreencast(els.vncScreen, websocketPath, {
    onStatus: (text) => setVncStatus(text, text.startsWith("connected") ? "ok" : "warn"),
    pasteViaApi: async (text) => {
      const res = await fetch("api/camofox/insert-text", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
        cache: "no-store",
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      return true;
    },
    copyViaApi: async () => {
      const res = await fetch("api/camofox/copy-selection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        cache: "no-store",
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      return typeof data.text === "string" ? data.text : "";
    },
    ui: {
      pasteBtn: els.vncPasteRemote,
      copyBtn: els.vncCopyRemote,
      textarea: els.vncClipboardText,
    },
  });
}

function connectCloudView(viewport) {
  if (state.cloudFrame) return;
  state.screencast?.close();
  state.screencast = null;
  disconnectVnc({ clear: false });
  layoutFillScreen(els.vncScreen);
  const label = document.getElementById("chrome-vnc-label");
  if (label) label.textContent = "Live";
  state.cloudFrame = mountCloudLiveFrame(els.vncScreen, "api/browser/live-frame", {
    width: viewport?.width,
    height: viewport?.height,
    onStatus: (text) => setVncStatus(text, text.startsWith("connected") ? "ok" : "warn"),
  });
}

async function maybeConnectVncFromStatus(data, { force = false } = {}) {
  if (data?.liveView?.mode === "cloud") {
    connectCloudView(data.browserViewport);
    return;
  }
  if (data?.liveView?.mode === "screencast" && data.liveView.websocketPath) {
    if (!camofoxBrowserReady(data.camofox)) {
      if (!state.screencast) setVncStatus("waiting for browser", "warn");
      return;
    }
    connectScreencastView(data.liveView.websocketPath);
    return;
  }
  if (!data?.novnc?.clientBaseUrl || !data?.novnc?.websocketPath) return;
  if (!camofoxBrowserReady(data.camofox)) {
    if (!state.rfb) setVncStatus("waiting for Camofox browser", "warn");
    return;
  }
  if (!force) {
    if (state.rfb) return;
    if (state.vncReconnectAfter && Date.now() < state.vncReconnectAfter) return;
    if (state.vncAutoConnectDone) return;
    state.vncAutoConnectDone = true;
  }
  await connectVnc(data.novnc, { force });
}

async function connectVnc(novnc, { force = false } = {}) {
  const clientBaseUrl = novnc?.clientBaseUrl?.replace(/\/+$/, "");
  const websocketPath = novnc?.websocketPath;
  if (!clientBaseUrl || !websocketPath) return;

  const changed = !state.novnc || state.novnc.clientBaseUrl !== clientBaseUrl || state.novnc.websocketPath !== websocketPath;
  state.novnc = { ...novnc, clientBaseUrl, websocketPath };
  if (!force && state.rfb && !changed) return;
  if (!force && state.vncReconnectAfter && Date.now() < state.vncReconnectAfter) return;

  disconnectVnc();
  setVncStatus("connecting", "running");
  try {
    const RFB = await loadRfb(clientBaseUrl);
    const rfb = new RFB(els.vncScreen, buildWebsocketUrl(websocketPath), { shared: false });
    state.rfb = rfb;
    configureNovncRfb(rfb);
    if (els.vncScreen) {
      if (state.vncClipboardDetach) state.vncClipboardDetach();
      state.vncClipboardDetach = attachVncClipboard(rfb, {
        targetEl: els.vncScreen,
        pasteViaApi: async (text) => {
          const res = await fetch("api/camofox/insert-text", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text }),
            cache: "no-store",
          });
          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || `HTTP ${res.status}`);
          }
          return true;
        },
        copyViaApi: async () => {
          const res = await fetch("api/camofox/copy-selection", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
            cache: "no-store",
          });
          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || `HTTP ${res.status}`);
          }
          const data = await res.json();
          return typeof data.text === "string" ? data.text : "";
        },
        ui: {
          pasteBtn: els.vncPasteRemote,
          copyBtn: els.vncCopyRemote,
          textarea: els.vncClipboardText,
          hint: els.vncClipboardHint,
        },
      });
      if (state.vncScrollDetach) state.vncScrollDetach();
      if (state.vncGestureDetach) {
        state.vncGestureDetach();
        state.vncGestureDetach = null;
      }
      const useGestures = preferVncLocalGestures();
      state.vncScrollDetach = attachVncScrollBridge(els.vncScreen, { skipWheel: useGestures });
      if (useGestures) {
        state.vncGestureDetach = attachVncLocalGestures(els.vncScreen, {
          rfb,
          onScroll: (direction, amount) => {
            if (typeof state.vncScrollDetach?.enqueueWheel === "function") {
              state.vncScrollDetach.enqueueWheel(direction, amount);
            }
          },
        });
      }
    }
    rfb.addEventListener("connect", () => {
      state.vncReconnectAfter = 0;
      requestAnimationFrame(() => {
        syncVncScale();
        setTimeout(syncVncScale, 50);
      });
      const fitViewport = () => {
        void fetch("api/camofox/fit-viewport", { method: "POST", cache: "no-store" }).catch(() => undefined);
      };
      fitViewport();
      setTimeout(fitViewport, 400);
      setTimeout(fitViewport, 1200);
      void installCamofoxShimOnce();
      setVncStatus(`connected ${CAMOFOX_FRAMEBUFFER.width}×${CAMOFOX_FRAMEBUFFER.height}`, "ok");
    });
    rfb.addEventListener("desktopresize", () => syncVncScale());
    rfb.addEventListener("disconnect", (event) => {
      const intentional = state.intentionalRfbDisconnect === rfb;
      if (intentional) {
        state.intentionalRfbDisconnect = null;
        return;
      }
      if (state.rfb === rfb) state.rfb = null;
      state.vncReconnectAfter = Date.now() + 60_000;
      const hint = event.detail?.clean ? "disconnected — Reload VNC" : "disconnected — Reload VNC";
      setVncStatus(hint, event.detail?.clean ? "" : "warn");
    });
  } catch (err) {
    setVncStatus("failed", "failed");
    console.warn("[joshu] noVNC failed to connect:", err.message);
  }
}

if (els.vncFrame) {
  new ResizeObserver(() => syncVncScale()).observe(els.vncFrame);
}
if (els.vncScreen) {
  new ResizeObserver(() => syncVncScale()).observe(els.vncScreen);
}

async function navigateFromUrlBar(raw) {
  const url = raw.trim();
  if (!url) return;
  els.urlBar?.classList.add("navigating");
  if (els.urlGo) els.urlGo.disabled = true;
  try {
    const res = await fetch("api/camofox/navigate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
      cache: "no-store",
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    state.urlBarDirty = false;
    setUrlBar(data.currentUrl || url, { force: true });
  } catch (err) {
    console.warn("[joshu] navigate failed:", err.message);
    if (els.vncClipboardHint) {
      els.vncClipboardHint.textContent = `Navigate failed: ${err.message}`;
      window.setTimeout(() => {
        if (els.vncClipboardHint) {
          els.vncClipboardHint.textContent =
            "For URLs, use the address bar — paste targets page fields, not Firefox chrome.";
        }
      }, 4000);
    }
  } finally {
    els.urlBar?.classList.remove("navigating");
    if (els.urlGo) els.urlGo.disabled = false;
  }
}

async function refreshStatus() {
  try {
    const res = await fetch("api/status", { cache: "no-store" });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const data = await res.json();
    const parts = [];
    parts.push(data.hermes.available ? `<span class="ok">hermes ok</span>` : `<span class="err">hermes missing</span>`);
    parts.push(data.camofox.reachable ? `<span class="ok">camofox ${escapeHtml(data.camofox.url)}</span>` : `<span class="err">camofox down</span>`);
    if (data.docker?.enabled) {
      parts.push(`<span class="${data.docker.running ? "ok" : "warn"}">docker ${escapeHtml(data.docker.status || "unknown")}</span>`);
    }
    if (data.lastCamofoxUserId) parts.push(`<span class="ok">${escapeHtml(data.lastCamofoxUserId)}</span>`);
    els.status.innerHTML = parts.join(" &middot; ");
    if (data.browserViewport) applyFramebufferAspect(data.browserViewport.width, data.browserViewport.height);
    if (data.novnc?.embedUrl) els.openVnc.href = data.novnc.embedUrl;
    if (data.lastBrowserUrl) setUrlBar(data.lastBrowserUrl);
    const warmed = await maybeWarmCamofoxBrowser(data);
    const statusForVnc = warmed
      ? await fetch("api/status", { cache: "no-store" }).then((r) => (r.ok ? r.json() : data)).catch(() => data)
      : data;
    await maybeConnectVncFromStatus(statusForVnc, warmed ? { force: true } : undefined);
    if (!state.sessionId && data.activeSessionId) setSession(data.activeSessionId);
  } catch (err) {
    els.status.innerHTML = `<span class="err">status error: ${escapeHtml(err.message)}</span>`;
  }
}

async function resetConversation(reason, { purgeTabs = false } = {}) {
  setSession(null);
  els.initialUrl.value = "";
  try {
    const res = await fetch("api/hermes/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ purgeTabs }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    console.info("[joshu]", reason, "— Hermes gateway recycled");
  } catch (err) {
    console.warn("[joshu] Hermes reset failed:", err.message);
  }
}

async function restartCamofox() {
  els.restartCamofox.disabled = true;
  try {
    const res = await fetch("api/camofox/restart", { method: "POST" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await resetConversation("Camofox restarted");
    setTimeout(refreshStatus, 1500);
  } catch (err) {
    console.warn("[joshu] Camofox restart failed:", err.message);
  } finally {
    els.restartCamofox.disabled = false;
  }
}

els.urlForm?.addEventListener("submit", (ev) => {
  ev.preventDefault();
  void navigateFromUrlBar(els.urlBar?.value || "");
});

els.urlBar?.addEventListener("focus", () => {
  state.urlBarEditing = true;
});

els.urlBar?.addEventListener("blur", () => {
  state.urlBarEditing = false;
});

els.urlBar?.addEventListener("input", () => {
  state.urlBarDirty = true;
});

els.forgetSession.addEventListener("click", () => resetConversation("session forgotten"));
els.reloadVnc.addEventListener("click", () => {
  state.vncReconnectAfter = 0;
  state.vncAutoConnectDone = false;
  state.screencast?.close();
  state.screencast = null;
  state.screencastPath = "";
  void refreshStatus().then(() => {
    if (!state.screencast && state.novnc) void connectVnc(state.novnc, { force: true });
  });
});
els.restartCamofox.addEventListener("click", restartCamofox);
els.openSettings?.addEventListener("click", openSettingsModal);
els.closeSettings?.addEventListener("click", closeSettingsModal);
els.settingsModal?.querySelectorAll("[data-close-settings]").forEach((node) => {
  node.addEventListener("click", closeSettingsModal);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && els.settingsModal && !els.settingsModal.hidden) closeSettingsModal();
});

applyFramebufferAspect(CAMOFOX_FRAMEBUFFER.width, CAMOFOX_FRAMEBUFFER.height);
layoutVncScreen();
loadPersistedState();
setSession(state.sessionId);
attachJChatBubble({ position: "right" });
refreshStatus();
setInterval(refreshStatus, 8000);
