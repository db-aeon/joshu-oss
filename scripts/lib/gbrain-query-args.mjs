/**
 * Normalize gbrain `query` / `search` time bounds for MCP.
 * CLI accepts relative since/until (e.g. 90d); MCP may pass them raw to SQL — convert to ISO-8601.
 */

/**
 * @param {string} raw
 * @param {{ endOfDay?: boolean }} [opts]
 * @returns {string | undefined}
 */
export function parseGbrainTimeBound(raw, opts = {}) {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  if (/^\d{4}-\d{2}-\d{2}(?:[T\s].*)?$/i.test(trimmed)) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      return opts.endOfDay ? `${trimmed}T23:59:59.999Z` : `${trimmed}T00:00:00.000Z`;
    }
    const ms = Date.parse(trimmed);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
  }

  const rel = /^(\d+)([dhwmy])$/i.exec(trimmed);
  if (rel) {
    const n = Number(rel[1]);
    if (!Number.isFinite(n) || n < 0) return undefined;
    const unit = rel[2].toLowerCase();
    const d = new Date();
    switch (unit) {
      case "d":
        d.setUTCDate(d.getUTCDate() - n);
        break;
      case "h":
        d.setUTCHours(d.getUTCHours() - n);
        break;
      case "w":
        d.setUTCDate(d.getUTCDate() - n * 7);
        break;
      case "m":
        d.setUTCMonth(d.getUTCMonth() - n);
        break;
      case "y":
        d.setUTCFullYear(d.getUTCFullYear() - n);
        break;
      default:
        return undefined;
    }
    return d.toISOString();
  }

  const parsed = Date.parse(trimmed);
  if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  return undefined;
}

/**
 * @param {Record<string, unknown>} args
 * @returns {Record<string, unknown>}
 */
export function normalizeGbrainQueryArgs(args = {}) {
  const out = { ...args };
  if (typeof out.since === "string") {
    const since = parseGbrainTimeBound(out.since);
    if (since) out.since = since;
  }
  if (typeof out.until === "string") {
    const until = parseGbrainTimeBound(out.until, { endOfDay: true });
    if (until) out.until = until;
  }
  return out;
}
