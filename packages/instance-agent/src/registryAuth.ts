/**
 * GHCR login for release updates — docker CLI runs inside instance-agent with
 * host ~/.docker bind-mounted (see deploy/docker-compose.yml).
 */
import { spawn } from "node:child_process";
import { access, readFile, writeFile, mkdir } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";

const DOCKER_CONFIG = "/root/.docker/config.json";
const GHCR_SECRETS_PATH = "/etc/joshu/secrets/ghcr-read.env";

export type RegistryAuth = {
  host?: string;
  username: string;
  token: string;
};

function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

async function readSecretsFileAuth(): Promise<RegistryAuth | null> {
  try {
    const raw = await readFile(GHCR_SECRETS_PATH, "utf8");
    const env = parseEnvFile(raw);
    const username = env.GHCR_READ_USER?.trim();
    const token = env.GHCR_READ_TOKEN?.trim();
    if (!username || !token) return null;
    return {
      host: env.GHCR_REGISTRY?.trim() || "ghcr.io",
      username,
      token,
    };
  } catch {
    return null;
  }
}

function registryAuthFromPayload(payload: Record<string, unknown>): RegistryAuth | null {
  const block = payload.registryAuth;
  if (!block || typeof block !== "object") return null;
  const rec = block as Record<string, unknown>;
  const username = typeof rec.username === "string" ? rec.username.trim() : "";
  const token = typeof rec.token === "string" ? rec.token.trim() : "";
  if (!username || !token) return null;
  return {
    host: typeof rec.host === "string" && rec.host.trim() ? rec.host.trim() : "ghcr.io",
    username,
    token,
  };
}

async function dockerLogin(auth: RegistryAuth): Promise<void> {
  const host = auth.host ?? "ghcr.io";
  await new Promise<void>((resolve, reject) => {
    const child = spawn("docker", ["login", host, "-u", auth.username, "--password-stdin"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`docker login failed (${code}): ${stderr.trim() || "unknown error"}`));
    });
    child.stdin.write(auth.token);
    child.stdin.end();
  });
}

async function configHasGhcrAuth(): Promise<boolean> {
  try {
    await access(DOCKER_CONFIG, fsConstants.R_OK);
    const raw = await readFile(DOCKER_CONFIG, "utf8");
    const parsed = JSON.parse(raw) as { auths?: Record<string, unknown> };
    return Boolean(parsed.auths?.["ghcr.io"]);
  } catch {
    return false;
  }
}

/** Persist creds for manual refresh scripts and future updates without control-plane inject. */
export async function persistGhcrSecretsFile(auth: RegistryAuth): Promise<void> {
  const host = auth.host ?? "ghcr.io";
  const body =
    `GHCR_REGISTRY=${host}\n` +
    `GHCR_READ_USER=${auth.username}\n` +
    `GHCR_READ_TOKEN=${auth.token}\n`;
  await mkdir("/etc/joshu/secrets", { recursive: true, mode: 0o700 });
  await writeFile(GHCR_SECRETS_PATH, body, { mode: 0o600 });
}

/**
 * Refresh GHCR login before compose pull. Prefers signed command payload (not stored in DB),
 * then on-box secrets file, then existing config.json.
 */
export async function ensureRegistryLoginForUpdate(
  payload: Record<string, unknown>,
): Promise<void> {
  const fromPayload = registryAuthFromPayload(payload);
  if (fromPayload) {
    await dockerLogin(fromPayload);
    await persistGhcrSecretsFile(fromPayload);
    return;
  }

  const fromSecrets = await readSecretsFileAuth();
  if (fromSecrets) {
    await dockerLogin(fromSecrets);
    return;
  }

  if (await configHasGhcrAuth()) {
    return;
  }

  throw new Error(
    "GHCR login missing — no registryAuth on command, no /etc/joshu/secrets/ghcr-read.env, " +
      "and no ghcr.io entry in /root/.docker/config.json. " +
      "Retry admin Update after control-plane deploy, or refresh GHCR credentials on the host.",
  );
}

/** Heartbeat telemetry — can instance-agent pull private images? */
export async function probeRegistryAuthOk(): Promise<boolean> {
  if (await configHasGhcrAuth()) return true;
  const fromSecrets = await readSecretsFileAuth();
  return fromSecrets !== null;
}
