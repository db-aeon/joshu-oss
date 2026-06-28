import { jsonFetch, resolveApiBase } from "./http.js";
import type { FilesQueryResult, PlatformDataClientOptions } from "./types.js";

export function createCalendarApi(opts: PlatformDataClientOptions) {
  const apiBase = resolveApiBase(opts.apiBase);
  const fetchFn = opts.fetch ?? fetch;

  return {
    async freeSlots(params: {
      date?: string;
      timezone?: string;
      timeMin?: string;
      timeMax?: string;
      items?: string;
      minDurationMinutes?: number;
    }): Promise<unknown> {
      const qs = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== "") qs.set(key, String(value));
      }
      const suffix = qs.toString() ? `?${qs}` : "";
      return jsonFetch(fetchFn, `${apiBase}/connectors/calendar/google/free-slots${suffix}`, {
        cache: "no-store",
      });
    },
  };
}

export function createFilesApi(opts: PlatformDataClientOptions) {
  const apiBase = resolveApiBase(opts.apiBase);
  const fetchFn = opts.fetch ?? fetch;

  return {
    async query(params: {
      q: string;
      since?: string;
      sourceId?: string;
      limit?: number;
    }): Promise<FilesQueryResult> {
      const qs = new URLSearchParams({ q: params.q });
      if (params.since) qs.set("since", params.since);
      qs.set("source_id", params.sourceId ?? "__all__");
      if (params.limit) qs.set("limit", String(params.limit));
      return jsonFetch(fetchFn, `${apiBase}/brain/query?${qs}`, { cache: "no-store" });
    },

    async getPage(slug: string): Promise<unknown> {
      const qs = new URLSearchParams({ slug });
      return jsonFetch(fetchFn, `${apiBase}/brain/get?${qs}`, { cache: "no-store" });
    },
  };
}

export function createMemoryApi(opts: PlatformDataClientOptions) {
  const apiBase = resolveApiBase(opts.apiBase);
  const fetchFn = opts.fetch ?? fetch;

  return {
    async status(): Promise<unknown> {
      return jsonFetch(fetchFn, `${apiBase}/hindsight/status`, { cache: "no-store" });
    },

    async graph(kind: "constellation" | "cooccurrence", query?: Record<string, string>): Promise<unknown> {
      const qs = new URLSearchParams(query ?? {});
      const suffix = qs.toString() ? `?${qs}` : "";
      return jsonFetch(fetchFn, `${apiBase}/hindsight/graph/${kind}${suffix}`, { cache: "no-store" });
    },

    /** Semantic recall over Hindsight bank (Phase 4). */
    async recall(params: { q: string; limit?: number }): Promise<unknown> {
      const qs = new URLSearchParams({ q: params.q });
      if (params.limit) qs.set("limit", String(params.limit));
      return jsonFetch(fetchFn, `${apiBase}/hindsight/recall?${qs}`, { cache: "no-store" });
    },
  };
}

export function createIdentityApi(opts: PlatformDataClientOptions) {
  const apiBase = resolveApiBase(opts.apiBase);
  const fetchFn = opts.fetch ?? fetch;

  return {
    async get(): Promise<{ name?: string; owner?: { displayName?: string } }> {
      return jsonFetch(fetchFn, `${apiBase}/instance/identity`, { cache: "no-store" });
    },
  };
}
