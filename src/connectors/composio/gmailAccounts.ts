/**
 * Multi-Gmail account discovery, registry keys, and legacy mirror migration.
 */
import { readdir, rename, mkdir } from "node:fs/promises";
import path from "node:path";
import { getOrCreateComposioSession, isComposioEnabled, resolveComposioUserId } from "../../composioApi.js";
import { composioClient } from "./client.js";
import { fetchGmailProfile } from "./gmail.js";
import {
  gmailLegacyThreadsDir,
  gmailSyncStatePath,
  mailThreadsDir,
  resolveConnectorPaths,
} from "../paths.js";
import { readConnectorsRegistry, writeConnectorsRegistry, type ConnectorsRegistry } from "../registry.js";

export type GmailRegistryAccount = {
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

/** Stable directory key under connectors/mail/gmail/{accountKey}/threads/ */
export function resolveGmailAccountKey(opts: {
  email?: string;
  connectedAccountId: string;
}): string {
  const email = opts.email?.trim().toLowerCase();
  if (email) {
    const local = email.replace(/@/g, "_at_").replace(/\./g, "_");
    const safe = local.replace(/[^a-z0-9._-]+/g, "_").slice(0, 80);
    if (safe) return safe;
  }
  const id = opts.connectedAccountId.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(-24);
  return `acct_${id || "default"}`;
}

async function listComposioGmailConnectedAccounts(projectRoot: string): Promise<ComposioConnectedAccountRow[]> {
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

  const result = await listFn({ userIds: [userId], toolkitSlugs: ["gmail"] });
  const items = result.items ?? [];
  return items.filter((row) => {
    const slug = row.toolkit?.slug?.toLowerCase() ?? row.appUniqueId?.toLowerCase() ?? "";
    const active = (row.status ?? "ACTIVE").toUpperCase() === "ACTIVE";
    return active && (slug === "gmail" || slug.includes("gmail"));
  });
}

/** Merge Composio connected accounts with persisted registry preferences. */
export async function listGmailRegistryAccounts(projectRoot: string): Promise<GmailRegistryAccount[]> {
  const persisted = (await readConnectorsRegistry(projectRoot))?.gmail.accounts ?? [];
  const persistedById = new Map(persisted.map((a) => [a.connectedAccountId, a]));

  const live = await listComposioGmailConnectedAccounts(projectRoot);
  const accounts: GmailRegistryAccount[] = [];

  for (const row of live) {
    const connectedAccountId = row.id;
    const prev = persistedById.get(connectedAccountId);
    let email = prev?.email;
    if (!email) {
      try {
        const profile = await fetchGmailProfile(projectRoot, { connectedAccountId });
        email = profile.emailAddress;
      } catch {
        /* optional */
      }
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

export async function getDefaultGmailAccount(
  projectRoot: string,
): Promise<GmailRegistryAccount | null> {
  const accounts = await listGmailRegistryAccounts(projectRoot);
  return accounts.find((a) => a.isDefault) ?? accounts[0] ?? null;
}

export async function resolveGmailAccount(
  projectRoot: string,
  connectedAccountId?: string,
): Promise<GmailRegistryAccount | null> {
  const accounts = await listGmailRegistryAccounts(projectRoot);
  if (accounts.length === 0) return null;
  if (connectedAccountId) {
    return accounts.find((a) => a.connectedAccountId === connectedAccountId) ?? null;
  }
  return getDefaultGmailAccount(projectRoot);
}

export async function isAnyGmailConnected(projectRoot: string): Promise<boolean> {
  if (!isComposioEnabled()) return false;
  try {
    const accounts = await listGmailRegistryAccounts(projectRoot);
    return accounts.length > 0;
  } catch {
    return false;
  }
}

/** Move legacy flat gmail/threads/*.md into the default account subdir once. */
export async function migrateLegacyGmailMirrorIfNeeded(
  projectRoot: string,
  defaultAccountKey: string,
): Promise<void> {
  const paths = resolveConnectorPaths(projectRoot);
  if (!paths) return;

  const legacyDir = gmailLegacyThreadsDir(paths.filesRoot);
  const targetDir = mailThreadsDir("gmail", paths.filesRoot, defaultAccountKey);

  let legacyEntries: string[];
  try {
    legacyEntries = await readdir(legacyDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }

  const mdFiles = legacyEntries.filter((n) => n.endsWith(".md"));
  if (mdFiles.length === 0) return;

  let targetEntries: string[] = [];
  try {
    targetEntries = await readdir(targetDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (targetEntries.some((n) => n.endsWith(".md"))) {
    return;
  }

  await mkdir(targetDir, { recursive: true });
  for (const name of mdFiles) {
    await rename(path.join(legacyDir, name), path.join(targetDir, name));
  }
  console.log(
    `[connectors] migrated ${mdFiles.length} legacy Gmail thread(s) → gmail/${defaultAccountKey}/threads/`,
  );
}

export async function persistGmailAccountPrefs(
  projectRoot: string,
  accounts: GmailRegistryAccount[],
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
    gmail: { enabled: isComposioEnabled(), accounts },
  };
  await writeConnectorsRegistry(projectRoot, next);
}

export function gmailSyncStateFileName(accountKey: string): string {
  return `gmail-sync.${accountKey}.json`;
}
