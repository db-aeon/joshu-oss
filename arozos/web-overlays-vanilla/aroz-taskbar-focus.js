/**
 * Marks the taskbar tab that owns the front-most float window (z-index 101 or 501).
 * ArozOS does not add a CSS class for "active tab"; this keeps .jp-fwb-active in sync.
 * Loaded after desktop.html main script (defer, end of body).
 */
(function () {
  function jpFocusedFwId($) {
    var focusId = "";
    $(".floatWindow").each(function () {
      var z = parseInt($(this).css("z-index"), 10);
      if (z === 101 || z === 501) {
        focusId = $(this).attr("windowId") || $(this).attr("windowid") || "";
        return false;
      }
    });
    return focusId;
  }

  function jpSyncTaskbarActive($) {
    var fid = jpFocusedFwId($);
    $(".floatWindowButton").removeClass("jp-fwb-active");
    if (!fid) return;
    $(".floatWindowButton").each(function () {
      try {
        var raw = $(this).attr("windowIDGroup");
        if (!raw) return;
        var ids = JSON.parse(decodeURIComponent(raw));
        if (Array.isArray(ids) && ids.indexOf(fid) !== -1) {
          $(this).addClass("jp-fwb-active");
          return false;
        }
      } catch (_e) {
        /* ignore malformed windowIDGroup */
      }
    });
  }

  function jpInstall($) {
    $(function () {
      jpSyncTaskbarActive($);
      $(document.body).on(
        "mousedown click",
        ".floatWindow, .floatWindowButton, .closetoggle, .close, .mintoggle, .maxtoggle",
        function () {
          window.requestAnimationFrame(function () {
            jpSyncTaskbarActive($);
          });
        }
      );
      window.setInterval(function () {
        jpSyncTaskbarActive($);
      }, 1500);
    });
  }

  function jpTry() {
    var jq = window.jQuery;
    if (!jq) return false;
    jpInstall(jq);
    return true;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      var n = 0;
      var t = window.setInterval(function () {
        if (jpTry() || ++n > 80) window.clearInterval(t);
      }, 50);
    });
  } else {
    var n2 = 0;
    var t2 = window.setInterval(function () {
      if (jpTry() || ++n2 > 80) window.clearInterval(t2);
    }, 50);
  }
})();
