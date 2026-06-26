/**
 * Execute Composio toolkit actions for connector sync (no Hermes / no MCP).
 */
export {
  fetchGoogleCalendarEventsForAccount,
  fetchGoogleCalendarList,
  type GoogleCalendarEventSummary,
  type GoogleCalendarEntry,
  type CalendarExecuteContext,
} from "./calendar.js";

// Re-export Gmail helpers from dedicated module.
export {
  fetchGmailInboxMessages,
  fetchGmailThreadMessages,
  fetchGmailMessageById,
  fetchGmailProfile,
  sendGmailEmail,
  replyGmailThread,
  modifyGmailLabels,
  type GmailMessageSummary,
} from "./gmail.js";

/** @deprecated Use fetchGoogleCalendarEventsForAccount with a connectedAccountId. */
export async function fetchGoogleCalendarEvents(
  projectRoot: string,
  opts: { maxResults?: number; daysBack?: number; daysForward?: number; connectedAccountId?: string } = {},
): Promise<import("./calendar.js").GoogleCalendarEventSummary[]> {
  const { listCalendarRegistryAccounts } = await import("./calendarAccounts.js");
  const accounts = await listCalendarRegistryAccounts(projectRoot);
  const account =
    (opts.connectedAccountId
      ? accounts.find((a) => a.connectedAccountId === opts.connectedAccountId)
      : undefined) ??
    accounts.find((a) => a.isDefault) ??
    accounts[0];
  if (!account) {
    throw new Error("No Google Calendar accounts connected");
  }
  const { fetchGoogleCalendarEventsForAccount } = await import("./calendar.js");
  return fetchGoogleCalendarEventsForAccount(
    projectRoot,
    { connectedAccountId: account.connectedAccountId },
    opts,
  );
}
