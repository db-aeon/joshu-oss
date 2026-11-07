/** Fixed OpenRouter model id for Joshu Hermes boxes (not openrouter/auto). */
export const JOSHU_OPENROUTER_DEFAULT_MODEL = "deepseek/deepseek-v4.1-flash";

/** OpenRouter model for Hermes session_search per-session summarization (auxiliary task). */
export const JOSHU_OPENROUTER_SESSION_SEARCH_MODEL = "google/gemini-3.1-flash-lite";

/** OpenRouter model for Hindsight retain / reflect / consolidation (LLM task). */
export const JOSHU_OPENROUTER_HINDSIGHT_LLM_MODEL = "google/gemini-3.1-flash-lite";

export const JOSHU_OPENROUTER_HINDSIGHT_LLM_PROVIDER = "openrouter";

/**
 * No-training routing (see openspec/glossary.md): OpenRouter does not send the request to an
 * upstream provider that may train on prompts or keep prompts for its own use.
 * Joshu does not require zero data retention.
 */
export const JOSHU_OPENROUTER_DATA_COLLECTION = "deny";

/**
 * Excluded upstream providers (see openspec/glossary.md): OpenRouter never sends a Joshu request
 * to these upstream providers. Relace drops the arguments of tool calls of
 * deepseek/deepseek-v4.1-flash, for example the summary of kanban_complete (issue #206).
 * Use the OpenRouter provider slug. scripts/patch-hermes-openrouter-data-collection.py has the
 * same list for the case where Hermes cannot read config.yaml; the test compares the two lists.
 */
export const JOSHU_OPENROUTER_IGNORED_PROVIDERS: readonly string[] = ["relace"];

function asProviderPrefs(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Return the ignore list of the provider preferences with each excluded upstream provider added. */
function withIgnoredProviders(ignore: unknown): string[] {
  const list = Array.isArray(ignore) ? ignore.filter((slug): slug is string => typeof slug === "string") : [];
  const present = new Set(list.map((slug) => slug.trim().toLowerCase()));
  return [...list, ...JOSHU_OPENROUTER_IGNORED_PROVIDERS.filter((slug) => !present.has(slug))];
}

/** Return provider preferences with no-training routing and the excluded upstream providers. */
function withJoshuProviderPrefs(prefs: Record<string, unknown>): Record<string, unknown> {
  return {
    ...prefs,
    data_collection: JOSHU_OPENROUTER_DATA_COLLECTION,
    ignore: withIgnoredProviders(prefs.ignore),
  };
}

/**
 * Return the OpenRouter request body with no-training routing and the excluded upstream
 * providers. Other provider preferences stay.
 */
export function withOpenRouterDataPolicy<T extends Record<string, unknown>>(
  body: T,
): T & { provider: Record<string, unknown> } {
  return { ...body, provider: withJoshuProviderPrefs(asProviderPrefs(body.provider)) };
}

/**
 * Set provider_routing.data_collection and add the excluded upstream providers to
 * provider_routing.ignore in the Hermes config. Hermes sends provider_routing on main turns,
 * Hermes cron jobs, workers, and subagents. Returns true when the config changed.
 */
export function syncJoshuOpenRouterDataPolicy(config: Record<string, unknown>): boolean {
  const routing = asProviderPrefs(config.provider_routing);
  const desired = withJoshuProviderPrefs(routing);
  const ignoreUnchanged =
    Array.isArray(routing.ignore) && JSON.stringify(routing.ignore) === JSON.stringify(desired.ignore);
  if (
    config.provider_routing === routing &&
    routing.data_collection === JOSHU_OPENROUTER_DATA_COLLECTION &&
    ignoreUnchanged
  ) {
    return false;
  }
  config.provider_routing = desired;
  return true;
}
