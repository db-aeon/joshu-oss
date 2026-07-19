/**
 * Desktop toast for File Brain indexing / PDF·TXT ingest progress.
 * Polls /joshu/api/brain/status and shows a compact top-right toast while busy.
 */
(function () {
  var API_BASE = "/joshu/api/brain";
  var POLL_IDLE_MS = 8000;
  var POLL_BUSY_MS = 1500;
  var DONE_HOLD_MS = 3200;
  var STYLE_ID = "jp-filebrain-toast-style";
  var ROOT_ID = "jp-filebrain-toast";

  var state = {
    busy: false,
    label: "",
    detail: "",
    dismissed: false,
    readApiKey: undefined,
    timer: null,
    doneTimer: null,
    showingDone: false,
  };

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent =
      "#" +
      ROOT_ID +
      "{" +
      "position:fixed;top:18px;right:18px;z-index:10050;" +
      "display:flex;align-items:flex-start;gap:0.65rem;" +
      "max-width:min(360px,calc(100vw - 36px));" +
      "padding:0.7rem 0.85rem;border-radius:10px;" +
      "border:1px solid rgba(26,26,26,0.16);" +
      "background:rgba(255,252,245,0.96);" +
      "color:#1a1a1a;box-shadow:0 10px 28px rgba(26,26,26,0.14);" +
      "font:500 13px/1.35 ui-sans-serif,system-ui,-apple-system,sans-serif;" +
      "backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);" +
      "opacity:0;transform:translateY(-8px);pointer-events:none;" +
      "transition:opacity .2s ease,transform .2s ease;" +
      "}" +
      "#" +
      ROOT_ID +
      ".jp-filebrain-toast-visible{" +
      "opacity:1;transform:translateY(0);pointer-events:auto;" +
      "}" +
      "#" +
      ROOT_ID +
      " .jp-filebrain-toast-dot{" +
      "flex:0 0 auto;width:8px;height:8px;margin-top:0.35rem;" +
      "border-radius:50%;background:#e6b800;border:1px solid #1a1a1a;" +
      "animation:jp-filebrain-pulse 1.1s ease-in-out infinite;" +
      "}" +
      "#" +
      ROOT_ID +
      ".jp-filebrain-toast-done .jp-filebrain-toast-dot{" +
      "background:#3d8b6e;animation:none;" +
      "}" +
      "#" +
      ROOT_ID +
      " .jp-filebrain-toast-body{flex:1 1 auto;min-width:0;}" +
      "#" +
      ROOT_ID +
      " .jp-filebrain-toast-title{margin:0;font-weight:650;}" +
      "#" +
      ROOT_ID +
      " .jp-filebrain-toast-msg{" +
      "margin:0.2rem 0 0;color:rgba(26,26,26,0.72);font-weight:500;" +
      "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" +
      "}" +
      "#" +
      ROOT_ID +
      " .jp-filebrain-toast-close{" +
      "flex:0 0 auto;border:0;background:transparent;color:rgba(26,26,26,0.55);" +
      "font-size:16px;line-height:1;cursor:pointer;padding:0 0 0 0.25rem;" +
      "}" +
      "@keyframes jp-filebrain-pulse{0%,100%{opacity:1}50%{opacity:0.35}}";
    document.head.appendChild(style);
  }

  function ensureToast() {
    injectStyle();
    var existing = document.getElementById(ROOT_ID);
    if (existing) return existing;

    var root = document.createElement("div");
    root.id = ROOT_ID;
    root.setAttribute("role", "status");
    root.setAttribute("aria-live", "polite");
    root.hidden = true;
    root.innerHTML =
      '<span class="jp-filebrain-toast-dot" aria-hidden="true"></span>' +
      '<div class="jp-filebrain-toast-body">' +
      '<p class="jp-filebrain-toast-title"></p>' +
      '<p class="jp-filebrain-toast-msg"></p>' +
      "</div>" +
      '<button type="button" class="jp-filebrain-toast-close" aria-label="Dismiss">×</button>';

    root.querySelector(".jp-filebrain-toast-close").addEventListener("click", function (evt) {
      evt.stopPropagation();
      state.dismissed = true;
      state.showingDone = false;
      if (state.doneTimer) {
        clearTimeout(state.doneTimer);
        state.doneTimer = null;
      }
      setVisible(false);
    });

    root.addEventListener("click", function () {
      if (typeof window.openModule === "function") {
        window.openModule("File Brain");
      }
    });

    document.body.appendChild(root);
    return root;
  }

  function setVisible(visible) {
    var root = ensureToast();
    root.hidden = !visible;
    root.classList.toggle("jp-filebrain-toast-visible", visible);
  }

  function render() {
    var root = ensureToast();
    var title = root.querySelector(".jp-filebrain-toast-title");
    var msg = root.querySelector(".jp-filebrain-toast-msg");
    if (!title || !msg) return;

    if (state.showingDone) {
      root.classList.add("jp-filebrain-toast-done");
      title.textContent = "File Brain";
      msg.textContent = "Indexing finished";
      setVisible(true);
      return;
    }

    root.classList.remove("jp-filebrain-toast-done");
    if (!state.busy || state.dismissed) {
      setVisible(false);
      return;
    }

    title.textContent = "File Brain";
    msg.textContent = state.detail || state.label || "Updating index…";
    setVisible(true);
  }

  function activityLabel(activity) {
    if (!activity || typeof activity !== "object") {
      return { busy: false, label: "", detail: "" };
    }

    var pdf = activity.pdf_ingest || null;
    var txt = activity.txt_ingest || null;
    var reindex = activity.reindex || null;
    var parts = [];
    var detail = "";

    if (pdf && pdf.active) {
      if (pdf.phase === "running") {
        parts.push("Extracting PDFs");
        detail = pdf.last_message || detail;
      } else {
        parts.push("PDF ingest queued");
      }
    }
    if (txt && txt.active) {
      if (txt.phase === "running") {
        parts.push("Ingesting text");
        detail = txt.last_message || detail;
      } else {
        parts.push("Text ingest queued");
      }
    }
    if (reindex && reindex.active) {
      if (reindex.reindex_running) {
        parts.push("Reindexing");
      } else {
        parts.push("Reindex queued");
      }
    }

    var busy = Boolean(activity.busy) || parts.length > 0;
    return {
      busy: busy,
      label: parts.length ? parts.join(" · ") : busy ? "Updating index…" : "",
      detail: detail || (parts.length ? parts.join(" · ") : ""),
    };
  }

  function authHeaders() {
    var headers = { Accept: "application/json" };
    if (state.readApiKey) {
      headers.Authorization = "Bearer " + state.readApiKey;
    }
    return headers;
  }

  function resolveReadApiKey() {
    if (state.readApiKey !== undefined) {
      return Promise.resolve(state.readApiKey);
    }
    return fetch(API_BASE + "/viewer-config", { cache: "no-store", credentials: "same-origin" })
      .then(function (res) {
        if (!res.ok) {
          state.readApiKey = null;
          return null;
        }
        return res.json();
      })
      .then(function (body) {
        var key =
          body && typeof body.readApiKey === "string" && body.readApiKey.trim()
            ? body.readApiKey.trim()
            : null;
        state.readApiKey = key;
        return key;
      })
      .catch(function () {
        state.readApiKey = null;
        return null;
      });
  }

  function schedulePoll(ms) {
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(tick, ms);
  }

  function showDoneBriefly() {
    state.showingDone = true;
    state.dismissed = false;
    render();
    if (state.doneTimer) clearTimeout(state.doneTimer);
    state.doneTimer = setTimeout(function () {
      state.showingDone = false;
      state.doneTimer = null;
      render();
    }, DONE_HOLD_MS);
  }

  function tick() {
    resolveReadApiKey()
      .then(function () {
        return fetch(API_BASE + "/status", {
          cache: "no-store",
          credentials: "same-origin",
          headers: authHeaders(),
        });
      })
      .then(function (res) {
        if (!res.ok) throw new Error("status " + res.status);
        return res.json();
      })
      .then(function (body) {
        var next = activityLabel(body && body.activity);
        var wasBusy = state.busy;
        state.busy = next.busy;
        state.label = next.label;
        state.detail = next.detail;
        if (next.busy) {
          state.dismissed = false;
          state.showingDone = false;
          if (state.doneTimer) {
            clearTimeout(state.doneTimer);
            state.doneTimer = null;
          }
        } else if (wasBusy && !next.busy) {
          showDoneBriefly();
        }
        render();
        schedulePoll(next.busy ? POLL_BUSY_MS : POLL_IDLE_MS);
      })
      .catch(function () {
        // Fail quiet — File Brain may be offline during boot.
        schedulePoll(POLL_IDLE_MS);
      });
  }

  function boot() {
    ensureToast();
    tick();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
