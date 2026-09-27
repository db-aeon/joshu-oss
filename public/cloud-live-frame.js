/**
 * Browser Use live view. The frame URL comes from a gated Joshu route.
 * The iframe matches the cloud screen (1024×768, 4:3) and is centered in the pane.
 * ui=false is applied on the server.
 */
export function mountCloudLiveFrame(screenEl, framePath, opts = {}) {
  const ratio = (opts.width || 1024) / (opts.height || 768);
  const pollMs = opts.pollMs || 8000;
  const visibilityAware = opts.visibilityAware !== false && !opts.interactive;
  screenEl.style.display = "flex";
  screenEl.style.alignItems = "center";
  screenEl.style.justifyContent = "center";
  screenEl.style.background = "#111";
  const frame = document.createElement("iframe");
  frame.title = "Shared browser";
  frame.setAttribute("allow", "autoplay");
  frame.style.cssText = "border:0;background:#111;flex:0 0 auto;";
  const fit = () => {
    const box = screenEl.getBoundingClientRect();
    if (box.width < 40 || box.height < 40) return;
    let height = box.height;
    let width = height * ratio;
    if (width > box.width) {
      width = box.width;
      height = width / ratio;
    }
    frame.style.width = `${Math.round(width)}px`;
    frame.style.height = `${Math.round(height)}px`;
  };
  fit();
  const fitObserver = new ResizeObserver(fit);
  fitObserver.observe(screenEl);
  screenEl.replaceChildren(frame);
  let mountedBrowserId = "";
  let hasFrame = false;

  const pollUrl = () => {
    // Resolve like fetch() would (document base, e.g. /joshu/) — resolving
    // against the origin dropped the /joshu/ prefix and 404'd every handoff poll.
    const url = new URL(framePath, document.baseURI);
    if (visibilityAware && document.visibilityState === "visible") {
      url.searchParams.set("viewer", "active");
    } else if (opts.interactive) {
      url.searchParams.set("viewer", "active");
    }
    return `${url.pathname}${url.search}`;
  };

  const tick = async () => {
    if (visibilityAware && document.visibilityState !== "visible") return;
    const res = await fetch(pollUrl(), { cache: "no-store", credentials: "same-origin" });
    if (!res.ok) {
      if (opts.onStatus) {
        opts.onStatus(hasFrame ? "reconnecting…" : "browser unavailable");
      }
      return;
    }
    const data = await res.json();
    if (data.warming && !data.url) {
      if (opts.onStatus) opts.onStatus(hasFrame ? "connected" : "connecting…");
      return;
    }
    const browserId = typeof data.browserId === "string" ? data.browserId : "";
    const nextUrl = typeof data.url === "string" ? data.url : "";
    // Reload only when Browser Use starts a new session — not on every poll or liveUrl tweak.
    const needsLoad = nextUrl && (!hasFrame || (browserId && browserId !== mountedBrowserId));
    if (needsLoad) {
      mountedBrowserId = browserId || mountedBrowserId;
      frame.src = nextUrl;
      hasFrame = true;
      if (opts.onStatus) opts.onStatus(`connected ${opts.width || 1024}×${opts.height || 768}`);
    } else if (hasFrame && opts.onStatus) {
      opts.onStatus(`connected ${opts.width || 1024}×${opts.height || 768}`);
    }
    // Handoff stays interactive. jWeb locks the picture while the agent is driving.
    const locked = opts.interactive ? false : data.agentDriving === true;
    frame.inert = locked;
    frame.style.pointerEvents = locked ? "none" : "auto";
    frame.tabIndex = locked ? -1 : 0;
  };
  void tick();
  const timer = window.setInterval(() => {
    void tick();
  }, pollMs);
  if (visibilityAware) {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") void tick();
    });
  }
  return () => {
    window.clearInterval(timer);
    fitObserver.disconnect();
  };
}
