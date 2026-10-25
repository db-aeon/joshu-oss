/**
 * Slack connect steps on api.slack.com in the shared browser.
 *
 * The steps click by role and visible name. When a click target is missing,
 * the step reports it, and the Slack connect run asks the owner to click in
 * jWeb. Tokens are found by pattern, not by the position of an element, so a
 * moved button does not break the token search. The app token is in the page
 * (a read-only input). The configuration token is only behind the "Copy access
 * token" buttons, so copyConfigurationTokens catches what those buttons copy.
 * Pages checked on 2026-10-10 (openspec change slack-connect, task 1.1).
 */
import type { Locator, Page } from "playwright-core";
import { isOauthPopupUrl } from "../chromiumSession.js";

export const SLACK_APPS_URL = "https://api.slack.com/apps";

/** Name of the app token that Slack connect makes. */
export const SLACK_APP_TOKEN_NAME = "joshu-socket-mode";

const TOKEN_PATTERNS = {
  /** Configuration token. The refresh token (`xoxe-1-…`) does not match. */
  configuration: /\bxoxe\.xoxp-1-[A-Za-z0-9-]{20,}/g,
  /** App-level token. */
  app: /\bxapp-1-[A-Za-z0-9-]{20,}/g,
} as const;

export type SlackTokenKind = keyof typeof TOKEN_PATTERNS;

/** Unique tokens of one kind in the given strings, in order of first appearance. */
export function findTokens(strings: readonly string[], kind: SlackTokenKind): string[] {
  const found = new Set<string>();
  for (const text of strings) {
    for (const match of text.matchAll(TOKEN_PATTERNS[kind])) found.add(match[0]);
  }
  return [...found];
}

/** Tokens that were not on the page before the click (`baseline`). */
export function findNewTokens(
  strings: readonly string[],
  kind: SlackTokenKind,
  baseline: ReadonlySet<string>,
): string[] {
  return findTokens(strings, kind).filter((token) => !baseline.has(token));
}

/**
 * Page text, the values of `input` and `textarea` elements, and the attributes
 * `value` and `data-clipboard-text`, also in open shadow roots.
 */
function readDocumentStrings(): string[] {
  const out: string[] = [];
  const visit = (root: Document | ShadowRoot): void => {
    const body = root instanceof Document ? root.body : null;
    if (body?.innerText) out.push(body.innerText);
    for (const el of Array.from(root.querySelectorAll("*"))) {
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        if (el.value) out.push(el.value);
      }
      for (const attr of ["value", "data-clipboard-text"]) {
        const value = el.getAttribute(attr);
        if (value) out.push(value);
      }
      if (el.shadowRoot) {
        if (el.shadowRoot.textContent) out.push(el.shadowRoot.textContent);
        visit(el.shadowRoot);
      }
    }
  };
  visit(document);
  return out;
}

/** Strings of all frames of the page. A frame that fails to answer is skipped. */
export async function collectPageStrings(page: Page): Promise<string[]> {
  const parts = await Promise.all(
    page.frames().map((frame) => frame.evaluate(readDocumentStrings).catch(() => [] as string[])),
  );
  return parts.flat();
}

/**
 * What one tab of the shared browser shows. Slack connect reads each tab on
 * each poll, names the page (slackPageKind), and decides the next step
 * (decideSignIn). Text that looks like a token is masked in the page.
 */
export type SlackTabView = {
  url: string;
  title: string;
  /** Visible h1 and h2 texts, without the cookie notice. */
  headings: string[];
  /** Title of the open dialog, or "". */
  dialog: string;
  /** The button Generate Token of `api.slack.com/apps`. */
  generateToken: "none" | "enabled" | "disabled";
  /** `api.slack.com/apps` asks the visitor to sign in. */
  signInPrompt: boolean;
};

/** Runs in the page. Exported for scripts/test-slack-connect.mjs. */
export function describeSlackPage(): Omit<SlackTabView, "url"> {
  const clean = (text: string | null | undefined): string =>
    String(text ?? "")
      .replace(/\b(xox[a-z]?|xapp)[-.][A-Za-z0-9.-]+/gi, "[token]")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120);
  const visible = (el: Element): boolean => {
    const box = el.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  };
  const cookieNotice = /cookie|privacy preference/i;
  const headings = Array.from(document.querySelectorAll("h1, h2"))
    .filter(visible)
    .map((el) => clean(el.textContent))
    .filter((text) => text && !cookieNotice.test(text))
    .slice(0, 6);
  const dialog = Array.from(document.querySelectorAll("[role=dialog]"))
    .filter(visible)
    .map((el) => clean(el.getAttribute("aria-label") || el.querySelector("h1, h2, h3, [role=heading]")?.textContent))
    .filter((text) => text && !cookieNotice.test(text))
    .pop();
  const generate = Array.from(document.querySelectorAll("button")).find((el) =>
    /^\s*generate token\s*$/i.test(el.textContent ?? ""),
  );
  return {
    title: clean(document.title),
    headings,
    dialog: dialog ?? "",
    generateToken: generate ? ((generate as HTMLButtonElement).disabled ? "disabled" : "enabled") : "none",
    signInPrompt: /need to sign in to your slack account/i.test(document.body?.innerText ?? ""),
  };
}

/** The view of one tab. A tab that does not answer shows only its URL. */
export async function readSlackTab(page: Page): Promise<SlackTabView> {
  const url = page.url();
  const view = await page
    .evaluate(describeSlackPage)
    .catch(() => ({ title: "", headings: [], dialog: "", generateToken: "none" as const, signInPrompt: false }));
  return { url, ...view };
}

/** The pages of Slack that the sign-in step tells apart. */
export type SlackPageKind =
  | "apps_ready"
  | "apps_signed_out"
  | "workspace_signed_in"
  | "launching"
  | "two_factor"
  | "workspace_list"
  | "sign_in"
  | "other";

/** Name the page of one tab, from its URL, title, headings, and buttons. */
export function slackPageKind(view: SlackTabView): SlackPageKind {
  const { url } = view;
  const text = [view.title, ...view.headings].join(" | ");
  if (url.startsWith(SLACK_APPS_URL)) {
    if (view.generateToken !== "none") return "apps_ready";
    if (view.signInPrompt) return "apps_signed_out";
    return "other";
  }
  if (/^https:\/\/[a-z0-9-]+\.slack\.com\/ssb\/redirect/.test(url) || /^launching\b/i.test(view.headings[0] ?? "")) {
    return "launching";
  }
  if (/authentication code|additional authentication|two-factor|2-factor/i.test(text)) return "two_factor";
  if (/^https:\/\/([a-z0-9-]+\.)?slack\.com\/signin/.test(url)) {
    return /#workspaces/.test(url) ? "workspace_list" : "sign_in";
  }
  // "Sign in with Google" (or Microsoft, Apple) is part of the Slack sign-in.
  if (isOauthPopupUrl(url)) return "sign_in";
  if (shouldReturnToAppsPage(url)) return "workspace_signed_in";
  return "other";
}

/** The workspace name of a page "Launching <workspace>", or "". */
export function launchingWorkspace(view: SlackTabView): string {
  const match = /^launching\s+(.+?)\s*$/i.exec(view.headings[0] ?? "");
  return match?.[1] ?? "";
}

const KIND_RANK: Record<SlackPageKind, number> = {
  apps_ready: 6,
  workspace_signed_in: 5,
  launching: 5,
  two_factor: 4,
  workspace_list: 3,
  sign_in: 2,
  apps_signed_out: 1,
  other: 0,
};

export type SignInDecision = {
  /** `go_on`: the apps page is ready. `open_apps`: keep one tab and load the apps page. `wait`: the owner acts. */
  act: "go_on" | "open_apps" | "wait";
  /** The page that decided, for the log. */
  kind: SlackPageKind;
  /** What the box sees and what happens next, for the Safety app. */
  hint: string;
};

/**
 * The sign-in step: look at each tab, take the page that is furthest in the
 * sign-in, and decide. `ownerSaysDone` is a click on I'm signed in.
 */
export function decideSignIn(views: readonly SlackTabView[], ownerSaysDone: boolean): SignInDecision {
  const ranked = [...views].sort((a, b) => KIND_RANK[slackPageKind(b)] - KIND_RANK[slackPageKind(a)]);
  const top = ranked[0];
  const kind = top ? slackPageKind(top) : "other";
  const onSlack = top ? /^https:\/\/([a-z0-9-]+\.)*slack\.(com|dev)(\/|$)/.test(top.url) : false;
  const label = top ? `"${top.headings[0] || top.title || top.url}"` : "";
  const shows = !top ? "jWeb shows no page." : onSlack ? `Slack is showing ${label}.` : `jWeb shows ${label}.`;
  if (kind === "apps_ready") {
    // The run works on the first tab, so the apps page must be the only tab.
    if (views.length === 1) return { act: "go_on", kind, hint: "You are signed in. Making a configuration token on api.slack.com." };
    return { act: "open_apps", kind, hint: "You are signed in. The box closes the other tabs and opens Your Apps." };
  }
  if (kind === "launching" || kind === "workspace_signed_in") {
    return {
      act: "open_apps",
      kind,
      hint: `${shows} You are signed in to the workspace. The box opens Your Apps on api.slack.com. You don't need to click Open Slack.`,
    };
  }
  if (ownerSaysDone) return { act: "open_apps", kind, hint: "The box opens Your Apps on api.slack.com to check your sign-in." };
  const next: Record<Exclude<SlackPageKind, "apps_ready" | "launching" | "workspace_signed_in">, string> = {
    two_factor:
      "Slack asks for 2-factor authentication. In jWeb, click Authenticate if Slack shows it, and enter the code from your authentication app.",
    workspace_list: "Slack shows your workspaces. In jWeb, click the workspace where you want to chat with your companion.",
    sign_in: "Sign in to Slack in jWeb.",
    apps_signed_out: 'In jWeb, click "sign in to your Slack account" and sign in.',
    other: "Finish this page in jWeb. When you are signed in, click I'm signed in.",
  };
  return { act: "wait", kind, hint: `${shows} ${next[kind]}` };
}

/**
 * True on a Slack page where a signed-in owner lands instead of the apps
 * page. After the sign-in, Slack sends the browser to `docs.slack.dev`
 * (checked 2026-10-10). Sign-in pages do not match.
 */
export function shouldReturnToAppsPage(url: string): boolean {
  if (url.startsWith(SLACK_APPS_URL)) return false;
  if (/^https:\/\/(docs\.slack\.dev|api\.slack\.com|app\.slack\.com\/client)(\/|$)/.test(url)) return true;
  // After a 2-factor sign-in, the workspace shows its "open the Slack app" page (checked on a test box 2026-10-11).
  return /^https:\/\/[a-z0-9-]+\.slack\.com\/ssb\/redirect/.test(url);
}

/**
 * True when the settings page of the app shows the App-Level Tokens section.
 * `api.slack.com/apps/<app_id>/general` redirects to
 * `app.slack.com/app-settings/<team_id>/<app_id>/general` (checked 2026-10-10).
 */
export function isAppSettingsPage(url: string, appId: string, strings: readonly string[]): boolean {
  const legacy = url.startsWith(`${SLACK_APPS_URL}/${appId}`);
  const current = url.startsWith("https://app.slack.com/app-settings/") && url.split("/").includes(appId);
  if (!legacy && !current) return false;
  return strings.some((text) => /app-level tokens/i.test(text));
}

const CLICK_TIMEOUT_MS = 3_000;

/**
 * Result of a click step. `step` names the part that failed, for the log of
 * the run (no page text, no token).
 */
export type ClickOutcome = { ok: true } | { ok: false; step: string };

const failedAt = (step: string): ClickOutcome => ({ ok: false, step });
const CLICKED: ClickOutcome = { ok: true };

async function clickFirst(locator: Locator): Promise<boolean> {
  const target = locator.first();
  try {
    await target.waitFor({ state: "visible", timeout: CLICK_TIMEOUT_MS });
    await target.click({ timeout: CLICK_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

/**
 * The open dialog with this title. Slack can show other dialogs at the same
 * time (the cookie consent manager, notices), so the title picks the dialog.
 */
async function dialogWithTitle(page: Page, title: RegExp): Promise<Locator | null> {
  const dialog = page.getByRole("dialog").filter({ hasText: title }).last();
  try {
    await dialog.waitFor({ state: "visible", timeout: CLICK_TIMEOUT_MS });
    return dialog;
  } catch {
    return null;
  }
}

async function anyVisibleDialog(page: Page): Promise<boolean> {
  return page
    .evaluate(() =>
      Array.from(document.querySelectorAll("[role=dialog]")).some((d) => d.getBoundingClientRect().height > 0),
    )
    .catch(() => false);
}

/**
 * True when the button Generate Token on `api.slack.com/apps` can be clicked.
 * Slack allows one configuration token for each workspace, so the button is
 * disabled when each workspace already has one (checked on a test box 2026-10-11).
 */
export async function canGenerateConfigurationToken(page: Page): Promise<boolean> {
  const button = page.getByRole("button", { name: /^\s*generate token\s*$/i }).first();
  if ((await button.count().catch(() => 0)) === 0) return false;
  return button.isEnabled().catch(() => false);
}

/** True when the dialog with this title is open now. Does not wait. */
async function dialogIsOpen(page: Page, title: RegExp): Promise<boolean> {
  const dialog = page.getByRole("dialog").filter({ hasText: title }).last();
  return dialog.isVisible().catch(() => false);
}

/** Step name when the workspace list has more than one workspace; the owner picks. */
export const SEVERAL_WORKSPACES = "several_workspaces";

const CONFIGURATION_DIALOG_TITLE = /generate your app configuration token/i;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * On `api.slack.com/apps`: click Generate Token, select the workspace, and
 * click Generate. The step selects the workspace when the list has one
 * workspace, or when exactly one option is `workspace` (the name of the
 * page "Launching <workspace>" of the sign-in). When the dialog is already
 * open (an earlier try stopped in the dialog), the step starts in the dialog.
 * On a failure the outcome names the step; the owner then does the step in jWeb.
 */
export async function clickGenerateConfigurationToken(page: Page, workspace = ""): Promise<ClickOutcome> {
  if (!(await dialogIsOpen(page, CONFIGURATION_DIALOG_TITLE))) {
    if (!(await clickFirst(page.getByRole("button", { name: /^\s*generate token\s*$/i })))) {
      return failedAt("generate_token_button");
    }
  }
  const dialog = await dialogWithTitle(page, CONFIGURATION_DIALOG_TITLE);
  if (!dialog) return failedAt("configuration_dialog");
  // The workspace picker is a combobox. Its list opens outside the dialog, and
  // Generate stays disabled until a workspace is selected, also with one workspace.
  const picker = dialog.getByRole("combobox").first();
  if ((await picker.count().catch(() => 0)) > 0) {
    if (!(await clickFirst(picker))) return failedAt("workspace_picker");
    const options = page.getByRole("option");
    await options.first().waitFor({ state: "visible", timeout: CLICK_TIMEOUT_MS }).catch(() => undefined);
    const count = await options.count().catch(() => 0);
    if (count === 0) return failedAt("workspace_options");
    let option = options;
    if (count > 1) {
      // More than one workspace: take the workspace of the sign-in, else the owner selects it.
      const named = workspace ? options.filter({ hasText: new RegExp(`^\\s*${escapeRegExp(workspace)}\\s*$`, "i") }) : null;
      if (!named || (await named.count().catch(() => 0)) !== 1) return failedAt(SEVERAL_WORKSPACES);
      option = named;
    }
    if (!(await clickFirst(option))) return failedAt("workspace_option");
  }
  if (!(await clickFirst(dialog.getByRole("button", { name: /^\s*generate\s*$/i })))) return failedAt("generate_button");
  return CLICKED;
}

type CopyCatcherWindow = Window & { __joshuSlackCopied?: string[]; __joshuSlackCopyCatcher?: boolean };

/**
 * Catch what Slack copy buttons copy, without a write to the clipboard. Slack
 * copies with a hidden textarea and `document.execCommand("copy")` (checked
 * 2026-10-10); `navigator.clipboard.writeText` is caught too. Runs in the page.
 */
function installCopyCatcher(): void {
  const w = window as CopyCatcherWindow;
  w.__joshuSlackCopied = [];
  if (w.__joshuSlackCopyCatcher) return;
  w.__joshuSlackCopyCatcher = true;
  const keep = (text: unknown) => {
    if (text) w.__joshuSlackCopied?.push(String(text));
  };
  const nativeExec = document.execCommand.bind(document);
  document.execCommand = (command: string, showUi?: boolean, value?: string): boolean => {
    if (String(command).toLowerCase() !== "copy") return nativeExec(command, showUi, value);
    keep(String(window.getSelection() ?? ""));
    const active = document.activeElement;
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) keep(active.value);
    return true;
  };
  if (navigator.clipboard) navigator.clipboard.writeText = async (text: string) => keep(text);
}

function takeCopied(): string[] {
  const w = window as CopyCatcherWindow;
  const copied = w.__joshuSlackCopied ?? [];
  w.__joshuSlackCopied = [];
  return copied;
}

/**
 * On `api.slack.com/apps`: click each "Copy access token" button and return
 * what Slack copied. The page shows configuration tokens only behind these
 * buttons, not in the page text (checked 2026-10-10).
 */
export async function copyConfigurationTokens(page: Page): Promise<string[]> {
  if (!page.url().startsWith(SLACK_APPS_URL)) return [];
  // Do not click behind an open dialog: the owner may be in the middle of a step.
  if (await anyVisibleDialog(page)) return [];
  const buttons = page.getByRole("button", { name: /copy access token/i });
  const count = await buttons.count().catch(() => 0);
  if (count === 0) return [];
  await page.evaluate(installCopyCatcher);
  for (let i = 0; i < count; i += 1) {
    await buttons.nth(i).click({ timeout: CLICK_TIMEOUT_MS }).catch(() => undefined);
  }
  return page.evaluate(takeCopied).catch(() => [] as string[]);
}

const APP_TOKEN_DIALOG_TITLE = /generate an app-level token/i;

/**
 * On the settings page of the app: click Generate Token and Scopes, type the
 * token name, add scope `connections:write`, and click Generate. Slack then
 * shows the app token in a read-only input (collectPageStrings reads it).
 * When the dialog is already open, the step starts in the dialog.
 */
export async function clickGenerateAppToken(page: Page): Promise<ClickOutcome> {
  if (!(await dialogIsOpen(page, APP_TOKEN_DIALOG_TITLE))) {
    if (!(await clickFirst(page.getByRole("button", { name: /generate token and scopes/i })))) {
      return failedAt("generate_token_and_scopes_button");
    }
  }
  const dialog = await dialogWithTitle(page, APP_TOKEN_DIALOG_TITLE);
  if (!dialog) return failedAt("app_token_dialog");
  try {
    await dialog.getByRole("textbox").first().fill(SLACK_APP_TOKEN_NAME, { timeout: CLICK_TIMEOUT_MS });
  } catch {
    return failedAt("token_name");
  }
  // A second try finds the scope already added.
  const scopeAdded = await dialog.getByText(/connections:write/i).first().isVisible().catch(() => false);
  if (!scopeAdded) {
    if (!(await clickFirst(dialog.getByRole("button", { name: /add scope/i })))) return failedAt("add_scope_button");
    // The scope list opens outside the dialog.
    if (!(await clickFirst(page.getByRole("option", { name: /connections:write/i })))) return failedAt("scope_option");
  }
  if (!(await clickFirst(dialog.getByRole("button", { name: /^\s*generate\s*$/i })))) return failedAt("generate_button");
  return CLICKED;
}
