/**
 * The two learning steps of the content goals client (change content-router, design decision D2).
 * Each step is one model call with the box model and reasoning off, the same as the other research
 * model calls (`callJson`):
 * - the route model call picks a provider endpoint for a goal kind from the router catalog, with
 *   the price, the success rate, and the latency of each provider endpoint (risk 1 of design.md);
 * - the recipe model call reads a sample of one reply and writes the shape recipe (design D4).
 */

import { callJson, type JsonCallOpts } from "../research/pipeline/llm.js";
import type { EndpointDetail, EndpointSummary, RouterClient } from "./client.js";
import { checkRecipe, type ShapeRecipe } from "./recipe.js";

/** The ids of provider endpoints and the names of inputs that the box keeps in the route cache. */
export const ENDPOINT_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,120}$/;
export const INPUT_NAME_PATTERN = /^[A-Za-z0-9_]{1,60}$/;
/** A text value of a fixed input: plain words and punctuation of URLs, at most 100 characters. */
export const INPUT_TEXT_PATTERN = /^[A-Za-z0-9 _.,:\/@-]{0,100}$/;
/** The most that a fixed input may ask for when its name is about a number of results. */
export const MAX_COUNT_INPUT = 50;
const COUNT_INPUT = /^(limit|count|max|num|number|per_page|page_size|size|results|top|first)/i;

/**
 * True when a goal may use a provider endpoint of a capability: a data capability, a known fixed
 * price, and no `treg.` route endpoint that can try more than one provider.
 */
export function goalEndpointAllowed(capabilityKind: string | undefined, e: Pick<EndpointSummary, "id" | "price_usd" | "price_varies">): boolean {
  return (
    capabilityKind === "data" &&
    ENDPOINT_ID_PATTERN.test(e.id) &&
    !e.id.startsWith("treg.") &&
    !e.price_varies &&
    typeof e.price_usd === "number"
  );
}

/** The input names of a provider endpoint: the `properties` of its JSON Schema. */
export function inputNames(detail: Pick<EndpointDetail, "inputs"> | null | undefined): Set<string> {
  const props = detail?.inputs && typeof detail.inputs === "object" ? (detail.inputs as { properties?: unknown }).properties : undefined;
  return new Set(props && typeof props === "object" && !Array.isArray(props) ? Object.keys(props as Record<string, unknown>) : []);
}

/**
 * The fixed inputs that the box keeps: only names of the JSON Schema of the endpoint (when `names`
 * is given), short plain text, finite numbers, and booleans. A number of results above 50 is left out.
 */
export function cleanFixedInputs(raw: unknown, names?: ReadonlySet<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [name, value] of Object.entries(raw as Record<string, unknown>).slice(0, 10)) {
    if (!INPUT_NAME_PATTERN.test(name) || (names && !names.has(name))) continue;
    if (typeof value === "number") {
      if (!Number.isFinite(value) || (COUNT_INPUT.test(name) && value > MAX_COUNT_INPUT)) continue;
      out[name] = value;
    } else if (typeof value === "boolean") {
      out[name] = value;
    } else if (typeof value === "string" && INPUT_TEXT_PATTERN.test(value)) {
      if (COUNT_INPUT.test(name) && /^\d+$/.test(value) && Number(value) > MAX_COUNT_INPUT) continue;
      out[name] = value;
    }
  }
  return out;
}

/**
 * The model answer of the route call, checked against the JSON Schema of the chosen endpoint:
 * the endpoint is a candidate, the query input is one of its inputs, and the fixed inputs pass
 * `cleanFixedInputs`. Null when the answer is not valid.
 */
export function checkRouteAnswer(raw: unknown, details: ReadonlyMap<string, EndpointDetail>): LearnedRoute | null {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const endpoint = typeof o.endpoint === "string" ? o.endpoint.trim() : "";
  const queryInput = typeof o.query_input === "string" ? o.query_input.trim() : "";
  const detail = details.get(endpoint);
  if (!detail) return null;
  const names = inputNames(detail);
  if (!INPUT_NAME_PATTERN.test(queryInput) || !names.has(queryInput)) return null;
  const fixedInputs = cleanFixedInputs(o.fixed_inputs, names);
  delete fixedInputs[queryInput];
  return { endpoint, queryInput, fixedInputs };
}

export type LearnLlm = Pick<JsonCallOpts, "fetchImpl" | "apiKey" | "model" | "projectRoot">;

/** The most provider endpoints that the route model call sees. */
export const ROUTE_CANDIDATES = 6;
/** The most characters of the reply sample of the recipe model call. */
export const SAMPLE_CHARS = 6_000;

const ROUTE_SYSTEM = `You pick one provider endpoint of the Joshu content router for a content goal of a research report.
Return JSON only: {"endpoint": string, "query_input": string, "fixed_inputs": object}
Rules:
- endpoint: the id of one candidate that returns a list of posts, videos, markets, or other items about a search query. Prefer a low price, a high success rate, and a low latency. When a hint names a provider and a candidate of that provider fits, pick it.
- query_input: the name of the input of that endpoint that takes the search words (or the link, for a goal about one link).
- fixed_inputs: other inputs that every call needs, for example a sort order "top" or a time window of about one month. Use only input names and values that the inputs of the endpoint allow. {} when none are needed.`;

const RECIPE_SYSTEM = `You write a shape recipe that turns the JSON reply of an API into a list of items for a research report.
Return JSON only: {"list": string, "url": string | [string], "title": string | [string], "text": string | [string], "author": string | [string], "publishedAt": {"path": string | [string], "format": "iso" | "epoch_s" | "epoch_ms" | "text"} | null, "metrics": {name: path}}
Path rules:
- A path is names and list positions joined by dots, for example "data.items" or "markets.0.outcomePrices.0". An empty string is the value itself.
- "list" is the path from the reply to the list of results. Every other path starts at one entry of that list.
- A field can be a template with paths in braces when the reply has no full link, for example "https://www.reddit.com{permalink}".
- A field can be a list of paths; the first path with a value wins.
- "url" is the link of the item itself (the post, the video, or the market page), never the link of the author or of a profile.
- "title" is the title, the caption, the question, or the first words of the text.
- "publishedAt" is the date the item was posted or created, never an end date or a closing date. "epoch_s" for Unix seconds, "epoch_ms" for milliseconds, "iso" for ISO dates, "text" for other date text.
- "metrics": names like views, likes, comments, shares, score, volume, or odds, each to a path of a number. Odds are a probability between 0 and 1.
- Use only paths that exist in the sample.`;

export type LearnedRoute = { endpoint: string; queryInput: string; fixedInputs: Record<string, unknown> };

function compactInputs(inputs: unknown): string {
  const text = JSON.stringify(inputs ?? {});
  return text.length > 1200 ? `${text.slice(0, 1200)}…` : text;
}

function candidateLine(e: EndpointSummary | EndpointDetail): string {
  const price = e.price_usd === null ? "price unknown" : `$${e.price_usd}${e.price_varies ? " or more" : ""}`;
  const rate = e.success_rate_30d === null ? "success rate unknown" : `success ${Math.round(e.success_rate_30d * 100)}%`;
  const latency = e.median_latency_ms_30d === null ? "" : `, ${Math.round(e.median_latency_ms_30d / 100) / 10} s`;
  const inputs = "inputs" in e ? `\n  inputs: ${compactInputs(e.inputs)}` : "";
  return `- ${e.id} (${e.provider}): ${e.title}; ${price}; ${rate}${latency}${inputs}`;
}

/** True when a provider endpoint belongs to the provider that a hint names, for example `Polymarket`. */
export function matchesPrefer(endpoint: Pick<EndpointSummary, "id" | "provider" | "provider_slug"> | string, prefer: string): boolean {
  const want = prefer.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!want) return true;
  const fields = typeof endpoint === "string" ? [endpoint] : [endpoint.id, endpoint.provider, endpoint.provider_slug];
  return fields.some((f) => (f ?? "").toLowerCase().replace(/[^a-z0-9]/g, "").includes(want));
}

/**
 * The provider endpoints of the router catalog for a goal kind, best match first, only those that
 * `goalEndpointAllowed` lets a goal use. With a preferred provider, its endpoints come first when
 * the router catalog has them.
 */
export async function routeCandidates(client: RouterClient, kind: string, prefer: string | undefined, deadline: number): Promise<EndpointSummary[]> {
  const queries = prefer ? [`${prefer} ${kind}`, kind] : [kind];
  const seen = new Map<string, EndpointSummary>();
  for (const q of queries) {
    const found = await client.search(q, 20, deadline);
    for (const cap of found.capabilities) {
      for (const e of cap.endpoints ?? []) if (!seen.has(e.id) && goalEndpointAllowed(cap.kind, e)) seen.set(e.id, e);
    }
  }
  const all = [...seen.values()];
  if (!prefer) return all;
  const preferred = all.filter((e) => matchesPrefer(e, prefer));
  return preferred.length ? [...preferred, ...all.filter((e) => !preferred.includes(e))] : all;
}

/**
 * Pick a provider endpoint for a goal kind with one model call. Throws when the router catalog has
 * no candidate or the model gives no valid answer.
 */
export async function learnRoute(
  client: RouterClient,
  goal: { kind: string; query: string; prefer?: string },
  hints: readonly string[],
  deadline: number,
  llm: LearnLlm = {},
): Promise<LearnedRoute> {
  const candidates = (await routeCandidates(client, goal.kind, goal.prefer, deadline)).slice(0, ROUTE_CANDIDATES);
  if (!candidates.length) throw new Error(`the router catalog has no provider endpoint for "${goal.kind}"`);
  // The model sees only endpoints with a JSON Schema of their inputs, so that the box can check its answer.
  const fetched = await Promise.all(candidates.map((c) => client.endpoint(c.id, deadline).catch(() => null)));
  const details = new Map<string, EndpointDetail>();
  fetched.forEach((d, i) => {
    if (d && inputNames(d).size && !d.price_varies && typeof d.price_usd === "number") details.set(candidates[i]!.id, d);
  });
  const shown = [...details.values()];
  if (!shown.length) throw new Error(`no provider endpoint for "${goal.kind}" has a schema of its inputs`);
  const user = [
    `Goal: ${goal.kind}`,
    `Example query: ${goal.query}`,
    ...(goal.prefer ? [`Preferred provider: ${goal.prefer}`] : []),
    ...(hints.length ? [`Hints: ${hints.join("; ")}`] : []),
    "Candidates:",
    ...shown.map(candidateLine),
  ].join("\n");
  const { value } = await callJson<LearnedRoute>({
    ...llm,
    step: "learn",
    system: ROUTE_SYSTEM,
    user,
    deadline,
    maxTokens: 600,
    check: (raw) => checkRouteAnswer(raw, details),
  });
  return value;
}

/** A sample of a reply for the recipe model call: at most three entries of each list, short strings. */
export function replySample(value: unknown, depth = 0): unknown {
  if (depth > 8) return "…";
  if (Array.isArray(value)) return value.slice(0, 3).map((v) => replySample(v, depth + 1));
  if (typeof value === "string") return value.length > 160 ? `${value.slice(0, 160)}…` : value;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 40).map(([k, v]) => [k, replySample(v, depth + 1)]));
  }
  return value;
}

function sampleText(reply: unknown): string {
  const text = JSON.stringify(replySample(reply));
  return text.length > SAMPLE_CHARS ? `${text.slice(0, SAMPLE_CHARS)}…` : text;
}

/** Learn the shape recipe of a provider endpoint from one reply, with one model call. Throws on no valid answer. */
export async function learnRecipe(
  endpoint: string,
  goalKind: string,
  reply: unknown,
  deadline: number,
  llm: LearnLlm = {},
  problem?: string,
): Promise<ShapeRecipe> {
  const user = [
    `Provider endpoint: ${endpoint}`,
    `Goal: ${goalKind}`,
    ...(problem ? [`The last recipe failed: ${problem}. Write a recipe that avoids this.`] : []),
    `Reply sample: ${sampleText(reply)}`,
  ].join("\n");
  const { value } = await callJson<ShapeRecipe>({
    ...llm,
    step: "learn",
    system: RECIPE_SYSTEM,
    user,
    deadline,
    maxTokens: 800,
    check: (raw) => checkRecipe(raw),
  });
  return value;
}
