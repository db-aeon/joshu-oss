/**
 * Per-toolkit Composio auth config overrides (toolkits without managed OAuth).
 * @see https://docs.composio.dev/docs/custom-app-vs-managed-app
 */

function envTrim(name: string): string {
  return process.env[name]?.trim() || "";
}

/** Toolkit slugs that require a custom auth config in Composio (no managed app). */
export const COMPOSIO_CUSTOM_AUTH_TOOLKITS = new Set(["onenote"]);

/**
 * Auth config IDs keyed by toolkit slug for Composio tool-router sessions.
 * Example: { onenote: "ac_1234abcd" }
 */
export function resolveComposioToolkitAuthConfigs(): Record<string, string> {
  const configs: Record<string, string> = {};

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

  return configs;
}

export function composioToolkitAuthConfigId(toolkitSlug: string): string | undefined {
  const slug = toolkitSlug.trim().toLowerCase();
  return resolveComposioToolkitAuthConfigs()[slug];
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
  return `Toolkit "${slug}" requires a Composio auth config. Set JOSHU_COMPOSIO_AUTH_CONFIGS or a toolkit-specific *_AUTH_CONFIG_ID env var.`;
}

/** Turn Composio SDK/API errors into short operator-facing messages. */
export function formatComposioConnectError(error: unknown, toolkitSlug: string): string {
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
