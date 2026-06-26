/**
 * Shared read-only MCP tool allowlist for Joshu gbrain (Hermes agents).
 * Matches gbrain brain-allowlist read ops; excludes put_page and all mutating tools.
 */

/** @type {ReadonlySet<string>} */
export const GBRAIN_MCP_READ_ONLY_TOOLS = new Set([
  "search",
  "query",
  "get_page",
  "list_pages",
  "file_list",
  "file_url",
  "get_backlinks",
  "traverse_graph",
  "resolve_slugs",
  "get_ingest_log",
  "get_recent_salience",
  "find_anomalies",
  "recall",
  "get_chunks",
  "get_brain_identity",
  "get_sources",
  "list_sources",
  "sources_list",
  "find_orphans",
  "get_raw_data",
  "search_by_image",
]);

/**
 * @param {string} name
 * @returns {boolean}
 */
export function isReadOnlyGbrainTool(name) {
  return GBRAIN_MCP_READ_ONLY_TOOLS.has(name);
}

/**
 * @param {unknown} tools
 * @returns {unknown[]}
 */
export function filterReadOnlyToolList(tools) {
  if (!Array.isArray(tools)) return [];
  return tools.filter((t) => {
    if (!t || typeof t !== "object") return false;
    const name = /** @type {{ name?: string }} */ (t).name;
    return typeof name === "string" && isReadOnlyGbrainTool(name);
  });
}
