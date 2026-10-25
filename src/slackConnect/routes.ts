/**
 * Routes and wiring of Slack connect.
 *
 * The status, start, and cancel routes are under `/api/safety-settings`, so
 * the desktop session gate of the Safety app covers them. The OAuth redirect
 * route is public: the shared browser follows the Slack redirect and has no
 * desktop session. The `state` of the current run is its only key.
 */
import type { Request, Response, Router } from "express";
import { pauseBrowserAgent, browserAgentPhase } from "../browserAgent.js";
import { isBrowserHandoffLocked } from "../browserHandoff/store.js";
import type { CamofoxSessionCoordinator } from "../camofoxSession.js";
import { cloudBrowserEnabled, ensureCloudBrowser, touchCloudBrowser } from "../cloudBrowser.js";
import { buildBoxSlackManifest, SLACK_OAUTH_CALLBACK_PATH, slackOAuthRedirectUrl } from "../hermesSlackSetup.js";
import {
  clickGenerateAppToken,
  clickGenerateConfigurationToken,
  canGenerateConfigurationToken,
  collectPageStrings,
  copyConfigurationTokens,
  readSlackTab,
} from "./browserSteps.js";
import { finishSlackConnection } from "./finish.js";
import { SlackConnectController, type SlackConnectBrowser } from "./run.js";

/** Slack connect on the shared browser of this box. */
export function sharedBrowserForSlackConnect(
  session: CamofoxSessionCoordinator,
  projectRoot: string,
): SlackConnectBrowser {
  const ready = async (): Promise<void> => {
    if (cloudBrowserEnabled(projectRoot)) {
      await ensureCloudBrowser();
      touchCloudBrowser();
    }
  };
  return {
    async open(url) {
      await ready();
      await session.ensureTab(url, { navigateExisting: true });
    },
    async url() {
      await ready();
      return session.withPage(async (page) => page.url());
    },
    async look() {
      await ready();
      return session.eachPage(readSlackTab);
    },
    async useOneTab(url) {
      await ready();
      await session.useOneTab(url);
    },
    async strings() {
      await ready();
      return session.withPage(collectPageStrings);
    },
    async copyConfigurationTokens() {
      await ready();
      return session.withPage(copyConfigurationTokens);
    },
    async canGenerateConfigurationToken() {
      await ready();
      return session.withPage(canGenerateConfigurationToken);
    },
    async clickGenerateConfigurationToken(workspace) {
      await ready();
      return session.withPage((page) => clickGenerateConfigurationToken(page, workspace));
    },
    async clickGenerateAppToken() {
      await ready();
      return session.withPage(clickGenerateAppToken);
    },
  };
}

export function createSlackConnectController(opts: {
  projectRoot: string;
  hermesBinary: string;
  session: CamofoxSessionCoordinator;
  /** Sync `~/.hermes/.env`, restart the Hermes gateway (busy wait), and resolve when it answers. */
  applyToHermes: (onWaiting: () => void) => Promise<void>;
}): SlackConnectController {
  const { projectRoot } = opts;
  return new SlackConnectController({
    projectRoot,
    browser: sharedBrowserForSlackConnect(opts.session, projectRoot),
    buildManifest: async () => (await buildBoxSlackManifest(opts.hermesBinary, projectRoot)).manifest,
    redirectUrl: slackOAuthRedirectUrl,
    finish: (input) => finishSlackConnection({ ...input, projectRoot, applyToHermes: opts.applyToHermes }),
    beforeStart: async () => {
      if (!opts.hermesBinary.trim()) return "HERMES_BIN is not configured on this box.";
      if (isBrowserHandoffLocked(projectRoot).locked) {
        return "The shared browser is in a browser handoff. Finish the handoff first.";
      }
      // The browser-use agent stays paused after the run. The companion resumes it when it needs it.
      if (browserAgentPhase() === "running") await pauseBrowserAgent().catch(() => undefined);
      return undefined;
    },
  });
}

/** Status, start, I'm signed in, and cancel. Register after the desktop session gate of the Safety app. */
export function registerSlackConnectRoutes(router: Router, controller: SlackConnectController): void {
  router.get("/api/safety-settings/slack-connect", (_req: Request, res: Response) => {
    res.json({ ok: true, run: controller.getStatus() });
  });

  router.post("/api/safety-settings/slack-connect/start", async (_req: Request, res: Response) => {
    const result = await controller.start();
    res.status(result.ok ? 200 : 409).json({ ok: result.ok, error: result.error, run: result.status });
  });

  router.post("/api/safety-settings/slack-connect/signed-in", (_req: Request, res: Response) => {
    res.json({ ok: true, run: controller.confirmSignedIn() });
  });

  router.post("/api/safety-settings/slack-connect/cancel", (_req: Request, res: Response) => {
    res.json({ ok: true, run: controller.cancel() });
  });
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function resultPage(title: string, message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5;color:#1f2328}h1{font-size:1.4rem}</style></head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body></html>`;
}

/** Public OAuth redirect route. Register outside the desktop session gate. */
export function registerSlackOAuthCallbackRoute(router: Router, controller: SlackConnectController): void {
  router.get(SLACK_OAUTH_CALLBACK_PATH, async (req: Request, res: Response) => {
    const query = req.query as Record<string, unknown>;
    const pick = (key: string) => (typeof query[key] === "string" ? (query[key] as string) : undefined);
    const result = await controller.acceptOAuthRedirect({
      state: pick("state"),
      code: pick("code"),
      error: pick("error"),
    });
    res
      .status(result.ok ? 200 : 400)
      .type("html")
      .send(resultPage(result.ok ? "Slack is connected" : "Slack connect", result.message));
  });
}
