/**
 * Per-toolkit Composio auth config overrides (toolkits without managed OAuth).
 * IDs may come from env (operator override) or `.joshu/composio-auth-configs.json` (in-UI wizard).
 * @see https://docs.composio.dev/docs/custom-app-vs-managed-app
 */

import fs from "node:fs";
import path from "node:path";
import { joshuConfigDir } from "./nylas/paths.js";

function envTrim(name: string): string {
  return process.env[name]?.trim() || "";
}

/** Toolkit slugs that require a custom auth config in Composio (no managed app). */
export const COMPOSIO_CUSTOM_AUTH_TOOLKITS = new Set(["onenote", "slackbot"]);

function authConfigsFileDir(projectRoot = process.cwd()): string {
  const joshu = joshuConfigDir(projectRoot);
  if (joshu) return joshu;
  return path.join(projectRoot, ".local");
}

export function composioAuthConfigsFilePath(projectRoot = process.cwd()): string {
  return path.join(authConfigsFileDir(projectRoot), "composio-auth-configs.json");
}

type AuthConfigsFile = Record<string, string>;

function readAuthConfigsFile(projectRoot = process.cwd()): AuthConfigsFile {
  const p = composioAuthConfigsFilePath(projectRoot);
  if (!fs.existsSync(p)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(p, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: AuthConfigsFile = {};
    for (const [slug, value] of Object.entries(parsed as Record<string, unknown>)) {
      const id = typeof value === "string" ? value.trim() : "";
      if (slug.trim() && id) out[slug.trim().toLowerCase()] = id;
    }
    return out;
  } catch {
    return {};
  }
}

/** Persist one toolkit → auth config id (ac_…). Mode 0600. */
export function setPersistedComposioAuthConfigId(
  toolkitSlug: string,
  authConfigId: string,
  projectRoot = process.cwd(),
): void {
  const slug = toolkitSlug.trim().toLowerCase();
  const id = authConfigId.trim();
  if (!slug || !id) throw new Error("toolkit_and_auth_config_id_required");
  const dir = authConfigsFileDir(projectRoot);
  fs.mkdirSync(dir, { recursive: true });
  const current = readAuthConfigsFile(projectRoot);
  current[slug] = id;
  const filePath = composioAuthConfigsFilePath(projectRoot);
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(current, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

export function getPersistedComposioAuthConfigId(
  toolkitSlug: string,
  projectRoot = process.cwd(),
): string | undefined {
  return readAuthConfigsFile(projectRoot)[toolkitSlug.trim().toLowerCase()];
}

/**
 * Auth config IDs keyed by toolkit slug for Composio tool-router sessions.
 * Resolution: env overrides → persisted `.joshu/composio-auth-configs.json`.
 */
export function resolveComposioToolkitAuthConfigs(
  projectRoot = process.cwd(),
): Record<string, string> {
  // File first, then env wins (operator override).
  const configs: Record<string, string> = { ...readAuthConfigsFile(projectRoot) };

  const rawJson = envTrim("JOSHU_COMPOSIO_AUTH_CONFIGS");
  if (rawJson) {
    try {
      const parsed = JSON.parse(rawJson) as Record<string, unknown>;
      for (const [slug, value] of Object.entries(parsed)) {
        const id = typeof value === "string" ? value.trim() : "";
        if (slug.trim() && id) configs[slug.trim().toLowerCase()] = id;
      }
    } catch {
      console.warn("[composio] JOSHU_COMPOSIO_AUTH_CONFIGS is not valid JSON — ignoring");
    }
  }

  const onenoteAuthConfigId = envTrim("JOSHU_COMPOSIO_ONENOTE_AUTH_CONFIG_ID");
  if (onenoteAuthConfigId) configs.onenote = onenoteAuthConfigId;

  const slackbotAuthConfigId = envTrim("JOSHU_COMPOSIO_SLACKBOT_AUTH_CONFIG_ID");
  if (slackbotAuthConfigId) configs.slackbot = slackbotAuthConfigId;

  return configs;
}

export function composioToolkitAuthConfigId(
  toolkitSlug: string,
  projectRoot = process.cwd(),
): string | undefined {
  const slug = toolkitSlug.trim().toLowerCase();
  return resolveComposioToolkitAuthConfigs(projectRoot)[slug];
}

export function composioToolkitNeedsCustomAuth(toolkitSlug: string): boolean {
  return COMPOSIO_CUSTOM_AUTH_TOOLKITS.has(toolkitSlug.trim().toLowerCase());
}

export function composioCustomAuthSetupMessage(toolkitSlug: string): string {
  const slug = toolkitSlug.trim().toLowerCase();
  if (slug === "onenote") {
    return (
      "Microsoft OneNote has no Composio managed OAuth app. In Composio dashboard: Auth configs → Create → OneNote → " +
      "add your Microsoft app client_id + client_secret (delegated Notes.Read). Copy the auth config id (ac_…) into " +
      "JOSHU_COMPOSIO_ONENOTE_AUTH_CONFIG_ID in .env, restart dev:arozos, then Connect again."
    );
  }
  if (slug === "slackbot") {
    return (
      "Set up Slackbot in Connectors: generate a Slack app manifest, paste Client ID, Client Secret, and " +
      "Verification Token, then Save & Connect. (Distinct from user Slack for approvals and Hermes Slack chat.)"
    );
  }
  return `Toolkit "${slug}" requires a Composio auth config. Set JOSHU_COMPOSIO_AUTH_CONFIGS or a toolkit-specific *_AUTH_CONFIG_ID env var.`;
}

/** Structured error so Connectors UI can open the Slackbot wizard. */
export class ComposioSlackbotSetupRequiredError extends Error {
  readonly code = "slackbot_setup_required" as const;
  constructor() {
    super(composioCustomAuthSetupMessage("slackbot"));
    this.name = "ComposioSlackbotSetupRequiredError";
  }
}

/** Turn Composio SDK/API errors into short operator-facing messages. */
export function formatComposioConnectError(error: unknown, toolkitSlug: string): string {
  if (error instanceof ComposioSlackbotSetupRequiredError) return error.message;
  const slug = toolkitSlug.trim().toLowerCase();
  const raw = error instanceof Error ? error.message : String(error);

  if (
    raw.includes("ToolRouterV2_NoManagedAuth") ||
    raw.includes("does not manage auth for toolkit") ||
    raw.includes("no auth config without required fields")
  ) {
    return composioCustomAuthSetupMessage(slug);
  }

  // Composio often wraps JSON in "400 {...}"
  const jsonStart = raw.indexOf("{");
  if (jsonStart >= 0) {
    try {
      const body = JSON.parse(raw.slice(jsonStart)) as {
        error?: { message?: string; slug?: string; code?: number };
      };
      const inner = body.error;
      if (
        inner?.slug === "ToolRouterV2_NoManagedAuth" ||
        inner?.code === 4308 ||
        inner?.message?.includes("does not manage auth")
      ) {
        return composioCustomAuthSetupMessage(slug);
      }
      if (inner?.message) return inner.message;
    } catch {
      /* fall through */
    }
  }

  return raw;
}
