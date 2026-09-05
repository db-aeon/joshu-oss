import { createHash } from "node:crypto";
import type { CoordinationFacet, CoordinationScope } from "./types.js";

/** Normalize subject for scope hashing (strip Re/Fwd, collapse whitespace). */
export function normalizeTopic(subject?: string): string {
  return (subject ?? "")
    .trim()
    .toLowerCase()
    .replace(/^(re|fwd|fw):\s*/gi, "")
    .replace(/\s+/g, " ");
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

/**
 * Derive a stable scope id from facets, participants, and topic.
 * Shared RFC Message-ID or linked thread aliases force the same id.
 */
export function deriveScopeId(opts: {
  facets: CoordinationFacet[];
  participants?: string[];
  topic?: string;
  rfcMessageId?: string;
}): string {
  const participants = sortedUnique(opts.participants ?? []);
  const topic = normalizeTopic(opts.topic);
  const rfc = opts.rfcMessageId?.trim().toLowerCase() ?? "";

  // RFC Message-ID is stable across Gmail/Nylas copies — canonical mail scope key.
  if (rfc) {
    const payload = [
      `rfc:${rfc}`,
      participants.length ? `p:${participants.join(",")}` : "",
      topic ? `t:${topic}` : "",
    ]
      .filter(Boolean)
      .join("|");
    return createHash("sha256").update(payload).digest("hex").slice(0, 24);
  }

  const threadKeys = sortedUnique(
    opts.facets.filter((f) => f.channel === "mail").map((f) => f.key),
  );
  const smsKeys = sortedUnique(
    opts.facets.filter((f) => f.channel === "sms").map((f) => f.key),
  );

  const payload = [
    threadKeys.length ? `threads:${threadKeys.join(",")}` : "",
    smsKeys.length ? `sms:${smsKeys.join(",")}` : "",
    participants.length ? `p:${participants.join(",")}` : "",
    topic ? `t:${topic}` : "",
  ]
    .filter(Boolean)
    .join("|");

  if (!payload) {
    return createHash("sha256").update("empty-scope").digest("hex").slice(0, 24);
  }
  return createHash("sha256").update(payload).digest("hex").slice(0, 24);
}

/** Union two scopes when adapters detect the same broader ask (cross-channel link). */
export function mergeScopes(a: CoordinationScope, b: CoordinationScope): CoordinationScope {
  const facetMap = new Map<string, CoordinationFacet>();
  for (const f of [...a.facets, ...b.facets]) {
    facetMap.set(`${f.channel}:${f.key}:${f.provider ?? ""}`, f);
  }
  const facets = [...facetMap.values()];
  const participants = sortedUnique([...a.participants, ...b.participants]);
  const threadIds = sortedUnique([
    ...a.threadIds,
    ...b.threadIds,
    ...facets.filter((f) => f.channel === "mail").map((f) => f.key),
  ]);
  const sourcePaths = sortedUnique([
    ...a.sourcePaths,
    ...b.sourcePaths,
    ...facets.map((f) => f.sourcePath).filter((p): p is string => Boolean(p)),
  ]);
  const rfcMessageId = a.rfcMessageId ?? b.rfcMessageId ?? facets.find((f) => f.rfcMessageId)?.rfcMessageId;
  const topic = a.topic || b.topic;
  const scopeId = deriveScopeId({ facets, participants, topic, rfcMessageId });

  return {
    scopeId,
    channel: a.channel,
    facets,
    participants,
    topic,
    projectSlug: a.projectSlug ?? b.projectSlug,
    threadIds,
    sourcePaths,
    rfcMessageId,
  };
}
