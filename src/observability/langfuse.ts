/**
 * Langfuse tracing for Joshu deterministic app LLM calls (Day 0, EA classifier).
 * Reuses HERMES_LANGFUSE_* on VPS boxes; fail-open when keys are absent.
 */
import { LangfuseSpanProcessor } from "@langfuse/otel";
import {
  type LangfuseGeneration,
  propagateAttributes,
  startActiveObservation,
} from "@langfuse/tracing";
import { NodeSDK } from "@opentelemetry/sdk-node";

export type JoshuLlmTraceOpts = {
  /** Langfuse trace name (top-level grouping). */
  traceName?: string;
  /** Observation / generation name within the trace. */
  generationName?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
};

/** Token/cost fields sent to Langfuse after an LLM call completes. */
export type JoshuLangfuseGenerationDetails = {
  usageDetails?: Record<string, number>;
  costDetails?: Record<string, number>;
  /** Resolved model id (e.g. OpenRouter response.model). */
  model?: string;
  metadata?: Record<string, unknown>;
};

let sdkStarted = false;

function envString(name: string, fallback = ""): string {
  const value = process.env[name]?.trim();
  return value || fallback;
}

function firstEnv(...names: string[]): string {
  for (const name of names) {
    const value = envString(name);
    if (value) return value;
  }
  return "";
}

/** Same attribution as Hermes gateway — box slug on VPS, explicit env locally. */
export function resolveJoshuLangfuseUserId(): string {
  const explicit = firstEnv("HERMES_LANGFUSE_USER_ID", "LANGFUSE_USER_ID");
  if (explicit) return explicit;
  const domain = envString("CUSTOMER_DOMAIN");
  if (!domain) return "";
  const suffix = envString("CUSTOMER_DOMAIN_SUFFIX", "box.joshu.me").replace(/^\.+|\.+$/g, "");
  const hostSuffix = `.${suffix}`;
  if (domain.endsWith(hostSuffix)) {
    return domain.slice(0, -hostSuffix.length);
  }
  const dot = domain.indexOf(".");
  return dot > 0 ? domain.slice(0, dot) : domain;
}

function resolveJoshuLangfuseConfig(): {
  publicKey: string;
  secretKey: string;
  baseUrl: string;
  environment: string;
  release: string;
} | null {
  const publicKey = firstEnv("HERMES_LANGFUSE_PUBLIC_KEY", "LANGFUSE_PUBLIC_KEY");
  const secretKey = firstEnv("HERMES_LANGFUSE_SECRET_KEY", "LANGFUSE_SECRET_KEY");
  if (!publicKey || !secretKey) return null;

  return {
    publicKey,
    secretKey,
    baseUrl:
      firstEnv("HERMES_LANGFUSE_BASE_URL", "HERMES_LANGFUSE_URL", "LANGFUSE_BASE_URL") ||
      "https://us.cloud.langfuse.com",
    environment:
      firstEnv("HERMES_LANGFUSE_ENV", "LANGFUSE_TRACING_ENVIRONMENT") ||
      envString("NODE_ENV", "development"),
    release: firstEnv("HERMES_LANGFUSE_RELEASE", "LANGFUSE_RELEASE"),
  };
}

export function isJoshuLangfuseEnabled(): boolean {
  return resolveJoshuLangfuseConfig() !== null;
}

function truncateForLangfuse(value: unknown, maxChars: number): unknown {
  if (maxChars <= 0 || value == null) return value;
  try {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (text.length <= maxChars) return value;
    return `${text.slice(0, maxChars)}… [truncated ${text.length - maxChars} chars]`;
  } catch {
    return "[unserializable]";
  }
}

function resolveLangfuseMaxChars(): number {
  const raw = Number.parseInt(
    firstEnv("HERMES_LANGFUSE_MAX_CHARS", "LANGFUSE_MAX_CHARS") || "12000",
    10,
  );
  return Number.isFinite(raw) && raw > 0 ? raw : 12000;
}

/** Start OTEL + Langfuse export once per process (idempotent). */
export function initJoshuLangfuse(): void {
  if (sdkStarted) return;
  const config = resolveJoshuLangfuseConfig();
  if (!config) return;

  const spanProcessor = new LangfuseSpanProcessor({
    publicKey: config.publicKey,
    secretKey: config.secretKey,
    baseUrl: config.baseUrl,
    environment: config.environment,
    ...(config.release ? { release: config.release } : {}),
  });

  const sdk = new NodeSDK({ spanProcessors: [spanProcessor] });
  sdk.start();
  sdkStarted = true;

  console.log(
    `[joshu-langfuse] tracing enabled (env=${config.environment}, baseUrl=${config.baseUrl})`,
  );
}

export async function withJoshuLlmObservation<T>(
  opts: JoshuLlmTraceOpts & {
    model: string;
    input: unknown;
    run: () => Promise<T>;
    formatOutput?: (result: T) => unknown;
    formatUsage?: (result: T) => Record<string, number> | undefined;
    formatGenerationDetails?: (result: T) => JoshuLangfuseGenerationDetails | undefined;
  },
): Promise<T> {
  if (!isJoshuLangfuseEnabled()) {
    return opts.run();
  }

  const maxChars = resolveLangfuseMaxChars();
  const userId = resolveJoshuLangfuseUserId();
  const traceName = opts.traceName ?? "joshu-day0-llm";
  const generationName = opts.generationName ?? "chat-completion";

  return propagateAttributes(
    {
      traceName,
      ...(userId ? { userId } : {}),
      tags: ["joshu-app", ...(opts.tags ?? [])],
      metadata: {
        component: "joshu-deterministic",
        ...opts.metadata,
      },
    },
    async () =>
      startActiveObservation(
        generationName,
        async (generation: LangfuseGeneration) => {
          generation.update({
            model: opts.model,
            input: truncateForLangfuse(opts.input, maxChars),
          });

          try {
            const result = await opts.run();
            const output = opts.formatOutput?.(result);
            const generationDetails =
              opts.formatGenerationDetails?.(result) ??
              (opts.formatUsage?.(result)
                ? { usageDetails: opts.formatUsage(result) }
                : undefined);
            generation.update({
              ...(output !== undefined
                ? { output: truncateForLangfuse(output, maxChars) }
                : {}),
              ...(generationDetails?.model ? { model: generationDetails.model } : {}),
              ...(generationDetails?.usageDetails
                ? { usageDetails: generationDetails.usageDetails }
                : {}),
              ...(generationDetails?.costDetails
                ? { costDetails: generationDetails.costDetails }
                : {}),
              ...(generationDetails?.metadata
                ? { metadata: generationDetails.metadata }
                : {}),
            });
            return result;
          } catch (err) {
            generation.update({
              level: "ERROR",
              statusMessage: err instanceof Error ? err.message : String(err),
            });
            throw err;
          }
        },
        { asType: "generation" },
      ),
  );
}

// Side-effect init when imported from server entry (after dotenv).
initJoshuLangfuse();
