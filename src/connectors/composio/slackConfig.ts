/** Composio Slack toolkit pin (optional). When unset, execute uses dangerouslySkipVersionCheck. */
export const COMPOSIO_SLACK_TOOLKIT_SLUG = "slack";

export function composioSlackToolkitVersion(): string | undefined {
  return process.env.JOSHU_COMPOSIO_SLACK_TOOLKIT_VERSION?.trim() || undefined;
}
