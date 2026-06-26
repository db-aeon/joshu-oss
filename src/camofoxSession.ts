export interface CamofoxTab {
  tabId: string;
  targetId?: string;
  url: string;
  title?: string;
  listItemId?: string;
}

export interface CamofoxPageObservation {
  tab: CamofoxTab;
  url?: string;
  title?: string;
  snapshot: string;
  refsCount?: number;
}

const HITL_TAB_SHIM = `
(() => {
  const SHIM_VERSION = 2;
  if (window.__hitlShimVersion === SHIM_VERSION) return 'already';
  window.__hitlShimInstalled = true;
  window.__hitlShimVersion = SHIM_VERSION;
  const fix = (root) => {
    if (!root || !root.querySelectorAll) return;
    root.querySelectorAll('a[target], area[target]').forEach((a) => {
      const target = String(a.target || '').toLowerCase();
      if (target !== '_blank' && target !== '_new') return;
      a.target = '_self';
      a.removeAttribute('rel');
    });
    root.querySelectorAll('form[target]').forEach((f) => {
      const target = String(f.target || '').toLowerCase();
      if (target === '_blank' || target === '_new') f.target = '_self';
    });
  };
  const sameTabNavigate = (url) => {
    if (!url) return false;
    try { location.href = String(url); return true; } catch (_) { return false; }
  };
  fix(document);
  new MutationObserver((muts) => muts.forEach((m) => m.addedNodes.forEach((n) => fix(n)))).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('click', (event) => {
    const anchor = event.target && event.target.closest ? event.target.closest('a[href], area[href]') : null;
    if (!anchor) return;
    const target = String(anchor.target || '').toLowerCase();
    const wantsNewContext = target === '_blank' || target === '_new' || event.metaKey || event.ctrlKey || event.shiftKey || event.button === 1;
    if (!wantsNewContext) return;
    if (sameTabNavigate(anchor.href)) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);
  document.addEventListener('auxclick', (event) => {
    const anchor = event.target && event.target.closest ? event.target.closest('a[href], area[href]') : null;
    if (!anchor) return;
    if (sameTabNavigate(anchor.href)) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);
  const origOpen = window.open;
  window.open = function(url, name, features) {
    try {
      if (url) location.href = String(url);
    } catch (e) {
      try { return origOpen.call(window, url, name, features); } catch (_) {}
    }
    return null;
  };
  return 'installed';
})()
`;

export class CamofoxSessionCoordinator {
  constructor(
    private readonly opts: {
      camofoxUrl: string;
      userId: string;
      sessionKey: string;
      singleTab: boolean;
      viewportWidth?: number;
      viewportHeight?: number;
    },
  ) {}

  /** Resize Playwright viewport and Firefox outer window to match the VNC framebuffer. */
  async readViewportMetrics(tabId?: string): Promise<{ innerWidth: number; innerHeight: number; screenWidth: number; screenHeight: number } | undefined> {
    const tab = tabId ? { tabId } : await this.currentTab();
    if (!tab?.tabId) return undefined;
    const url = new URL(`/tabs/${tab.tabId}/evaluate`, this.opts.camofoxUrl);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: this.opts.userId,
        expression: "JSON.stringify({ innerWidth: window.innerWidth, innerHeight: window.innerHeight, screenWidth: screen.width, screenHeight: screen.height })",
      }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return undefined;
    const data = await res.json() as { result?: string };
    if (!data.result) return undefined;
    try {
      const parsed = JSON.parse(data.result) as { innerWidth: number; innerHeight: number; screenWidth: number; screenHeight: number };
      return parsed;
    } catch {
      return undefined;
    }
  }

  async fitViewport(tabId?: string): Promise<void> {
    const width = this.opts.viewportWidth ?? 1024;
    const height = this.opts.viewportHeight ?? 768;
    const tab = tabId ? { tabId } : await this.currentTab();
    if (!tab?.tabId) return;
    const res = await fetch(new URL(`/tabs/${tab.tabId}/viewport`, this.opts.camofoxUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: this.opts.userId, width, height }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Camofox viewport fit failed: ${res.status}`);
  }

  async listTabs(): Promise<CamofoxTab[]> {
    const url = new URL("/tabs", this.opts.camofoxUrl);
    url.searchParams.set("userId", this.opts.userId);
    const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) throw new Error(`Camofox tabs failed: ${res.status}`);
    const data = await res.json() as { tabs?: CamofoxTab[] };
    return Array.isArray(data.tabs) ? data.tabs : [];
  }

  async currentTab(): Promise<CamofoxTab | undefined> {
    const tabs = await this.listTabs();
    const matching = tabs.filter((tab) => tab.listItemId === this.opts.sessionKey);
    return (matching.length > 0 ? matching : tabs).at(-1);
  }

  async ensureTab(url?: string): Promise<CamofoxTab> {
    const existing = await this.currentTab();
    if (!existing) {
      const created = await this.createTab(url);
      await this.installShim(created.tabId);
      return created;
    }
    if (this.opts.singleTab) await this.closeOtherTabs(existing.tabId).catch(() => undefined);
    const tab = url && existing.url !== url ? await this.navigate(existing.tabId, url) : existing;
    await this.installShim(tab.tabId);
    return tab;
  }

  async enforceSingleTab(): Promise<CamofoxTab | undefined> {
    const tab = await this.currentTab();
    if (!tab) return undefined;
    if (this.opts.singleTab) await this.closeOtherTabs(tab.tabId).catch(() => undefined);
    await this.installShim(tab.tabId);
    return tab;
  }

  async closeAllTabs(): Promise<void> {
    const tabs = await this.listTabs();
    await Promise.allSettled(tabs.map((tab) => this.closeTab(tab.tabId)));
  }

  async observe(tab: CamofoxTab): Promise<CamofoxPageObservation> {
    await this.installShim(tab.tabId);
    const url = new URL(`/tabs/${tab.tabId}/snapshot`, this.opts.camofoxUrl);
    url.searchParams.set("userId", this.opts.userId);
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`Camofox snapshot failed: ${res.status}`);
    const data = await res.json() as { snapshot?: string; refsCount?: number; url?: string; title?: string };
    return {
      tab,
      url: data.url ?? tab.url,
      title: data.title ?? tab.title,
      snapshot: data.snapshot ?? "",
      refsCount: data.refsCount,
    };
  }

  async installShim(tabId: string): Promise<void> {
    const url = new URL(`/tabs/${tabId}/evaluate`, this.opts.camofoxUrl);
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: this.opts.userId, expression: HITL_TAB_SHIM }),
      signal: AbortSignal.timeout(5_000),
    }).catch(() => undefined);
  }

  private async createTab(url?: string): Promise<CamofoxTab> {
    const res = await fetch(new URL("/tabs", this.opts.camofoxUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: this.opts.userId, sessionKey: this.opts.sessionKey, url }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`Camofox create tab failed: ${res.status}`);
    const data = await res.json() as { tabId: string; url?: string; title?: string };
    return { tabId: data.tabId, targetId: data.tabId, url: data.url ?? url ?? "about:blank", title: data.title, listItemId: this.opts.sessionKey };
  }

  private async navigate(tabId: string, url: string): Promise<CamofoxTab> {
    const res = await fetch(new URL(`/tabs/${tabId}/navigate`, this.opts.camofoxUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: this.opts.userId, url }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`Camofox navigate failed: ${res.status}`);
    const data = await res.json() as { url?: string; title?: string };
    return { tabId, targetId: tabId, url: data.url ?? url, title: data.title, listItemId: this.opts.sessionKey };
  }

  private async closeOtherTabs(keepTabId: string): Promise<void> {
    const tabs = await this.listTabs();
    await Promise.allSettled(tabs.filter((tab) => tab.tabId !== keepTabId).map((tab) => this.closeTab(tab.tabId)));
  }

  private async closeTab(tabId: string): Promise<void> {
    const url = new URL(`/tabs/${tabId}`, this.opts.camofoxUrl);
    url.searchParams.set("userId", this.opts.userId);
    await fetch(url, { method: "DELETE", signal: AbortSignal.timeout(10_000) });
  }
}
