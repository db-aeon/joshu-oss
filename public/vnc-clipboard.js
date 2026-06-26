/**
 * Bidirectional clipboard bridge for noVNC (Camofox / x11vnc).
 *
 * Button + textarea UI is the reliable path (explicit user gesture for navigator.clipboard).
 * Keyboard shortcuts are kept as a convenience but may be flaky on canvas focus.
 */

const XK_CONTROL_L = 0xffe3;
const XK_SHIFT_L = 0xffe1;
const XK_V = 0x0076;
const XK_C = 0x0063;
const XK_A = 0x0061;

/** US keyboard — shifted symbol → base key */
const US_SHIFT = {
  "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7", "*": "8",
  "(": "9", ")": "0", "_": "-", "+": "=", "{": "[", "}": "]", "|": "\\",
  ":": ";", '"': "'", "<": ",", ">": ".", "?": "/", "~": "`",
};

const EXTENDED_CLIPBOARD_FORMAT_TEXT = 1;
const EXTENDED_CLIPBOARD_ACTION_NOTIFY = 1 << 27;

const ECHO_MS = 750;
const PASTE_PROVIDE_TIMEOUT_MS = 500;
const PASTE_FALLBACK_MS = 40;

function readHostClipboard() {
  if (navigator.clipboard?.readText) {
    return navigator.clipboard.readText().catch(() => "");
  }
  return Promise.resolve("");
}

async function writeLocalClipboard(text) {
  if (!navigator.clipboard?.writeText) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function sendRemoteCtrlV(rfb) {
  if (rfb._rfbConnectionState !== "connected" || rfb.viewOnly) return;
  rfb.sendKey(XK_CONTROL_L, "ControlLeft", true);
  rfb.sendKey(XK_V, "KeyV", true);
  rfb.sendKey(XK_V, "KeyV", false);
  rfb.sendKey(XK_CONTROL_L, "ControlLeft", false);
}

function sendRemoteCtrlC(rfb) {
  if (rfb._rfbConnectionState !== "connected" || rfb.viewOnly) return;
  rfb.sendKey(XK_CONTROL_L, "ControlLeft", true);
  rfb.sendKey(XK_C, "KeyC", true);
  rfb.sendKey(XK_C, "KeyC", false);
  rfb.sendKey(XK_CONTROL_L, "ControlLeft", false);
}

function sendRemoteCtrlA(rfb) {
  if (rfb._rfbConnectionState !== "connected" || rfb.viewOnly) return;
  rfb.sendKey(XK_CONTROL_L, "ControlLeft", true);
  rfb.sendKey(XK_A, "KeyA", true);
  rfb.sendKey(XK_A, "KeyA", false);
  rfb.sendKey(XK_CONTROL_L, "ControlLeft", false);
}

/** Keystroke injection — works in Firefox chrome (address bar) where VNC clipboard paste does not. */
function typeTextToRemote(rfb, text, { selectAll = false } = {}) {
  if (rfb.viewOnly || rfb._rfbConnectionState !== "connected") return false;
  if (typeof text !== "string" || text.length === 0) return false;

  if (selectAll) sendRemoteCtrlA(rfb);

  for (const ch of text) {
    let keysym = ch.charCodeAt(0);
    let shift = false;

    if (ch >= "A" && ch <= "Z") {
      shift = true;
      keysym = ch.toLowerCase().charCodeAt(0);
    } else if (US_SHIFT[ch]) {
      shift = true;
      keysym = US_SHIFT[ch].charCodeAt(0);
    } else if (keysym < 0x20 || keysym > 0x7e) {
      // Skip unsupported control / non-ASCII for now
      continue;
    }

    if (shift) rfb.sendKey(XK_SHIFT_L, "ShiftLeft", true);
    rfb.sendKey(keysym);
    if (shift) rfb.sendKey(XK_SHIFT_L, "ShiftLeft", false);
  }
  return true;
}

function usesExtendedClipboard(rfb) {
  return Boolean(
    rfb._clipboardServerCapabilitiesFormats?.[EXTENDED_CLIPBOARD_FORMAT_TEXT] &&
      rfb._clipboardServerCapabilitiesActions?.[EXTENDED_CLIPBOARD_ACTION_NOTIFY],
  );
}

function isPasteShortcut(event) {
  if (event.repeat || event.altKey || event.shiftKey) return false;
  const key = event.key?.toLowerCase();
  if (key !== "v") return false;
  return event.metaKey || event.ctrlKey;
}

function isCopyShortcut(event) {
  if (event.repeat || event.altKey || event.shiftKey) return false;
  const key = event.key?.toLowerCase();
  if (key !== "c") return false;
  return event.metaKey || event.ctrlKey;
}

function stopHostClipboardEvent(event) {
  event.preventDefault();
  event.stopPropagation();
  if (typeof event.stopImmediatePropagation === "function") {
    event.stopImmediatePropagation();
  }
}

/**
 * Core paste/copy logic for one RFB session.
 * @param {object} rfb
 */
export function createVncClipboardBridge(rfb) {
  let lastSentToRemote = "";
  let lastSentAt = 0;
  let pasteFallbackTimer = 0;
  let provideWatch = 0;

  const clearPasteTimers = () => {
    if (pasteFallbackTimer) {
      window.clearTimeout(pasteFallbackTimer);
      pasteFallbackTimer = 0;
    }
    if (provideWatch) {
      window.cancelAnimationFrame(provideWatch);
      provideWatch = 0;
    }
  };

  const scheduleRemotePaste = () => {
    clearPasteTimers();
    sendRemoteCtrlV(rfb);
  };

  const pasteToRemote = (text) => {
    if (typeof text !== "string" || text.length === 0) return false;
    if (rfb.viewOnly || rfb._rfbConnectionState !== "connected") return false;

    lastSentToRemote = text;
    lastSentAt = Date.now();
    clearPasteTimers();
    rfb.clipboardPasteFrom(text);

    if (!usesExtendedClipboard(rfb)) {
      pasteFallbackTimer = window.setTimeout(scheduleRemotePaste, PASTE_FALLBACK_MS);
      return true;
    }

    const deadline = Date.now() + PASTE_PROVIDE_TIMEOUT_MS;
    const waitForProvide = () => {
      provideWatch = 0;
      if (rfb._rfbConnectionState !== "connected") return;
      if (rfb._clipboardText === null || Date.now() >= deadline) {
        scheduleRemotePaste();
        return;
      }
      provideWatch = window.requestAnimationFrame(waitForProvide);
    };
    provideWatch = window.requestAnimationFrame(waitForProvide);
    return true;
  };

  const requestRemoteCopy = () => {
    if (rfb.viewOnly || rfb._rfbConnectionState !== "connected") return false;
    sendRemoteCtrlC(rfb);
    return true;
  };

  const typeToRemote = (text, opts = {}) => {
    if (typeof text !== "string" || text.length === 0) return false;
    lastSentToRemote = text;
    lastSentAt = Date.now();
    return typeTextToRemote(rfb, text, opts);
  };

  const shouldAcceptRemoteText = (text) => {
    if (typeof text !== "string" || text.length === 0) return false;
    return !(text === lastSentToRemote && Date.now() - lastSentAt < ECHO_MS);
  };

  const destroy = () => {
    clearPasteTimers();
  };

  return { pasteToRemote, typeToRemote, requestRemoteCopy, shouldAcceptRemoteText, destroy };
}

/**
 * @param {object} rfb
 * @param {{ targetEl?: HTMLElement, ui?: Record<string, HTMLElement | null> }} options
 */
export function attachVncClipboard(rfb, options = {}) {
  const { targetEl, ui = {} } = options;
  const bridge = createVncClipboardBridge(rfb);
  let vncEngaged = false;
  const cleanups = [];

  const setHint = (message) => {
    if (ui.hint) ui.hint.textContent = message;
  };

  const onRemoteClipboard = (event) => {
    const text = event.detail?.text;
    if (!bridge.shouldAcceptRemoteText(text)) return;
    void writeLocalClipboard(text);
    if (ui.textarea) ui.textarea.value = text;
    setHint("Copied from Camofox — also on your Mac clipboard.");
  };

  rfb.addEventListener("clipboard", onRemoteClipboard);
  cleanups.push(() => rfb.removeEventListener("clipboard", onRemoteClipboard));

  if (ui.pasteBtn) {
    const onPasteClick = () => {
      void (async () => {
        let text = ui.textarea?.value ?? "";
        if (!text.trim()) {
          text = await readHostClipboard();
          if (ui.textarea && text) ui.textarea.value = text;
        }
        if (!text.trim()) {
          setHint("Nothing to paste — type here or use Load from Mac.");
          return;
        }
        if (bridge.pasteToRemote(text)) {
          setHint("Pasted into page field (clipboard). For the address bar, use Type into browser.");
          if (targetEl) targetEl.querySelector("canvas")?.focus?.();
        } else {
          setHint("VNC not connected.");
        }
      })();
    };
    ui.pasteBtn.addEventListener("click", onPasteClick);
    cleanups.push(() => ui.pasteBtn.removeEventListener("click", onPasteClick));
  }

  if (ui.typeBtn) {
    const onTypeClick = () => {
      void (async () => {
        let text = ui.textarea?.value ?? "";
        if (!text.trim()) {
          text = await readHostClipboard();
          if (ui.textarea && text) ui.textarea.value = text;
        }
        if (!text.trim()) {
          setHint("Nothing to type — click the address bar in Camofox first, then try again.");
          return;
        }
        const selectAll = ui.typeSelectAll?.checked !== false;
        if (bridge.typeToRemote(text, { selectAll })) {
          setHint(selectAll ? "Typed into Camofox (replaced selection)." : "Typed into Camofox.");
          if (targetEl) targetEl.querySelector("canvas")?.focus?.();
        } else {
          setHint("VNC not connected.");
        }
      })();
    };
    ui.typeBtn.addEventListener("click", onTypeClick);
    cleanups.push(() => ui.typeBtn.removeEventListener("click", onTypeClick));
  }

  if (ui.copyBtn) {
    const onCopyClick = () => {
      if (bridge.requestRemoteCopy()) {
        setHint("Requested copy — select text in Camofox first, then try again if empty.");
      } else {
        setHint("VNC not connected.");
      }
    };
    ui.copyBtn.addEventListener("click", onCopyClick);
    cleanups.push(() => ui.copyBtn.removeEventListener("click", onCopyClick));
  }

  if (ui.loadMacBtn) {
    const onLoadMac = () => {
      void readHostClipboard().then((text) => {
        if (!text) {
          setHint("Mac clipboard empty or permission denied.");
          return;
        }
        if (ui.textarea) ui.textarea.value = text;
        setHint("Loaded from Mac — click Paste into browser.");
      });
    };
    ui.loadMacBtn.addEventListener("click", onLoadMac);
    cleanups.push(() => ui.loadMacBtn.removeEventListener("click", onLoadMac));
  }

  if (ui.saveMacBtn) {
    const onSaveMac = () => {
      const text = ui.textarea?.value ?? "";
      if (!text.trim()) {
        setHint("Nothing to copy to Mac.");
        return;
      }
      void writeLocalClipboard(text).then((ok) => {
        setHint(ok ? "Copied to Mac clipboard." : "Could not write Mac clipboard.");
      });
    };
    ui.saveMacBtn.addEventListener("click", onSaveMac);
    cleanups.push(() => ui.saveMacBtn.removeEventListener("click", onSaveMac));
  }

  if (ui.toggleBtn && ui.panel) {
    const onToggle = () => {
      const open = ui.panel.hasAttribute("hidden");
      if (open) ui.panel.removeAttribute("hidden");
      else ui.panel.setAttribute("hidden", "");
      ui.toggleBtn.setAttribute("aria-expanded", open ? "true" : "false");
    };
    ui.toggleBtn.addEventListener("click", onToggle);
    cleanups.push(() => ui.toggleBtn.removeEventListener("click", onToggle));
  }

  if (targetEl) {
    const onVncEngage = () => {
      vncEngaged = true;
    };
    const onVncDisengage = (event) => {
      const target = event.target;
      if (target instanceof Node && targetEl.contains(target)) return;
      vncEngaged = false;
    };
    const shouldHandleInVnc = (event) => {
      if (vncEngaged) return true;
      const active = document.activeElement;
      if (active && (active === targetEl || targetEl.contains(active))) return true;
      const target = event.target;
      if (target instanceof Node && targetEl.contains(target)) return true;
      return false;
    };

    const onLocalPasteKey = (event) => {
      if (!isPasteShortcut(event) || !shouldHandleInVnc(event)) return;
      stopHostClipboardEvent(event);
      void readHostClipboard().then((text) => {
        if (!text) return;
        if (ui.textarea) ui.textarea.value = text;
        bridge.pasteToRemote(text);
        setHint("Pasted into Camofox (keyboard).");
      });
    };

    const onLocalCopyKey = (event) => {
      if (!isCopyShortcut(event) || !shouldHandleInVnc(event)) return;
      stopHostClipboardEvent(event);
      bridge.requestRemoteCopy();
    };

    targetEl.addEventListener("pointerdown", onVncEngage, true);
    targetEl.addEventListener("focusin", onVncEngage, true);
    document.addEventListener("pointerdown", onVncDisengage, true);
    document.addEventListener("keydown", onLocalPasteKey, true);
    document.addEventListener("keydown", onLocalCopyKey, true);
    cleanups.push(() => {
      targetEl.removeEventListener("pointerdown", onVncEngage, true);
      targetEl.removeEventListener("focusin", onVncEngage, true);
      document.removeEventListener("pointerdown", onVncDisengage, true);
      document.removeEventListener("keydown", onLocalPasteKey, true);
      document.removeEventListener("keydown", onLocalCopyKey, true);
    });
  }

  return () => {
    for (const fn of cleanups) fn();
    bridge.destroy();
  };
}
