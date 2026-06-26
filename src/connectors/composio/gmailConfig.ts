/**
 * Composio Gmail toolkit pin — https://docs.composio.dev/toolkits/gmail
 * Version: 20260506_01 (slug GMAIL)
 */
export const COMPOSIO_GMAIL_TOOLKIT_SLUG = "gmail";

/** Pin required for manual tools.execute (Composio rejects unresolved "latest"). */
export const COMPOSIO_GMAIL_TOOLKIT_VERSION =
  process.env.JOSHU_COMPOSIO_GMAIL_TOOLKIT_VERSION?.trim() || "20260506_01";
