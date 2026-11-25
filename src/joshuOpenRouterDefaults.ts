/**
 * Hermes model of this release (OpenRouter model id, not openrouter/auto). The release owns the
 * model: a box runs this model unless JOSHU_HERMES_MODEL in /etc/joshu/instance.env overrides it
 * on purpose. Change the model here, in the release (change release-hermes-model).
 * scripts/test-release-hermes-model.mjs checks that the fallbacks in the shell scripts and in the
 * voice service name the same model.
 */
export const JOSHU_OPENROUTER_DEFAULT_MODEL = "deepseek/deepseek-v4.1-flash-1017";

/**
 * Hermes models that the control plane wrote into JOSHU_HERMES_MODEL of instance.env at
 * provision, before the release owned the model. A JOSHU_HERMES_MODEL value or a cron job pin
 * with one of these models is not a choice of the owner, so the box drops it and follows the
 * release. packages/instance-agent/src/releaseEnv.ts has the same list; the test compares them.
 */
export const CONTROL_PLANE_HERMES_MODELS: readonly string[] = [
  "deepseek/deepseek-v4-flash",
  "deepseek/deepseek-v4-flash-0731",
  "deepseek/deepseek-v4.1-flash",
];

/** OpenRouter model for Hermes session_search per-session summarization (auxiliary task). */
export const JOSHU_OPENROUTER_SESSION_SEARCH_MODEL = "google/gemini-3.5-flash-lite";

/**
 * Hindsight model of this release (OpenRouter model id) for retain, reflect, and consolidation.
 * A box whose Hindsight uses OpenRouter runs this model unless HINDSIGHT_API_LLM_MODEL in
 * /etc/joshu/instance.env overrides it on purpose (change release-hindsight-model).
 * scripts/start-hindsight.sh has the same model as its fallback; the test compares them.
 */
export const JOSHU_OPENROUTER_HINDSIGHT_LLM_MODEL = "google/gemini-3.5-flash-lite";

/**
 * Hindsight models that the control plane wrote into HINDSIGHT_API_LLM_MODEL of instance.env at
 * provision, before the release owned the model. The box drops such a value and follows the
 * release. packages/instance-agent/src/releaseEnv.ts has the same list; the test compares them.
 */
export const CONTROL_PLANE_HINDSIGHT_LLM_MODELS: readonly string[] = ["google/gemini-3.1-flash-lite"];

/**
 * OpenRouter model for the small classifiers: mail triage, the action guard, the realtime goal
 * router, and Day 0. Each caller has its own env override (for example JOSHU_EA_CLASSIFIER_MODEL).
 */
export const JOSHU_OPENROUTER_CLASSIFIER_MODEL = "anthropic/claude-haiku-5.5";

/**
 * instance.env keys that a box drops because the control plane wrote their value: a Hermes model
 * or a Hindsight model from before the release owned it. Another value is a deliberate override
 * and stays. The instance agent runs the same rule in a release update
 * (packages/instance-agent/src/releaseEnv.ts, releaseEnvRemovals); the test compares the two.
 */
export function controlPlaneEnvRemovals(current: Record<string, string | undefined>): string[] {
  const removals: string[] = [];
  const hermes = (current.JOSHU_HERMES_MODEL ?? "").trim().toLowerCase();
  if (hermes && CONTROL_PLANE_HERMES_MODELS.includes(hermes)) removals.push("JOSHU_HERMES_MODEL");
  // Only for OpenRouter: the release Hindsight model is an OpenRouter model id, and the start
  // script of Hindsight has a fallback only for that provider.
  const hindsight = (current.HINDSIGHT_API_LLM_MODEL ?? "").trim().toLowerCase();
  const hindsightProvider = (current.HINDSIGHT_API_LLM_PROVIDER ?? "").trim().toLowerCase();
  if (hindsight && hindsightProvider === "openrouter" && CONTROL_PLANE_HINDSIGHT_LLM_MODELS.includes(hindsight)) {
    removals.push("HINDSIGHT_API_LLM_MODEL");
  }
  return removals;
}

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
