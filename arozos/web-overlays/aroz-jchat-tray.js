/**
 * jChat desk — taskbar tray (avatar + mic + VU meter) and notification toasts.
 * Replaces the stock background-tasks button on the bottom-right nav strip.
 */
(function () {
  var METER_BARS = 10;

  var trayState = {
    assistantName: "John",
    portraitUrl: "",
    notification: null,
    notificationDismissed: false,
    voiceInputOn: false,
    voiceAvailable: false,
    audioLevel: 0,
  };

  function jpQuery() {
    return window.jQuery || null;
  }

  function jpIsJChatFloatWindow($, fw) {
    if (!fw || !fw.length) return false;
    var src = String(fw.find("iframe").attr("src") || "").toLowerCase();
    if (src.indexOf("hermes-chat") !== -1 || src.indexOf("joshu-hermes-chat") !== -1) {
      return true;
    }
    return String(fw.find(".controls .title").first().text() || "").trim() === "jChat";
  }

  function jpFloatWindowElIsJChat(el) {
    if (!el || el.nodeType !== 1) return false;
    var iframe = el.querySelector("iframe");
    if (iframe) {
      var src = String(iframe.getAttribute("src") || "").toLowerCase();
      if (src.indexOf("hermes-chat") !== -1 || src.indexOf("joshu-hermes-chat") !== -1) {
        return true;
      }
    }
    var title = el.querySelector(".controls .title");
    return Boolean(title && String(title.textContent || "").trim() === "jChat");
  }

  function jpJChatFloatWindow($) {
    var found = null;
    $(".floatWindow").each(function () {
      var fw = $(this);
      if (!jpIsJChatFloatWindow($, fw)) return;
      found = fw;
      return false;
    });
    return found;
  }

  function jpJChatIsOpen($) {
    var fw = jpJChatFloatWindow($);
    if (!fw || !fw.length) return false;
    return !fw.hasClass("jp-jchat-dock-hidden");
  }

  function jpSetJChatVisible(fw, visible) {
    if (!fw || !fw.length) return;
    if (visible) {
      fw.removeClass("jp-jchat-dock-hidden");
      if (typeof window.MoveFloatWindowToTop === "function") {
        window.MoveFloatWindowToTop(fw);
      }
    } else {
      fw.addClass("jp-jchat-dock-hidden");
    }
  }

  function jpJChatIframe() {
    var $ = jpQuery();
    if (!$) return null;
    var fw = jpJChatFloatWindow($);
    if (!fw || !fw.length) return null;
    return fw.find("iframe")[0] || null;
  }

  function jpMeterBarHtml() {
    var html = "";
    for (var i = 0; i < METER_BARS; i++) {
      html += '<span class="jp-jchat-tray-meter-bar" data-idx="' + i + '"></span>';
    }
    return html;
  }

  function jpEnsureToastDom() {
    if (document.getElementById("jp-jchat-tray-toast")) return;

    var toast = document.createElement("div");
    toast.id = "jp-jchat-tray-toast";
    toast.className = "jp-jchat-tray-toast";
    toast.hidden = true;
    toast.setAttribute("role", "status");
    toast.innerHTML =
      '<button type="button" class="jp-jchat-tray-toast-close" aria-label="Dismiss">×</button>' +
      '<img class="jp-jchat-tray-toast-photo" id="jp-jchat-tray-toast-img" alt="" />' +
      '<div class="jp-jchat-tray-toast-body">' +
      '<p class="jp-jchat-tray-toast-name"><span id="jp-jchat-tray-toast-dot"></span><span id="jp-jchat-tray-toast-name"></span></p>' +
      '<p class="jp-jchat-tray-toast-msg" id="jp-jchat-tray-toast-msg"></p>' +
      "</div>";

    document.body.appendChild(toast);

    toast.querySelector(".jp-jchat-tray-toast-close").addEventListener("click", function (evt) {
      evt.stopPropagation();
      trayState.notificationDismissed = true;
      trayState.notification = null;
      jpSyncTray();
    });
    toast.addEventListener("click", jpOpenJChat);
  }

  function jpEnsureTrayDom() {
    var root = document.getElementById("backgroundtaskBtn");
    if (!root || root.getAttribute("data-jp-jchat-tray") === "1") return;

    root.setAttribute("data-jp-jchat-tray", "1");
    root.removeAttribute("onclick");
    root.removeAttribute("ontouchstart");
    root.classList.remove("clickable");
    root.classList.add("jp-jchat-tray-root");

    root.innerHTML =
      '<div class="jp-jchat-tray-controls">' +
      '<div id="jp-jchat-tray-meter" class="jp-jchat-tray-meter jp-jchat-tray-meter-off" aria-hidden="true">' +
      jpMeterBarHtml() +
      "</div>" +
      '<button type="button" id="jp-jchat-tray-mic" class="jp-jchat-tray-mic" aria-pressed="false" aria-label="Toggle voice mode" title="Voice mode">' +
      '<svg class="jp-jchat-tray-mic-icon" viewBox="0 0 24 24" aria-hidden="true">' +
      '<path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z"/>' +
      "</svg>" +
      "</button>" +
      '<button type="button" id="jp-jchat-tray-avatar" class="jp-jchat-tray-avatar" aria-label="Open jChat">' +
      '<img id="jp-jchat-tray-avatar-img" alt="" />' +
      '<span id="jp-jchat-tray-badge" class="jp-jchat-tray-badge" hidden></span>' +
      '<span id="jp-jchat-tray-online" class="jp-jchat-tray-online" aria-hidden></span>' +
      "</button>" +
      "</div>";

    jpEnsureToastDom();

    root.querySelector("#jp-jchat-tray-avatar").addEventListener("click", jpToggleJChat);
    root.querySelector("#jp-jchat-tray-mic").addEventListener("click", function (evt) {
      evt.stopPropagation();
      jpToggleVoice();
    });

    jpSwapClockAndTrayOrder();
  }

  /** float:right stacks right-to-left in DOM order — clock first = far right. */
  function jpSwapClockAndTrayOrder() {
    var root = document.getElementById("backgroundtaskBtn");
    var clock = document.querySelector("#navimenu .item.clock");
    if (!root || !clock || !root.parentNode) return;
    if (clock.nextElementSibling === root) return;
    root.parentNode.insertBefore(clock, root);
  }

  function jpSetVisible(el, visible) {
    if (!el) return;
    el.hidden = !visible;
    el.classList.toggle("jp-jchat-tray-hidden", !visible);
  }

  function jpResolvePortrait(url) {
    if (url && String(url).trim()) return String(url).trim();
    return "./img/joshu/chat-portrait.jpg";
  }

  function jpUpdateMeter() {
    var meter = document.getElementById("jp-jchat-tray-meter");
    if (!meter) return;

    var voiceActive = trayState.voiceInputOn && trayState.voiceAvailable;
    meter.classList.toggle("jp-jchat-tray-meter-off", !voiceActive);

    var level = voiceActive ? Math.max(0, Math.min(1, trayState.audioLevel || 0)) : 0;
    var bars = meter.querySelectorAll(".jp-jchat-tray-meter-bar");
    for (var i = 0; i < bars.length; i++) {
      var threshold = (i + 1) / bars.length;
      bars[i].classList.toggle("jp-jchat-tray-meter-bar-lit", level >= threshold * 0.82);
    }
  }

  function jpUpdateMicButton() {
    var mic = document.getElementById("jp-jchat-tray-mic");
    if (!mic) return;

    var on = trayState.voiceInputOn && trayState.voiceAvailable;
    var disabled = !trayState.voiceAvailable;

    mic.classList.toggle("jp-jchat-tray-mic-on", on);
    mic.classList.toggle("jp-jchat-tray-mic-disabled", disabled);
    mic.setAttribute("aria-pressed", on ? "true" : "false");
    mic.setAttribute("aria-disabled", disabled ? "true" : "false");
    mic.title = disabled
      ? "Voice unavailable"
      : on
        ? "Voice mode on — click to mute"
        : "Voice mode off — click to talk";
  }

  function jpSyncTray() {
    jpEnsureTrayDom();
    var $ = jpQuery();
    var chatOpen = $ ? jpJChatIsOpen($) : false;

    if (chatOpen) {
      trayState.notificationDismissed = true;
      trayState.notification = null;
    }

    var portrait = jpResolvePortrait(trayState.portraitUrl);
    var avatarImg = document.getElementById("jp-jchat-tray-avatar-img");
    var toastImg = document.getElementById("jp-jchat-tray-toast-img");
    if (avatarImg) avatarImg.src = portrait;
    if (toastImg) toastImg.src = portrait;

    var nameEl = document.getElementById("jp-jchat-tray-toast-name");
    if (nameEl) nameEl.textContent = trayState.assistantName || "John";

    var msgEl = document.getElementById("jp-jchat-tray-toast-msg");
    if (msgEl) msgEl.textContent = trayState.notification || "";

    var hasNotification =
      Boolean(trayState.notification) && !trayState.notificationDismissed && !chatOpen;

    var badge = document.getElementById("jp-jchat-tray-badge");
    if (badge && hasNotification) badge.textContent = "1";
    jpSetVisible(badge, hasNotification);
    jpSetVisible(document.getElementById("jp-jchat-tray-toast"), hasNotification);

    var avatar = document.getElementById("jp-jchat-tray-avatar");
    if (avatar) {
      avatar.classList.toggle("jp-jchat-tray-avatar-open", chatOpen);
      avatar.title = chatOpen
        ? "Close chat with " + (trayState.assistantName || "John")
        : "Chat with " + (trayState.assistantName || "John");
      avatar.setAttribute("aria-label", chatOpen ? "Close jChat" : "Open jChat");
    }

    jpUpdateMicButton();
    jpUpdateMeter();
  }

  function jpScheduleSyncTray() {
    window.setTimeout(jpSyncTray, 50);
    window.setTimeout(jpSyncTray, 250);
  }

  function jpPostVoiceToggle() {
    var iframe = jpJChatIframe();
    if (iframe && iframe.contentWindow) {
      iframe.contentWindow.postMessage({ type: "jchat:voice-toggle" }, "*");
      return true;
    }
    return false;
  }

  function jpToggleVoice() {
    if (!trayState.voiceAvailable) return;
    if (jpPostVoiceToggle()) return;

    jpOpenJChat();
    window.setTimeout(function () {
      jpPostVoiceToggle();
    }, 650);
  }

  function jpOpenJChat() {
    trayState.notificationDismissed = true;
    trayState.notification = null;

    var $ = jpQuery();
    var fw = $ ? jpJChatFloatWindow($) : null;
    if (fw && fw.length) {
      jpSetJChatVisible(fw, true);
      jpSyncTray();
      return;
    }

    if (typeof window.openModule === "function") {
      window.openModule("jChat");
    }
    jpScheduleSyncTray();
  }

  function jpToggleJChat() {
    trayState.notificationDismissed = true;
    trayState.notification = null;

    var $ = jpQuery();
    var fw = $ ? jpJChatFloatWindow($) : null;
    if (fw && fw.length) {
      jpSetJChatVisible(fw, !jpJChatIsOpen($));
      jpSyncTray();
      return;
    }

    jpOpenJChat();
  }

  /** Detect stock min/close on jChat — native listener (no jQuery timing dependency). */
  function jpInstallChromeSync() {
    document.addEventListener(
      "mousedown",
      function (evt) {
        var target = evt.target;
        if (!target || !target.closest) return;
        if (!target.closest(".buttons.closetoggle, .buttons.close")) return;
        var fwEl = target.closest(".floatWindow");
        if (!fwEl || !jpFloatWindowElIsJChat(fwEl)) return;
        jpScheduleSyncTray();
      },
      true
    );
  }

  /** When ArozOS removes the jChat float window from the DOM, refresh tray state. */
  function jpInstallFloatWindowObserver() {
    if (typeof MutationObserver === "undefined") return;
    var obs = new MutationObserver(function (mutations) {
      var changed = false;
      for (var i = 0; i < mutations.length; i++) {
        var m = mutations[i];
        var list = m.type === "childList" ? m.removedNodes : null;
        if (!list) continue;
        for (var j = 0; j < list.length; j++) {
          if (jpFloatWindowElIsJChat(list[j])) {
            changed = true;
            break;
          }
        }
        if (changed) break;
      }
      if (changed) jpSyncTray();
    });
    obs.observe(document.body, { childList: true });
  }

  function jpInstallMessageListener() {
    window.addEventListener("message", function (evt) {
      var data = evt.data;
      if (!data || !data.type) return;

      if (data.type !== "jchat:tray") return;
      if (typeof data.assistantName === "string") trayState.assistantName = data.assistantName;
      if (typeof data.portraitUrl === "string") trayState.portraitUrl = data.portraitUrl;
      if (typeof data.notification === "string" && data.notification.trim()) {
        trayState.notification = data.notification.trim();
        var $n = jpQuery();
        trayState.notificationDismissed = $n ? jpJChatIsOpen($n) : false;
      }
      if (typeof data.voiceInputOn === "boolean") trayState.voiceInputOn = data.voiceInputOn;
      if (typeof data.voiceAvailable === "boolean") trayState.voiceAvailable = data.voiceAvailable;
      if (typeof data.audioLevel === "number" && !Number.isNaN(data.audioLevel)) {
        trayState.audioLevel = data.audioLevel;
      }
      jpSyncTray();
    });
  }

  function jpHookTaskbar($) {
    $(document.body).on("mousedown click", ".floatWindowButton", function () {
      jpScheduleSyncTray();
    });
  }

  function jpBoot() {
    var legacy = document.getElementById("jp-jchat-tray-root");
    if (legacy && legacy.parentNode) legacy.parentNode.removeChild(legacy);

    jpEnsureTrayDom();
    jpSwapClockAndTrayOrder();
    jpInstallMessageListener();
    jpInstallChromeSync();
    jpInstallFloatWindowObserver();

    var $ = jpQuery();
    if ($) jpHookTaskbar($);

    fetch("/joshu/api/instance/identity", { cache: "no-store" })
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (json) {
        if (!json) return;
        if (json.name) trayState.assistantName = json.name;
        trayState.portraitUrl = json.avatarUrl || json.imageUrl || "";
        jpSyncTray();
      })
      .catch(function () {});

    fetch("/joshu/api/voice/status", { cache: "no-store" })
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (json) {
        if (!json) return;
        trayState.voiceAvailable = Boolean(json.available);
        jpSyncTray();
      })
      .catch(function () {});

    jpSyncTray();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", jpBoot);
  } else {
    jpBoot();
  }
})();
