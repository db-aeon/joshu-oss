/// <reference lib="dom" />
/**
 * Shared Chromium page via CDP. Handoff and jWeb keep calling
 * CamofoxSessionCoordinator; this is the browser underneath when BROWSER_CDP_URL is set.
 */
import type { Browser, BrowserContext, Frame, Page } from "playwright-core";
import { chromium } from "playwright-core";
import type { CatalogButton, CatalogField } from "./browserHandoff/formCatalog.js";

function isOauthPopupUrl(url: string | undefined): boolean {
  const value = (url ?? "").toLowerCase();
  if (!value) return false;
  return (
    value.includes("accounts.google.com") ||
    value.includes("accounts.youtube.com") ||
    value.includes("login.microsoftonline.com") ||
    value.includes("login.live.com") ||
    value.includes("github.com/login") ||
    value.includes("github.com/session") ||
    value.includes("appleid.apple.com")
  );
}

export interface ChromiumTab {
  tabId: string;
  targetId?: string;
  url: string;
  title?: string;
  listItemId?: string;
}

export interface ChromiumObservation {
  tab: ChromiumTab;
  url?: string;
  title?: string;
  snapshot: string;
  refsCount?: number;
}

const PROXY_TUNNEL_RE =
  /proxy server is refusing connections|Error code:\s*522|502 Bad Gateway or Proxy Error|Unable to connect to the proxy server|NS_ERROR_PROXY_CONNECTION_REFUSED|ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED|This site can.?t be reached/i;

function isBlankBrowserUrl(url: string | undefined): boolean {
  const value = (url ?? "").trim().toLowerCase();
  return !value || value === "about:blank" || value === "about:home";
}

function explainInsertFailure(reason?: string): string {
  if (reason === "readonly") return "That field is read-only.";
  if (reason === "no-field" || reason === "not-a-field" || reason === "non-text-input") {
    return "Click a text field in the page first, then paste.";
  }
  return reason ? `Paste failed: ${reason}` : "Click a text field in the page first, then paste.";
}

/** Same-tab shim. Passed to Playwright as a function so it runs in the page. */
function installHitlShim(): string {
  const version = 2;
  const w = window as unknown as { __hitlShimVersion?: number };
  if (w.__hitlShimVersion === version) return "already";
  w.__hitlShimVersion = version;
  const fix = (root: ParentNode | null) => {
    if (!root || !("querySelectorAll" in root)) return;
    root.querySelectorAll("a[target], area[target]").forEach((node) => {
      const anchor = node as HTMLAnchorElement;
      const target = String(anchor.target || "").toLowerCase();
      if (target !== "_blank" && target !== "_new") return;
      anchor.target = "_self";
      anchor.removeAttribute("rel");
    });
    root.querySelectorAll("form[target]").forEach((node) => {
      const form = node as HTMLFormElement;
      const target = String(form.target || "").toLowerCase();
      if (target === "_blank" || target === "_new") form.target = "_self";
    });
  };
  fix(document);
  new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      mutation.addedNodes.forEach((node) => {
        if (node instanceof Element) fix(node);
      });
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener(
    "click",
    (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const anchor = target?.closest("a[href], area[href]") as HTMLAnchorElement | null;
      if (!anchor) return;
      const named = String(anchor.target || "").toLowerCase();
      const wantsNew =
        named === "_blank" ||
        named === "_new" ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.button === 1;
      if (!wantsNew) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      location.href = anchor.href;
    },
    true,
  );
  const origOpen = window.open;
  window.open = function (url?: string | URL, name?: string, features?: string) {
    try {
      if (url) location.href = String(url);
    } catch {
      try {
        return origOpen.call(window, url, name, features);
      } catch {
        /* ignore */
      }
    }
    return null;
  };
  return "installed";
}

function insertIntoFocused(payload: { text: string; selectAll: boolean }): { ok: boolean; reason?: string; via?: string; chars?: number } {
  const text = payload.text;
  const selectAll = payload.selectAll;
  let el: Element | null = document.activeElement;
  while (el && (el as HTMLElement).shadowRoot?.activeElement) {
    el = (el as HTMLElement).shadowRoot!.activeElement;
  }
  if (!el || el === document.body || el === document.documentElement) return { ok: false, reason: "no-field" };
  const tag = String(el.tagName || "").toUpperCase();
  const type = tag === "INPUT" ? String((el as HTMLInputElement).type || "text").toLowerCase() : "";
  const skip = ["button", "submit", "checkbox", "radio", "file", "image", "reset", "hidden", "color", "range"];
  if (tag === "INPUT" && skip.includes(type)) return { ok: false, reason: "non-text-input" };
  if (tag === "INPUT" || tag === "TEXTAREA") {
    const input = el as HTMLInputElement | HTMLTextAreaElement;
    if (input.disabled || input.readOnly) return { ok: false, reason: "readonly" };
    const value = String(input.value || "");
    const start = selectAll ? 0 : input.selectionStart == null ? value.length : input.selectionStart;
    const end = selectAll ? value.length : input.selectionEnd == null ? start : input.selectionEnd;
    const next = value.slice(0, start) + text + value.slice(end);
    const proto = tag === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc?.set) desc.set.call(input, next);
    else input.value = next;
    try {
      input.setSelectionRange(start + text.length, start + text.length);
    } catch {
      /* ignore */
    }
    input.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, inputType: "insertFromPaste", data: text }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, via: "value", chars: text.length };
  }
  if ((el as HTMLElement).isContentEditable) {
    (el as HTMLElement).focus();
    if (selectAll) document.execCommand("selectAll", false);
    const okEdit = document.execCommand("insertText", false, text);
    return { ok: !!okEdit, via: "execCommand", chars: text.length };
  }
  const okAny = document.execCommand("insertText", false, text);
  if (okAny) return { ok: true, via: "execCommand-fallback", chars: text.length };
  return { ok: false, reason: "not-a-field" };
}

function readFocusedText(): { text: string } {
  let el: Element | null = document.activeElement;
  while (el && (el as HTMLElement).shadowRoot?.activeElement) {
    el = (el as HTMLElement).shadowRoot!.activeElement;
  }
  if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) {
    const input = el as HTMLInputElement;
    if (typeof input.selectionStart === "number") {
      const start = input.selectionStart || 0;
      const end = input.selectionEnd || 0;
      if (end > start) return { text: String(input.value || "").slice(start, end) };
      return { text: String(input.value || "") };
    }
  }
  if (el && (el as HTMLElement).isContentEditable) {
    const innerSel = String(window.getSelection?.() || "");
    if (innerSel) return { text: innerSel };
    return { text: String((el as HTMLElement).innerText || el.textContent || "") };
  }
  return { text: String(window.getSelection?.() || "") };
}

function formSignature(): { url: string; title: string; key: string } {
  const skipType = (t: string) =>
    ["hidden", "button", "submit", "file", "image", "reset", "color", "range"].includes(t);
  const usable = (el: Element) => {
    if ((el as HTMLInputElement).disabled) return false;
    try {
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") return false;
    } catch {
      /* ignore */
    }
    return true;
  };
  const parts: string[] = [];
  document.querySelectorAll("input, textarea, select").forEach((el) => {
    const type = String((el as HTMLInputElement).type || "").toLowerCase();
    if (el.tagName === "INPUT" && skipType(type)) return;
    if (!usable(el)) return;
    parts.push(
      ["f", el.tagName, type, (el as HTMLInputElement).name || "", el.id || "", el.getAttribute("placeholder") || ""].join(":"),
    );
  });
  document.querySelectorAll("button, input[type=submit], [role=button]").forEach((el) => {
    if (!usable(el)) return;
    const text = String((el as HTMLElement).innerText || (el as HTMLInputElement).value || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 40);
    parts.push(["b", text].join(":"));
  });
  return {
    url: String(location.href || ""),
    title: String(document.title || ""),
    key: parts.slice(0, 24).join("|"),
  };
}

function scanFrame(frameIndex: number): { fields: CatalogField[]; buttons: CatalogButton[] } {
  const MAX_FIELDS = 32;
  // The handoff overlay renders these as the owner's dropdown: birth years and
  // country lists run 100–250 entries (24 stopped DOB years at 2004). The LLM
  // labeler trims options on its own (formCatalog.ts).
  const MAX_SELECT_OPTIONS = 300;
  const SKIP_TYPES = ["hidden", "button", "submit", "file", "image", "reset", "color", "range"];
  const SECRET_TYPES = ["password"];
  const SECRET_AUTO = [
    "current-password",
    "new-password",
    "cc-number",
    "cc-csc",
    "cc-exp",
    "cc-exp-month",
    "cc-exp-year",
    "one-time-code",
  ];
  const usable = (el: Element) => {
    if ((el as HTMLInputElement).disabled) return false;
    const box = (node: Element) => {
      const rect = node.getBoundingClientRect();
      return rect.width >= 2 && rect.height >= 2;
    };
    // Alaska (and other design systems) keep the real input at 1×0, sometimes
    // with opacity 0, inside a visible custom element. The host is the field.
    const root = el.getRootNode() as ShadowRoot | Document;
    const host = "host" in root ? (root.host as Element | undefined) : undefined;
    if (host && host.tagName.includes("-") && box(host)) return true;
    try {
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    } catch {
      /* ignore */
    }
    if (!box(el) && (el as HTMLElement).offsetWidth < 2 && (el as HTMLElement).offsetHeight < 2) {
      return false;
    }
    return true;
  };
  const labelFor = (el: Element) => {
    const aria = String(el.getAttribute("aria-label") || "").trim();
    if (aria) return aria.slice(0, 80);
    const id = el.id ? String(el.id) : "";
    if (id) {
      try {
        const lab = document.querySelector(`label[for="${CSS.escape(id)}"]`);
        if (lab) return String(lab.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80);
      } catch {
        /* ignore */
      }
    }
    const wrap = el.closest("label");
    if (wrap) return String(wrap.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80);
    const raw = String(el.getAttribute("placeholder") || el.getAttribute("name") || "").slice(0, 80);
    const auto = String(el.getAttribute("autocomplete") || "").toLowerCase();
    const token = auto.split(/\s+/).pop() || "";
    const fromAuto: Record<string, string> = {
      "given-name": "First name",
      "family-name": "Last name",
      "additional-name": "Middle name",
      "honorific-suffix": "Suffix",
      sex: "Gender",
      "bday-month": "Birth month",
      "bday-day": "Birth day",
      "bday-year": "Birth year",
      email: "Email",
      "tel-country-code": "Phone country",
      "tel-national": "Phone",
      "country-name": "Country",
      "postal-code": "ZIP code",
    };
    if (fromAuto[token]) return fromAuto[token];
    if (raw.includes(".") || raw.includes("[")) {
      const leaf = raw.split(".").pop() || raw;
      return leaf.replace(/\[\d+\]/g, "").replace(/([A-Z])/g, " $1").trim().slice(0, 80);
    }
    return raw;
  };
  const walkRoots = (root: ParentNode, visit: (root: ParentNode) => void) => {
    if (!root || !("querySelectorAll" in root)) return;
    visit(root);
    root.querySelectorAll("*").forEach((node) => {
      if ((node as HTMLElement).shadowRoot) walkRoots((node as HTMLElement).shadowRoot!, visit);
    });
  };
  const outFields: CatalogField[] = [];
  const outButtons: CatalogButton[] = [];
  let fieldN = 0;
  let buttonN = 0;
  walkRoots(document, (root) => {
    root.querySelectorAll('input, textarea, select, [contenteditable="true"], [contenteditable=""]').forEach((el) => {
      if (outFields.length >= MAX_FIELDS) return;
      const tag = String(el.tagName || "").toUpperCase();
      const type =
        tag === "INPUT"
          ? String((el as HTMLInputElement).type || "text").toLowerCase()
          : tag === "TEXTAREA"
            ? "textarea"
            : tag === "SELECT"
              ? "select"
              : "text";
      if (tag === "INPUT" && SKIP_TYPES.includes(type)) return;
      if (!usable(el)) return;
      const hid = `f${frameIndex}-e${fieldN}`;
      fieldN += 1;
      el.setAttribute("data-joshu-handoff", hid);
      const autocomplete = String(el.getAttribute("autocomplete") || "").trim();
      const secret = SECRET_TYPES.includes(type) || SECRET_AUTO.includes(autocomplete.toLowerCase());
      const rec: CatalogField = {
        id: hid,
        tag,
        type,
        name: String(el.getAttribute("name") || "").slice(0, 80),
        elementId: String(el.id || "").slice(0, 80),
        autocomplete: autocomplete.slice(0, 80),
        placeholder: String(el.getAttribute("placeholder") || "").slice(0, 80),
        label: labelFor(el),
      };
      if (tag === "SELECT") {
        rec.options = [];
        const opts = (el as HTMLSelectElement).options || [];
        for (let o = 0; o < opts.length && (rec.options?.length ?? 0) < MAX_SELECT_OPTIONS; o++) {
          rec.options!.push({
            value: String(opts[o]?.value || ""),
            label: String(opts[o]?.text || opts[o]?.value || "").slice(0, 80),
          });
        }
      }
      if (type === "checkbox" || type === "radio") rec.checked = !!(el as HTMLInputElement).checked;
      if (!secret && tag !== "SELECT" && type !== "checkbox" && type !== "radio") {
        const value = (el as HTMLInputElement).value;
        if (typeof value === "string" && value) rec.value = value.slice(0, 200);
      }
      outFields.push(rec);
    });
    root.querySelectorAll('button, input[type="submit"], input[type="button"], [role="button"]').forEach((el) => {
      if (outButtons.length >= 12) return;
      if (!usable(el)) return;
      const hid = `f${frameIndex}-b${buttonN}`;
      buttonN += 1;
      el.setAttribute("data-joshu-handoff", hid);
      const text = String((el as HTMLElement).innerText || (el as HTMLInputElement).value || el.getAttribute("aria-label") || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 80);
      outButtons.push({
        id: hid,
        text,
        type: String((el as HTMLInputElement).type || el.getAttribute("type") || "button").toLowerCase(),
        ariaLabel: String(el.getAttribute("aria-label") || "").slice(0, 80),
      });
    });
  });
  return { fields: outFields, buttons: outButtons };
}

function fillFrame(payload: {
  fields: Array<{ id: string; value: string | boolean }>;
  buttonId: string;
}): { filled: Array<{ id: string; via: string }>; missing: string[]; clicked: string | null } {
  const findStamp = (root: ParentNode, id: string): Element | null => {
    if (!root || !("querySelector" in root)) return null;
    const direct = root.querySelector(`[data-joshu-handoff="${id}"]`);
    if (direct) return direct;
    const all = root.querySelectorAll("*");
    for (let n = 0; n < all.length; n++) {
      const shadow = (all[n] as HTMLElement).shadowRoot;
      if (shadow) {
        const hit = findStamp(shadow, id);
        if (hit) return hit;
      }
    }
    return null;
  };
  const setValue = (el: Element, value: string | boolean) => {
    const tag = String(el.tagName || "").toUpperCase();
    const type = tag === "INPUT" ? String((el as HTMLInputElement).type || "text").toLowerCase() : "";
    if (type === "checkbox" || type === "radio") {
      const want = value === true || value === "true" || value === "1" || value === "on" || value === "yes";
      (el as HTMLInputElement).checked = !!want;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return "check";
    }
    if (tag === "SELECT") {
      // Native setter so framework value trackers (React) see the change.
      const selectDesc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
      if (selectDesc?.set) selectDesc.set.call(el, String(value));
      else (el as HTMLSelectElement).value = String(value);
      el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      syncCustomHost(el, String(value));
      return "select";
    }
    if ((el as HTMLElement).isContentEditable) {
      (el as HTMLElement).focus();
      document.execCommand("selectAll", false);
      document.execCommand("insertText", false, String(value));
      return "edit";
    }
    const proto = tag === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc?.set) desc.set.call(el, String(value));
    else (el as HTMLInputElement).value = String(value);
    el.dispatchEvent(
      new InputEvent("input", { bubbles: true, composed: true, cancelable: true, inputType: "insertReplacementText", data: String(value) }),
    );
    el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    // Custom elements (auro-input / auro-select) keep their own value. The
    // inner control is often 1×0, so the picture only updates when the host
    // property changes.
    syncCustomHost(el, String(value));
    return "value";
  };
  const syncCustomHost = (el: Element, value: string) => {
    const root = el.getRootNode() as ShadowRoot | Document;
    const host = "host" in root ? (root.host as HTMLElement & { value?: string }) : undefined;
    if (!host || !host.tagName.includes("-")) return;
    try {
      host.value = value;
    } catch {
      /* host may reject the assignment */
    }
    host.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    host.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  };
  const filled: Array<{ id: string; via: string }> = [];
  const missing: string[] = [];
  for (const item of payload.fields) {
    const el = findStamp(document, item.id);
    if (!el) {
      missing.push(item.id);
      continue;
    }
    filled.push({ id: item.id, via: setValue(el, item.value) });
  }
  let clicked: string | null = null;
  if (payload.buttonId) {
    const btn = findStamp(document, payload.buttonId);
    if (btn) {
      (btn as HTMLElement).click();
      clicked = payload.buttonId;
    }
  }
  return { filled, missing, clicked };
}

export class ChromiumCdpSession {
  private browser: Browser | null = null;
  private connecting: Promise<Browser> | null = null;
  private ids = new WeakMap<Page, string>();
  private seq = 0;
  private proxyRetries = 0;

  private cdpUrl: string;
  /** Bumps when retarget() runs so an in-flight connect cannot stick to the old browser. */
  private generation = 0;
  /** Cloud browsers set the screen once. Do not call setViewportSize after attach. */
  private readonly lockViewport: boolean;

  constructor(
    private readonly opts: {
      cdpUrl: string;
      /** Health/rotate server (same host as the old Camofox control port). */
      controlUrl: string;
      sessionKey: string;
      singleTab: boolean;
      viewportWidth?: number;
      viewportHeight?: number;
      lockViewport?: boolean;
    },
  ) {
    this.cdpUrl = opts.cdpUrl;
    this.lockViewport = opts.lockViewport === true;
  }

  /** Drop the Playwright connection and attach to a replacement browser. */
  retarget(cdpUrl: string): void {
    const next = cdpUrl.trim();
    if (!next || next === this.cdpUrl) return;
    this.generation += 1;
    this.cdpUrl = next;
    const previous = this.browser;
    this.browser = null;
    this.connecting = null;
    // Disconnect only. Browser Use keeps the cloud browser until PATCH stop.
    void previous?.close().catch(() => undefined);
  }

  private async connect(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    if (!this.connecting) {
      const generation = this.generation;
      const url = this.cdpUrl;
      this.connecting = chromium
        .connectOverCDP(url)
        .then((browser) => {
          if (generation !== this.generation) {
            void browser.close().catch(() => undefined);
            throw new Error("browser CDP changed during connect");
          }
          this.browser = browser;
          browser.on("disconnected", () => {
            if (this.browser === browser) this.browser = null;
          });
          return browser;
        })
        .finally(() => {
          this.connecting = null;
        });
    }
    return this.connecting;
  }

  private async context(): Promise<BrowserContext> {
    const browser = await this.connect();
    const existing = browser.contexts()[0];
    const context = existing
      ?? (await browser.newContext({
        viewport: {
          width: this.opts.viewportWidth ?? 1024,
          height: this.opts.viewportHeight ?? 768,
        },
      }));
    // esbuild names functions with a __name helper. Page scripts need it or
    // evaluate throws " __name is not defined".
    await context.addInitScript({ content: "globalThis.__name = (fn) => fn;" }).catch(() => undefined);
    const defineName = new Function("globalThis.__name = (fn) => fn;") as () => void;
    for (const page of context.pages()) {
      await page.evaluate(defineName).catch(() => undefined);
    }
    return context;
  }

  private idFor(page: Page): string {
    let id = this.ids.get(page);
    if (!id) {
      this.seq += 1;
      id = `p${this.seq}`;
      this.ids.set(page, id);
    }
    return id;
  }

  private async tabFor(page: Page): Promise<ChromiumTab> {
    const title = await page.title().catch(() => "");
    return {
      tabId: this.idFor(page),
      targetId: this.idFor(page),
      url: page.url() || "about:blank",
      title,
      listItemId: this.opts.sessionKey,
    };
  }

  private async pages(): Promise<Page[]> {
    const context = await this.context();
    return context.pages().filter((page) => !page.isClosed());
  }

  private async pageById(tabId: string): Promise<Page | undefined> {
    const open = await this.pages();
    return open.find((page) => this.idFor(page) === tabId);
  }

  /** One shared page. Leave OAuth popups alone so the opener is not recycled. */
  private async primaryPage(): Promise<Page | undefined> {
    const open = await this.pages();
    if (open.length === 0) return undefined;
    const nonOauth = open.filter((page) => !isOauthPopupUrl(page.url()));
    const pool = nonOauth.length > 0 ? nonOauth : open;
    return pool[0];
  }

  async listTabs(): Promise<ChromiumTab[]> {
    const open = await this.pages();
    return Promise.all(open.map((page) => this.tabFor(page)));
  }

  async currentTab(): Promise<ChromiumTab | undefined> {
    const page = await this.primaryPage();
    if (!page) return undefined;
    return this.tabFor(page);
  }

  async ensureTab(url?: string, opts?: { navigateExisting?: boolean }): Promise<ChromiumTab> {
    let page = await this.primaryPage();
    if (!page) {
      const context = await this.context();
      page = await context.newPage();
      await this.fitViewport(this.idFor(page));
      if (url && !isBlankBrowserUrl(url)) await this.goto(page, url);
      await this.installShim(this.idFor(page));
      return this.tabFor(page);
    }
    if (this.opts.singleTab) await this.closeOtherTabs(this.idFor(page)).catch(() => undefined);
    await this.fitViewport(this.idFor(page));
    const existingBlank = isBlankBrowserUrl(page.url());
    const shouldNavigate = Boolean(url) && page.url() !== url && (opts?.navigateExisting === true || existingBlank);
    if (shouldNavigate && url) await this.goto(page, url);
    await this.installShim(this.idFor(page));
    return this.tabFor(page);
  }

  async enforceSingleTab(): Promise<ChromiumTab | undefined> {
    const page = await this.primaryPage();
    if (!page) return undefined;
    if (this.opts.singleTab) await this.closeOtherTabs(this.idFor(page)).catch(() => undefined);
    await this.installShim(this.idFor(page));
    return this.tabFor(page);
  }

  async closeAllTabs(): Promise<void> {
    const open = await this.pages();
    await Promise.allSettled(open.map((page) => page.close()));
  }

  async observe(tab: ChromiumTab): Promise<ChromiumObservation> {
    const page = (await this.pageById(tab.tabId)) ?? (await this.primaryPage());
    if (!page) throw new Error("No Chromium tab");
    await this.installShim(this.idFor(page));
    const title = await page.title().catch(() => tab.title ?? "");
    const snapshot = await page
      .locator("body")
      .innerText({ timeout: 8_000 })
      .catch(() => "");
    return {
      tab: await this.tabFor(page),
      url: page.url(),
      title,
      snapshot,
      refsCount: undefined,
    };
  }

  async insertText(text: string, opts?: { selectAll?: boolean }): Promise<void> {
    const page = await this.primaryPage();
    if (!page) throw new Error("No Chromium tab");
    const result = await page.evaluate(insertIntoFocused, { text, selectAll: opts?.selectAll === true });
    if (result?.ok) return;
    throw new Error(explainInsertFailure(result?.reason));
  }

  async listFormFields(): Promise<{ fields: CatalogField[]; buttons: CatalogButton[] }> {
    const page = await this.primaryPage();
    if (!page) throw new Error("No Chromium tab");
    const fields: CatalogField[] = [];
    const buttons: CatalogButton[] = [];
    const frames = page.frames();
    for (let i = 0; i < frames.length; i++) {
      const frame: Frame | undefined = frames[i];
      if (!frame) continue;
      let part: { fields: CatalogField[]; buttons: CatalogButton[] } | undefined;
      try {
        part = await frame.evaluate(scanFrame, i);
      } catch (err) {
        if (frame === page.mainFrame()) throw err;
      }
      if (part?.fields) fields.push(...part.fields);
      if (part?.buttons) buttons.push(...part.buttons);
    }
    return { fields: fields.slice(0, 16), buttons: buttons.slice(0, 12) };
  }

  async readFormSignature(): Promise<{ url: string; title: string; key: string }> {
    const page = await this.primaryPage();
    if (!page) throw new Error("No Chromium tab");
    const evaluated = await page.evaluate(formSignature);
    return {
      url: evaluated.url || page.url(),
      title: evaluated.title || (await page.title().catch(() => "")),
      key: evaluated.key || "",
    };
  }

  async fillForm(opts: {
    fields: Array<{ id: string; value: string | boolean }>;
    buttonId?: string | null;
  }): Promise<{ ok: boolean; filled: number; missing: string[]; clicked: string | null }> {
    const page = await this.primaryPage();
    if (!page) throw new Error("No Chromium tab");
    const filled: Array<{ id: string }> = [];
    const missing: string[] = [];
    let clicked: string | null = null;
    const frames = page.frames();
    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i];
      if (!frame) continue;
      const prefix = `f${i}-`;
      const partFields = opts.fields.filter((row) => row.id.startsWith(prefix));
      const partButton = opts.buttonId && opts.buttonId.startsWith(prefix) ? opts.buttonId : "";
      if (partFields.length === 0 && !partButton) continue;
      const part = await frame.evaluate(fillFrame, { fields: partFields, buttonId: partButton });
      filled.push(...part.filled);
      missing.push(...part.missing);
      if (part.clicked) clicked = part.clicked;
    }
    const handled = new Set([...filled.map((row) => row.id), ...missing]);
    for (const row of opts.fields) {
      if (!handled.has(row.id)) missing.push(row.id);
    }
    return { ok: missing.length === 0, filled: filled.length, missing, clicked };
  }

  async readSelection(): Promise<string> {
    const page = await this.primaryPage();
    if (!page) throw new Error("No Chromium tab");
    const evaluated = await page.evaluate(readFocusedText);
    return evaluated.text || "";
  }

  async readViewportMetrics(
    tabId?: string,
  ): Promise<{ innerWidth: number; innerHeight: number; screenWidth: number; screenHeight: number } | undefined> {
    const page = tabId ? await this.pageById(tabId) : await this.primaryPage();
    if (!page) return undefined;
    return page.evaluate(() => ({
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      screenWidth: screen.width,
      screenHeight: screen.height,
    }));
  }

  async fitViewport(tabId?: string): Promise<void> {
    const page = tabId ? await this.pageById(tabId) : await this.primaryPage();
    if (!page || this.lockViewport) return;
    if (isOauthPopupUrl(page.url())) return;
    await page.setViewportSize({
      width: this.opts.viewportWidth ?? 1024,
      height: this.opts.viewportHeight ?? 768,
    });
  }

  async scrollPage(opts: { direction?: "up" | "down" | "left" | "right"; amount?: number } = {}): Promise<void> {
    const page = await this.primaryPage();
    if (!page) throw new Error("No Chromium tab");
    const direction = opts.direction ?? "down";
    const amount = Math.max(1, Math.min(8000, Math.floor(Number(opts.amount ?? 400) || 400)));
    const deltaX = direction === "left" ? -amount : direction === "right" ? amount : 0;
    const deltaY = direction === "up" ? -amount : direction === "down" ? amount : 0;
    await page.mouse.wheel(deltaX, deltaY);
  }

  async pressKey(key: string): Promise<void> {
    const page = await this.primaryPage();
    if (!page) throw new Error("No Chromium tab");
    await page.keyboard.press(key);
  }

  async installShim(tabId: string): Promise<void> {
    const page = await this.pageById(tabId);
    if (!page) return;
    await page.evaluate(installHitlShim).catch(() => undefined);
  }

  private async closeOtherTabs(keepTabId: string): Promise<void> {
    const open = await this.pages();
    if (open.some((page) => isOauthPopupUrl(page.url()))) return;
    await Promise.allSettled(
      open.filter((page) => this.idFor(page) !== keepTabId).map((page) => page.close()),
    );
  }

  /** Switch Decodo ports when the page is a dead proxy tunnel, then load again. */
  private async goto(page: Page, url: string): Promise<void> {
    let current = page;
    for (let attempt = 0; attempt < 3; attempt++) {
      await current.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      const text = await current.locator("body").innerText({ timeout: 4_000 }).catch(() => "");
      if (!PROXY_TUNNEL_RE.test(text)) {
        this.proxyRetries = 0;
        return;
      }
      // Cloud egress is Browser Use's proxy. Do not rotate the local Decodo hop.
      if (this.lockViewport) return;
      if (this.proxyRetries >= 2) return;
      this.proxyRetries += 1;
      const rotate = await fetch(new URL("/rotate-proxy", this.opts.controlUrl), {
        method: "POST",
        signal: AbortSignal.timeout(30_000),
      }).catch(() => undefined);
      if (!rotate?.ok) return;
      const rotated = (await rotate.json().catch(() => ({}))) as { relaunched?: boolean };
      // Local auth proxy switches Decodo ports without killing Chrome.
      if (rotated.relaunched === false) continue;
      this.browser = null;
      const next = await this.primaryPage();
      if (!next) return;
      current = next;
    }
  }
}
