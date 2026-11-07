/**
 * The Exa client of the research pipeline: `/search` with highlights and `/contents` with full text
 * and page images. Exa's rate limit is shared by all boxes of the Exa team, so one box sends at
 * most four calls at once and waits for `Retry-After` on HTTP 429. Design decision D1.
 */

import { provisionEnvTrim } from "../../provisionInstanceEnv.js";
import { mapLimit } from "./llm.js";

const EXA_BASE = "https://api.exa.ai";
export const EXA_CONCURRENCY = 4;
const CALL_TIMEOUT_MS = 30_000;

export type ExaSearchRequest = {
  query: string;
  numResults?: number;
  startPublishedDate?: string;
  excludeDomains?: string[];
  category?: string;
  highlightsQuery?: string;
};

export type ExaResult = {
  id?: string;
  url: string;
  title?: string;
  publishedDate?: string;
  image?: string;
  favicon?: string;
  highlights?: string[];
  highlightScores?: number[];
  text?: string;
  extras?: { imageLinks?: string[]; richImageLinks?: Array<{ url?: string; src?: string; alt?: string } | string> };
};

export type ExaClient = {
  search(req: ExaSearchRequest, deadline: number): Promise<ExaResult[]>;
  /** Full text and images, or only the passages that match `highlightsQuery` when it is set. */
  contents(urls: string[], deadline: number, opts?: { highlightsQuery?: string }): Promise<ExaResult[]>;
};

export class ExaError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** The Exa key of the box: the provision file (the control plane writes it) first, then the process env. */
export function exaApiKey(): string {
  return provisionEnvTrim("EXA_API_KEY") || process.env.EXA_API_KEY?.trim() || "";
}

/** Exa client with the key of the box. Returns null when the box has no Exa key. */
export function exaClient(_projectRoot: string, fetchImpl: typeof fetch = fetch): ExaClient | null {
  const key = exaApiKey();
  if (!key) return null;
  return makeExaClient(key, fetchImpl);
}

export function makeExaClient(apiKey: string, fetchImpl: typeof fetch = fetch): ExaClient {
  async function post(path: string, body: unknown, deadline: number): Promise<ExaResult[]> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const remaining = Math.min(CALL_TIMEOUT_MS, deadline - Date.now());
      if (remaining <= 0) throw new ExaError(0, "out of time");
      const res = await fetchImpl(`${EXA_BASE}${path}`, {
        method: "POST",
        headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(remaining),
      });
      if (res.status === 429 && attempt === 0) {
        const wait = Math.min(Number(res.headers.get("retry-after") ?? "1") * 1000 || 1000, 5000);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      if (!res.ok) throw new ExaError(res.status, `Exa ${path} answered ${res.status}`);
      const data = (await res.json()) as { results?: ExaResult[] };
      return Array.isArray(data.results) ? data.results : [];
    }
    throw new ExaError(429, `Exa ${path} rate limit`);
  }

  return {
    search(req, deadline) {
      return post(
        "/search",
        {
          query: req.query,
          type: "auto",
          numResults: req.numResults ?? 10,
          ...(req.startPublishedDate ? { startPublishedDate: req.startPublishedDate } : {}),
          ...(req.excludeDomains?.length ? { excludeDomains: req.excludeDomains } : {}),
          ...(req.category ? { category: req.category } : {}),
          contents: { highlights: { query: req.highlightsQuery ?? req.query, maxCharacters: 1500 } },
        },
        deadline,
      );
    },
    async contents(urls, deadline, opts = {}) {
      if (!urls.length) return [];
      const body = opts.highlightsQuery
        ? { urls, highlights: { query: opts.highlightsQuery, maxCharacters: 3000 } }
        : { urls, text: { maxCharacters: 12_000 }, extras: { richImageLinks: 8 } };
      return post("/contents", body, deadline);
    },
  };
}

/** Run many searches with at most `EXA_CONCURRENCY` at once. A failed search gives an empty list and its error. */
export async function searchAll(
  client: ExaClient,
  requests: ExaSearchRequest[],
  deadline: number,
): Promise<{ results: ExaResult[]; error?: string }[]> {
  return mapLimit(requests, EXA_CONCURRENCY, async (req) => {
    try {
      return { results: await client.search(req, deadline) };
    } catch (err) {
      return { results: [], error: (err as Error).message };
    }
  });
}

/** The image links of a result, in one shape. */
export function resultPictures(result: ExaResult): { url: string; alt: string }[] {
  const out: { url: string; alt: string }[] = [];
  for (const raw of result.extras?.richImageLinks ?? []) {
    if (typeof raw === "string") out.push({ url: raw, alt: "" });
    else if (raw && (raw.url || raw.src)) out.push({ url: (raw.url || raw.src)!, alt: raw.alt?.trim() ?? "" });
  }
  for (const url of result.extras?.imageLinks ?? []) if (!out.some((p) => p.url === url)) out.push({ url, alt: "" });
  return out;
}
