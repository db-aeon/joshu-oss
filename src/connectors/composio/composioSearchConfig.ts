/**
 * Composio Search toolkit (search tools with no sign-in), used by the Research report.
 * Pin: version 20260903_00 (slug COMPOSIO_SEARCH). Change research-report-sources, design decision D1.
 */
export const COMPOSIO_SEARCH_TOOLKIT_SLUG = "composio_search";

export const COMPOSIO_SEARCH_TOOLKIT_VERSION =
  process.env.JOSHU_COMPOSIO_SEARCH_TOOLKIT_VERSION?.trim() || "20260903_00";

export const COMPOSIO_SEARCH_NEWS = "COMPOSIO_SEARCH_NEWS";
export const COMPOSIO_SEARCH_SCHOLAR = "COMPOSIO_SEARCH_SCHOLAR";
export const COMPOSIO_SEARCH_FINANCE = "COMPOSIO_SEARCH_FINANCE";
export const COMPOSIO_SEARCH_SEC_FILINGS = "COMPOSIO_SEARCH_SEC_FILINGS";
