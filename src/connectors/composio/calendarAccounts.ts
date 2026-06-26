/**
 * Multi Google Calendar account discovery + registry (Composio googlecalendar toolkit).
 */
import { getOrCreateComposioSession, isComposioEnabled, resolveComposioUserId } from "../../composioApi.js";
import { composioClient } from "./client.js";
import { resolveGmailAccountKey } from "./gmailAccounts.js";
import { fetchGoogleCalendarList } from "./calendar.js";
import { readConnectorsRegistry, writeConnectorsRegistry, type ConnectorsRegistry } from "../registry.js";

export type CalendarRegistryAccount = {
  connectedAccountId: string;
  accountKey: string;
  email?: string;
  label?: string;
  enabled: boolean;
  isDefault?: boolean;
};

type ComposioConnectedAccountRow = {
  id: string;
  status?: string;
  toolkit?: { slug?: string };
  appName?: string;
  appUniqueId?: string;
};

async function listComposioCalendarConnectedAccounts(
  projectRoot: string,
): Promise<ComposioConnectedAccountRow[]> {
  if (!isComposioEnabled()) return [];
  await getOrCreateComposioSession(projectRoot);
  const userId = resolveComposioUserId(projectRoot);
  const composio = composioClient();
  const listFn = (
    composio.connectedAccounts as {
      list: (params: { userIds: string[]; toolkitSlugs?: string[] }) => Promise<{
        items?: ComposioConnectedAccountRow[];
      }>;
    }
  ).list;

  const result = await listFn({ userIds: [userId], toolkitSlugs: ["googlecalendar"] });
  const items = result.items ?? [];
  return items.filter((row) => {
    const slug = row.toolkit?.slug?.toLowerCase() ?? row.appUniqueId?.toLowerCase() ?? "";
    const active = (row.status ?? "ACTIVE").toUpperCase() === "ACTIVE";
    return active && (slug === "googlecalendar" || slug.includes("calendar"));
  });
}

/** Resolve primary calendar email for a connected Google Calendar OAuth account. */
async function resolvePrimaryCalendarEmail(
  projectRoot: string,
  connectedAccountId: string,
): Promise<string | undefined> {
  try {
    const calendars = await fetchGoogleCalendarList(projectRoot, { connectedAccountId });
    const primary =
      calendars.find((c) => c.primary) ??
      calendars.find((c) => c.accessRole === "owner" && c.id.includes("@")) ??
      calendars[0];
    const id = primary?.id?.trim();
    if (id && id.includes("@")) return id.toLowerCase();
    const summary = primary?.summary?.trim();
    if (summary && summary.includes("@")) return summary.toLowerCase();
    return summary || id;
  } catch {
    return undefined;
  }
}

/** Merge Composio connected accounts with persisted registry preferences. */
export async function listCalendarRegistryAccounts(projectRoot: string): Promise<CalendarRegistryAccount[]> {
  const persisted = (await readConnectorsRegistry(projectRoot))?.googleCalendar?.accounts ?? [];
  const persistedById = new Map(persisted.map((a) => [a.connectedAccountId, a]));

  const live = await listComposioCalendarConnectedAccounts(projectRoot);
  const accounts: CalendarRegistryAccount[] = [];

  for (const row of live) {
    const connectedAccountId = row.id;
    const prev = persistedById.get(connectedAccountId);
    let email = prev?.email;
    if (!email) {
      email = await resolvePrimaryCalendarEmail(projectRoot, connectedAccountId);
    }
    const accountKey = prev?.accountKey ?? resolveGmailAccountKey({ email, connectedAccountId });
    accounts.push({
      connectedAccountId,
      accountKey,
      email,
      label: prev?.label ?? email,
      enabled: prev?.enabled !== false,
      isDefault: prev?.isDefault,
    });
  }

  if (accounts.length > 0 && !accounts.some((a) => a.isDefault)) {
    accounts[0]!.isDefault = true;
  }

  return accounts;
}

export async function getDefaultCalendarAccount(
  projectRoot: string,
): Promise<CalendarRegistryAccount | null> {
  const accounts = await listCalendarRegistryAccounts(projectRoot);
  return accounts.find((a) => a.isDefault) ?? accounts[0] ?? null;
}

export async function isAnyGoogleCalendarConnected(projectRoot: string): Promise<boolean> {
  if (!isComposioEnabled()) return false;
  try {
    const accounts = await listCalendarRegistryAccounts(projectRoot);
    return accounts.length > 0;
  } catch {
    return false;
  }
}

export async function persistCalendarAccountPrefs(
  projectRoot: string,
  accounts: CalendarRegistryAccount[],
): Promise<void> {
  const existing = (await readConnectorsRegistry(projectRoot)) ?? {
    updatedAt: new Date().toISOString(),
    composio: { enabled: isComposioEnabled() },
    nylas: { configured: false, provisioned: false },
    gmail: { enabled: isComposioEnabled(), accounts: [] },
    googleCalendar: { enabled: isComposioEnabled(), accounts: [] },
    onenote: { enabled: isComposioEnabled(), accounts: [] },
  };
  const next: ConnectorsRegistry = {
    ...existing,
    updatedAt: new Date().toISOString(),
    googleCalendar: { enabled: isComposioEnabled(), accounts },
  };
  await writeConnectorsRegistry(projectRoot, next);
}
