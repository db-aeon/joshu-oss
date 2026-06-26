/**
 * Desktop icons: sync native title tooltips from label text (labels stay visible in CSS).
 * Also rewrites cached stock folder glyphs to versioned Joshu Tango PNGs (one write per icon).
 * Re-runs when ArozOS adds or updates .launchIcon nodes (upload, refresh, rename).
 */
(function () {
  var FOLDER_EMPTY = "img/joshu/folder.png?v=2";
  var FOLDER_OPEN = "img/joshu/folder-open.png?v=2";
  var STOCK_FOLDER_RE =
    /img\/desktop\/(?:system_icon\/folder(?:-with-content)?|files_icon\/[^/]+\/folder(?: outline|-with-content)?)\.png/;

  function jpFolderImagePath(iconEl, currentSrc) {
    if (STOCK_FOLDER_RE.test(currentSrc || "")) {
      return /folder-with-content|folder outline/.test(currentSrc)
        ? FOLDER_OPEN
        : FOLDER_EMPTY;
    }
    if ((currentSrc || "").indexOf("folder-open") >= 0) {
      return FOLDER_OPEN;
    }
    if ((currentSrc || "").indexOf("img/joshu/folder.png") >= 0) {
      return FOLDER_EMPTY;
    }
    return FOLDER_OPEN;
  }

  function jpSyncFolderIconGlyph(iconEl) {
    if (iconEl.getAttribute("type") !== "folder") return;
    var img = iconEl.querySelector(".launchIconImage");
    if (!img) return;
    var src = img.getAttribute("src") || "";
    var target = jpFolderImagePath(iconEl, src);
    // Thumbnail loader replaces folder icons with cached stock previews; restore Tango glyph.
    if (src.indexOf("data:image") === 0 || src !== target) {
      img.setAttribute("src", target);
      img.style.padding = "";
    }
  }

  function jpLabelText(iconEl) {
    var label = iconEl.querySelector(".launchIconText");
    if (!label) return "";
    return (label.textContent || "").replace(/\s+/g, " ").trim();
  }

  function jpSyncDesktopIconTooltips(root) {
    var scope = root && root.querySelectorAll ? root : document;
    var icons = scope.querySelectorAll
      ? scope.querySelectorAll(".launchIcon")
      : [];
    for (var i = 0; i < icons.length; i++) {
      var icon = icons[i];
      jpSyncFolderIconGlyph(icon);
      var name = jpLabelText(icon);
      if (!name) continue;
      icon.setAttribute("title", name);
      var wrapper = icon.querySelector(".launchIconWrapper");
      if (wrapper) wrapper.setAttribute("title", name);
      var img = icon.querySelector(".launchIconImage");
      if (img) img.setAttribute("title", name);
    }
  }

  function jpInstallObserver() {
    var desktop = document.getElementById("desktop") || document.body;
    if (!desktop || desktop.__jpIconTooltipObserver) return;
    desktop.__jpIconTooltipObserver = true;
    var observer = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var m = mutations[i];
        if (m.type === "attributes" && m.attributeName === "src") {
          var icon = m.target.closest && m.target.closest(".launchIcon");
          if (icon) {
            jpSyncFolderIconGlyph(icon);
          }
        }
        jpSyncDesktopIconTooltips(m.target);
      }
    });
    observer.observe(desktop, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["src"],
    });
  }

  function jpInit() {
    jpSyncDesktopIconTooltips(document);
    jpInstallObserver();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", jpInit);
  } else {
    jpInit();
  }

  window.jpSyncDesktopIconTooltips = jpSyncDesktopIconTooltips;
})();
