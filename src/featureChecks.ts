/**
 * Feature checks for component `capabilities` of the health report (`GET /api/instance/health`,
 * change box-capability-checks). A service can answer its health probe while the feature that
 * the owner uses is broken, for example a missing Exa key or a Hindsight reranker that cannot
 * read its key file. Each feature check tests one feature and gives the reason when it fails.
 *
 * Informational only, like `failures` and `runtimeDrift`: the component never changes `healthy`
 * or `readyForUpdate`. The fleet failure digest of the control plane lists each component with
 * `ok: false` and its `reason`, so the `reason` of the component names each failed feature check.
 *
 * A feature check has two parts:
 *  - `config` reads only the config and the environment of the box, so it runs on each health
 *    request. It returns a result, or null when the live part must decide.
 *  - `live` calls a service. A timer runs it at most once every 6 hours, and a health request
 *    reads the stored result. A health request never waits for a call to a service.
 */
import fs from "node:fs";
import path from "node:path";

import YAML from "yaml";

import { makeExaClient } from "./research/pipeline/exa.js";
import { makeYouApiClient, youAccess, type YouPost } from "./research/pipeline/you.js";
import type { SocialSourcesHealth } from "./research/social/health.js";

export type FeatureCheckResult = {
  ok: boolean;
  reason?: string;
  /** hindsight_saves only: the number of failed save operations of the last 24 hours. */
  failed24h?: number;
  /** Set when the feature check did not test the feature, for example Hindsight turned off. */
  note?: string;
};

export type FeatureCheckEntry = FeatureCheckResult & {
  /** Time of the latest run; null before the first run of a live feature check. */
  checkedAt: string | null;
  /** True before the first run of a live feature check. */
  pending?: true;
};

export type CapabilitiesComponent = {
  ok: boolean;
  reason?: string;
  checks: Record<string, FeatureCheckEntry>;
};

export type FeatureCheck = {
  name: string;
  config?: () => FeatureCheckResult | null;
  live?: () => Promise<FeatureCheckResult>;
};

export const FIRST_LIVE_RUN_DELAY_MS = 5 * 60 * 1000;
export const LIVE_RUN_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const LIVE_CALL_TIMEOUT_MS = 20_000;
const MAX_COMPONENT_REASON_CHARS = 300;
const MAX_ERROR_CHARS = 200;
const SAVES_WINDOW_MS = 24 * 60 * 60 * 1000;
const SAVES_PAGE_SIZE = 100;
const SAVES_MAX_PAGES = 5;
/** Fixed text, so a feature check never sends owner content to a provider. */
const PROBE_QUERY = "Joshu feature check";

/** One line of provider error text, cut so that no long payload reaches the health report. */
export function clipError(text: unknown, max = MAX_ERROR_CHARS): string {
  const line = String(text ?? "").replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 3)}...` : line;
}

function failure(reason: string, extra: Partial<FeatureCheckResult> = {}): FeatureCheckResult {
  return { ok: false, reason, ...extra };
}

function errorReason(err: unknown): string {
  const e = err as { name?: string; message?: string };
  if (e?.name === "TimeoutError" || e?.name === "AbortError") {
    return `no answer in ${LIVE_CALL_TIMEOUT_MS / 1000} seconds`;
  }
  return clipError(e?.message ?? err);
}

/** The summary `ok` and `reason` of component `capabilities`. */
export function summarizeChecks(checks: Record<string, FeatureCheckEntry>): CapabilitiesComponent {
  const failed = Object.entries(checks).filter(([, entry]) => !entry.ok);
  if (failed.length === 0) return { ok: true, checks };
  const reason = clipError(
    failed.map(([name, entry]) => `${name}: ${entry.reason ?? "failed"}`).join("; "),
    MAX_COMPONENT_REASON_CHARS,
  );
  return { ok: false, reason, checks };
}

/**
 * Runs the feature checks. `report()` answers a health request from the config parts and the
 * stored live results; `runLive()` makes the calls to the services.
 */
export class FeatureCheckRunner {
  private readonly live = new Map<string, FeatureCheckEntry>();
  private timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly checks: FeatureCheck[],
    private readonly now: () => Date = () => new Date(),
  ) {}

  report(): CapabilitiesComponent {
    const checkedAt = this.now().toISOString();
    const entries: Record<string, FeatureCheckEntry> = {};
    for (const check of this.checks) {
      const fromConfig = check.config?.() ?? null;
      if (fromConfig || !check.live) {
        entries[check.name] = { ...(fromConfig ?? { ok: true }), checkedAt };
      } else {
        entries[check.name] = this.live.get(check.name) ?? { ok: true, pending: true, checkedAt: null };
      }
    }
    return summarizeChecks(entries);
  }

  /** Run the live part of each feature check whose config part does not already decide. */
  async runLive(): Promise<void> {
    await Promise.all(
      this.checks.map(async (check) => {
        if (!check.live || check.config?.()) return;
        let result: FeatureCheckResult;
        try {
          result = await check.live();
        } catch (err) {
          result = failure(errorReason(err));
        }
        this.live.set(check.name, { ...result, checkedAt: this.now().toISOString() });
      }),
    );
  }

  start(firstDelayMs = FIRST_LIVE_RUN_DELAY_MS, intervalMs = LIVE_RUN_INTERVAL_MS): void {
    if (this.timers.length) return;
    const run = () => {
      this.runLive().catch((err: unknown) => console.warn(`[feature-checks] live run failed: ${errorReason(err)}`));
    };
    const first = setTimeout(() => {
      run();
      const every = setInterval(run, intervalMs);
      every.unref();
      this.timers.push(every);
    }, firstDelayMs);
    first.unref();
    this.timers.push(first);
  }

  stop(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
  }
}

// ---------------------------------------------------------------------------------------------
// The feature checks of a box.

export type FeatureCheckDeps = {
  fetch: typeof fetch;
  /** Path of the Hermes config of the box (`<HERMES_HOME>/config.yaml`). */
  hermesConfigPath: string;
  exaKey: () => string;
  /** How the box reaches You.com, or null when it cannot. Default: `youAccess` (change you-web-provider). */
  you?: () => { post: YouPost } | null;
  hindsight: {
    enabled: () => boolean;
    apiUrl: string;
    bankId: string;
    headers: () => Record<string, string>;
  };
  socialSourcesHealth: () => SocialSourcesHealth;
};

/** The web search backend that the Hermes config names, or null when it names none. */
export function readWebSearchBackend(configPath: string): string | null {
  try {
    const config = YAML.parse(fs.readFileSync(configPath, "utf8")) as { web?: Record<string, unknown> } | null;
    const web = config?.web ?? {};
    const backend = web.search_backend || web.backend;
    return typeof backend === "string" && backend.trim() ? backend.trim().toLowerCase() : null;
  } catch {
    return null;
  }
}

function webSearchCheck(deps: FeatureCheckDeps): FeatureCheck {
  const you = deps.you ?? (() => youAccess(deps.fetch));
  return {
    name: "web_search",
    // The Joshu API pins `web.backend` (src/hermesApi.ts, applyWebBackend): `you` when the box can
    // reach You.com, or else `exa` with an Exa key. No backend in the config means Exa.
    config: () => {
      const backend = readWebSearchBackend(deps.hermesConfigPath) ?? "exa";
      if (backend === "you") return you() ? null : failure("the box cannot reach You.com: no relay mode and no You.com key");
      if (backend !== "exa") return failure(`web search backend ${backend} has no feature check`);
      if (!deps.exaKey()) return failure("EXA_API_KEY is not set");
      return null;
    },
    live: async () => {
      if ((readWebSearchBackend(deps.hermesConfigPath) ?? "exa") === "you") {
        // You.com alone, with no Exa fallback, so the check shows a You.com fault.
        try {
          await makeYouApiClient(you()!.post, null).search({ query: PROBE_QUERY, numResults: 1 }, Date.now() + LIVE_CALL_TIMEOUT_MS);
          return { ok: true };
        } catch (err) {
          return failure(`You.com search failed: ${errorReason(err)}`);
        }
      }
      const exa = makeExaClient(deps.exaKey(), deps.fetch);
      try {
        await exa.search({ query: PROBE_QUERY, numResults: 1 }, Date.now() + LIVE_CALL_TIMEOUT_MS);
        return { ok: true };
      } catch (err) {
        return failure(`Exa search failed: ${errorReason(err)}`);
      }
    },
  };
}

function hindsightUrl(deps: FeatureCheckDeps, suffix: string): string {
  const bank = encodeURIComponent(deps.hindsight.bankId);
  return `${deps.hindsight.apiUrl.replace(/\/+$/, "")}/v1/default/banks/${bank}${suffix}`;
}

async function hindsightError(res: Response): Promise<string> {
  const body = await res.text().catch(() => "");
  return clipError(`status ${res.status}${body ? ` ${body}` : ""}`);
}

function hindsightRecallCheck(deps: FeatureCheckDeps): FeatureCheck {
  return {
    name: "hindsight_recall",
    config: () => (deps.hindsight.enabled() ? null : failure("Hindsight is turned off")),
    // A recall runs the embedding and the reranker of Hindsight, so it fails when either one
    // cannot reach its provider or read its key. The answer (owner memories) is never kept.
    live: async () => {
      const res = await deps.fetch(hindsightUrl(deps, "/memories/recall"), {
        method: "POST",
        headers: { ...deps.hindsight.headers(), "Content-Type": "application/json" },
        body: JSON.stringify({ query: PROBE_QUERY, budget: "low", max_tokens: 256 }),
        signal: AbortSignal.timeout(LIVE_CALL_TIMEOUT_MS),
      });
      if (!res.ok) return failure(`recall failed: ${await hindsightError(res)}`);
      await res.body?.cancel().catch(() => undefined);
      return { ok: true };
    },
  };
}

type HindsightOperation = { status?: string; created_at?: string; error_message?: string | null };

function hindsightSavesCheck(deps: FeatureCheckDeps): FeatureCheck {
  return {
    name: "hindsight_saves",
    config: () => (deps.hindsight.enabled() ? null : { ok: true, note: "Hindsight is turned off" }),
    // Hindsight 0.7.2: GET /v1/default/banks/{bank}/operations?type=retain&exclude_parents=true
    // &limit=&offset= lists the save operations newest first, each with `status` (pending,
    // processing, completed, failed, cancelled), `created_at`, and `error_message`. This read
    // changes no memory of the owner.
    live: async () => {
      const since = Date.now() - SAVES_WINDOW_MS;
      let latest: HindsightOperation | undefined;
      let failed24h = 0;
      for (let page = 0; page < SAVES_MAX_PAGES; page += 1) {
        const query = `?type=retain&exclude_parents=true&limit=${SAVES_PAGE_SIZE}&offset=${page * SAVES_PAGE_SIZE}`;
        const res = await deps.fetch(hindsightUrl(deps, `/operations${query}`), {
          headers: deps.hindsight.headers(),
          signal: AbortSignal.timeout(LIVE_CALL_TIMEOUT_MS),
        });
        if (!res.ok) return failure(`operations list failed: ${await hindsightError(res)}`);
        const data = (await res.json()) as { operations?: HindsightOperation[] };
        const operations = Array.isArray(data.operations) ? data.operations : [];
        let older = false;
        for (const op of operations) {
          const created = Date.parse(op.created_at ?? "");
          if (!Number.isFinite(created) || created < since) {
            older = true;
            break;
          }
          if (op.status === "failed") failed24h += 1;
          if (!latest && (op.status === "completed" || op.status === "failed")) latest = op;
        }
        if (older || operations.length < SAVES_PAGE_SIZE) break;
      }
      if (latest?.status === "failed") {
        return failure(`latest save failed (${failed24h} failed in 24 hours): ${clipError(latest.error_message || "no error text")}`, {
          failed24h,
        });
      }
      return { ok: true, failed24h };
    },
  };
}

function contentRouterCheck(deps: FeatureCheckDeps): FeatureCheck {
  return {
    name: "content_router",
    config: () => {
      const { router } = deps.socialSourcesHealth();
      if (router.mode === "off" || router.configured) return { ok: true };
      return failure(`content router is on but the router API key is not set${router.reason ? ` (${clipError(router.reason, 120)})` : ""}`);
    },
  };
}

export function boxFeatureChecks(deps: FeatureCheckDeps): FeatureCheck[] {
  return [webSearchCheck(deps), hindsightRecallCheck(deps), hindsightSavesCheck(deps), contentRouterCheck(deps)];
}

export function hermesConfigPath(hermesHome: string): string {
  return path.join(hermesHome, "config.yaml");
}

