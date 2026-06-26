import { execFile as execFileCb } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { resolveJoshuIdentity } from "./joshuIdentity.js";
import { readHermesSlackMessagingConfig } from "./hermesMessagingEnv.js";
import { readLocalEnv, resolveEnvWithLocalFallback } from "./safetySettings/localEnv.js";

const execFile = promisify(execFileCb);

function getHermesHome(): string {
  return process.env.HERMES_HOME?.trim() || path.join(homedir(), ".hermes");
}

export type SlackTokenVerifyResult =
  | { ok: true; team: string; botId: string; user: string; url: string }
  | { ok: false; error: string };

export async function verifySlackBotToken(botToken: string): Promise<SlackTokenVerifyResult> {
  const token = botToken.trim();
  if (!token) return { ok: false, error: "bot_token_required" };
  if (!token.startsWith("xoxb-")) return { ok: false, error: "bot_token_must_start_with_xoxb" };

  const res = await fetch("https://slack.com/api/auth.test", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
  });
  const json = (await res.json()) as {
    ok?: boolean;
    error?: string;
    team?: string;
    bot_id?: string;
    user?: string;
    url?: string;
  };
  if (!json.ok) {
    return { ok: false, error: json.error || "auth_test_failed" };
  }
  return {
    ok: true,
    team: json.team ?? "",
    botId: json.bot_id ?? "",
    user: json.user ?? "",
    url: json.url ?? "",
  };
}

export function validateSlackAppToken(appToken: string): { ok: true } | { ok: false; error: string } {
  const token = appToken.trim();
  if (!token) return { ok: false, error: "app_token_required" };
  if (!token.startsWith("xapp-")) return { ok: false, error: "app_token_must_start_with_xapp" };
  return { ok: true };
}

/** Hermes default; Slack requires a URL in the manifest but Socket Mode never calls it. */
export const HERMES_SLACK_SLASH_URL_PLACEHOLDER = "https://hermes-agent.local/slack/commands";

export const SLACK_MANIFEST_URL_NOTE =
  "Slash command url fields are schema placeholders. With Socket Mode enabled, Slack delivers commands over the WebSocket — no public HTTPS endpoint is required.";

function personalizeSlackManifest(manifest: unknown, projectRoot: string): unknown {
  const identity = resolveJoshuIdentity(projectRoot);
  const ownerLabel = identity.owner.displayName?.trim() || "the owner";
  const name = identity.name.trim() || "Hermes";
  const description = `${name} — ${ownerLabel}'s Joshu assistant on Slack`;

  if (!manifest || typeof manifest !== "object") return manifest;
  const root = manifest as Record<string, unknown>;
  const display = root.display_information;
  if (display && typeof display === "object") {
    const d = display as Record<string, unknown>;
    d.name = name.slice(0, 35);
    d.description = description.slice(0, 140);
  }
  const features = root.features;
  if (features && typeof features === "object") {
    const f = features as Record<string, unknown>;
    const botUser = f.bot_user;
    if (botUser && typeof botUser === "object") {
      (botUser as Record<string, unknown>).display_name = name.slice(0, 80);
    }
  }
  return root;
}

export async function generateHermesSlackManifest(
  hermesBinary: string,
  projectRoot = process.cwd(),
): Promise<{ manifest: unknown; manifestPath: string; urlNote: string }> {
  const binary = hermesBinary.trim();
  if (!binary) throw new Error("HERMES_BIN is not configured");

  const identity = resolveJoshuIdentity(projectRoot);
  const ownerLabel = identity.owner.displayName?.trim() || "the owner";
  const name = identity.name.trim() || "Hermes";
  const description = `${name} — ${ownerLabel}'s Joshu assistant on Slack`;

  await execFile(
    binary,
    ["slack", "manifest", "--write", "--name", name, "--description", description],
    { timeout: 60_000 },
  );
  const manifestPath = path.join(getHermesHome(), "slack-manifest.json");
  const raw = await readFile(manifestPath, "utf8");
  const manifest = personalizeSlackManifest(JSON.parse(raw) as unknown, projectRoot);
  return { manifest, manifestPath, urlNote: SLACK_MANIFEST_URL_NOTE };
}

export type HermesSlackSetupStatus = {
  configured: boolean;
  botTokenConfigured: boolean;
  appTokenConfigured: boolean;
  allowedUsers: string;
  homeChannel: string;
  allowedChannels: string;
  manifestPath: string;
  steps: string[];
};

export function hermesSlackSetupStatus(projectRoot = process.cwd()): HermesSlackSetupStatus {
  const cfg = readHermesSlackMessagingConfig(projectRoot);
  const configured = cfg.botTokenConfigured && cfg.appTokenConfigured && Boolean(cfg.allowedUsers.trim());
  return {
    ...cfg,
    configured,
    manifestPath: path.join(getHermesHome(), "slack-manifest.json"),
    steps: [
      "Generate the Slack app manifest (button below) and create an app at api.slack.com → From manifest.",
      "Ignore slash-command url fields (hermes-agent.local) — placeholders only; Socket Mode uses WebSocket, not HTTP.",
      "Enable Socket Mode and create an App-Level Token (xapp-…) with connections:write.",
      "Enable Messages Tab under App Home (required for DMs).",
      "Install the app to your workspace and copy the Bot User OAuth Token (xoxb-…).",
      "Paste tokens and your Slack member ID (U…) below, then Save.",
      "Restart the Hermes gateway, invite the bot to your channel (/invite @bot), and @mention it or DM it.",
    ],
  };
}

export async function verifyHermesSlackSetup(
  projectRoot: string,
  overrides?: { botToken?: string; appToken?: string },
): Promise<{
  bot: SlackTokenVerifyResult;
  app: { ok: true } | { ok: false; error: string };
}> {
  const botToken =
    overrides?.botToken?.trim() ||
    resolveEnvWithLocalFallback("SLACK_BOT_TOKEN", projectRoot);
  const appToken =
    overrides?.appToken?.trim() ||
    resolveEnvWithLocalFallback("SLACK_APP_TOKEN", projectRoot);

  const [bot, app] = await Promise.all([
    verifySlackBotToken(botToken),
    Promise.resolve(validateSlackAppToken(appToken)),
  ]);
  return { bot, app };
}
