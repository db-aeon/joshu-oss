/**
 * The Hermes configuration of the metered providers: one MCP server and one toolset for each provider.
 * The gateway sync of `src/hermesApi.ts` calls these functions.
 */
import {
  getMeteredProviderDefinition,
  METERED_PROVIDER_DEFINITIONS,
  meteredProviderMcpEnabled,
  resolveMeteredProviderApiKey,
  resolveMeteredProviderMcpHttpUrl,
  resolveMeteredProviderMode,
  RETIRED_METERED_PROVIDERS,
} from "./config.js";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Add the toolset of each active metered provider, and remove the toolset of each other one and of
 * each retired provider.
 */
export function toolsetsWithMeteredProviders(toolsets: string[], activeToolsets: ReadonlySet<string>): string[] {
  const retired = new Set(RETIRED_METERED_PROVIDERS.map((p) => p.hermesToolset));
  const next = toolsets.filter((name) => !retired.has(name));
  for (const def of METERED_PROVIDER_DEFINITIONS) {
    const idx = next.indexOf(def.hermesToolset);
    const active = activeToolsets.has(def.hermesToolset);
    if (active && idx < 0) next.push(def.hermesToolset);
    if (!active && idx >= 0) next.splice(idx, 1);
  }
  return next;
}

/**
 * Write the MCP server of each metered provider into `mcpServers`: the local metered MCP relay in
 * relay mode, the provider URL with the key of the owner in direct mode, and disabled when off.
 * Returns whether `mcpServers` changed and the toolsets of the active providers.
 */
export function syncMeteredProviderMcpServers(
  mcpServers: Record<string, unknown>,
  projectRoot: string,
): { changed: boolean; activeToolsets: Set<string> } {
  let changed = false;
  const activeToolsets = new Set<string>();
  for (const retired of RETIRED_METERED_PROVIDERS) {
    if (retired.hermesServerName in mcpServers) {
      delete mcpServers[retired.hermesServerName];
      changed = true;
    }
  }
  for (const def of METERED_PROVIDER_DEFINITIONS) {
    const current = asRecord(mcpServers[def.hermesServerName]);
    if (!meteredProviderMcpEnabled(def, projectRoot)) {
      if (Object.keys(current).length > 0 && current.enabled !== false) {
        mcpServers[def.hermesServerName] = { ...current, enabled: false };
        changed = true;
      }
      continue;
    }
    activeToolsets.add(def.hermesToolset);
    const desired =
      resolveMeteredProviderMode(def) === "relay"
        ? { url: resolveMeteredProviderMcpHttpUrl(def), connect_timeout: 120, enabled: true }
        : {
            url: def.ossMcpUrl,
            headers: { Authorization: `Bearer ${resolveMeteredProviderApiKey(def, projectRoot)}` },
            connect_timeout: 120,
            enabled: true,
          };
    const headersMatch =
      JSON.stringify(asRecord(current.headers)) === JSON.stringify(desired.headers ?? {});
    if (
      current.url !== desired.url ||
      current.enabled !== true ||
      current.connect_timeout !== desired.connect_timeout ||
      !headersMatch
    ) {
      mcpServers[def.hermesServerName] = desired;
      changed = true;
    }
  }
  return { changed, activeToolsets };
}

/** Hermes plugin with the image provider and the video provider `joshu` (change content-router, D7). */
export const MEDIA_PLUGIN = "joshu-media";
/** Name of the image provider and of the video provider of plugin `joshu-media`. */
export const MEDIA_BACKEND = "joshu";
const MEDIA_SECTIONS = ["image_gen", "video_gen"] as const;

/** True when the toolset of the content router is active, so the media backend can be on. */
export function routerToolsetActive(activeToolsets: ReadonlySet<string>): boolean {
  const router = getMeteredProviderDefinition("router");
  return Boolean(router && activeToolsets.has(router.hermesToolset));
}

/**
 * Turn the media backend `joshu` on or off with the toolset of the content router. On: plugin
 * `joshu-media` in `plugins.enabled`, `image_gen.provider` and `video_gen.provider` set to `joshu`,
 * and toolsets `image_gen` and `video_gen` in `toolsets`. Off: the plugin leaves `plugins.enabled`,
 * and a provider `joshu` leaves the two sections, so Hermes has no media tools of provider `joshu`.
 * A media provider that the owner chose is not changed. Changes `config` and `toolsets` in place.
 */
export function syncMediaBackend(
  config: Record<string, unknown>,
  toolsets: string[],
  routerActive: boolean,
): { changed: boolean; pluginsChanged: boolean } {
  let changed = false;
  let pluginsChanged = false;
  const plugins = asRecord(config.plugins);
  const current = Array.isArray(plugins.enabled) ? plugins.enabled.filter((v): v is string => typeof v === "string") : [];
  const enabled = routerActive
    ? current.includes(MEDIA_PLUGIN)
      ? current
      : [...current, MEDIA_PLUGIN]
    : current.filter((name) => name !== MEDIA_PLUGIN);
  if (enabled.length !== current.length) {
    config.plugins = { ...plugins, enabled };
    changed = true;
    pluginsChanged = true;
  }
  for (const name of MEDIA_SECTIONS) {
    const section = asRecord(config[name]);
    if (routerActive) {
      if (!section.provider) {
        config[name] = { ...section, provider: MEDIA_BACKEND };
        changed = true;
      }
      if (!toolsets.includes(name)) {
        toolsets.push(name);
        changed = true;
      }
    } else if (section.provider === MEDIA_BACKEND) {
      const { provider: _drop, ...rest } = section;
      config[name] = rest;
      changed = true;
    }
  }
  return { changed, pluginsChanged };
}
