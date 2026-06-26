/**
 * Push control-plane companion persona onto the box: identity.json + Hermes SOUL.md.
 * Sources: JOSHU_* env vars and optional JOSHU_COMPANION_SOUL_FILE secret.
 */

import fs from "node:fs";
import { provisionEnvTrim } from "./provisionInstanceEnv.js";
import { writeJoshuIdentity, DEFAULT_JOSHU_IDENTITY, type JoshuIdentity } from "./joshuIdentity.js";
import { syncHermesContextFile } from "./hermesContextFile.js";
import { syncHermesSoulFile, writeHermesSoulFile } from "./hermesSoulFile.js";

function envTrim(name: string): string | undefined {
  return provisionEnvTrim(name);
}

function ownerEmailFromEnv(): string | undefined {
  return envTrim("JOSHU_OWNER_EMAIL") || envTrim("JOSHU_AROZ_USER");
}

export function readCompanionSoulMd(): string | undefined {
  const filePath = envTrim("JOSHU_COMPANION_SOUL_FILE");
  if (filePath && fs.existsSync(filePath)) {
    const content = fs.readFileSync(filePath, "utf8").trim();
    return content || undefined;
  }
  return envTrim("JOSHU_COMPANION_SOUL_MD");
}

/** True when instance.env carries control-plane companion bootstrap fields. */
export function hasCompanionIdentityBootstrap(): boolean {
  return Boolean(
    envTrim("JOSHU_NAME") ||
      envTrim("JOSHU_IMAGE_URL") ||
      envTrim("JOSHU_AVATAR_URL") ||
      readCompanionSoulMd(),
  );
}

export interface CompanionIdentitySyncResult {
  identityWritten: boolean;
  soulWritten: boolean;
  hermesContextWritten: boolean;
}

export interface CompanionIdentitySyncOptions {
  /** Overwrite non-managed SOUL.md (provision / operator apply). Default false. */
  forceSoul?: boolean;
}

/**
 * Write `.joshu/identity.json` (source: control-plane) and refresh Hermes context files.
 * Returns which artifacts changed.
 */
export function syncCompanionIdentityFromEnv(
  projectRoot = process.cwd(),
  options: CompanionIdentitySyncOptions = {},
): CompanionIdentitySyncResult {
  if (!hasCompanionIdentityBootstrap()) {
    return { identityWritten: false, soulWritten: false, hermesContextWritten: false };
  }

  const soulMd = readCompanionSoulMd();
  const joshuName = envTrim("JOSHU_NAME");
  const ownerName = envTrim("JOSHU_OWNER_NAME");
  const ownerEmail = ownerEmailFromEnv();

  const partial: Partial<Omit<JoshuIdentity, "schemaVersion">> = {
    source: "control-plane",
    imageUrl: envTrim("JOSHU_IMAGE_URL") ?? null,
    avatarUrl: envTrim("JOSHU_AVATAR_URL") ?? null,
    voiceId: envTrim("JOSHU_VOICE_ID") ?? null,
  };
  if (joshuName) partial.name = joshuName;
  if (ownerName || ownerEmail) {
    partial.owner = {
      displayName: ownerName || DEFAULT_JOSHU_IDENTITY.owner.displayName,
      ...(ownerEmail ? { email: ownerEmail } : {}),
    };
  }
  const identityWritten = writeJoshuIdentity(partial, projectRoot);

  const soulWritten = options.forceSoul
    ? Boolean(soulMd && writeHermesSoulFile(soulMd))
    : syncHermesSoulFile(soulMd);
  const hermesContextWritten = syncHermesContextFile(projectRoot);

  return { identityWritten, soulWritten, hermesContextWritten };
}
