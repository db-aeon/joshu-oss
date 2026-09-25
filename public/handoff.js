import { attachVncClipboard } from "./vnc-clipboard.js";
import { wrapPasswordInput } from "./handoff-password-toggle.js";
import { connectScreencast } from "./screencast-client.js?v=20260922d";
import { mountCloudLiveFrame } from "./cloud-live-frame.js?v=ui-browser-22";
import { configureNovncRfb, loadNovncRfb } from "./vnc-client.js";
import { attachVncLocalGestures } from "./vnc-gestures.js";
import { attachVncScrollBridge } from "./vnc-scroll.js";

function readConfig() {
  const el = document.getElementById("handoff-config");
  if (!el?.textContent) throw new Error("missing handoff config");
  return JSON.parse(el.textContent);
}

function truncateUrl(url, max = 72) {
  if (!url || url.length <= max) return url || "";
  return `${url.slice(0, max - 1)}…`;
}

function renderShell(root, cfg) {
  root.innerHTML = `
    <header class="handoff-header">
      <img class="handoff-logo" src="joshu-mark.svg" alt="Joshu" width="22" height="22" />
      <div class="handoff-brand-copy">
        <p class="handoff-instructions"></p>
        <p class="handoff-meta"></p>
      </div>
    </header>
    <div id="vnc-frame">
      <div id="status">connecting…</div>
      <div id="vnc-screen" aria-label="Shared browser via noVNC"></div>
    </div>
    <section class="handoff-overlay" id="handoff-overlay">
      <p class="handoff-overlay-status" id="handoff-overlay-status">Scanning page fields…</p>
      <form class="handoff-fields" id="handoff-fields"></form>
      <div class="handoff-overlay-actions">
        <button type="button" class="handoff-btn handoff-btn-primary" id="handoff-fill" disabled>Fill fields</button>
        <button type="button" class="handoff-btn" id="handoff-done">I'm done</button>
      </div>
      <details class="handoff-more">
        <summary>More Options</summary>
        <div class="handoff-more-body">
          <button type="button" class="handoff-btn" id="handoff-scan">Scan fields</button>
          <div class="vnc-clipboard-bar">
            <textarea id="vnc-clipboard-text" class="vnc-clipboard-text" rows="2" spellcheck="false" autocapitalize="off" autocorrect="off"
              placeholder="Tap a field in the picture, type here, then Paste" aria-label="Fallback clipboard for missed fields"></textarea>
            <button type="button" id="vnc-paste-remote" class="vnc-clipboard-btn vnc-clipboard-btn-primary">Paste into field</button>
            <button type="button" id="vnc-copy-remote" class="vnc-clipboard-btn">Copy from browser</button>
            <p class="vnc-clipboard-hint">Fallback when a control is not in the list above (CAPTCHA, custom widgets).</p>
          </div>
        </div>
      </details>
    </section>
  `;
  const instructions = cfg.instructions || "Complete the staged checkout step.";
  const instructionsEl = root.querySelector(".handoff-instructions");
  instructionsEl.textContent = instructions;
  instructionsEl.title = instructions;
  root.querySelector(".handoff-meta").textContent = cfg.pageTitle
    ? `${cfg.pageTitle} — ${truncateUrl(cfg.pageUrl)}`
    : truncateUrl(cfg.pageUrl);
}

function wsUrl(path) {
  const u = new URL(path, document.baseURI || location.href);
  u.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return u.toString();
}

function camofoxHandoffOperational(camofox) {
  const h = camofox?.health;
  return (h?.activeTabs ?? 0) > 0;
}

function nativeInputType(overlayType) {
  if (overlayType === "email") return "email";
  if (overlayType === "password") return "password";
  if (overlayType === "tel") return "tel";
  if (overlayType === "number") return "number";
  return "text";
}

function collectOverlayValues(formEl) {
  const fields = [];
  for (const el of formEl.querySelectorAll("[data-field-id]")) {
    const id = el.getAttribute("data-field-id");
    if (!id) continue;
    if (el.type === "checkbox" || el.type === "radio") {
      fields.push({ id, value: el.checked });
      continue;
    }
    const value = typeof el.value === "string" ? el.value : "";
    if (value) fields.push({ id, value });
  }
  return fields;
}

function renderOverlayFields(formEl, scan) {
  formEl.innerHTML = "";
  for (const field of scan.fields || []) {
    const wrap = document.createElement("label");
    wrap.className = "handoff-field";
    const caption = document.createElement("span");
    caption.className = "handoff-field-label";
    caption.textContent = field.label || "Field";
    wrap.appendChild(caption);
    if (field.inputType === "select") {
      const sel = document.createElement("select");
      sel.dataset.fieldId = field.id;
      sel.setAttribute("autocomplete", "off");
      const blank = document.createElement("option");
      blank.value = "";
      blank.textContent = "Choose…";
      sel.appendChild(blank);
      for (const opt of field.options || []) {
        const o = document.createElement("option");
        o.value = opt.value;
        o.textContent = opt.label || opt.value;
        sel.appendChild(o);
      }
      if (field.prefill) sel.value = field.prefill;
      sel.dataset.initialValue = sel.value;
      wrap.appendChild(sel);
    } else if (field.inputType === "checkbox") {
      const input = document.createElement("input");
      input.type = "checkbox";
      input.dataset.fieldId = field.id;
      input.checked = field.checked === true;
      input.dataset.initialChecked = input.checked ? "true" : "false";
      wrap.appendChild(input);
    } else if (field.inputType === "radio") {
      const input = document.createElement("input");
      input.type = "checkbox";
      input.dataset.fieldId = field.id;
      input.checked = field.checked === true;
      input.dataset.initialChecked = input.checked ? "true" : "false";
      wrap.appendChild(input);
    } else {
      const input = document.createElement("input");
      input.type = nativeInputType(field.inputType);
      input.dataset.fieldId = field.id;
      input.autocapitalize = "off";
      input.autocorrect = "off";
      input.spellcheck = false;
      if (field.inputType === "password") input.autocomplete = "off";
      if (field.prefill && field.inputType !== "password") input.value = field.prefill;
      input.dataset.initialValue = input.value;
      wrap.appendChild(field.inputType === "password" ? wrapPasswordInput(input) : input);
    }
    formEl.appendChild(wrap);
  }
}

async function main() {
  const cfg = readConfig();
  const root = document.getElementById("handoff-root");
  renderShell(root, cfg);

  const statusEl = document.getElementById("status");
  const frameEl = document.getElementById("vnc-frame");
  const screenEl = document.getElementById("vnc-screen");
  const doneBtn = document.getElementById("handoff-done");
  const scanBtn = document.getElementById("handoff-scan");
  const fillBtn = document.getElementById("handoff-fill");
  const fieldsForm = document.getElementById("handoff-fields");
  const overlayStatus = document.getElementById("handoff-overlay-status");
  const metaEl = root.querySelector(".handoff-meta");
  const fb = { width: 1024, height: 768 };
  let rfb = null;
  let heartbeatTimer = null;
  let rescanTimer = null;
  let lastWarmAt = 0;
  let lastScan = { fields: [], primaryButtonId: null, primaryButtonLabel: null };
  let lastPageKey = "";
  let scanInFlight = false;
  let fastScanInFlight = false;
  let fillInFlight = false;
  let quietUntil = 0;

  const tokenQuery = `t=${encodeURIComponent(cfg.token)}&exp=${encodeURIComponent(cfg.exp)}`;
  /** Append the handoff token, whether or not the path already has a query (`?fast=1`). */
  const withToken = (path) => `${path}${path.includes("?") ? "&" : "?"}${tokenQuery}`;

  async function postJson(path, body = {}) {
    const res = await fetch(withToken(path), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, t: cfg.token, exp: cfg.exp }),
      cache: "no-store",
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  async function getJson(path) {
    const res = await fetch(withToken(path), { cache: "no-store" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  function overlayHasOwnerEdits() {
    for (const el of fieldsForm.querySelectorAll("[data-field-id]")) {
      if (el.type === "checkbox" || el.type === "radio") {
        const initial = el.dataset.initialChecked === "true";
        if (el.checked !== initial) return true;
        continue;
      }
      const initial = el.dataset.initialValue ?? "";
      const value = typeof el.value === "string" ? el.value : "";
      if (value !== initial) return true;
    }
    return false;
  }

  function updateFillButton() {
    const label = lastScan.primaryButtonLabel;
    fillBtn.disabled = fillInFlight || !overlayHasOwnerEdits();
    fillBtn.textContent = label ? `Fill and continue (${label})` : "Fill fields";
  }

  function overlayBusy() {
    if (scanInFlight || fillInFlight) return true;
    if (Date.now() < quietUntil) return true;
    return false;
  }

  function applyPageMeta(pageTitle, pageUrl) {
    if (!metaEl || !pageUrl) return;
    metaEl.textContent = pageTitle ? `${pageTitle} — ${truncateUrl(pageUrl)}` : truncateUrl(pageUrl);
  }

  function rememberPageKey(data) {
    if (typeof data?.pageKey === "string") lastPageKey = data.pageKey;
    applyPageMeta(data?.pageTitle, data?.pageUrl);
  }

  function applyScanResult(data) {
    lastScan = {
      fields: Array.isArray(data.fields) ? data.fields : [],
      primaryButtonId: data.primaryButtonId || null,
      primaryButtonLabel: data.primaryButtonLabel || null,
    };
    rememberPageKey(data);
    renderOverlayFields(fieldsForm, lastScan);
    updateFillButton();
  }

  function setScanStatusMessage() {
    if (lastScan.fields.length === 0) {
      overlayStatus.textContent =
        "No fillable fields on this page — use paste into focused field. Overlay updates when the page changes.";
      return;
    }
    overlayStatus.textContent = lastScan.primaryButtonLabel
      ? `Type below, then fill. Will click “${lastScan.primaryButtonLabel}”.`
      : "Type below, then fill. No continue button detected — tap it in the picture after fill.";
  }

  /** fast=1 skips the LLM — DOM heuristics only (auto-rescan). Full scan labels fields with AI. */
  async function scanFields({ fast = false, silent = false } = {}) {
    if (scanInFlight && !fast) return;
    if (fast && fastScanInFlight) return;
    if (fast) fastScanInFlight = true;
    else {
      scanInFlight = true;
      scanBtn.disabled = true;
    }
    if (!silent) overlayStatus.textContent = fast ? "Scanning page fields…" : "Refining field labels…";
    try {
      const q = fast ? "?fast=1" : "";
      const data = await getJson(`api/browser-handoff/${encodeURIComponent(cfg.handoffId)}/form-fields${q}`);
      applyScanResult(data);
      if (!silent) setScanStatusMessage();
    } catch (err) {
      if (!silent) overlayStatus.textContent = String(err.message || err);
    } finally {
      if (fast) fastScanInFlight = false;
      else {
        scanInFlight = false;
        scanBtn.disabled = false;
      }
    }
  }

  async function maybeRescanIfPageChanged() {
    if (overlayBusy()) return;
    // A rescan rebuilds the form and would wipe what the owner already typed.
    if (overlayHasOwnerEdits()) return;
    try {
      const data = await getJson(`api/browser-handoff/${encodeURIComponent(cfg.handoffId)}/page-key`);
      const nextKey = typeof data.pageKey === "string" ? data.pageKey : "";
      const nextUrl = typeof data.pageUrl === "string" ? data.pageUrl : "";
      applyPageMeta(data.pageTitle, nextUrl);
      if (!nextKey || nextKey === lastPageKey) return;
      await scanFields({ fast: true });
    } catch {
      /* non-fatal */
    }
  }

  async function fillFields() {
    fillBtn.disabled = true;
    fillInFlight = true;
    overlayStatus.textContent = "Filling the remote page…";
    try {
      const fields = collectOverlayValues(fieldsForm);
      const result = await postJson(`api/browser-handoff/${encodeURIComponent(cfg.handoffId)}/fill-form`, {
        fields,
        clickPrimary: Boolean(lastScan.primaryButtonId),
        primaryButtonId: lastScan.primaryButtonId,
      });
      const filled = Number(result.filled) || 0;
      const missing = Array.isArray(result.missing) ? result.missing.length : 0;
      if (filled === 0) {
        overlayStatus.textContent = "Nothing was written on the page. Scan fields and try again.";
        updateFillButton();
        return;
      }
      overlayStatus.textContent = missing
        ? `Wrote ${filled} field${filled === 1 ? "" : "s"}. ${missing} could not be found.`
        : `Wrote ${filled} field${filled === 1 ? "" : "s"} on the page.`;
      quietUntil = Date.now() + 1500;
      lastPageKey = "";
    } catch (err) {
      overlayStatus.textContent = String(err.message || err);
      updateFillButton();
    } finally {
      fillInFlight = false;
    }
  }

  async function heartbeat() {
    try {
      await postJson(`api/browser-handoff/${encodeURIComponent(cfg.handoffId)}/heartbeat`);
    } catch {
      /* non-fatal */
    }
  }

  async function maybeWarm(data) {
    // Cloud: the live-frame poll wakes Browser Use itself; Camofox health always
    // reads "not running" there, and warming here remounted the iframe every ~15s.
    if (data?.liveView?.mode === "cloud") return false;
    // OAuth can drop Playwright tab tracking while Firefox keeps running (activeTabs: 0).
    if (camofoxHandoffOperational(data?.camofox)) return false;
    const now = Date.now();
    if (now - lastWarmAt < 15_000) return false;
    lastWarmAt = now;
    statusEl.textContent = "starting browser…";
    await fetch("api/camofox/fit-viewport", { method: "POST", cache: "no-store" }).catch(() => undefined);
    return true;
  }

  function layout() {
    const rect = frameEl.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return null;
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height));
    screenEl.style.flex = "1 1 auto";
    screenEl.style.width = `${w}px`;
    screenEl.style.height = `${h}px`;
    if (rfb?.scaleViewport) window.dispatchEvent(new Event("resize"));
    return { width: w, height: h };
  }

  doneBtn.addEventListener("click", async () => {
    doneBtn.disabled = true;
    try {
      await postJson(`api/browser-handoff/${encodeURIComponent(cfg.handoffId)}/complete`);
      if (heartbeatTimer) window.clearInterval(heartbeatTimer);
      if (rescanTimer) window.clearInterval(rescanTimer);
      const banner = document.createElement("div");
      banner.className = "handoff-done-banner";
      banner.textContent = "Got it. Joshu will text you when it has picked this up.";
      root.insertBefore(banner, root.firstChild);
      doneBtn.textContent = "Done";
      overlayStatus.textContent = "Done.";
      statusEl.textContent = "Done.";
    } catch (err) {
      doneBtn.disabled = false;
      statusEl.textContent = String(err.message || err);
    }
  });
  scanBtn.addEventListener("click", () => {
    scanFields({ fast: false }).catch(() => undefined);
  });
  fillBtn.addEventListener("click", () => {
    fillFields().catch(() => undefined);
  });
  fieldsForm.addEventListener("input", () => updateFillButton());
  fieldsForm.addEventListener("change", () => updateFillButton());
  fieldsForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (fillBtn.disabled) return;
    fillFields().catch(() => undefined);
  });

  heartbeatTimer = window.setInterval(heartbeat, 20_000);
  heartbeat();
  rescanTimer = window.setInterval(() => {
    maybeRescanIfPageChanged().catch(() => undefined);
  }, 2500);

  const res = await fetch("api/status", { cache: "no-store" });
  if (!res.ok) throw new Error(`status ${res.status}`);
  let data = await res.json();
  if (data.browserViewport?.width > 0) {
    fb.width = data.browserViewport.width;
    fb.height = data.browserViewport.height;
  }

  await fetch("api/camofox/fit-viewport", { method: "POST", cache: "no-store" }).catch(() => undefined);

  // Cloud live view mounts once: it polls and reloads only when Browser Use
  // starts a new session. Remounting blanks the iframe and leaks a poller.
  let cloudFrameUnmount = null;
  const connectLive = async () => {
    if (data?.liveView?.mode === "cloud") {
      if (cloudFrameUnmount) return;
      const framePath = `api/browser/live-frame?handoffId=${encodeURIComponent(cfg.handoffId)}&t=${encodeURIComponent(cfg.token)}&exp=${encodeURIComponent(cfg.exp)}`;
      cloudFrameUnmount = mountCloudLiveFrame(screenEl, framePath, {
        width: data.browserViewport?.width,
        height: data.browserViewport?.height,
        interactive: true,
        pollMs: 4000,
        onStatus: (text) => {
          statusEl.textContent = text;
        },
      });
      return;
    }
    if (data?.liveView?.mode === "screencast" && data.liveView.websocketPath) {
      if (rfb) {
        rfb.disconnect();
        rfb = null;
      }
      connectScreencast(screenEl, data.liveView.websocketPath, {
        onStatus: (text) => {
          statusEl.textContent = text;
        },
        pasteViaApi: async (text) => {
          const pasteRes = await fetch("api/camofox/insert-text", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text }),
            cache: "no-store",
          });
          if (!pasteRes.ok) {
            const err = await pasteRes.json().catch(() => ({}));
            throw new Error(err.error || `HTTP ${pasteRes.status}`);
          }
          return true;
        },
        ui: {
          pasteBtn: document.getElementById("vnc-paste-remote"),
          copyBtn: document.getElementById("vnc-copy-remote"),
          textarea: document.getElementById("vnc-clipboard-text"),
        },
      });
      return;
    }
    const base = data.novnc?.clientBaseUrl?.replace(/\/+$/, "");
    const path = data.novnc?.websocketPath;
    if (!base || !path) throw new Error("noVNC not configured");
    const RFB = await loadNovncRfb(base);
    if (rfb) {
      rfb.disconnect();
      rfb = null;
    }
    rfb = new RFB(screenEl, wsUrl(path), { shared: false });
    configureNovncRfb(rfb);
    attachVncClipboard(rfb, {
      targetEl: screenEl,
      pasteViaApi: async (text) => {
        const pasteRes = await fetch("api/camofox/insert-text", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
          cache: "no-store",
        });
        if (!pasteRes.ok) {
          const err = await pasteRes.json().catch(() => ({}));
          throw new Error(err.error || `HTTP ${pasteRes.status}`);
        }
        return true;
      },
      copyViaApi: async () => {
        const copyRes = await fetch("api/camofox/copy-selection", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
          cache: "no-store",
        });
        if (!copyRes.ok) {
          const err = await copyRes.json().catch(() => ({}));
          throw new Error(err.error || `HTTP ${copyRes.status}`);
        }
        const copyData = await copyRes.json();
        return typeof copyData.text === "string" ? copyData.text : "";
      },
      ui: {
        pasteBtn: document.getElementById("vnc-paste-remote"),
        copyBtn: document.getElementById("vnc-copy-remote"),
        textarea: document.getElementById("vnc-clipboard-text"),
        hint: document.querySelector(".vnc-clipboard-hint"),
      },
    });
    const scrollDetach = attachVncScrollBridge(screenEl, { skipWheel: true });
    attachVncLocalGestures(screenEl, {
      rfb,
      onScroll: (direction, amount) => {
        if (typeof scrollDetach.enqueueWheel === "function") {
          scrollDetach.enqueueWheel(direction, amount);
        }
      },
    });
    rfb.addEventListener("connect", () => {
      statusEl.textContent = `connected ${fb.width}×${fb.height}`;
      layout();
    });
    rfb.addEventListener("disconnect", () => {
      statusEl.textContent = "disconnected — if jWeb is open on desktop, close it and reload";
    });
  };

  // Defer until flex layout assigns height to #vnc-frame (mobile Safari).
  requestAnimationFrame(() => {
    layout();
    requestAnimationFrame(() => layout());
  });
  await connectLive();
  layout();
  scanFields({ fast: true })
    .then(() => scanFields({ fast: false, silent: true }))
    .catch(() => undefined);

  window.setInterval(async () => {
    const statusRes = await fetch("api/status", { cache: "no-store" }).catch(() => undefined);
    if (!statusRes?.ok) return;
    data = await statusRes.json();
    if (await maybeWarm(data)) {
      await fetch("api/camofox/fit-viewport", { method: "POST", cache: "no-store" }).catch(() => undefined);
      if (!rfb) await connectLive().catch(() => undefined);
    }
  }, 8000);

  new ResizeObserver(() => layout()).observe(frameEl);
  window.addEventListener("orientationchange", () => window.setTimeout(() => layout(), 100));
}

main().catch((err) => {
  const root = document.getElementById("handoff-root");
  if (root) root.innerHTML = `<p style="padding:1rem;color:#f88">${String(err.message || err)}</p>`;
});
