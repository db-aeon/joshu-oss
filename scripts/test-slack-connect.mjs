#!/usr/bin/env npx tsx
/**
 * Slack chat setup (openspec change slack-connect): box manifest, token search,
 * Slack Web API calls, finishing a connection, the Slack connect run, the
 * Safety app routes (gate, token checks, background restart, pairing), and the
 * suggested prompts in the Hermes config.
 *
 * Slack is a fake `fetch`. The shared browser is a fake. No network access.
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = await mkdtemp(path.join(tmpdir(), "joshu-slack-connect-"));
process.env.AROZ_DATA = path.join(root, "aroz");
process.env.JOSHU_AROZ_USER = "alex@example.com";
process.env.JOSHU_OWNER_EMAIL = "alex@example.com";
process.env.JOSHU_NAME = "Clara";
process.env.JOSHU_OWNER_NAME = "Alex Rivera";
process.env.HERMES_HOME = path.join(root, "hermes");
await mkdir(process.env.HERMES_HOME, { recursive: true });
process.env.CUSTOMER_DOMAIN = "sample.box.joshu.me";
process.env.PUBLIC_BASE_PATH = "/joshu";
for (const key of [
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "SLACK_ALLOWED_USERS",
  "SLACK_HOME_CHANNEL",
  "SLACK_APP_ID",
  "JOSHU_PUBLIC_URL",
  "JOSHU_OWNER_CHANNEL_PUBLIC_URL",
]) {
  delete process.env[key];
}

const {
  BOX_SLACK_SLASH_COMMANDS,
  boxSlackNames,
  shapeBoxSlackManifest,
  slackCreateAppUrl,
  slackOAuthRedirectUrl,
  syncJoshuSlackSuggestedPrompts,
  JOSHU_SLACK_SUGGESTED_PROMPTS,
} = await import("../src/hermesSlackSetup.ts");
const {
  decideSignIn,
  findTokens,
  findNewTokens,
  isAppSettingsPage,
  launchingWorkspace,
  shouldReturnToAppsPage,
  slackPageKind,
} = await import("../src/slackConnect/browserSteps.ts");

/** A view of one tab (readSlackTab), for the fakes. */
function tabView(url, extra = {}) {
  return { url, title: "", headings: [], dialog: "", generateToken: "none", signInPrompt: false, ...extra };
}
const APPS_READY = tabView("https://api.slack.com/apps", { headings: ["Your Apps"], generateToken: "enabled" });
const APPS_SIGNED_OUT = tabView("https://api.slack.com/apps", { headings: ["Your Apps"], signInPrompt: true });
const LAUNCHING = tabView("https://acme-studio.slack.com/ssb/redirect", { title: "Redirecting… | Slack", headings: ["Launching Acme Studio"] });
const WORKSPACE_LIST = tabView("https://slack.com/signin?entry_point=redirect_flow#workspaces", { title: "Login | Slack" });
const { slackAuthTest, SlackApiError } = await import("../src/slackConnect/slackApi.ts");
const { addSlackUser, finishSlackConnection } = await import("../src/slackConnect/finish.ts");
const { SlackConnectController } = await import("../src/slackConnect/run.ts");
const { normalizePairingCode, parsePairingApproveOutput } = await import("../src/slackConnect/pairing.ts");
const { readLocalEnvOverrides, writeLocalEnvOverrides } = await import("../src/safetySettings/localEnv.ts");
const { registerSafetySettingsRoutes } = await import("../src/safetySettings/routes.ts");
const express = (await import("express")).default;

// Fake tokens are built from two parts, so that secret scanners do not match them.
const BOT = "xoxb" + "-1111-2222-abcdefghijklmnopqrstuvwx";
const BAD_APP = "xapp-1-AAAA-0000-badbadbadbadbadbadbadbad";
const APP = "xapp-1-A0APP-1234-abcdefghijklmnopqrstuvwxyz0123";
const OLD_CONFIG = "xoxe.xoxp" + "-1-OLDOLDOLDOLDOLDOLDOLDOLDOLD-old";
const CONFIG = "xoxe.xoxp" + "-1-NEWNEWNEWNEWNEWNEWNEWNEWNEW-new";
const REFRESH = "xoxe" + "-1-REFRESHREFRESHREFRESHREFRESH";
const SECRETS = [BOT, APP, CONFIG, "client-secret-123", "the-code"];

/** Fake Slack Web API. Records each call; answers by method. */
function fakeSlack(overrides = {}, events = []) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const method = url.replace("https://slack.com/api/", "");
    const params = Object.fromEntries(new URLSearchParams(String(init?.body ?? "")));
    const auth = String(init?.headers?.Authorization ?? "").replace(/^Bearer /, "");
    calls.push({ method, params, auth });
    events.push(method);
    const answer = overrides[method]?.(params, auth) ?? defaults(method, params, auth);
    return new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { calls, fetchImpl };
}

function defaults(method, params, auth) {
  switch (method) {
    case "auth.test":
      return auth === BOT
        ? { ok: true, team: "Alex Test", team_id: "T1", user_id: "UBOT", bot_id: "B1", url: "https://alextest.slack.com/" }
        : { ok: false, error: "invalid_auth" };
    case "apps.connections.open":
      return auth === APP ? { ok: true, url: "wss://example" } : { ok: false, error: "invalid_auth" };
    case "apps.manifest.create":
      return auth === CONFIG
        ? {
            ok: true,
            app_id: "A0NEW",
            credentials: { client_id: "111.222", client_secret: "client-secret-123" },
            oauth_authorize_url: "https://slack.com/oauth/v2/authorize?client_id=111.222&scope=chat:write",
          }
        : { ok: false, error: "invalid_auth" };
    case "apps.manifest.delete":
      return { ok: true };
    case "oauth.v2.access":
      return params.code === "the-code" && params.client_secret === "client-secret-123"
        ? {
            ok: true,
            access_token: BOT,
            bot_user_id: "UBOT",
            app_id: "A0NEW",
            team: { id: "T1", name: "Alex Test" },
            authed_user: { id: "UALEX" },
          }
        : { ok: false, error: "invalid_code" };
    case "users.lookupByEmail":
      return params.email === "alex@example.com" ? { ok: true, user: { id: "UALEX" } } : { ok: false, error: "users_not_found" };
    case "conversations.open":
      return { ok: true, channel: { id: `D-${params.users}` } };
    case "chat.postMessage":
      return { ok: true };
    default:
      return { ok: false, error: "unknown_method" };
  }
}

function resetLocalEnv() {
  const keys = Object.keys(readLocalEnvOverrides(root));
  writeLocalEnvOverrides(Object.fromEntries(keys.map((k) => [k, ""])), root);
}

function assertNoSecret(value, where) {
  const text = JSON.stringify(value);
  for (const secret of SECRETS) assert.ok(!text.includes(secret), `${where} must not contain a secret`);
}

try {
  // --- Box manifest (requirement "Box Slack app uses agent view and the names of the companion")
  {
    const hermes = JSON.parse(await readFile(path.join(here, "fixtures/hermes-slack-manifest-agent-view.json"), "utf8"));
    hermes.features.assistant_view = { assistant_description: "old" };
    const names = boxSlackNames(root);
    assert.equal(names.companion, "Clara");
    assert.ok(names.longDescription.length >= 175 && names.longDescription.length <= 4000);
    const redirect = slackOAuthRedirectUrl();
    assert.equal(redirect, "https://sample.box.joshu.me/joshu/api/slack/oauth/callback");
    const manifest = shapeBoxSlackManifest(hermes, names, redirect);
    assert.ok(manifest.features.agent_view, "agent_view");
    assert.equal(manifest.features.assistant_view, undefined, "no assistant_view");
    assert.match(manifest.features.agent_view.agent_description, /Clara/);
    assert.equal(manifest.display_information.name, "Clara");
    assert.equal(manifest.features.bot_user.display_name, "Clara");
    assert.deepEqual(
      manifest.features.slash_commands.map((c) => c.command),
      [...BOX_SLACK_SLASH_COMMANDS],
    );
    assert.ok(manifest.oauth_config.scopes.bot.includes("users:read.email"));
    assert.ok(manifest.oauth_config.scopes.bot.includes("im:write"));
    assert.deepEqual(manifest.oauth_config.redirect_urls, [redirect]);
    assert.equal(manifest.settings.socket_mode_enabled, true);
    assert.equal(hermes.features.slash_commands.length, 50, "the input manifest is not changed");
    const link = slackCreateAppUrl(manifest);
    assert.ok(link.startsWith("https://api.slack.com/apps?new_app=1&manifest_json="));
    assert.ok(link.length < 8000, `prefilled link has ${link.length} characters`);
  }

  // --- Token search by pattern; an old token does not count
  {
    const before = [`Your App Configuration Tokens\nAccess Token ${OLD_CONFIG}`, REFRESH];
    const after = [...before, `<input value="${CONFIG}">`, CONFIG];
    assert.deepEqual(findTokens(before, "configuration"), [OLD_CONFIG], "refresh token is not a configuration token");
    const baseline = new Set(findTokens(before, "configuration"));
    assert.deepEqual(findNewTokens(after, "configuration", baseline), [CONFIG]);
    assert.deepEqual(findTokens([`token: ${APP}.`], "app"), [APP]);
    // Pages of 2026-10-10: the sign-in ends on docs.slack.dev; app settings moved to app.slack.com.
    assert.equal(shouldReturnToAppsPage("https://docs.slack.dev/"), true);
    assert.equal(shouldReturnToAppsPage("https://app.slack.com/client/T1/C1"), true);
    assert.equal(shouldReturnToAppsPage("https://slack.com/signin"), false, "sign-in pages stay");
    assert.equal(shouldReturnToAppsPage("https://projectaeonworkspace.slack.com/ssb/redirect"), true, "page after 2FA");
    assert.equal(shouldReturnToAppsPage("https://projectaeonworkspace.slack.com/z-app-123"), false, "2FA page stays");
    assert.equal(shouldReturnToAppsPage("https://accounts.google.com/o/oauth2"), false);
    assert.equal(shouldReturnToAppsPage("https://api.slack.com/apps"), false);
    assert.equal(isAppSettingsPage("https://app.slack.com/app-settings/T1/A0NEW/general", "A0NEW", ["App-Level Tokens"]), true);
    assert.equal(isAppSettingsPage("https://app.slack.com/app-settings/T1/A0OTHER/general", "A0NEW", ["App-Level Tokens"]), false);
    assert.equal(isAppSettingsPage("https://api.slack.com/apps/A0NEW/general", "A0NEW", ["App-Level Tokens"]), true);
  }

  // --- Look and decide: name each Slack page and pick the next step of the sign-in
  //     (requirement "Slack connect reads the browser and says what it sees")
  {
    // Pages of 2026-10-14 (clara, and the Claude browser pane).
    assert.equal(slackPageKind(APPS_SIGNED_OUT), "apps_signed_out");
    assert.equal(slackPageKind(APPS_READY), "apps_ready");
    assert.equal(slackPageKind(tabView("https://api.slack.com/apps", { generateToken: "disabled" })), "apps_ready");
    assert.equal(slackPageKind(tabView("https://api.slack.com/apps")), "other", "apps page still loading");
    assert.equal(slackPageKind(LAUNCHING), "launching");
    assert.equal(launchingWorkspace(LAUNCHING), "Acme Studio");
    assert.equal(slackPageKind(WORKSPACE_LIST), "workspace_list");
    assert.equal(slackPageKind(tabView("https://slack.com/signin#/signin")), "sign_in");
    assert.equal(
      slackPageKind(tabView("https://acme-studio.slack.com/z-app-1-2", { title: "Enter your authentication code | Slack" })),
      "two_factor",
    );
    assert.equal(slackPageKind(tabView("https://docs.slack.dev/")), "workspace_signed_in");
    assert.equal(slackPageKind(tabView("https://app.slack.com/client/T1")), "workspace_signed_in");
    assert.equal(slackPageKind(tabView("https://accounts.google.com/v3/signin/accountchooser")), "sign_in", "Google sign-in is part of the sign-in");
    assert.match(
      decideSignIn([tabView("https://accounts.google.com/v3/signin/accountchooser", { headings: ["Choose an account"] })], false).hint,
      /^jWeb shows "Choose an account"\. Sign in to Slack in jWeb\.$/,
    );
    // A live box, 2026-10-14: the workspace list of a workspace with 2-factor sign-in.
    assert.match(
      decideSignIn([tabView("https://slack.com/signin#/workspaces", { headings: ["Welcome back! You look nice today.", "Additional authentication required"] })], false).hint,
      /click Authenticate if Slack shows it/,
    );

    // Clara: the sign-in ended on "Launching" in a second tab. The box acts and says what it sees.
    const launching = decideSignIn([WORKSPACE_LIST, LAUNCHING], false);
    assert.equal(launching.act, "open_apps");
    assert.match(launching.hint, /Slack is showing "Launching Acme Studio"\. You are signed in to the workspace\./);
    // The owner signs in: the box says what Slack shows and what to do.
    const signedOut = decideSignIn([APPS_SIGNED_OUT], false);
    assert.equal(signedOut.act, "wait");
    assert.match(signedOut.hint, /Slack is showing "Your Apps"\. In jWeb, click "sign in to your Slack account"/);
    assert.match(decideSignIn([WORKSPACE_LIST], false).hint, /click the workspace/);
    // I'm signed in is a "go now": the box opens the apps page also when it sees no sign-in.
    assert.equal(decideSignIn([APPS_SIGNED_OUT], true).act, "open_apps");
    // Ready only when the apps page is the only tab, because the next steps use the first tab.
    assert.equal(decideSignIn([APPS_READY], false).act, "go_on");
    assert.equal(decideSignIn([WORKSPACE_LIST, APPS_READY], false).act, "open_apps");
    // An unknown page: the box names it and asks the owner to finish it.
    const unknown = decideSignIn([tabView("https://acme.okta.com/login", { title: "Acme Sign In" })], false);
    assert.equal(unknown.act, "wait");
    assert.match(unknown.hint, /jWeb shows "Acme Sign In"\. Finish this page in jWeb/);
  }

  // --- Slack Web API: bearer token, and no token in errors
  {
    const slack = fakeSlack();
    const identity = await slackAuthTest(BOT, slack.fetchImpl);
    assert.equal(identity.team, "Alex Test");
    assert.equal(slack.calls[0].auth, BOT);
    await assert.rejects(
      () => slackAuthTest("xoxb-wrong-wrong-wrong", slack.fetchImpl),
      (err) => err instanceof SlackApiError && err.code === "invalid_auth" && !err.message.includes("xoxb-"),
    );
    assert.equal(addSlackUser("U1, U2", "U2"), "U1,U2");
    assert.equal(addSlackUser("", "U3"), "U3");
  }

  // --- finishSlackConnection (requirements "The companion writes first" and "Joshu finds the Slack user …")
  {
    resetLocalEnv();
    writeLocalEnvOverrides({ SLACK_APP_ID: "A0OLD" }, root);
    const events = [];
    const slack = fakeSlack({}, events);
    let applied = 0;
    const hints = [];
    const result = await finishSlackConnection({
      projectRoot: root,
      botToken: BOT,
      appToken: APP,
      appId: "A0NEW",
      configurationToken: CONFIG,
      applyToHermes: async (onWaiting) => {
        applied += 1;
        events.push("restart-start");
        onWaiting();
        await new Promise((r) => setTimeout(r, 20));
        events.push("restart-done");
      },
      onWaiting: (hint) => hints.push(hint),
      fetchImpl: slack.fetchImpl,
    });
    // The first DM goes out only after the Hermes gateway has the new tokens.
    // The DM channel opens before the restart, so the gateway starts with SLACK_HOME_CHANNEL.
    assert.ok(events.indexOf("conversations.open") < events.indexOf("restart-start"), "DM channel opens before the restart");
    assert.ok(events.indexOf("restart-done") < events.indexOf("chat.postMessage"), "restart awaited before chat.postMessage");
    assert.deepEqual(hints, ["Clara is finishing a task and will message you in Slack in a few minutes."]);
    const env = readLocalEnvOverrides(root);
    assert.equal(env.SLACK_BOT_TOKEN, BOT);
    assert.equal(env.SLACK_APP_TOKEN, APP);
    assert.equal(env.SLACK_ALLOWED_USERS, "UALEX", "owner found by email");
    assert.equal(env.SLACK_APP_ID, "A0NEW");
    assert.equal(env.SLACK_HOME_CHANNEL, "D-UALEX", "DM becomes the Slack home channel");
    assert.equal(result.welcomeSent, true);
    assert.equal(applied, 1);
    const post = slack.calls.find((c) => c.method === "chat.postMessage");
    assert.match(post.params.text, /^Hi Alex, it's Clara\./);
    const del = slack.calls.find((c) => c.method === "apps.manifest.delete");
    assert.equal(del?.params.app_id, "A0OLD", "earlier box Slack app deleted");

    // A set Slack home channel stays.
    writeLocalEnvOverrides({ SLACK_HOME_CHANNEL: "C-HOME" }, root);
    await finishSlackConnection({
      projectRoot: root,
      botToken: BOT,
      appToken: APP,
      ownerUserId: "UALEX",
      applyToHermes: async () => undefined,
      fetchImpl: fakeSlack().fetchImpl,
    });
    assert.equal(readLocalEnvOverrides(root).SLACK_HOME_CHANNEL, "C-HOME");

    await assert.rejects(
      () =>
        finishSlackConnection({
          projectRoot: root,
          botToken: BOT,
          appToken: BAD_APP,
          applyToHermes: async () => undefined,
          fetchImpl: fakeSlack().fetchImpl,
        }),
      /Slack rejected the app token/,
    );
  }

  // --- Slack connect run (requirements "Slack connect needs only a sign-in and Allow",
  //     "Tokens stay out of models and logs", "OAuth redirect needs the state of the run")
  {
    resetLocalEnv();
    const slack = fakeSlack();
    const statuses = [];
    let currentUrl = "about:blank";
    let signedIn = false;
    let configClicked = false;
    let appClicked = false;
    let authorizeUrl = "";
    const opened = [];
    const logs = [];
    let controller;
    const browser = {
      async look() {
        if (currentUrl === "https://api.slack.com/apps") return [signedIn ? APPS_READY : APPS_SIGNED_OUT];
        return [tabView(currentUrl)];
      },
      async useOneTab(url) {
        await browser.open(url);
      },
      async open(url) {
        // Slack redirects the old settings URL to the new settings UI.
        currentUrl = url === "https://api.slack.com/apps/A0NEW/general"
          ? "https://app.slack.com/app-settings/T1/A0NEW/general"
          : url;
        opened.push(currentUrl);
        if (url.startsWith("https://slack.com/oauth/v2/authorize")) authorizeUrl = url;
      },
      async url() {
        statuses.push(controller.getStatus());
        return currentUrl;
      },
      async strings() {
        statuses.push(controller.getStatus());
        if (currentUrl === "https://api.slack.com/apps") {
          if (!signedIn) return ["You'll need to sign in to your Slack account to create an application."];
          // As on the real page: the tokens are not in the page text.
          return ["Your App Configuration Tokens", "Workspace\tAccess Token\tRefresh Token\tDelete"];
        }
        if (currentUrl.startsWith("https://app.slack.com/app-settings/T1/A0NEW/")) {
          // As on the real page: the app token is in a read-only input.
          return ["Basic Information", "App-Level Tokens", ...(appClicked ? [APP] : [])];
        }
        return [""];
      },
      async copyConfigurationTokens() {
        if (currentUrl !== "https://api.slack.com/apps" || !signedIn) return [];
        return [OLD_CONFIG, ...(configClicked ? [CONFIG] : [])];
      },
      async canGenerateConfigurationToken() {
        return true;
      },
      async clickGenerateConfigurationToken() {
        configClicked = true;
        return { ok: true };
      },
      async clickGenerateAppToken() {
        // Slack moved the button: the owner clicks in jWeb a little later.
        setTimeout(() => {
          appClicked = true;
        }, 60);
        return { ok: false, step: "generate_token_and_scopes_button" };
      },
    };
    let applied = 0;
    controller = new SlackConnectController({
      projectRoot: root,
      browser,
      buildManifest: async () => ({ display_information: { name: "Clara" } }),
      redirectUrl: slackOAuthRedirectUrl,
      finish: (input) =>
        finishSlackConnection({
          ...input,
          projectRoot: root,
          applyToHermes: async (onWaiting) => {
            applied += 1;
            onWaiting();
            statuses.push(controller.getStatus());
          },
        }),
      fetchImpl: slack.fetchImpl,
      pollMs: 5,
      ownerClickAfterMs: 20,
      log: (line) => logs.push(line),
    });

    assert.equal((await controller.start()).ok, true);
    assert.equal(controller.getStatus().phase, "sign_in");
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(controller.getStatus().phase, "sign_in", "waits for the sign-in");
    // After the sign-in, Slack shows docs.slack.dev; the run goes back to the apps page.
    signedIn = true;
    currentUrl = "https://docs.slack.dev/";
    for (let i = 0; i < 100 && controller.getStatus().phase === "sign_in"; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.ok(opened.filter((u) => u === "https://api.slack.com/apps").length >= 2, "run returns to the apps page");

    // Wait for the install phase.
    for (let i = 0; i < 200 && controller.getStatus().phase !== "install"; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.equal(controller.getStatus().phase, "install");
    assert.ok(
      statuses.some((s) => s.phase === "app_token" && /Generate Token and Scopes/.test(s.hint)),
      "hint asks the owner to click the moved button",
    );
    assert.equal(
      logs.filter((l) => /app token: try \d of 3 stopped at generate_token_and_scopes_button/.test(l)).length,
      3,
      "the run tries the app token clicks 3 times and logs the step",
    );
    const create = slack.calls.find((c) => c.method === "apps.manifest.create");
    assert.equal(create.auth, CONFIG, "only the new configuration token is used");
    const authorize = new URL(authorizeUrl);
    const state = authorize.searchParams.get("state");
    assert.ok(state && state.length >= 40);
    assert.equal(authorize.searchParams.get("redirect_uri"), "https://sample.box.joshu.me/joshu/api/slack/oauth/callback");

    const callsBefore = slack.calls.length;
    const wrong = await controller.acceptOAuthRedirect({ state: "not-the-state", code: "the-code" });
    assert.equal(wrong.ok, false);
    assert.equal(slack.calls.length, callsBefore, "wrong state: no Slack call");

    const accepted = await controller.acceptOAuthRedirect({ state, code: "the-code" });
    assert.equal(accepted.ok, true, accepted.message);
    assert.ok(["finishing", "done"].includes(accepted.status.phase), "the redirect answers after the code exchange");
    const done = { status: await controller.waitForEnd() };
    assert.equal(done.status.phase, "done");
    assert.equal(done.status.team, "Alex Test");
    assert.equal(done.status.appId, "A0NEW");
    assert.equal(applied, 1);
    const env = readLocalEnvOverrides(root);
    assert.equal(env.SLACK_BOT_TOKEN, BOT);
    assert.equal(env.SLACK_APP_TOKEN, APP);
    assert.equal(env.SLACK_ALLOWED_USERS, "UALEX", "the user who clicked Allow");
    assert.equal(env.SLACK_APP_ID, "A0NEW");

    assert.ok(
      statuses.some((st) => st.phase === "finishing" && /finishing a task and will message you/.test(st.hint)),
      "run status tells the owner why the first DM waits",
    );
    const callsAtEnd = slack.calls.length;
    const reused = await controller.acceptOAuthRedirect({ state, code: "the-code" });
    assert.equal(reused.ok, true, "a second load of the redirect shows the status");
    assert.match(reused.message, /Slack is connected/);
    assert.equal(slack.calls.length, callsAtEnd, "a used state makes no second Slack call");
    for (const status of [...statuses, controller.getStatus(), done.status]) assertNoSecret(status, "run status");
    assertNoSecret(logs, "run log");

    // Slack allows one configuration token for each workspace: with one token on
    // the page and Generate Token disabled, the run uses the existing token.
    {
      const slack2 = fakeSlack({
        "apps.manifest.create": (_p, auth) =>
          auth === OLD_CONFIG
            ? { ok: true, app_id: "A0TWO", credentials: { client_id: "1.2", client_secret: "s" }, oauth_authorize_url: "https://slack.com/oauth/v2/authorize?client_id=1.2" }
            : { ok: false, error: "invalid_auth" },
      });
      let url2 = "https://api.slack.com/apps";
      const run2 = new SlackConnectController({
        projectRoot: root,
        browser: {
          async open(url) { url2 = url; },
          async url() { return url2; },
          async look() { return [url2 === "https://api.slack.com/apps" ? APPS_READY : tabView(url2)]; },
          async useOneTab(url) { url2 = url; },
          async strings() { return url2 === "https://api.slack.com/apps" ? ["Your App Configuration Tokens"] : [""]; },
          async copyConfigurationTokens() { return [OLD_CONFIG]; },
          async canGenerateConfigurationToken() { return false; },
          async clickGenerateConfigurationToken() { throw new Error("must not click a disabled button"); },
          async clickGenerateAppToken() { return { ok: false, step: "generate_token_and_scopes_button" }; },
        },
        buildManifest: async () => ({}),
        redirectUrl: slackOAuthRedirectUrl,
        finish: async () => { throw new Error("not reached"); },
        fetchImpl: slack2.fetchImpl,
        pollMs: 5,
        log: () => undefined,
      });
      await run2.start();
      for (let i = 0; i < 200 && run2.getStatus().phase !== "app_token"; i += 1) await new Promise((r) => setTimeout(r, 5));
      assert.equal(run2.getStatus().phase, "app_token", "existing configuration token used");
      assert.equal(slack2.calls.find((c) => c.method === "apps.manifest.create")?.auth, OLD_CONFIG);
      run2.cancel();
    }

    // Cancel stops a run.
    signedIn = false;
    await controller.start();
    const cancelled = controller.cancel();
    assert.equal(cancelled.phase, "cancelled");
    assert.equal((await controller.waitForEnd()).phase, "cancelled");
  }

  // --- Sign-in phase: look at all tabs, act, check; I'm signed in; click tries
  //     (requirements "Slack connect reads the browser and says what it sees", "The owner says when the Slack
  //     sign-in is done", "Slack connect checks each click and tries again")
  {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const until = async (cond) => {
      for (let i = 0; i < 400 && !cond(); i += 1) await wait(5);
      return cond();
    };
    /** A shared browser with tabs. `state.tabs` holds the view of each tab. */
    const tabbedBrowser = (state) => ({
      async open(url) {
        state.opened.push(url);
        state.tabs[0] = url === "https://api.slack.com/apps" ? state.appsView() : tabView(url);
      },
      async url() { return state.tabs[0]?.url ?? ""; },
      async look() { return state.tabs.map((t) => (t.url === "https://api.slack.com/apps" ? state.appsView() : t)); },
      async useOneTab(url) {
        state.oneTab += 1;
        state.tabs = [];
        await this.open(url);
      },
      async strings() { return [""]; },
      async copyConfigurationTokens() { return state.configClicked ? [CONFIG] : []; },
      async canGenerateConfigurationToken() { return true; },
      async clickGenerateConfigurationToken(workspace) {
        state.configTries += 1;
        state.workspaces.push(workspace);
        const outcome = state.configOutcomes.shift() ?? { ok: true };
        if (outcome.ok) state.configClicked = true;
        return outcome;
      },
      async clickGenerateAppToken() { return { ok: true }; },
    });
    const newState = (extra = {}) => {
      const state = {
        tabs: [],
        opened: [],
        oneTab: 0,
        signedIn: false,
        configTries: 0,
        configClicked: false,
        configOutcomes: [],
        workspaces: [],
        ...extra,
      };
      state.appsView = () => (state.signedIn ? APPS_READY : APPS_SIGNED_OUT);
      return state;
    };
    const newRun = (state, logs) =>
      new SlackConnectController({
        projectRoot: root,
        browser: tabbedBrowser(state),
        buildManifest: async () => ({}),
        redirectUrl: slackOAuthRedirectUrl,
        finish: async () => { throw new Error("not reached"); },
        fetchImpl: fakeSlack().fetchImpl,
        pollMs: 5,
        ownerClickAfterMs: 1_000,
        log: (line) => logs.push(line),
      });

    // Clara 2026-10-14: the sign-in ends on "Launching" in a second tab, and the first tab
    // still shows the workspace list. The box sees it, says so, keeps one tab, and goes on.
    {
      const logs = [];
      const state = newState();
      const run = newRun(state, logs);
      await run.start();
      assert.ok(await until(() => /Slack is showing "Your Apps"\. In jWeb, click "sign in/.test(run.getStatus().hint)));
      assert.equal(run.getStatus().phase, "sign_in");
      const statuses = [];
      state.tabs = [WORKSPACE_LIST, LAUNCHING];
      state.signedIn = true;
      assert.ok(
        await until(() => {
          statuses.push(run.getStatus());
          return run.getStatus().phase !== "sign_in";
        }),
        "a sign-in in the second tab counts without a click",
      );
      assert.ok(statuses.some((st) => /Launching Acme Studio/.test(st.hint)), "the Safety app says what the box sees");
      assert.equal(state.oneTab, 1, "the box keeps one tab");
      assert.ok(await until(() => state.configTries === 1));
      assert.deepEqual(state.workspaces, ["Acme Studio"], "the box picks the workspace of the sign-in");
      assert.ok(logs.some((l) => l === "[slack-connect] sign-in: tabs=workspace_list,launching act=open_apps"));
      run.cancel();
    }

    // I'm signed in: a "go now". Too early, the box says what Slack shows; after the sign-in, it goes on.
    {
      const logs = [];
      const state = newState();
      const run = newRun(state, logs);
      await run.start();
      await wait(20);
      assert.match(run.confirmSignedIn().hint, /opens Your Apps/);
      assert.ok(await until(() => state.oneTab === 1));
      assert.ok(await until(() => /In jWeb, click "sign in to your Slack account"/.test(run.getStatus().hint)));
      assert.equal(run.getStatus().phase, "sign_in", "the button does not skip the sign-in");
      state.signedIn = true;
      run.confirmSignedIn();
      assert.ok(await until(() => run.getStatus().phase !== "sign_in"));
      assert.ok(logs.some((l) => /act=open_apps \(owner clicked I'm signed in\)/.test(l)));
      run.cancel();
    }

    // I'm signed in outside phase sign_in changes nothing.
    {
      const run = newRun(newState(), []);
      assert.equal(run.confirmSignedIn().phase, "idle");
    }

    // Generate Token: check the result, load the page again when it did not answer, and log each step.
    {
      const logs = [];
      const state = newState({
        signedIn: true,
        configOutcomes: [{ ok: false, step: "configuration_dialog" }, { ok: false, step: "workspace_picker" }, { ok: true }],
      });
      state.tabs = [APPS_READY];
      const run = newRun(state, logs);
      await run.start();
      assert.ok(await until(() => !["sign_in", "configuration_token"].includes(run.getStatus().phase)));
      assert.notEqual(run.getStatus().phase, "failed", run.getStatus().error);
      assert.equal(state.configTries, 3);
      assert.ok(logs.includes("[slack-connect] configuration token: try 1 of 3 stopped at configuration_dialog"));
      assert.ok(logs.includes("[slack-connect] configuration token: try 2 of 3 stopped at workspace_picker"));
      assert.ok(logs.includes("[slack-connect] configuration token: clicks done on try 3"));
      // Only the try where the dialog did not open loads the apps page again.
      const reloads = state.opened.filter((u) => u === "https://api.slack.com/apps").length;
      assert.equal(reloads, 2, "one load at the start and one after the dialog did not open");
      run.cancel();

      const state2 = newState({ signedIn: true, configOutcomes: [{ ok: false, step: "several_workspaces" }] });
      state2.tabs = [APPS_READY];
      const run2 = newRun(state2, []);
      await run2.start();
      assert.ok(await until(() => /pick your workspace/.test(run2.getStatus().hint)));
      await wait(30);
      assert.equal(state2.configTries, 1, "the owner picks the workspace; no second try");
      run2.cancel();
    }
  }

  // --- Safety app routes (gate, token checks, background restart, pairing)
  {
    resetLocalEnv();
    const events = [];
    const slack = fakeSlack({}, events);
    const reloads = [];
    let finishRestart;
    const runner = {
      applyConfigAndAwaitGatewayRestart: async (reason) => {
        reloads.push(reason);
        events.push("restart-start");
        await new Promise((resolve) => {
          finishRestart = resolve;
        });
        events.push("restart-done");
        return { restarted: true };
      },
      getGatewayStatus: async () => ({ running: true, autoStart: true }),
    };
    const execFileImpl = async (_file, args) => ({
      stdout:
        args[3] === "ABCD2345"
          ? "\n  Approved! User Alex R (UPAIR) on slack can now use the bot~\n"
          : "\n  Pairing request or code 'X' not found or expired for platform 'slack'.\n",
    });
    const app = express();
    app.use(express.json());
    const router = express.Router();
    registerSafetySettingsRoutes(router, {
      projectRoot: root,
      hermesBinary: "/fake/hermes",
      runner,
      fetchImpl: slack.fetchImpl,
      execFileImpl,
    });
    app.use("/joshu", router);
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}/joshu`;
    const call = (p, init = {}) =>
      fetch(`${base}${p}`, {
        ...init,
        headers: { "content-type": "application/json", ...(init.headers ?? {}) },
      });
    try {
      // Requirement "Safety app API needs a desktop session"
      const blocked = await call("/api/safety-settings", {
        method: "PUT",
        headers: { "x-forwarded-for": "203.0.113.9", "x-forwarded-host": "sample.box.joshu.me" },
        body: JSON.stringify({ secrets: { slackBotToken: BOT } }),
      });
      assert.equal(blocked.status, 401);
      assert.equal(readLocalEnvOverrides(root).SLACK_BOT_TOKEN, undefined, "blocked request changes nothing");
      assert.equal((await call("/api/safety-settings/slack-setup", { headers: { "x-forwarded-for": "1.2.3.4" } })).status, 401);
      assert.equal((await call("/api/safety-settings")).status, 200, "direct localhost passes");

      // Requirement "Token checks before save"
      const rejected = await call("/api/safety-settings", {
        method: "PUT",
        body: JSON.stringify({ secrets: { slackBotToken: BOT, slackAppToken: BAD_APP } }),
      });
      assert.equal(rejected.status, 400);
      assert.match((await rejected.json()).error, /app token.*invalid_auth/);
      assert.equal(readLocalEnvOverrides(root).SLACK_BOT_TOKEN, undefined, "rejected save changes nothing");
      assert.equal(reloads.length, 0);

      // Good tokens: saved, owner found, first DM, background restart (no prompt).
      const saved = await call("/api/safety-settings", {
        method: "PUT",
        body: JSON.stringify({ secrets: { slackBotToken: BOT, slackAppToken: APP } }),
      });
      const savedJson = await saved.json();
      assert.equal(saved.status, 200, savedJson.error);
      assert.match(savedJson.note, /restarts in the background/);
      assert.match(savedJson.note, /Clara sends you a DM in Slack when the Hermes gateway has restarted/);
      assert.ok(!events.includes("chat.postMessage"), "no first DM while the restart waits");
      finishRestart();
      for (let i = 0; i < 100 && !events.includes("chat.postMessage"); i += 1) {
        await new Promise((r) => setTimeout(r, 5));
      }
      assert.ok(events.indexOf("restart-done") < events.indexOf("chat.postMessage"), "manual path: restart before the first DM");
      assert.equal(savedJson.settings.hermesMessaging.slack.configured, true);
      assert.equal(savedJson.settings.hermesMessaging.slack.ownerLinked, true);
      assert.equal(reloads.length, 1, "messaging change restarts the gateway in the background");
      assertNoSecret(savedJson, "save response");

      // Requirement "Messaging save restarts the gateway without a prompt": no change, no restart.
      const unchanged = await call("/api/safety-settings", {
        method: "PUT",
        body: JSON.stringify({ actionGuard: { approvalTimeoutMs: 600000 } }),
      });
      assert.equal(unchanged.status, 200);
      assert.equal(reloads.length, 1, "no messaging change, no restart");

      // Pairing code: wrong, then right.
      resetLocalEnv();
      writeLocalEnvOverrides({ SLACK_BOT_TOKEN: BOT, SLACK_APP_TOKEN: APP }, root);
      const wrongCode = await call("/api/safety-settings/pairing/approve", {
        method: "POST",
        body: JSON.stringify({ platform: "slack", code: "ZZZZ9999" }),
      });
      assert.equal(wrongCode.status, 400);
      const approved = await call("/api/safety-settings/pairing/approve", {
        method: "POST",
        body: JSON.stringify({ platform: "slack", code: "abcd-2345" }),
      });
      const approvedJson = await approved.json();
      assert.equal(approved.status, 200, approvedJson.error);
      assert.equal(approvedJson.userId, "UPAIR");
      assert.equal(approvedJson.dmSent, true);
      assert.equal(readLocalEnvOverrides(root).SLACK_ALLOWED_USERS, "UPAIR");
      const badPlatform = await call("/api/safety-settings/pairing/approve", {
        method: "POST",
        body: JSON.stringify({ platform: "email", code: "ABCD2345" }),
      });
      assert.equal(badPlatform.status, 400);
    } finally {
      server.close();
    }
  }

  // --- Pairing helpers
  {
    assert.equal(normalizePairingCode(" `abcd2345` "), "ABCD2345");
    assert.equal(normalizePairingCode("ABCD1234"), null, "1 is not in the pairing alphabet");
    assert.deepEqual(parsePairingApproveOutput("Approved! User U123 on slack can now use the bot~"), {
      ok: true,
      userName: "",
      userId: "U123",
    });
    assert.equal(parsePairingApproveOutput("Platform 'slack' is locked out after too many").ok, false);
  }

  // --- Suggested prompts (requirement "Suggested prompts in the Slack DM")
  {
    const config = { platforms: { sms: { enabled: false }, slack: { extra: { other: 1 } } } };
    assert.equal(syncJoshuSlackSuggestedPrompts(config), true);
    assert.deepEqual(config.platforms.slack.extra.suggested_prompts, JOSHU_SLACK_SUGGESTED_PROMPTS);
    assert.equal(config.platforms.slack.extra.other, 1, "other extra keys stay");
    assert.equal(config.platforms.slack.extra.reply_in_thread, false, "flat replies, like a DM with a coworker");
    assert.equal(config.platforms.slack.extra.dm_top_level_threads_as_sessions, false, "one DM conversation");
    assert.equal(config.platforms.slack.extra.gateway_restart_notification, false, "no restart notice in Slack");
    assert.equal(config.platforms.sms.enabled, false);
    assert.equal(syncJoshuSlackSuggestedPrompts(config), false, "second sync changes nothing");
    assert.equal(JOSHU_SLACK_SUGGESTED_PROMPTS.length, 4);
    for (const p of JOSHU_SLACK_SUGGESTED_PROMPTS) assert.ok(p.title.length <= 75);
  }

  console.log("slack-connect: ok");
} finally {
  await rm(root, { recursive: true, force: true });
}
