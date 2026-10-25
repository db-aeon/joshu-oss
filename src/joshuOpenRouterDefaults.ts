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

function asProviderPrefs(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Return the OpenRouter request body with no-training routing. Other provider preferences stay. */
export function withOpenRouterDataPolicy<T extends Record<string, unknown>>(
  body: T,
): T & { provider: Record<string, unknown> } {
  return {
    ...body,
    provider: { ...asProviderPrefs(body.provider), data_collection: JOSHU_OPENROUTER_DATA_COLLECTION },
  };
}

/**
 * Set provider_routing.data_collection in the Hermes config. Hermes sends provider_routing on
 * main turns, Hermes cron jobs, workers, and subagents. Returns true when the config changed.
 */
export function syncJoshuOpenRouterDataPolicy(config: Record<string, unknown>): boolean {
  const routing = asProviderPrefs(config.provider_routing);
  if (routing.data_collection === JOSHU_OPENROUTER_DATA_COLLECTION && config.provider_routing === routing) {
    return false;
  }
  config.provider_routing = { ...routing, data_collection: JOSHU_OPENROUTER_DATA_COLLECTION };
  return true;
}
