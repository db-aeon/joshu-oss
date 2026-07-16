import { attachVncClipboard } from "./vnc-clipboard.js";

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
// Defaults until /api/status returns browserViewport (Camofox env).
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
  vncTypeRemote: $("#vnc-type-remote"),
  vncTypeSelectAll: $("#vnc-type-select-all"),
  vncCopyRemote: $("#vnc-copy-remote"),
  vncClipboardToggle: $("#vnc-clipboard-toggle"),
  vncClipboardPanel: $("#vnc-clipboard-panel"),
  vncClipboardText: $("#vnc-clipboard-text"),
  vncLoadMac: $("#vnc-load-mac"),
  vncSaveMac: $("#vnc-save-mac"),
  vncClipboardHint: $("#vnc-clipboard-hint"),
  sessionPill: $("#session-pill"),
  forgetSession: $("#forget-session"),
  form: $("#run-form"),
  initialUrl: $("#initial-url"),
  prompt: $("#prompt"),
  submit: $("#submit-run"),
  cancel: $("#cancel-run"),
  runStatus: $("#run-status"),
  log: $("#log"),
  clearLog: $("#clear-log"),
  settingsModal: $("#settings-modal"),
  openSettings: $("#open-settings"),
  closeSettings: $("#close-settings"),
};

const state = {
  sessionId: null,
  conversationId: null,
  runId: null,
  source: null,
  RFB: null,
  rfb: null,
  intentionalRfbDisconnect: null,
  novnc: null,
  vncClipboardDetach: null,
  /** After a VNC drop, block auto-reconnect until this timestamp (ms). Reload VNC clears it. */
  vncReconnectAfter: 0,
  /** True after the first automatic connect attempt (status poll must not keep reconnecting). */
  vncAutoConnectDone: false,
};

function appendLog(stream, text, opts = {}) {
  const span = document.createElement("span");
  span.className = `ev ${stream}`;
  const prefix = opts.ts ? `${opts.ts.slice(11, 19)} ` : "";
  span.textContent = (stream === "stdout" ? text : `${prefix}[${stream}] ${text}`) + "\n";
  const nearBottom = els.log.scrollHeight - els.log.scrollTop - els.log.clientHeight < 40;
  els.log.appendChild(span);
  if (nearBottom) els.log.scrollTop = els.log.scrollHeight;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

function setRunStatus(label, cls = "") {
  els.runStatus.textContent = label;
  els.runStatus.className = `run-status ${cls}`.trim();
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
    conversationId: state.conversationId,
  }));
}

function loadPersistedState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (typeof saved.sessionId === "string") state.sessionId = saved.sessionId;
    if (typeof saved.conversationId === "string") state.conversationId = saved.conversationId;
  } catch {
    localStorage.removeItem(STORAGE_KEY);
  }
}

function newConversationId() {
  const suffix = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `joshu-hitl-${suffix}`;
}

function ensureConversationId() {
  if (!state.conversationId) {
    state.conversationId = newConversationId();
    persistState();
  }
  return state.conversationId;
}

function setSession(id) {
  state.sessionId = id || null;
  persistState();
  els.sessionPill.textContent = id ? `Session ${id.slice(0, 8)}…` : "No Hermes session";
  els.sessionPill.classList.toggle("has-session", Boolean(id));
}

function setBusy(busy) {
  els.submit.disabled = busy;
  els.cancel.disabled = !busy;
  els.prompt.disabled = busy;
  els.initialUrl.disabled = busy;
}

function buildWebsocketUrl(pathOrUrl) {
  if (/^wss?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  // Resolve against the page URL so paths work under ArozOS (/joshu/...) and at /.
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
  const mod = await import(`${clientBaseUrl.replace(/\/+$/, "")}/core/rfb.js`);
  state.RFB = mod.default;
  return state.RFB;
}

function disconnectVnc({ clear = true } = {}) {
  if (state.vncClipboardDetach) {
    state.vncClipboardDetach();
    state.vncClipboardDetach = null;
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

/** Letterbox #vnc-screen inside #vnc-frame to the 1024×768 framebuffer aspect (see docs/hitl-camofox-notes.md). */
function layoutVncScreen() {
  return layoutLetterboxedScreen(els.vncFrame, els.vncScreen, {
    width: CAMOFOX_FRAMEBUFFER.width,
    height: CAMOFOX_FRAMEBUFFER.height,
    maxWidthPx: readMaxWidthPx(),
  });
}

/** Ask noVNC to rescale via its scaleViewport + window resize handler (no private Display APIs). */
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

/** Install single-tab link shim once per VNC session (idempotent in the tab). */
async function installCamofoxShimOnce() {
  await fetch("api/camofox/shim", { method: "POST", cache: "no-store" }).catch(() => undefined);
}

function camofoxBrowserReady(camofox) {
  const h = camofox?.health;
  return Boolean(h?.browserRunning || h?.browserConnected || (h?.activeTabs ?? 0) > 0);
}

async function maybeConnectVncFromStatus(data, { force = false } = {}) {
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
    // Exclusive session — shared viewers make x11vnc drop the previous client (connect/disconnect loop).
    const rfb = new RFB(els.vncScreen, buildWebsocketUrl(websocketPath), { shared: false });
    state.rfb = rfb;
    rfb.viewOnly = false;
    rfb.focusOnClick = true;
    rfb.clipViewport = false;
    rfb.dragViewport = false;
    // scaleViewport fits remote desktop to #vnc-screen; CSS keeps that box at framebuffer aspect.
    rfb.scaleViewport = true;
    rfb.resizeSession = false;
    rfb.showDotCursor = true;
    if (els.vncScreen) {
      if (state.vncClipboardDetach) state.vncClipboardDetach();
      state.vncClipboardDetach = attachVncClipboard(rfb, {
        targetEl: els.vncScreen,
        pasteViaApi: async (text) => {
          const res = await fetch("api/camofox/insert-text", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text, selectAll: true }),
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
          typeBtn: els.vncTypeRemote,
          typeSelectAll: els.vncTypeSelectAll,
          copyBtn: els.vncCopyRemote,
          toggleBtn: els.vncClipboardToggle,
          panel: els.vncClipboardPanel,
          textarea: els.vncClipboardText,
          loadMacBtn: els.vncLoadMac,
          saveMacBtn: els.vncSaveMac,
          hint: els.vncClipboardHint,
        },
      });
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
      // Status poll must not auto-reconnect; use Reload VNC after backoff.
      state.vncReconnectAfter = Date.now() + 60_000;
      const hint = event.detail?.clean ? "disconnected — Reload VNC" : "disconnected — Reload VNC";
      setVncStatus(hint, event.detail?.clean ? "" : "warn");
    });
  } catch (err) {
    setVncStatus("failed", "failed");
    appendLog("stderr", `noVNC failed to connect: ${err.message}`);
  }
}

if (els.vncFrame) {
  new ResizeObserver(() => syncVncScale()).observe(els.vncFrame);
}
if (els.vncScreen) {
  new ResizeObserver(() => syncVncScale()).observe(els.vncScreen);
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
    await maybeConnectVncFromStatus(data);
    if (!state.sessionId && data.activeSessionId) setSession(data.activeSessionId);
  } catch (err) {
    els.status.innerHTML = `<span class="err">status error: ${escapeHtml(err.message)}</span>`;
  }
}

async function resetConversation(reason, { purgeTabs = false } = {}) {
  state.conversationId = newConversationId();
  setSession(null);
  els.initialUrl.value = "";
  try {
    const res = await fetch("api/hermes/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ purgeTabs }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    appendLog("system", `${reason}; killed Hermes gateway and cleared app history`);
  } catch (err) {
    appendLog("stderr", `Hermes reset failed: ${err.message}`);
  }
}

async function submitRun(ev) {
  ev.preventDefault();
  if (state.runId) return;
  const prompt = els.prompt.value.trim();
  if (!prompt) return;
  setBusy(true);
  setRunStatus("starting", "running");

  // Snapshot the live noVNC tab before Hermes runs so tool calls adopt the same page.
  await fetch("api/camofox/sync", { method: "POST", cache: "no-store" }).catch(() => undefined);

  let runId;
  try {
    const res = await fetch("api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt,
        initialUrl: els.initialUrl.value.trim() || undefined,
        conversationId: ensureConversationId(),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    runId = data.runId;
  } catch (err) {
    appendLog("stderr", `failed to start run: ${err.message}`);
    setRunStatus("failed", "failed");
    setBusy(false);
    return;
  }

  state.runId = runId;
  appendLog("system", `>>> run ${runId}`);
  els.prompt.value = "";
  els.initialUrl.value = "";
  attachRunStream(runId);
}

function attachRunStream(runId) {
  if (state.source) state.source.close();
  const src = new EventSource(`api/runs/${runId}/events`);
  state.source = src;
  src.addEventListener("log", (e) => {
    const ev = JSON.parse(e.data);
    appendLog(ev.stream, ev.text, { ts: ev.ts });
  });
  src.addEventListener("status", (e) => {
    const { status } = JSON.parse(e.data);
    setRunStatus(status, status);
  });
  src.addEventListener("final", (e) => {
    const summary = JSON.parse(e.data);
    if (summary.sessionId) setSession(summary.sessionId);
    if (summary.finalResponse) appendLog("final", summary.finalResponse);
    teardownRun();
  });
}

function teardownRun() {
  if (state.source) state.source.close();
  state.source = null;
  state.runId = null;
  setBusy(false);
}

async function cancelRun() {
  if (!state.runId) return;
  await fetch(`api/runs/${state.runId}/cancel`, { method: "POST" }).catch((err) => appendLog("stderr", `cancel failed: ${err.message}`));
}

async function restartCamofox() {
  els.restartCamofox.disabled = true;
  appendLog("system", "restarting Camofox Docker container...");
  try {
    const res = await fetch("api/camofox/restart", { method: "POST" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await resetConversation("Camofox restarted");
    setTimeout(refreshStatus, 1500);
  } catch (err) {
    appendLog("stderr", `Camofox restart failed: ${err.message}`);
  } finally {
    els.restartCamofox.disabled = false;
  }
}

els.form.addEventListener("submit", submitRun);
els.cancel.addEventListener("click", cancelRun);
els.clearLog.addEventListener("click", () => { els.log.textContent = ""; });
els.forgetSession.addEventListener("click", () => resetConversation("session forgotten"));
els.reloadVnc.addEventListener("click", () => {
  state.vncReconnectAfter = 0;
  state.vncAutoConnectDone = false;
  void refreshStatus().then(() => {
    if (state.novnc) void connectVnc(state.novnc, { force: true });
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
els.prompt.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    els.form.requestSubmit();
  }
});

setBusy(false);
setRunStatus("idle");
applyFramebufferAspect(CAMOFOX_FRAMEBUFFER.width, CAMOFOX_FRAMEBUFFER.height);
layoutVncScreen();
loadPersistedState();
ensureConversationId();
setSession(state.sessionId);
refreshStatus();
setInterval(refreshStatus, 8000);
