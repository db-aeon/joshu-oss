/**
 * The shared browser for jWeb, the browser handoff page, and Hermes context.
 * Each call goes to ChromiumCdpSession: local Chromium (BROWSER_CDP_URL) or a
 * Browser Use Cloud session (useCdpUrl). The class name is older than the
 * Chromium path; the Camofox REST fallback is gone (change remove-camofox).
 */
import type { Page } from "playwright-core";
import type { CatalogButton, CatalogField } from "./browserHandoff/formCatalog.js";
import {
  ChromiumCdpSession,
  isOauthPopupUrl,
  type ChromiumObservation,
  type ChromiumTab,
} from "./chromiumSession.js";

export { isOauthPopupUrl };

export type CamofoxTab = ChromiumTab;
export type CamofoxPageObservation = ChromiumObservation;

export class CamofoxSessionCoordinator {
  private cdp: ChromiumCdpSession | null = null;

  constructor(
    private readonly opts: {
      /** Health URL of the Chromium supervisor (CAMOFOX_URL). */
      camofoxUrl: string;
      userId: string;
      sessionKey: string;
      singleTab: boolean;
      viewportWidth?: number;
      viewportHeight?: number;
      /** CDP endpoint of local Chromium. Browser Use Cloud sets it later with useCdpUrl. */
      cdpUrl?: string;
      /** Portrait cloud browser: do not resize the page to the viewer. */
      lockViewport?: boolean;
    },
  ) {
    const cdpUrl = opts.cdpUrl?.trim();
    if (cdpUrl) this.useCdpUrl(cdpUrl);
  }

  /** Attach Playwright to a CDP endpoint, replacing any previous one. */
  useCdpUrl(cdpUrl: string): void {
    const next = cdpUrl.trim();
    if (!next) return;
    if (this.cdp) {
      this.cdp.retarget(next);
      return;
    }
    this.cdp = new ChromiumCdpSession({
      cdpUrl: next,
      controlUrl: this.opts.camofoxUrl,
      sessionKey: this.opts.sessionKey,
      singleTab: this.opts.singleTab,
      viewportWidth: this.opts.viewportWidth,
      viewportHeight: this.opts.viewportHeight,
      lockViewport: this.opts.lockViewport,
    });
  }

  private session(): ChromiumCdpSession {
    if (!this.cdp) throw new Error("shared browser not started");
    return this.cdp;
  }

  async readViewportMetrics(
    tabId?: string,
  ): Promise<{ innerWidth: number; innerHeight: number; screenWidth: number; screenHeight: number } | undefined> {
    return this.session().readViewportMetrics(tabId);
  }

  async fitViewport(tabId?: string): Promise<void> {
    return this.session().fitViewport(tabId);
  }

  async scrollPage(opts: { direction?: "up" | "down" | "left" | "right"; amount?: number } = {}): Promise<void> {
    return this.session().scrollPage(opts);
  }

  async pressKey(key: string): Promise<void> {
    return this.session().pressKey(key);
  }

  async listTabs(): Promise<CamofoxTab[]> {
    return this.session().listTabs();
  }

  async currentTab(): Promise<CamofoxTab | undefined> {
    return this.session().currentTab();
  }

  async ensureTab(url?: string, opts?: { navigateExisting?: boolean }): Promise<CamofoxTab> {
    return this.session().ensureTab(url, opts);
  }

  /** Run `fn` on the primary page of the shared browser (Slack connect browser steps). */
  async withPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
    return this.session().withPage(fn);
  }

  /** Run `fn` on each open page, in tab order (Slack connect reads every tab). */
  async eachPage<T>(fn: (page: Page) => Promise<T>): Promise<T[]> {
    return this.session().eachPage(fn);
  }

  /** Close each tab but the primary tab, and load `url` there (Slack connect sign-in). */
  async useOneTab(url: string): Promise<CamofoxTab> {
    return this.session().useOneTab(url);
  }

  async enforceSingleTab(): Promise<CamofoxTab | undefined> {
    return this.session().enforceSingleTab();
  }

  async closeAllTabs(): Promise<void> {
    return this.session().closeAllTabs();
  }

  async observe(tab: CamofoxTab): Promise<CamofoxPageObservation> {
    return this.session().observe(tab);
  }

  async insertText(text: string, opts?: { selectAll?: boolean }): Promise<void> {
    return this.session().insertText(text, opts);
  }

  async listFormFields(): Promise<{ fields: CatalogField[]; buttons: CatalogButton[] }> {
    return this.session().listFormFields();
  }

  async readFormSignature(): Promise<{ url: string; title: string; key: string }> {
    return this.session().readFormSignature();
  }

  async fillForm(opts: {
    fields: Array<{ id: string; value: string | boolean }>;
    buttonId?: string | null;
  }): Promise<{ ok: boolean; filled: number; missing: string[]; clicked: string | null }> {
    return this.session().fillForm(opts);
  }

  async readSelection(): Promise<string> {
    return this.session().readSelection();
  }

  async installShim(tabId: string): Promise<void> {
    return this.session().installShim(tabId);
  }
}
