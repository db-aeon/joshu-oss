/**
 * Slack connect run: the state machine that makes the box Slack app and gets
 * its tokens (openspec change slack-connect, design decision 1).
 *
 * One run at a time, in memory only. The configuration token, the app token,
 * the bot token, and the client secret stay in this object and are dropped
 * when the run ends. The status of a run never has a token.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { slackAppSettingsUrl } from "../hermesSlackSetup.js";
import {
  SEVERAL_WORKSPACES,
  SLACK_APPS_URL,
  decideSignIn,
  findNewTokens,
  findTokens,
  isAppSettingsPage,
  launchingWorkspace,
  slackPageKind,
  type ClickOutcome,
  type SlackTabView,
} from "./browserSteps.js";
import type { FinishSlackConnectionInput, FinishSlackConnectionResult } from "./finish.js";
import {
  slackAppsManifestCreate,
  slackOAuthV2Access,
  type FetchLike,
  type SlackCreatedApp,
} from "./slackApi.js";

export type SlackConnectPhase =
  | "idle"
  | "sign_in"
  | "configuration_token"
  | "create_app"
  | "app_token"
  | "install"
  | "finishing"
  | "done"
  | "failed"
  | "cancelled";

const END_PHASES: ReadonlySet<SlackConnectPhase> = new Set(["idle", "done", "failed", "cancelled"]);

export type SlackConnectStatus = {
  phase: SlackConnectPhase;
  /** What the owner should do now, or what the box does now. */
  hint: string;
  error: string;
  /** Not secret. */
  appId: string;
  team: string;
  warnings: string[];
  startedAt: string;
  updatedAt: string;
};

/** The shared browser, as Slack connect sees it. */
export interface SlackConnectBrowser {
  open(url: string): Promise<void>;
  url(): Promise<string>;
  /** What each open tab shows, in tab order (readSlackTab). A sign-in can end in a new tab. */
  look(): Promise<SlackTabView[]>;
  /** Close each tab but one, and load `url` in that tab. */
  useOneTab(url: string): Promise<void>;
  strings(): Promise<string[]>;
  /** What the "Copy access token" buttons on the apps page copy. */
  copyConfigurationTokens(): Promise<string[]>;
  /** False when Slack disables Generate Token (each workspace already has a configuration token). */
  canGenerateConfigurationToken(): Promise<boolean>;
  /** `workspace`: the workspace of the sign-in, picked when the dialog lists more than one. */
  clickGenerateConfigurationToken(workspace: string): Promise<ClickOutcome>;
  clickGenerateAppToken(): Promise<ClickOutcome>;
}

export type SlackConnectDeps = {
  projectRoot: string;
  browser: SlackConnectBrowser;
  buildManifest: () => Promise<unknown>;
  redirectUrl: () => string;
  finish: (input: Omit<FinishSlackConnectionInput, "applyToHermes" | "projectRoot">) => Promise<FinishSlackConnectionResult>;
  /** Returns a reason to refuse the start (for example a pending browser handoff). Pauses other browser drivers. */
  beforeStart?: () => Promise<string | undefined>;
  /** Runs once when the run ends. */
  afterEnd?: () => Promise<void>;
  fetchImpl?: FetchLike;
  pollMs?: number;
  timeoutMs?: number;
  /** Time to wait for a token before the hint asks the owner to click. */
  ownerClickAfterMs?: number;
  /** Log of the run. Gets step names and results, never a token. Default: console.log. */
  log?: (line: string) => void;
};

const DEFAULT_POLL_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_OWNER_CLICK_AFTER_MS = 15_000;
const OAUTH_CALLBACK_WAIT_MS = 90_000;
/** Tries of each click step before the hint asks the owner to click. */
const CLICK_TRIES = 3;

const SIGN_IN_HINT = "In jWeb, sign in to Slack. The Safety app tells you what the box sees.";
const CHECKING_SIGN_IN_HINT = "The box looks at jWeb and opens Your Apps on api.slack.com.";

class RunCancelled extends Error {}

type PendingOAuth = {
  state: string;
  resolve: (code: string) => void;
  reject: (err: Error) => void;
};

export class SlackConnectController {
  private status: SlackConnectStatus = SlackConnectController.emptyStatus();
  private generation = 0;
  private pendingOAuth: PendingOAuth | null = null;
  /** The `state` that the current run already accepted. A second load of the redirect only shows the status. */
  private usedState = "";
  private finished: Promise<SlackConnectStatus> | null = null;
  /** The owner clicked I'm signed in, and the run has not looked yet. */
  private signInRequested = false;
  /** The workspace of the sign-in ("Launching <workspace>"), or "". */
  private workspace = "";

  constructor(private readonly deps: SlackConnectDeps) {}

  private log(line: string): void {
    (this.deps.log ?? ((text: string) => console.log(text)))(`[slack-connect] ${line}`);
  }

  private static emptyStatus(): SlackConnectStatus {
    const now = new Date().toISOString();
    return { phase: "idle", hint: "", error: "", appId: "", team: "", warnings: [], startedAt: "", updatedAt: now };
  }

  getStatus(): SlackConnectStatus {
    return { ...this.status, warnings: [...this.status.warnings] };
  }

  isActive(): boolean {
    return !END_PHASES.has(this.status.phase);
  }

  /** Start a run. A run that is active stays; its status is returned. */
  async start(): Promise<{ ok: boolean; error?: string; status: SlackConnectStatus }> {
    if (this.isActive()) return { ok: true, status: this.getStatus() };
    const refusal = await this.deps.beforeStart?.();
    if (refusal) return { ok: false, error: refusal, status: this.getStatus() };
    this.generation += 1;
    const generation = this.generation;
    const now = new Date().toISOString();
    this.status = { ...SlackConnectController.emptyStatus(), phase: "sign_in", startedAt: now, updatedAt: now };
    this.usedState = "";
    this.signInRequested = false;
    this.workspace = "";
    this.finished = this.drive(generation);
    return { ok: true, status: this.getStatus() };
  }

  /**
   * The owner clicked I'm signed in. At its next look, the run keeps one tab
   * and opens `api.slack.com/apps` unless a tab already shows it ready.
   * Outside phase `sign_in` the click changes nothing.
   */
  confirmSignedIn(): SlackConnectStatus {
    if (this.status.phase === "sign_in") {
      this.signInRequested = true;
      this.set({ hint: CHECKING_SIGN_IN_HINT });
    }
    return this.getStatus();
  }

  cancel(): SlackConnectStatus {
    if (this.isActive()) {
      this.generation += 1;
      this.rejectOAuth(new RunCancelled("cancelled"));
      this.set({ phase: "cancelled", hint: "Slack connect was cancelled." });
      void this.deps.afterEnd?.().catch(() => undefined);
    }
    return this.getStatus();
  }

  /** For tests: resolves when the current run ends. */
  async waitForEnd(): Promise<SlackConnectStatus> {
    return this.finished ?? this.getStatus();
  }

  /**
   * The OAuth redirect route calls this. A `state` that the current run does
   * not wait for is refused without a Slack call. A `state` works one time.
   */
  async acceptOAuthRedirect(query: {
    state?: string;
    code?: string;
    error?: string;
  }): Promise<{ ok: boolean; status: SlackConnectStatus; message: string }> {
    const pending = this.pendingOAuth;
    if (query.state && this.usedState && sameSecret(this.usedState, query.state)) {
      // The browser loaded the redirect again (for example a reload). No second Slack call.
      return this.redirectAnswer(this.getStatus());
    }
    if (!pending || !query.state || !sameSecret(pending.state, query.state)) {
      return { ok: false, status: this.getStatus(), message: "This Slack link is not valid or has expired." };
    }
    this.pendingOAuth = null;
    this.usedState = query.state;
    if (query.error || !query.code) {
      pending.reject(new Error(`Slack did not install the app: ${query.error || "no code"}`));
    } else {
      pending.resolve(query.code);
    }
    // Answer when the code exchange is done, not after the whole finishing phase:
    // the first DM waits for the gateway restart, which can take minutes.
    const deadline = Date.now() + OAUTH_CALLBACK_WAIT_MS;
    let status = this.getStatus();
    while (status.phase === "install" && Date.now() < deadline) {
      await sleep(250);
      status = this.getStatus();
    }
    return this.redirectAnswer(status);
  }

  private redirectAnswer(status: SlackConnectStatus): { ok: boolean; status: SlackConnectStatus; message: string } {
    if (status.phase === "done") {
      return { ok: true, status, message: "Slack is connected. Go back to the Safety app." };
    }
    if (status.phase === "finishing") {
      return {
        ok: true,
        status,
        message: "Slack accepted the app. Your companion is starting Slack chat and will message you in Slack. Go back to the Safety app.",
      };
    }
    return { ok: false, status, message: status.error || "Slack connect is still running. Go back to the Safety app." };
  }

  private set(patch: Partial<SlackConnectStatus>): void {
    this.status = { ...this.status, ...patch, updatedAt: new Date().toISOString() };
  }

  private rejectOAuth(err: Error): void {
    const pending = this.pendingOAuth;
    this.pendingOAuth = null;
    pending?.reject(err);
  }

  private async drive(generation: number): Promise<SlackConnectStatus> {
    const deadline = Date.now() + (this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const ctx = new RunContext(() => generation !== this.generation, deadline, this.deps.pollMs ?? DEFAULT_POLL_MS);
    // Secrets of this run. They leave this function only to Slack and to finish().
    let configurationToken = "";
    let appToken = "";
    let created: SlackCreatedApp | null = null;
    try {
      configurationToken = await this.stepConfigurationToken(ctx);
      this.set({ phase: "create_app", hint: "Making the Slack app of your box." });
      const manifest = await this.deps.buildManifest();
      ctx.check();
      created = await slackAppsManifestCreate(configurationToken, manifest, this.deps.fetchImpl);
      ctx.check();
      this.set({ appId: created.appId });
      appToken = await this.stepAppToken(ctx, created.appId);
      const code = await this.stepInstall(ctx, created);
      this.set({ phase: "finishing", hint: "Saving the tokens and starting Slack chat." });
      const redirectUri = this.deps.redirectUrl();
      const oauth = await slackOAuthV2Access(
        { clientId: created.clientId, clientSecret: created.clientSecret, code, redirectUri },
        this.deps.fetchImpl,
      );
      ctx.check();
      this.set({ team: oauth.teamName });
      const result = await this.deps.finish({
        botToken: oauth.botToken,
        appToken,
        ownerUserId: oauth.authedUserId,
        appId: created.appId,
        configurationToken,
        fetchImpl: this.deps.fetchImpl,
        // The first DM waits for the Hermes gateway restart; tell the owner why.
        onWaiting: (hint) => this.set({ hint }),
      });
      ctx.check();
      this.set({
        phase: "done",
        team: result.team || oauth.teamName,
        warnings: result.warnings,
        hint: result.welcomeSent
          ? "Slack chat is connected. Your companion sent you a DM in Slack."
          : "Slack chat is connected.",
      });
    } catch (err) {
      if (generation === this.generation && !(err instanceof RunCancelled)) {
        this.set({ phase: "failed", error: (err as Error).message, hint: failureHint(this.status.phase) });
      }
    } finally {
      configurationToken = "";
      appToken = "";
      created = null;
      if (generation === this.generation) {
        this.pendingOAuth = null;
        await this.deps.afterEnd?.().catch(() => undefined);
      }
    }
    return this.getStatus();
  }

  /**
   * Phase `sign_in`: look at each tab, decide (decideSignIn), act, and look
   * again. The run goes on when the only tab is `api.slack.com/apps` with
   * Generate Token. The owner's click on I'm signed in is a "go now"; the run
   * does not wait for it.
   */
  private async stepSignIn(ctx: RunContext): Promise<void> {
    const { browser } = this.deps;
    this.set({ phase: "sign_in", hint: SIGN_IN_HINT });
    await browser.open(SLACK_APPS_URL);
    let lastKind = "";
    await this.pollUntil(ctx, async () => {
      const byOwner = this.signInRequested;
      this.signInRequested = false;
      const views = await browser.look();
      for (const view of views) this.workspace = launchingWorkspace(view) || this.workspace;
      const decision = decideSignIn(views, byOwner);
      if (decision.kind !== lastKind || byOwner || decision.act !== "wait") {
        this.log(
          `sign-in: tabs=${views.map((v) => slackPageKind(v)).join(",") || "none"} act=${decision.act}` +
            (byOwner ? " (owner clicked I'm signed in)" : ""),
        );
        lastKind = decision.kind;
      }
      this.set({ hint: decision.hint });
      if (decision.act === "go_on") return true;
      if (decision.act === "open_apps") await browser.useOneTab(SLACK_APPS_URL);
      return null;
    });
  }

  /**
   * Try a click step up to CLICK_TRIES times, and check its result. Logs the
   * step that stopped each try. Before the next try, `beforeRetry` can load
   * the page again (a page that did not answer a click). A list of more than
   * one workspace is for the owner, so it is not tried again.
   */
  private async tryClicks(
    ctx: RunContext,
    name: string,
    click: () => Promise<ClickOutcome>,
    beforeRetry?: (failedStep: string) => Promise<void>,
  ): Promise<boolean> {
    for (let attempt = 1; attempt <= CLICK_TRIES; attempt += 1) {
      ctx.check();
      const outcome = await click().catch((): ClickOutcome => ({ ok: false, step: "error" }));
      if (outcome.ok) {
        if (attempt > 1) this.log(`${name}: clicks done on try ${attempt}`);
        return true;
      }
      this.log(`${name}: try ${attempt} of ${CLICK_TRIES} stopped at ${outcome.step}`);
      if (outcome.step === SEVERAL_WORKSPACES) return false;
      if (attempt < CLICK_TRIES) {
        await ctx.sleep();
        await beforeRetry?.(outcome.step).catch(() => undefined);
      }
    }
    return false;
  }

  private async stepConfigurationToken(ctx: RunContext): Promise<string> {
    const { browser } = this.deps;
    await this.stepSignIn(ctx);

    this.set({ phase: "configuration_token", hint: "Making a configuration token on api.slack.com." });
    // The page shows configuration tokens only behind Copy buttons.
    const configurationStrings = async () => [...(await browser.strings()), ...(await browser.copyConfigurationTokens())];
    let strings = await configurationStrings();
    const baseline = new Set(findTokens(strings, "configuration"));
    // Slack allows one configuration token for each workspace. With one token
    // on the page and Generate Token disabled, the existing token is the one to use.
    if (baseline.size === 1 && !(await browser.canGenerateConfigurationToken().catch(() => true))) {
      this.set({ hint: "Using the configuration token that Slack already shows for your workspace." });
      return [...baseline][0]!;
    }
    // When Generate Token opens no dialog, the page did not answer (clara,
    // 2026-10-14): load the apps page again before the next try.
    const clicked = await this.tryClicks(
      ctx,
      "configuration token",
      () => browser.clickGenerateConfigurationToken(this.workspace),
      async (failedStep) => {
        if (failedStep !== "generate_token_button" && failedStep !== "configuration_dialog") return;
        this.set({ hint: "Generate Token did not open its dialog. The box loads Your Apps again and tries again." });
        await browser.open(SLACK_APPS_URL);
      },
    );
    const askOwner =
      "In jWeb, under Your App Configuration Tokens, click Generate Token, pick your workspace, and click Generate.";
    if (clicked) this.set({ hint: "Making a configuration token on api.slack.com." });
    else this.set({ hint: askOwner });
    const askAt = Date.now() + (this.deps.ownerClickAfterMs ?? DEFAULT_OWNER_CLICK_AFTER_MS);
    strings = await this.pollUntil(ctx, async () => {
      const page = await configurationStrings();
      if (findNewTokens(page, "configuration", baseline).length > 0) return page;
      if (clicked && Date.now() >= askAt) this.set({ hint: askOwner });
      return null;
    });
    return findNewTokens(strings, "configuration", baseline)[0]!;
  }

  private async stepAppToken(ctx: RunContext, appId: string): Promise<string> {
    const { browser } = this.deps;
    this.set({ phase: "app_token", hint: "Making the app token of the Slack app." });
    await browser.open(slackAppSettingsUrl(appId));
    const strings = await this.pollUntil(ctx, async () => {
      const page = await browser.strings();
      return isAppSettingsPage(await browser.url(), appId, page) ? page : null;
    });
    const baseline = new Set(findTokens(strings, "app"));
    const clicked = await this.tryClicks(ctx, "app token", () => browser.clickGenerateAppToken());
    const askOwner =
      "In jWeb, under App-Level Tokens, click Generate Token and Scopes, type any name, add the scope connections:write, and click Generate.";
    if (!clicked) this.set({ hint: askOwner });
    const askAt = Date.now() + (this.deps.ownerClickAfterMs ?? DEFAULT_OWNER_CLICK_AFTER_MS);
    const withToken = await this.pollUntil(ctx, async () => {
      const page = await browser.strings();
      if (findNewTokens(page, "app", baseline).length > 0) return page;
      if (clicked && Date.now() >= askAt) this.set({ hint: askOwner });
      return null;
    });
    return findNewTokens(withToken, "app", baseline)[0]!;
  }

  private async stepInstall(ctx: RunContext, created: SlackCreatedApp): Promise<string> {
    const state = randomBytes(32).toString("base64url");
    const authorize = new URL(created.oauthAuthorizeUrl);
    authorize.searchParams.set("state", state);
    authorize.searchParams.set("redirect_uri", this.deps.redirectUrl());
    const code = new Promise<string>((resolve, reject) => {
      this.pendingOAuth = { state, resolve, reject };
    });
    this.set({
      phase: "install",
      hint: "In jWeb, click Allow. If Slack asks for approval by an admin, start again after the admin approves.",
    });
    await this.deps.browser.open(authorize.toString());
    return ctx.race(code);
  }

  private async pollUntil<T>(ctx: RunContext, probe: () => Promise<T | null>): Promise<T> {
    for (;;) {
      ctx.check();
      const value = await probe().catch(() => null);
      ctx.check();
      if (value !== null) return value;
      await ctx.sleep();
    }
  }
}

/** One run's cancel flag, deadline, and poll interval. */
class RunContext {
  constructor(
    private readonly cancelled: () => boolean,
    private readonly deadline: number,
    private readonly pollMs: number,
  ) {}

  check(): void {
    if (this.cancelled()) throw new RunCancelled("cancelled");
    if (Date.now() > this.deadline) throw new Error("Slack connect timed out after 30 minutes.");
  }

  async sleep(): Promise<void> {
    await sleep(this.pollMs);
  }

  /** Wait for `promise`, but stop on cancel or at the deadline. */
  async race<T>(promise: Promise<T>): Promise<T> {
    for (;;) {
      this.check();
      const value = await Promise.race([promise.then((v) => ({ v })), sleep(this.pollMs).then(() => null)]);
      if (value) return value.v;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function failureHint(phase: SlackConnectPhase): string {
  if (phase === "configuration_token" || phase === "app_token") {
    return "Slack connect could not get a token from api.slack.com. Try again, or use Set up by hand.";
  }
  return "Slack connect stopped. Try again, or use Set up by hand.";
}
