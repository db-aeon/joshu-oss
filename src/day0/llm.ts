/**
 * Cheap OpenRouter chat for Day 0 inference (separate from Hermes main model).
 */

import {
  type JoshuLangfuseGenerationDetails,
  type JoshuLlmTraceOpts,
  withJoshuLlmObservation,
} from "../observability/langfuse.js";

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type Day0CompletionOpts = JoshuLlmTraceOpts & {
  json?: boolean;
  maxTokens?: number;
  model?: string;
};

export type Day0CompletionMeta = {
  finishReason?: string;
  model: string;
  truncated: boolean;
};

type OpenRouterUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cost?: number;
  cost_details?: {
    upstream_inference_prompt_cost?: number;
    upstream_inference_completions_cost?: number;
    upstream_inference_cost?: number;
  };
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
  completion_tokens_details?: {
    reasoning_tokens?: number;
  };
};

type Day0CompletionCoreResult = {
  content: string;
  meta: Day0CompletionMeta;
  langfuse?: JoshuLangfuseGenerationDetails;
};

function resolveDay0ApiKey(): string {
  return (
    process.env.JOSHU_DAY0_API_KEY?.trim() ||
    process.env.OPENROUTER_API_KEY?.trim() ||
    ""
  );
}

export function resolveDay0Model(): string {
  return (
    process.env.JOSHU_DAY0_MODEL?.trim() ||
    "openai/gpt-5.4-nano"
  );
}

/** Default max output tokens — Day 0 JSON can be large (VIPs, notes, chunk merges). */
export function resolveDay0MaxTokens(override?: number): number {
  if (override != null && override > 0) return override;
  const fromEnv = Number.parseInt(process.env.JOSHU_DAY0_MAX_TOKENS ?? "", 10);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return 8192;
}

export function isDay0LlmConfigured(): boolean {
  return Boolean(resolveDay0ApiKey());
}

/** Map OpenRouter usage (with usage.include=true) to Langfuse generation fields. */
export function openRouterUsageToLangfuseDetails(
  usage: OpenRouterUsage | undefined,
  opts: { requestedModel: string; resolvedModel?: string; generationId?: string },
): JoshuLangfuseGenerationDetails | undefined {
  if (!usage) return undefined;

  const usageDetails: Record<string, number> = {};
  if (usage.prompt_tokens != null || usage.completion_tokens != null) {
    usageDetails.input = usage.prompt_tokens ?? 0;
    usageDetails.output = usage.completion_tokens ?? 0;
    usageDetails.total = usage.total_tokens ?? usageDetails.input + usageDetails.output;
  }
  const cached = usage.prompt_tokens_details?.cached_tokens;
  if (cached != null && cached > 0) {
    usageDetails.cache_read_input_tokens = cached;
  }
  const reasoning = usage.completion_tokens_details?.reasoning_tokens;
  if (reasoning != null && reasoning > 0) {
    usageDetails.reasoning_tokens = reasoning;
  }

  const costDetails: Record<string, number> = {};
  const promptCost = usage.cost_details?.upstream_inference_prompt_cost;
  const completionCost = usage.cost_details?.upstream_inference_completions_cost;
  if (promptCost != null) costDetails.input = promptCost;
  if (completionCost != null) costDetails.output = completionCost;
  if (usage.cost != null) costDetails.total = usage.cost;

  const resolvedModel = opts.resolvedModel?.trim() || opts.requestedModel;
  const metadata: Record<string, unknown> = {
    cost_source: usage.cost != null ? "openrouter" : "estimated",
    requested_model: opts.requestedModel,
  };
  if (opts.resolvedModel && opts.resolvedModel !== opts.requestedModel) {
    metadata.resolved_model = opts.resolvedModel;
  }
  if (opts.generationId) {
    metadata.openrouter_generation_id = opts.generationId;
  }

  if (
    Object.keys(usageDetails).length === 0 &&
    Object.keys(costDetails).length === 0
  ) {
    return undefined;
  }

  return {
    ...(Object.keys(usageDetails).length > 0 ? { usageDetails } : {}),
    ...(Object.keys(costDetails).length > 0 ? { costDetails } : {}),
    model: resolvedModel,
    metadata,
  };
}

export async function day0ChatCompletion(
  messages: ChatMessage[],
  opts: Day0CompletionOpts = {},
): Promise<string> {
  const { content } = await day0ChatCompletionDetailed(messages, opts);
  return content;
}

async function day0ChatCompletionCore(
  messages: ChatMessage[],
  opts: Pick<Day0CompletionOpts, "json" | "maxTokens" | "model">,
): Promise<Day0CompletionCoreResult> {
  const apiKey = resolveDay0ApiKey();
  if (!apiKey) {
    throw new Error(
      "Day 0 LLM not configured — set OPENROUTER_API_KEY or JOSHU_DAY0_API_KEY",
    );
  }

  const baseUrl = (
    process.env.JOSHU_DAY0_BASE_URL?.trim() || "https://openrouter.ai/api/v1"
  ).replace(/\/$/, "");
  const requestedModel = opts.model?.trim() || resolveDay0Model();
  const maxTokens = resolveDay0MaxTokens(opts.maxTokens);

  const body: Record<string, unknown> = {
    model: requestedModel,
    messages,
    max_tokens: maxTokens,
    temperature: 0.2,
    // Ask OpenRouter for authoritative per-request cost (Langfuse costDetails).
    usage: { include: true },
  };
  if (opts.json) {
    body.response_format = { type: "json_object" };
  }

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://joshu.local",
      "X-Title": "Joshu Day 0",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Day 0 LLM HTTP ${res.status}: ${text.slice(0, 500)}`);
  }

  const json = (await res.json()) as {
    id?: string;
    model?: string;
    choices?: Array<{
      message?: { content?: string };
      finish_reason?: string;
    }>;
    usage?: OpenRouterUsage;
    error?: { message?: string };
  };
  if (json.error?.message) {
    throw new Error(json.error.message);
  }

  const choice = json.choices?.[0];
  const content = choice?.message?.content?.trim() ?? "";
  const finishReason = choice?.finish_reason;
  const truncated = finishReason === "length";
  const resolvedModel = json.model?.trim() || requestedModel;

  if (!content) {
    throw new Error(
      truncated
        ? `Day 0 LLM output truncated (finish_reason=length, max_tokens=${maxTokens}) — set JOSHU_DAY0_MAX_TOKENS higher or use a model with larger output`
        : "Day 0 LLM returned empty completion",
    );
  }

  if (truncated && opts.json) {
    throw new Error(
      `Day 0 LLM JSON truncated (finish_reason=length, max_tokens=${maxTokens}). ` +
        "Increase JOSHU_DAY0_MAX_TOKENS (e.g. 16384) or reduce mail volume.",
    );
  }

  return {
    content,
    meta: { finishReason, model: resolvedModel, truncated },
    langfuse: openRouterUsageToLangfuseDetails(json.usage, {
      requestedModel,
      resolvedModel,
      generationId: json.id,
    }),
  };
}

export async function day0ChatCompletionDetailed(
  messages: ChatMessage[],
  opts: Day0CompletionOpts = {},
): Promise<{ content: string; meta: Day0CompletionMeta }> {
  const model = opts.model?.trim() || resolveDay0Model();
  const maxTokens = resolveDay0MaxTokens(opts.maxTokens);
  const { traceName, generationName, tags, metadata, ...coreOpts } = opts;

  const result = await withJoshuLlmObservation({
    traceName,
    generationName,
    tags,
    metadata: {
      json: Boolean(opts.json),
      maxTokens,
      ...metadata,
    },
    model,
    input: { messages },
    run: () => day0ChatCompletionCore(messages, coreOpts),
    formatOutput: (value) => ({
      content: value.content,
      finishReason: value.meta.finishReason,
      truncated: value.meta.truncated,
    }),
    formatGenerationDetails: (value) => value.langfuse,
  });

  return {
    content: result.content,
    meta: result.meta,
  };
}

/** Parse JSON from LLM output, tolerating fenced code blocks. */
export function parseLlmJson<T>(raw: string): T {
  let s = raw.trim();
  const fence = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/m.exec(s);
  if (fence?.[1]) s = fence[1].trim();
  try {
    return JSON.parse(s) as T;
  } catch (err) {
    const preview = s.slice(0, 120).replace(/\s+/g, " ");
    const tail = s.slice(-80).replace(/\s+/g, " ");
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Day 0 LLM returned invalid JSON (${message}). Preview: "${preview}…" Tail: "…${tail}"`,
    );
  }
}
