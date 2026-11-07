/**
 * One OpenRouter call that returns JSON, for every model step of a Research report: no-training
 * routing, reasoning off, a deadline, and one retry on an invalid answer. Design decision D2.
 */

import { resolveBoxSecret } from "../../boxSecrets/resolve.js";
import { JOSHU_OPENROUTER_DEFAULT_MODEL, withOpenRouterDataPolicy } from "../../joshuOpenRouterDefaults.js";
import { ResearchStepError, type ResearchStep } from "../errors.js";

export type JsonCallOpts = {
  step: ResearchStep;
  system: string;
  user: string;
  /** The call must answer before this time (epoch milliseconds), retry included. */
  deadline: number;
  maxTokens?: number;
  /** Return null to reject an answer, which counts as invalid and gets one retry. */
  check?: (parsed: unknown) => unknown | null;
  fetchImpl?: typeof fetch;
  apiKey?: string;
  model?: string;
  projectRoot?: string;
};

export function researchModel(): string {
  return process.env.JOSHU_RESEARCH_WRITER_MODEL?.trim() || JOSHU_OPENROUTER_DEFAULT_MODEL;
}

/** The outermost JSON object in a model answer (models add fences or words around it). */
export function jsonObjectIn(content: string): string {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  return start >= 0 && end > start ? content.slice(start, end + 1) : content;
}

/** Ask the model for JSON. Throws `ResearchStepError` with the step when no valid answer comes in time. */
export async function callJson<T = unknown>(opts: JsonCallOpts): Promise<{ value: T; model: string }> {
  const apiKey = opts.apiKey ?? resolveBoxSecret("OPENROUTER_API_KEY", opts.projectRoot).trim();
  if (!apiKey) throw new ResearchStepError(opts.step, "the box has no OpenRouter key");
  const model = opts.model ?? researchModel();
  const doFetch = opts.fetchImpl ?? fetch;
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const remaining = opts.deadline - Date.now();
    if (remaining <= 0) break;
    let content = "";
    try {
      const res = await doFetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://joshu.local",
          "X-Title": `Joshu research report (${opts.step})`,
        },
        body: JSON.stringify(
          withOpenRouterDataPolicy({
            model,
            messages: [
              { role: "system", content: opts.system },
              { role: "user", content: opts.user },
            ],
            max_tokens: opts.maxTokens ?? 8000,
            temperature: 0.3,
            // The default model is a reasoning model: with reasoning on it spent about 7,500
            // tokens and more than two minutes before an answer; with reasoning off, 28 seconds.
            reasoning: { enabled: false },
            response_format: { type: "json_object" },
          }),
        ),
        signal: AbortSignal.timeout(remaining),
      });
      if (!res.ok) {
        lastError = `OpenRouter answered ${res.status}`;
        continue;
      }
      const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      content = data.choices?.[0]?.message?.content?.trim() ?? "";
    } catch (err) {
      lastError = (err as Error).name === "TimeoutError" ? `the ${opts.step} step ran out of time` : (err as Error).message;
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonObjectIn(content));
    } catch {
      lastError = `the ${opts.step} answer is not JSON`;
      continue;
    }
    const checked = opts.check ? opts.check(parsed) : parsed;
    if (checked !== null && checked !== undefined) return { value: checked as T, model };
    lastError = `the ${opts.step} answer is not complete`;
  }
  throw new ResearchStepError(opts.step, lastError || `the ${opts.step} step ran out of time`);
}

export function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function asStringArray(value: unknown): string[] {
  return (Array.isArray(value) ? value : []).map(asString).filter(Boolean);
}

/** Run `fn` over `items` with at most `limit` at once, keeping the order of the results. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** The result of `promise`, or an "out of time" error at `deadline` (epoch milliseconds), whichever comes first. */
export function withDeadline<T>(promise: Promise<T>, deadline: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("out of time")), Math.max(0, deadline - Date.now()));
    promise.then(
      (value) => (clearTimeout(timer), resolve(value)),
      (err) => (clearTimeout(timer), reject(err)),
    );
  });
}

/** Run at most `limit` promises at once, in the order of the calls. */
export function limiter(limit: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async (fn) => {
    if (active >= limit) await new Promise<void>((r) => waiting.push(r));
    active += 1;
    try {
      return await fn();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
}
