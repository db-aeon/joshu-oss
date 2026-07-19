/**
 * Hydrate the public guest identity lockup (portrait + name + {owner}'s Joshu).
 * Used on ArozOS File Share pages; Share Chat injects identity server-side instead.
 *
 * Expects markup:
 *   <div class="jp-identity" data-jp-identity hidden>
 *     <div class="jp-identity-photo" data-jp-photo></div>
 *     <div class="jp-identity-copy">
 *       <p class="jp-identity-name" data-jp-name></p>
 *       <p class="jp-identity-role" data-jp-role></p>
 *     </div>
 *   </div>
 */
(function () {
  function roleLine(ownerDisplayName) {
    var owner = String(ownerDisplayName || "").trim();
    if (!owner) return "Joshu";
    return owner + "'s Joshu";
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function photoHtml(name, portraitUrl) {
    var safeName = escapeHtml(name);
    if (portraitUrl) {
      return (
        '<img class="jp-identity-img" src="' +
        escapeHtml(portraitUrl) +
        '" alt="' +
        safeName +
        '" width="72" height="72" decoding="async" />'
      );
    }
    var initial = escapeHtml((name.trim().charAt(0) || "?").toUpperCase());
    return '<span class="jp-identity-fallback" aria-hidden="true">' + initial + "</span>";
  }

  function identityUrls() {
    var urls = [];
    var configured =
      typeof window.JOSHU_PUBLIC_IDENTITY_URL === "string"
        ? window.JOSHU_PUBLIC_IDENTITY_URL.trim()
        : "";
    if (configured) urls.push(configured);
    // Live identity when ArozOS proxies /joshu (VPS / subservice).
    urls.push("/joshu/api/instance/identity");
    urls.push("/api/instance/identity");
    // Same-origin snapshot from theme apply (local / guest paths without /joshu).
    urls.push("/script/joshu-public-persona.json");
    return urls;
  }

  async function fetchIdentity() {
    var lastErr = null;
    var urls = identityUrls();
    for (var i = 0; i < urls.length; i++) {
      try {
        var res = await fetch(urls[i], { credentials: "same-origin" });
        if (!res.ok) {
          lastErr = new Error("HTTP " + res.status);
          continue;
        }
        return await res.json();
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error("identity unavailable");
  }

  function applyIdentity(root, data) {
    var name = String((data && data.name) || "").trim() || "Companion";
    var portrait =
      (data && data.imageUrl && String(data.imageUrl).trim()) ||
      (data && data.avatarUrl && String(data.avatarUrl).trim()) ||
      "";
    var owner =
      data && data.owner && data.owner.displayName
        ? String(data.owner.displayName)
        : "";

    var photo = root.querySelector("[data-jp-photo]");
    var nameEl = root.querySelector("[data-jp-name]");
    var roleEl = root.querySelector("[data-jp-role]");
    if (photo) photo.innerHTML = photoHtml(name, portrait);
    if (nameEl) nameEl.textContent = name;
    if (roleEl) roleEl.textContent = roleLine(owner);
    root.setAttribute("aria-label", name);
    root.hidden = false;
  }

  function boot() {
    var roots = document.querySelectorAll("[data-jp-identity]");
    if (!roots.length) return;
    fetchIdentity()
      .then(function (data) {
        for (var i = 0; i < roots.length; i++) applyIdentity(roots[i], data);
      })
      .catch(function () {
        /* Leave identity hidden — wordmark still present. */
      });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
