/**
 * Clears stuck full-screen desktop layers (notification shade, drag capture planes,
 * invisible fade leftovers, Semantic UI dimmers) that block clicks after login.
 * Also coordinates multi-tab loads and can re-bind desktop handlers when overlays are clean
 * but the tab is still wedged.
 */
(function () {
  var TAB_ID = window.__arozDesktopTabId || Math.random().toString(36).slice(2);
  window.__arozDesktopTabId = TAB_ID;

  function jpDescribe(el) {
    if (!el || el === document.documentElement) return "html";
    var id = el.id ? "#" + el.id : "";
    var cls = el.className && typeof el.className === "string"
      ? "." + el.className.trim().split(/\s+/).slice(0, 3).join(".")
      : "";
    return el.tagName.toLowerCase() + id + cls;
  }

  function jpStackDetails(x, y) {
    return document.elementsFromPoint(x, y).slice(0, 12).map(function (el) {
      var style = window.getComputedStyle(el);
      return {
        el: jpDescribe(el),
        pointerEvents: style.pointerEvents,
        zIndex: style.zIndex,
        opacity: style.opacity,
        display: style.display,
      };
    });
  }

  function jpKillInvisibleBlockers() {
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var killed = [];
    document.querySelectorAll("body *").forEach(function (el) {
      if (el.id === "navimenu" || el.closest("#navimenu, .launchIcon, .floatWindow")) return;
      var style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") return;
      if (style.position !== "fixed" && style.position !== "absolute") return;
      var opacity = parseFloat(style.opacity);
      if (!(opacity < 0.15)) return;
      if (style.pointerEvents === "none") return;
      var rect = el.getBoundingClientRect();
      if (rect.width < vw * 0.85 || rect.height < vh * 0.85) return;
      el.style.pointerEvents = "none";
      el.style.display = "none";
      killed.push(jpDescribe(el));
    });
    return killed;
  }

  function jpForceNotificationClosed() {
    document.querySelectorAll(".notificationbar").forEach(function (el) {
      el.classList.remove("jp-notifications-open");
      el.style.display = "none";
      el.style.pointerEvents = "none";
      el.style.opacity = "1";
      el.querySelectorAll(".cover").forEach(function (cover) {
        cover.style.display = "none";
        cover.style.pointerEvents = "none";
        cover.style.opacity = "0";
      });
    });
  }

  function jpClearInitBanners() {
    var cleared = [];
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    document.querySelectorAll("body *").forEach(function (el) {
      if (el.closest("#navimenu, .floatWindow, .launchIcon, .notificationbar .content")) return;
      var text = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (!/initializ/i.test(text)) return;
      var style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") return;
      var rect = el.getBoundingClientRect();
      var largeOverlay = rect.width >= vw * 0.35 && rect.height >= vh * 0.12;
      var fixedOverlay = style.position === "fixed" || style.position === "absolute";
      if (!largeOverlay && !fixedOverlay) return;
      el.style.pointerEvents = "none";
      el.style.display = "none";
      cleared.push(jpDescribe(el));
    });
    return cleared;
  }

  function jpClearInitSplash() {
    if (typeof window.clearDesktopInitSplash === "function") {
      window.clearDesktopInitSplash();
    } else {
      document.body.style.backgroundImage = "none";
      document.body.style.backgroundColor = "#000000";
    }
  }

  function jpReset($) {
    jpClearInitSplash();
    jpForceNotificationClosed();
    if (typeof window.resetDesktopInteractionLayers === "function") {
      window.resetDesktopInteractionLayers();
    }
    $(".notificationbar").removeClass("jp-notifications-open").stop(true, true).hide()
      .css({ display: "none", "pointer-events": "none", opacity: 1 });
    $(".notificationbar .cover").css({ display: "none", "pointer-events": "none", opacity: 0 });
    $("#fwdragpanel, #tfwdragpanel").hide().css({ "pointer-events": "none" });
    $(".floatWindow").css({ "pointer-events": "auto", opacity: 1 });
    $(".floatWindow").find(".iframecover").hide();
    $("#selectionPanel").hide();
    $("#quickAccessPanel").stop(true, true).hide();
    $("#backgroundTaskPanel").stop(true, true).hide();
    $("#listMenu").stop(true, true).hide();
    $("body > .ui.dimmer.active").removeClass("active").hide();
    if (typeof window.movingWindow !== "undefined") window.movingWindow = false;
    if (typeof window.resizingWindow !== "undefined") window.resizingWindow = false;
    if (typeof window.resizingEdgeID !== "undefined") window.resizingEdgeID = 0;
    if (typeof window.multiSelecting !== "undefined") window.multiSelecting = false;
    if (typeof window.multiSelectionStartPoint !== "undefined") {
      window.multiSelectionStartPoint = [-1, -1];
    }
    if (typeof window.resizingWindowTarget !== "undefined") {
      window.resizingWindowTarget = undefined;
    }
    if (typeof window.listMenuShown !== "undefined") window.listMenuShown = false;
    var killed = jpKillInvisibleBlockers();
    var cleared = jpClearInitBanners();
    return killed.concat(cleared);
  }

  function jpDiagnose() {
    var points = [
      [window.innerWidth / 2, window.innerHeight / 2],
      [window.innerWidth / 2, window.innerHeight - 18],
      [48, window.innerHeight - 18],
    ];
    return points.map(function (pt) {
      return {
        x: Math.round(pt[0]),
        y: Math.round(pt[1]),
        stack: document.elementsFromPoint(pt[0], pt[1]).slice(0, 8).map(jpDescribe),
        details: jpStackDetails(pt[0], pt[1]),
      };
    });
  }

  window.__arozDesktopDiag = function () {
    var jq = window.jQuery;
    return {
      initComplete: !!window.__arozDesktopInitComplete,
      tabId: TAB_ID,
      movingWindow: window.movingWindow,
      resizingWindow: window.resizingWindow,
      multiSelecting: window.multiSelecting,
      iconCount: document.querySelectorAll(".launchIcon").length,
      floatWindowCount: document.querySelectorAll(".floatWindow").length,
      notificationOpen: jq ? jq(".notificationbar").is(":visible") : null,
      dragPanels: {
        fw: jq ? jq("#fwdragpanel").is(":visible") : null,
        tfw: jq ? jq("#tfwdragpanel").is(":visible") : null,
      },
      handlers: {
        toggleListMenu: typeof window.toggleListMenu,
        iconDoubleClicked: typeof window.iconDoubleClicked,
        recoverDesktopInteraction: typeof window.recoverDesktopInteraction,
        initDesktop: typeof window.initDesktop,
      },
      hitTest: jpDiagnose(),
    };
  };

  function jpRun(log, options) {
    options = options || {};
    var jq = window.jQuery;
    if (!jq) return { ok: false, killed: [] };
    var killed = jpReset(jq);
    var diag = window.__arozDesktopDiag();
    if (log) {
      console.log("[aroz-desktop-overlay-guard] unblock", { killed: killed, diag: diag });
    }
    if (!options.skipRecover && killed.length === 0 && typeof window.arozRecoverDesktop === "function") {
      window.arozRecoverDesktop();
      diag = window.__arozDesktopDiag();
      if (log) {
        console.log("[aroz-desktop-overlay-guard] recover follow-up", { diag: diag });
      }
    }
    return { ok: true, killed: killed, diag: diag };
  }

  function jpScheduleRetries() {
    [50, 200, 750, 2000, 5000, 10000].forEach(function (ms) {
      window.setTimeout(function () { jpRun(false, { skipRecover: true }); }, ms);
    });
  }

  function jpMaybeReloadStaleTab(readyTabId) {
    if (readyTabId === TAB_ID) return;
    if (window.__arozDesktopInitComplete) return;
    jpRun(true, { skipRecover: false });
    window.setTimeout(function () {
      if (window.__arozDesktopInitComplete) return;
      if (document.visibilityState !== "visible") return;
      console.warn("[aroz-desktop-overlay-guard] another tab finished desktop init; reloading stale tab");
      window.location.reload();
    }, 1200);
  }

  window.arozUnblockDesktop = function () {
    return jpRun(true, { skipRecover: false });
  };

  window.__arozOnDesktopInitComplete = function () {
    jpRun(false, { skipRecover: true });
    try {
      localStorage.setItem("ao_desktop_ready", TAB_ID + ":" + Date.now());
    } catch (ex) {
      /* ignore */
    }
  };

  if (!window.__arozDesktopOverlayGuard) {
    window.__arozDesktopOverlayGuard = true;
    window.addEventListener("pageshow", function () {
      jpRun(false, { skipRecover: true });
      jpScheduleRetries();
    });
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") {
        jpRun(false, { skipRecover: false });
        jpScheduleRetries();
      }
    });
    window.addEventListener("focus", function () {
      jpRun(false, { skipRecover: false });
    });
    window.addEventListener("blur", function () {
      if (window.movingWindow || window.resizingWindow) jpRun(false, { skipRecover: true });
    });
    window.addEventListener("load", function () {
      jpRun(false, { skipRecover: true });
      jpScheduleRetries();
    });
    window.addEventListener("keydown", function (event) {
      if ((event.which || event.keyCode) === 27) jpRun(false, { skipRecover: false });
    });
    window.addEventListener("storage", function (event) {
      if (event.key !== "ao_desktop_ready" || !event.newValue) return;
      var readyTabId = String(event.newValue).split(":")[0];
      jpMaybeReloadStaleTab(readyTabId);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      var n = 0;
      var t = window.setInterval(function () {
        if (jpRun(false, { skipRecover: true }).ok || ++n > 120) window.clearInterval(t);
      }, 50);
    });
  } else {
    jpRun(false, { skipRecover: true });
    jpScheduleRetries();
  }
})();
