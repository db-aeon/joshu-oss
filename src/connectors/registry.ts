/**
 * App-wide connector registry — canonical snapshot for UIs and services.
 * Written to `.joshu/connectors-registry.json` (metadata only; OAuth tokens stay in Composio).
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { isComposioEnabled, resolveComposioUserId } from "../composioApi.js";
import { readAgentGrant } from "../nylas/store.js";
import { isNylasConfigured } from "../nylas/config.js";
import { joshuConfigDir } from "../nylas/paths.js";
import type { GmailRegistryAccount } from "./composio/gmailAccounts.js";
import { listGmailRegistryAccounts } from "./composio/gmailAccounts.js";
import type { CalendarRegistryAccount } from "./composio/calendarAccounts.js";
import { listCalendarRegistryAccounts } from "./composio/calendarAccounts.js";
import type { OnenoteRegistryAccount } from "./composio/onenoteAccounts.js";
import { listOnenoteRegistryAccounts } from "./composio/onenoteAccounts.js";

export type ConnectorsRegistry = {
  updatedAt: string;
  composio: { enabled: boolean; userId?: string };
  nylas: { configured: boolean; provisioned: boolean; email?: string };
  gmail: { enabled: boolean; accounts: GmailRegistryAccount[] };
  googleCalendar: { enabled: boolean; accounts: CalendarRegistryAccount[] };
  onenote: { enabled: boolean; accounts: OnenoteRegistryAccount[] };
};

function registryPath(projectRoot: string): string | null {
  const dir = joshuConfigDir(projectRoot);
  if (!dir) return null;
  return path.join(dir, "connectors-registry.json");
}

export async function readConnectorsRegistry(projectRoot: string): Promise<ConnectorsRegistry | null> {
  const file = registryPath(projectRoot);
  if (!file) return null;
  try {
    const raw = await readFile(file, "utf8");
    return JSON.parse(raw) as ConnectorsRegistry;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    console.warn(`[connectors] could not read registry: ${(err as Error).message}`);
    return null;
  }
}

export async function writeConnectorsRegistry(
  projectRoot: string,
  registry: ConnectorsRegistry,
): Promise<void> {
  const file = registryPath(projectRoot);
  if (!file) throw new Error("Could not resolve Joshu config dir for connectors registry");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
}

/** Rebuild registry from live connector state (Composio + Nylas). */
export async function refreshConnectorsRegistry(projectRoot: string): Promise<ConnectorsRegistry> {
  const agent = readAgentGrant(projectRoot);
  const composioEnabled = isComposioEnabled();
  let gmailAccounts: GmailRegistryAccount[] = [];
  let calendarAccounts: CalendarRegistryAccount[] = [];
  let onenoteAccounts: OnenoteRegistryAccount[] = [];
  if (composioEnabled) {
    try {
      gmailAccounts = await listGmailRegistryAccounts(projectRoot);
    } catch (err) {
      console.warn(`[connectors] gmail account list failed: ${(err as Error).message}`);
    }
    try {
      calendarAccounts = await listCalendarRegistryAccounts(projectRoot);
    } catch (err) {
      console.warn(`[connectors] google calendar account list failed: ${(err as Error).message}`);
    }
    try {
      onenoteAccounts = await listOnenoteRegistryAccounts(projectRoot);
    } catch (err) {
      console.warn(`[connectors] onenote account list failed: ${(err as Error).message}`);
    }
  }

  const registry: ConnectorsRegistry = {
    updatedAt: new Date().toISOString(),
    composio: {
      enabled: composioEnabled,
      userId: composioEnabled ? resolveComposioUserId(projectRoot) : undefined,
    },
    nylas: {
      configured: isNylasConfigured(),
      provisioned: Boolean(agent),
      email: agent?.email,
    },
    gmail: {
      enabled: composioEnabled,
      accounts: gmailAccounts,
    },
    googleCalendar: {
      enabled: composioEnabled,
      accounts: calendarAccounts,
    },
    onenote: {
      enabled: composioEnabled,
      accounts: onenoteAccounts,
    },
  };

  await writeConnectorsRegistry(projectRoot, registry).catch((err) => {
    console.warn(`[connectors] could not write registry: ${(err as Error).message}`);
  });

  return registry;
}
