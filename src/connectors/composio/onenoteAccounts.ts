/**
 * Microsoft OneNote account discovery via Composio ONENOTE toolkit.
 */
import { getOrCreateComposioSession, isComposioEnabled, resolveComposioUserId } from "../../composioApi.js";
import { composioClient } from "./client.js";
import { resolveGmailAccountKey } from "./gmailAccounts.js";
import { readConnectorsRegistry, writeConnectorsRegistry, type ConnectorsRegistry } from "../registry.js";

export type OnenoteRegistryAccount = {
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

async function listComposioOnenoteConnectedAccounts(
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

  const result = await listFn({ userIds: [userId], toolkitSlugs: ["onenote"] });
  const items = result.items ?? [];
  return items.filter((row) => {
    const slug = row.toolkit?.slug?.toLowerCase() ?? row.appUniqueId?.toLowerCase() ?? "";
    const active = (row.status ?? "ACTIVE").toUpperCase() === "ACTIVE";
    return active && (slug === "onenote" || slug.includes("onenote"));
  });
}

/** Merge Composio connected accounts with persisted registry preferences. */
export async function listOnenoteRegistryAccounts(
  projectRoot: string,
): Promise<OnenoteRegistryAccount[]> {
  const persisted = (await readConnectorsRegistry(projectRoot))?.onenote?.accounts ?? [];
  const persistedById = new Map(persisted.map((a) => [a.connectedAccountId, a]));

  const live = await listComposioOnenoteConnectedAccounts(projectRoot);
  const accounts: OnenoteRegistryAccount[] = [];

  for (const row of live) {
    const connectedAccountId = row.id;
    const prev = persistedById.get(connectedAccountId);
    const label = prev?.label ?? row.appName?.trim() ?? "Microsoft OneNote";
    const email = prev?.email;
    const accountKey =
      prev?.accountKey ?? resolveGmailAccountKey({ email, connectedAccountId });
    accounts.push({
      connectedAccountId,
      accountKey,
      email,
      label,
      enabled: prev?.enabled !== false,
      isDefault: prev?.isDefault,
    });
  }

  if (accounts.length > 0 && !accounts.some((a) => a.isDefault)) {
    accounts[0]!.isDefault = true;
  }

  return accounts;
}

export async function getDefaultOnenoteAccount(
  projectRoot: string,
): Promise<OnenoteRegistryAccount | null> {
  const accounts = await listOnenoteRegistryAccounts(projectRoot);
  return accounts.find((a) => a.isDefault) ?? accounts[0] ?? null;
}

export async function resolveOnenoteAccount(
  projectRoot: string,
  connectedAccountId?: string,
): Promise<OnenoteRegistryAccount | null> {
  const accounts = await listOnenoteRegistryAccounts(projectRoot);
  if (accounts.length === 0) return null;
  if (connectedAccountId) {
    return accounts.find((a) => a.connectedAccountId === connectedAccountId) ?? null;
  }
  return getDefaultOnenoteAccount(projectRoot);
}

export async function isAnyOnenoteConnected(projectRoot: string): Promise<boolean> {
  if (!isComposioEnabled()) return false;
  try {
    const accounts = await listOnenoteRegistryAccounts(projectRoot);
    return accounts.length > 0;
  } catch {
    return false;
  }
}

export async function persistOnenoteAccountPrefs(
  projectRoot: string,
  accounts: OnenoteRegistryAccount[],
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
    onenote: { enabled: isComposioEnabled(), accounts },
  };
  await writeConnectorsRegistry(projectRoot, next);
}
