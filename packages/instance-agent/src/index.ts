/**
 * Joshu instance agent — polls control plane, reports Joshu health, executes commands.
 */

import "dotenv/config";
import { createHmac, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  assertDistProvenanceMatches,
  shouldSyncDistFromImage,
  syncDistFromImage,
} from "./distSync.js";
import { ensureRegistryLoginForUpdate, persistGhcrSecretsFile, probeRegistryAuthOk } from "./registryAuth.js";
import { voiceImageRefFromSandbox } from "./voiceImageRef.js";

const execFileAsync = promisify(execFile);

function env(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback;
}

const INSTANCE_ID = env("JOSHU_INSTANCE_ID");
const AGENT_TOKEN = env("INSTANCE_AGENT_TOKEN");
const CONTROL_PLANE_URL = env("CONTROL_PLANE_URL").replace(/\/+$/, "");
const JOSHU_HEALTH_URL = env("JOSHU_HEALTH_URL", "http://127.0.0.1:8788/joshu/api/instance/health");
const JOSHU_BOX_SNAP_URL = env("JOSHU_BOX_SNAP_URL", "http://127.0.0.1:8788/joshu/api/box/snap");
const POLL_INTERVAL_SEC = Number(env("INSTANCE_AGENT_POLL_SEC", "30"));
const SIGNING_SECRET = env("INSTANCE_AGENT_SIGNING_SECRET");
const COMPOSE_FILE = env("JOSHU_COMPOSE_FILE", "/opt/joshu/deploy/docker-compose.yml");
const COMPOSE_ENV_FILE = env("JOSHU_COMPOSE_ENV_FILE", "/etc/joshu/instance.env");
const INSTALL_DIR = env("JOSHU_INSTALL_DIR", "/opt/joshu");
const HOSTNAME = env("CUSTOMER_DOMAIN", os.hostname());
const UPDATE_STACK_SERVICES = env("JOSHU_UPDATE_SERVICES", "joshu-stack,instance-agent")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
/** Services safe to force-recreate during an in-flight update (never include instance-agent). */
const UPDATE_RECREATE_SERVICES = UPDATE_STACK_SERVICES.filter((s) => s !== "instance-agent");
const HEALTH_WAIT_MS = Number(env("INSTANCE_AGENT_HEALTH_WAIT_MS", "600000"));
const HEALTH_POLL_MS = Number(env("INSTANCE_AGENT_HEALTH_POLL_MS", "5000"));
/** After recreate, Hermes MCP boot can exceed 5 min — allow core OK before Hermes within this window. */
const HERMES_GRACE_MS = Number(env("INSTANCE_AGENT_HERMES_GRACE_MS", "180000"));
const COMPANION_SOUL_SECRET_PATH = "/etc/joshu/secrets/companion-soul.md";
const PENDING_UPDATE_PATH = "/etc/joshu/secrets/pending-release-update.json";
const PATCH_INSTANCE_ENV_SCRIPT = path.join(INSTALL_DIR, "scripts/patch-instance-env.mjs");
const JOSHU_SYNC_IDENTITY_URL = env(
  "JOSHU_SYNC_IDENTITY_URL",
  "http://127.0.0.1:8788/joshu/api/instance/sync-companion-identity",
);

function authHeader(): string {
  return `Bearer ${INSTANCE_ID}.${AGENT_TOKEN}`;
}

function verifySignature(
  commandId: string,
  type: string,
  issuedAt: string,
  payload: unknown,
  signature: string,
): boolean {
  if (!SIGNING_SECRET) {
    console.warn("[instance-agent] INSTANCE_AGENT_SIGNING_SECRET unset; rejecting commands");
    return false;
  }
  const body = `${commandId}:${type}:${issuedAt}:${JSON.stringify(payload)}`;
  const expected = createHmac("sha256", SIGNING_SECRET).update(body).digest("hex");
  try {
    const a = Buffer.from(signature, "hex");
    const b = Buffer.from(expected, "hex");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

const UNREACHABLE_HEALTH = {
  healthy: false,
  readyForUpdate: false,
  releaseVersion: env("JOSHU_RELEASE_VERSION", "0.0.0-dev"),
  components: {} as Record<string, unknown>,
};

async function fetchJoshuHealth(): Promise<{
  healthy: boolean;
  readyForUpdate: boolean;
  releaseVersion: string;
  components: Record<string, unknown>;
}> {
  try {
    const res = await fetch(JOSHU_HEALTH_URL, { signal: AbortSignal.timeout(10_000) });
    const body = (await res.json()) as {
      healthy?: boolean;
      readyForUpdate?: boolean;
      releaseVersion?: string;
      components?: Record<string, unknown>;
    };
    return {
      healthy: Boolean(body.healthy) && res.ok,
      readyForUpdate: body.readyForUpdate !== false,
      releaseVersion: body.releaseVersion ?? env("JOSHU_RELEASE_VERSION", "0.0.0-dev"),
      components: body.components ?? {},
    };
  } catch (err) {
    const cause = err instanceof Error && "cause" in err ? err.cause : undefined;
    const code =
      cause && typeof cause === "object" && "code" in cause
        ? String((cause as { code?: unknown }).code ?? "")
        : "";
    const detail = code || (err instanceof Error ? err.message : String(err));
    console.info(`[instance-agent] health check unreachable (${detail})`);
    return UNREACHABLE_HEALTH;
  }
}

async function postJson(path: string, payload: unknown): Promise<Response> {
  return fetch(`${CONTROL_PLANE_URL}${path}`, {
    method: "POST",
    headers: {
      Authorization: authHeader(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
}

async function registerOnce(releaseVersion: string): Promise<void> {
  const res = await postJson("/api/instances/register", {
    instanceId: INSTANCE_ID,
    hostname: HOSTNAME,
    releaseVersion,
    vpsIpv4: env("VPS_IPV4"),
  });
  if (!res.ok) {
    console.warn(`[instance-agent] register failed: ${res.status} ${await res.text()}`);
  } else {
    console.info("[instance-agent] registered with control plane");
  }
}

interface Command {
  id: string;
  type: string;
  issuedAt: string;
  signature: string;
  payload: Record<string, unknown>;
}

async function ackCommand(commandId: string, status: "succeeded" | "failed", error?: string): Promise<void> {
  await postJson(`/api/instances/commands/${commandId}/ack`, {
    instanceId: INSTANCE_ID,
    status,
    error,
  });
}

/** Keys written to /etc/joshu/instance.env during updates — must not leak from agent boot env into compose. */
const COMPOSE_ENV_FILE_KEYS = [
  "JOSHU_IMAGE_REF",
  "JOSHU_VOICE_IMAGE_REF",
  "JOSHU_RELEASE_VERSION",
  "JOSHU_RELEASE_CHANNEL",
  "HERMES_AGENT_REF",
] as const;

function composeExecEnv(): NodeJS.ProcessEnv {
  const out = { ...process.env };
  for (const key of COMPOSE_ENV_FILE_KEYS) {
    delete out[key];
  }
  return out;
}

const VOICE_RT_COMPOSE_PROFILE = "voice-rt";

async function runCompose(args: string[], profiles: string[] = []): Promise<void> {
  const composeArgs = ["compose", "-f", COMPOSE_FILE, "--env-file", COMPOSE_ENV_FILE];
  for (const profile of profiles) {
    composeArgs.push("--profile", profile);
  }
  composeArgs.push(...args);
  await execFileAsync("docker", composeArgs, {
    timeout: 600_000,
    env: composeExecEnv(),
  });
}

/** Speech-to-speech voice — GHCR image (JOSHU_VOICE_IMAGE_REF) or host compose build fallback. */
async function voiceRealtimeS2sEnabled(): Promise<boolean> {
  const fileEnv = await readEnvFileKeys();
  const mode = fileEnv.JOSHU_VOICE_MODE || env("JOSHU_VOICE_MODE", "realtime_s2s");
  return mode === "realtime_s2s";
}

async function buildVoiceRealtime(): Promise<void> {
  console.info("[instance-agent] building voice-realtime from host clone (no GHCR ref)");
  await runCompose(["build", "voice-realtime"], [VOICE_RT_COMPOSE_PROFILE]);
}

async function pullVoiceRealtime(imageRef: string): Promise<void> {
  console.info(`[instance-agent] pulling voice-realtime ${imageRef}`);
  await runCompose(["pull", "voice-realtime"], [VOICE_RT_COMPOSE_PROFILE]);
}

async function syncVoiceRealtimeForUpdate(payload: Record<string, unknown>): Promise<void> {
  const fileEnv = await readEnvFileKeys();
  const voiceRef =
    typeof payload.voiceImageRef === "string" && payload.voiceImageRef.trim()
      ? payload.voiceImageRef.trim()
      : fileEnv.JOSHU_VOICE_IMAGE_REF?.trim() ||
        (fileEnv.JOSHU_IMAGE_REF
          ? voiceImageRefFromSandbox(fileEnv.JOSHU_IMAGE_REF)
          : typeof payload.imageRef === "string" && payload.imageRef
            ? voiceImageRefFromSandbox(payload.imageRef)
            : "");
  if (voiceRef) {
    await pullVoiceRealtime(voiceRef);
  } else {
    await buildVoiceRealtime();
  }
}

async function recreateVoiceRealtime(): Promise<void> {
  console.info("[instance-agent] recreating voice-realtime (profile voice-rt)");
  await runCompose(["up", "-d", "--force-recreate", "voice-realtime"], [VOICE_RT_COMPOSE_PROFILE]);
}

/** GHCR pulls run via docker CLI inside this container — creds must be mounted at ~/.docker/config.json. */
async function assertRegistryAuthForPull(): Promise<void> {
  if (await probeRegistryAuthOk()) return;
  throw new Error(
    "missing GHCR auth — mount /root/.docker:/root/.docker:ro on instance-agent " +
      "or provision /etc/joshu/secrets/ghcr-read.env (see deploy/docker-compose.yml)",
  );
}

async function runShell(command: string, args: string[], cwd: string): Promise<void> {
  await execFileAsync(command, args, { cwd, timeout: 300_000, env: process.env });
}

async function readEnvFileKeys(): Promise<Record<string, string>> {
  try {
    const text = await readFile(COMPOSE_ENV_FILE, "utf8");
    const out: Record<string, string> = {};
    for (const line of text.split(/\r?\n/)) {
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
      if (match) out[match[1]] = match[2].replace(/^"|"$/g, "");
    }
    return out;
  } catch {
    return {};
  }
}

function formatEnvValue(value: string): string {
  if (/[\s#'"\\$`]/.test(value)) {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return value;
}

async function updateEnvFile(updates: Record<string, string>): Promise<void> {
  try {
    await access(PATCH_INSTANCE_ENV_SCRIPT);
    const args = [PATCH_INSTANCE_ENV_SCRIPT, "--file", COMPOSE_ENV_FILE];
    for (const [key, value] of Object.entries(updates)) {
      args.push(`${key}=${value}`);
    }
    await execFileAsync("node", args, { timeout: 30_000 });
    for (const [key, value] of Object.entries(updates)) {
      process.env[key] = value;
    }
    return;
  } catch {
    // Fall back when /opt/joshu is not mounted (local dev).
  }

  let envText = "";
  try {
    envText = await readFile(COMPOSE_ENV_FILE, "utf8");
  } catch {
    envText = "";
  }

  const keysToUpdate = new Set(Object.keys(updates));
  const nextLines = envText.split(/\r?\n/).filter((line) => {
    const match = /^([A-Z0-9_]+)=/.exec(line);
    if (!match) return true;
    return !keysToUpdate.has(match[1]);
  });

  for (const [key, value] of Object.entries(updates)) {
    nextLines.push(`${key}=${formatEnvValue(value)}`);
  }

  await writeFile(COMPOSE_ENV_FILE, `${nextLines.join("\n").trimEnd()}\n`, { mode: 0o600 });
  for (const [key, value] of Object.entries(updates)) {
    process.env[key] = value;
  }
}

function releaseEnvUpdates(payload: Record<string, unknown>): Record<string, string> {
  const updates: Record<string, string> = {};
  const imageRef = typeof payload.imageRef === "string" ? payload.imageRef.trim() : "";
  if (imageRef) {
    updates.JOSHU_IMAGE_REF = imageRef;
  }
  if (typeof payload.version === "string" && payload.version) {
    updates.JOSHU_RELEASE_VERSION = payload.version;
  }
  if (typeof payload.hermesRef === "string" && payload.hermesRef) {
    updates.HERMES_AGENT_REF = payload.hermesRef;
  }
  const explicitVoice =
    typeof payload.voiceImageRef === "string" ? payload.voiceImageRef.trim() : "";
  if (explicitVoice) {
    updates.JOSHU_VOICE_IMAGE_REF = explicitVoice;
  } else if (imageRef) {
    updates.JOSHU_VOICE_IMAGE_REF = voiceImageRefFromSandbox(imageRef);
  }
  return updates;
}

async function commandExists(command: string): Promise<boolean> {
  try {
    await execFileAsync("sh", ["-c", `command -v ${command}`], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

async function syncHostGit(payload: Record<string, unknown>): Promise<void> {
  if (!payload.hostGitRequired) return;
  if (!(await commandExists("git"))) {
    console.warn(
      "[instance-agent] skipping host git sync (git not in PATH — rebuild instance-agent image)",
    );
    return;
  }
  const repoRef =
    typeof payload.repoRef === "string" && payload.repoRef.trim()
      ? payload.repoRef.trim()
      : env("JOSHU_REPO_REF", "main");
  console.info(`[instance-agent] syncing host clone at ${INSTALL_DIR} to ${repoRef}`);
  await runShell("git", ["fetch", "--all"], INSTALL_DIR);
  await runShell("git", ["checkout", repoRef], INSTALL_DIR);
  try {
    await runShell("git", ["pull", "--ff-only", "origin", repoRef], INSTALL_DIR);
  } catch {
    console.info("[instance-agent] git pull skipped (detached ref or already current)");
  }
}

async function buildHostInstanceAgent(): Promise<void> {
  const agentDir = path.join(INSTALL_DIR, "packages/instance-agent");
  const distDir = path.join(agentDir, "dist");
  const nodeModulesDir = path.join(agentDir, "node_modules");

  // Dev machines may have npm at repo root; VPS host has no npm and workspace:* breaks package-only install.
  if (await commandExists("npm")) {
    try {
      console.info(`[instance-agent] building host agent at ${agentDir} (npm)`);
      try {
        await runShell("npm", ["ci", "--omit=dev"], agentDir);
      } catch {
        await runShell("npm", ["install", "--omit=dev"], agentDir);
      }
      await runShell("npm", ["run", "build"], agentDir);
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[instance-agent] npm build failed, falling back to docker compose build: ${msg}`);
    }
  }

  console.info("[instance-agent] building host agent via docker compose build instance-agent");
  await runCompose(["build", "instance-agent"]);
  const { stdout } = await execFileAsync(
    "docker",
    ["compose", "-f", COMPOSE_FILE, "--env-file", COMPOSE_ENV_FILE, "images", "-q", "instance-agent"],
    { timeout: 60_000, env: composeExecEnv() },
  );
  const imageId = stdout.trim().split("\n").find(Boolean);
  if (!imageId) throw new Error("instance-agent image id missing after compose build");
  const { stdout: cidOut } = await execFileAsync("docker", ["create", imageId], { timeout: 60_000 });
  const cid = cidOut.trim();
  try {
    await rm(distDir, { recursive: true, force: true });
    await rm(nodeModulesDir, { recursive: true, force: true });
    await execFileAsync("docker", ["cp", `${cid}:/app/dist`, distDir], { timeout: 120_000 });
    await execFileAsync("docker", ["cp", `${cid}:/app/node_modules`, nodeModulesDir], {
      timeout: 120_000,
    });
  } finally {
    await execFileAsync("docker", ["rm", cid], { timeout: 30_000 }).catch(() => {});
  }
}

interface PendingUpdateFile {
  commandId: string;
  commandType: string;
  issuedAt: string;
  payload: Record<string, unknown>;
}

async function writePendingUpdate(cmd: Command): Promise<void> {
  await mkdir("/etc/joshu/secrets", { recursive: true });
  const record: PendingUpdateFile = {
    commandId: cmd.id,
    commandType: cmd.type,
    issuedAt: cmd.issuedAt,
    payload: { ...cmd.payload, _agentPrepared: true },
  };
  await writeFile(PENDING_UPDATE_PATH, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

async function readPendingUpdate(): Promise<PendingUpdateFile | null> {
  try {
    const raw = await readFile(PENDING_UPDATE_PATH, "utf8");
    return JSON.parse(raw) as PendingUpdateFile;
  } catch {
    return null;
  }
}

async function clearPendingUpdate(): Promise<void> {
  await unlink(PENDING_UPDATE_PATH).catch(() => {});
}

/** git pull + build host agent, restart container, resume command on next boot. */
async function prepareAgentThenRestart(cmd: Command): Promise<void> {
  console.info("[instance-agent] refreshing host agent before release command");
  await syncHostGit(cmd.payload);
  await buildHostInstanceAgent();
  await writePendingUpdate(cmd);
  await runCompose(["up", "-d", "--force-recreate", "instance-agent"]);
  process.exit(0);
}

async function preUpdateSnapshot(payload: Record<string, unknown>): Promise<void> {
  if (payload.requiresSnap === false) return;
  const fileEnv = await readEnvFileKeys();
  const bucket = fileEnv.JOSHU_SNAPSHOT_GCS_BUCKET ?? env("JOSHU_SNAPSHOT_GCS_BUCKET");
  if (!bucket) {
    console.info("[instance-agent] skipping pre-update snap (no JOSHU_SNAPSHOT_GCS_BUCKET)");
    return;
  }
  const version = typeof payload.version === "string" ? payload.version : "release";
  const label = `pre-update-${version}-${new Date().toISOString().slice(0, 19).replace(/[:.]/g, "-")}`;
  console.info(`[instance-agent] pre-update snapshot label=${label}`);
  const res = await fetch(JOSHU_BOX_SNAP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label, includeGbrain: true }),
    signal: AbortSignal.timeout(600_000),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`pre-update snap failed: ${res.status} ${text}`);
  }
  console.info("[instance-agent] pre-update snapshot completed");
}

async function setUpdateInProgress(inProgress: boolean): Promise<void> {
  await updateEnvFile({ JOSHU_UPDATE_IN_PROGRESS: inProgress ? "true" : "false" });
}

async function waitForHealthyAfterUpdate(expectedVersion: string, graceStartedAt: number): Promise<void> {
  const deadline = Date.now() + HEALTH_WAIT_MS;
  while (Date.now() < deadline) {
    const health = await fetchJoshuHealth();
    const dist = health.components.dist as { ok?: boolean; status?: string; version?: string } | undefined;
    const distOk = dist?.ok !== false || dist?.version === expectedVersion;
    const releaseMatches =
      health.releaseVersion === expectedVersion || dist?.version === expectedVersion;
    const hermes = health.components.hermes as { ok?: boolean } | undefined;
    const hermesOk = hermes?.ok !== false;
    const withinHermesGrace = Date.now() < graceStartedAt + HERMES_GRACE_MS;
    const camofoxOk = (health.components.camofox as { ok?: boolean } | undefined)?.ok !== false;
    const connectorsOk =
      (health.components.connectorsMcp as { ok?: boolean } | undefined)?.ok !== false;

    if (releaseMatches && distOk && camofoxOk && connectorsOk && (hermesOk || withinHermesGrace)) {
      if (!hermesOk) {
        console.info("[instance-agent] post-update core OK; Hermes still warming (grace period)");
      } else {
        console.info("[instance-agent] post-update health OK");
      }
      return;
    }

    if (!releaseMatches) {
      console.info(
        `[instance-agent] waiting for releaseVersion (got ${health.releaseVersion}, expected ${expectedVersion})...`,
      );
    } else if (!distOk) {
      console.info(
        `[instance-agent] waiting for dist provenance (status=${dist?.status ?? "unknown"}, version=${dist?.version ?? "?"})...`,
      );
    } else if (!hermesOk && !withinHermesGrace) {
      console.info("[instance-agent] waiting for Hermes after grace period...");
    } else {
      console.info("[instance-agent] waiting for healthy stack...");
    }
    await new Promise((r) => setTimeout(r, HEALTH_POLL_MS));
  }
  throw new Error(`stack not healthy within ${HEALTH_WAIT_MS / 1000}s after update`);
}

async function applyCompanionIdentitySync(payload: Record<string, unknown>): Promise<void> {
  const envUpdates: Record<string, string> = {};

  if (typeof payload.joshuName === "string" && payload.joshuName.trim()) {
    envUpdates.JOSHU_NAME = payload.joshuName.trim();
  }
  if (typeof payload.joshuImageUrl === "string" && payload.joshuImageUrl.trim()) {
    envUpdates.JOSHU_IMAGE_URL = payload.joshuImageUrl.trim();
  }
  if (typeof payload.joshuAvatarUrl === "string" && payload.joshuAvatarUrl.trim()) {
    envUpdates.JOSHU_AVATAR_URL = payload.joshuAvatarUrl.trim();
  }
  if (typeof payload.joshuVoiceId === "string" && payload.joshuVoiceId.trim()) {
    const voiceId = payload.joshuVoiceId.trim();
    envUpdates.JOSHU_VOICE_ID = voiceId;
    // Keep Gemini/OpenAI voice env aligned so voice-realtime picks the companion voice on recreate.
    envUpdates.GEMINI_LIVE_VOICE = voiceId;
    envUpdates.OPENAI_REALTIME_VOICE = voiceId;
  }
  if (typeof payload.ownerDisplayName === "string" && payload.ownerDisplayName.trim()) {
    envUpdates.JOSHU_OWNER_NAME = payload.ownerDisplayName.trim();
  }
  if (typeof payload.ownerEmail === "string" && payload.ownerEmail.trim()) {
    const email = payload.ownerEmail.trim();
    envUpdates.JOSHU_AROZ_USER = email;
    envUpdates.JOSHU_OWNER_EMAIL = email;
  }

  const soulMd =
    typeof payload.companionSoulMd === "string" ? payload.companionSoulMd.trim() : "";
  if (soulMd) {
    await mkdir("/etc/joshu/secrets", { recursive: true, mode: 0o700 });
    await writeFile(COMPANION_SOUL_SECRET_PATH, `${soulMd}\n`, { mode: 0o600 });
    envUpdates.JOSHU_COMPANION_SOUL_FILE = COMPANION_SOUL_SECRET_PATH;
  }

  if (Object.keys(envUpdates).length > 0) {
    await updateEnvFile(envUpdates);
  }

  const res = await fetch(JOSHU_SYNC_IDENTITY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ forceSoul: true }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`sync-companion-identity failed: ${res.status} ${text.slice(0, 300)}`);
  }
  console.info("[instance-agent] companion identity synced");

  if (typeof payload.joshuVoiceId === "string" && payload.joshuVoiceId.trim() && (await voiceRealtimeS2sEnabled())) {
    await recreateVoiceRealtime();
  }
}

async function applyReleaseEnvUpdates(envUpdates: Record<string, string>): Promise<void> {
  if (Object.keys(envUpdates).length === 0) return;
  await updateEnvFile(envUpdates);
  const applied = await readEnvFileKeys();
  for (const [key, expected] of Object.entries(envUpdates)) {
    if (applied[key] !== expected) {
      throw new Error(
        `${key} not persisted in ${COMPOSE_ENV_FILE} (expected ${expected}, got ${applied[key] ?? "missing"})`,
      );
    }
  }
  console.info(
    `[instance-agent] instance.env release keys: ${Object.keys(envUpdates).join(", ")}`,
  );
}

async function applyReleaseUpdate(payload: Record<string, unknown>): Promise<void> {
  const rollingBack = payload.commandType === "rollback";
  const envUpdates = releaseEnvUpdates(payload);

  const expectedVersion =
    typeof payload.version === "string" && payload.version
      ? payload.version
      : env("JOSHU_RELEASE_VERSION");
  const imageRef =
    typeof payload.imageRef === "string" && payload.imageRef
      ? payload.imageRef
      : env("JOSHU_IMAGE_REF");
  const syncDist = shouldSyncDistFromImage(payload);

  if (!rollingBack) {
    await preUpdateSnapshot(payload);
  } else {
    console.info("[instance-agent] skipping pre-update snapshot (rollback)");
  }
  if (!payload._agentPrepared) {
    await syncHostGit(payload);
  }

  const voiceRtEnabled = await voiceRealtimeS2sEnabled();

  await setUpdateInProgress(true);
  const healthGraceStartedAt = Date.now();
  process.env.JOSHU_UPDATE_IN_PROGRESS = "true";
  try {
    await ensureRegistryLoginForUpdate(payload);
    await assertRegistryAuthForPull();
    const pullServices = UPDATE_RECREATE_SERVICES.length > 0 ? UPDATE_RECREATE_SERVICES : ["joshu-stack"];
    await runCompose(["pull", ...pullServices]);

    if (voiceRtEnabled) {
      await syncVoiceRealtimeForUpdate(payload);
    }

    // Sync host dist/ before instance.env — on rollback, dist reverts before env so we never
    // leave env at N−1 with dist at N. Health reads release version from instance.env mount
    // (provisionInstanceEnv) so dist matches as soon as env is patched, before recreate.
    if (syncDist) {
      if (!imageRef) {
        throw new Error("syncDistFromImage requires JOSHU_IMAGE_REF or payload.imageRef");
      }
      if (!expectedVersion) {
        throw new Error("syncDistFromImage requires JOSHU_RELEASE_VERSION or payload.version");
      }
      await syncDistFromImage({
        installDir: INSTALL_DIR,
        imageRef,
        version: expectedVersion,
      });
      await assertDistProvenanceMatches(INSTALL_DIR, expectedVersion);
    }

    await applyReleaseEnvUpdates(envUpdates);

    if (UPDATE_RECREATE_SERVICES.length === 0) {
      throw new Error("JOSHU_UPDATE_SERVICES must include at least one service besides instance-agent");
    }
    // Never force-recreate instance-agent here — it SIGKILLs this process before ack.
    await runCompose(["up", "-d", "--force-recreate", ...UPDATE_RECREATE_SERVICES]);
    await waitForHealthyAfterUpdate(expectedVersion, healthGraceStartedAt);

    if (voiceRtEnabled) {
      await recreateVoiceRealtime();
    }
  } finally {
    process.env.JOSHU_UPDATE_IN_PROGRESS = "false";
    try {
      await setUpdateInProgress(false);
    } catch (err) {
      console.warn(
        `[instance-agent] failed to clear JOSHU_UPDATE_IN_PROGRESS: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}

async function executeCommand(cmd: Command): Promise<void> {
  const payload = cmd.payload ?? {};
  switch (cmd.type) {
    case "update":
    case "rollback":
      if (!payload._agentPrepared) {
        await prepareAgentThenRestart(cmd);
        return;
      }
      await applyReleaseUpdate(payload);
      break;
    case "restart": {
      const services = Array.isArray(payload.services)
        ? payload.services.filter((s): s is string => typeof s === "string")
        : [];
      if (services.length > 0) {
        await runCompose(["restart", ...services]);
      } else {
        await runCompose(["restart"]);
      }
      break;
    }
    case "sync_companion_identity":
      await applyCompanionIdentitySync(payload);
      break;
    case "rotate_secrets": {
      const secrets = payload.secrets;
      if (secrets && typeof secrets === "object") {
        const map = secrets as Record<string, string>;
        await updateEnvFile(map);
        const user = map.GHCR_READ_USER?.trim();
        const token = map.GHCR_READ_TOKEN?.trim();
        if (user && token) {
          const auth = {
            host: map.GHCR_REGISTRY?.trim() || "ghcr.io",
            username: user,
            token,
          };
          await persistGhcrSecretsFile(auth);
          await ensureRegistryLoginForUpdate({ registryAuth: auth });
        }
      }
      await runCompose(["up", "-d", "--force-recreate", "joshu-stack"]);
      const fileEnv = await readEnvFileKeys();
      const version = fileEnv.JOSHU_RELEASE_VERSION?.trim() || env("JOSHU_RELEASE_VERSION", "0.0.0-dev");
      await waitForHealthyAfterUpdate(version, Date.now());
      if (await voiceRealtimeS2sEnabled()) {
        await recreateVoiceRealtime();
      }
      break;
    }
    case "deprovision":
      await runCompose(["down"]);
      break;
    default:
      throw new Error(`unknown command type: ${cmd.type}`);
  }
}

async function heartbeatLoop(): Promise<void> {
  const health = await fetchJoshuHealth();
  const registryAuthOk = await probeRegistryAuthOk();
  const res = await postJson("/api/instances/heartbeat", {
    instanceId: INSTANCE_ID,
    reportedAt: new Date().toISOString(),
    releaseVersion: health.releaseVersion,
    healthy: health.healthy,
    components: health.components,
    host: {
      uptimeSec: os.uptime(),
      memUsedPct: Math.round((1 - os.freemem() / os.totalmem()) * 100),
      loadAvg: os.loadavg(),
      readyForUpdate: health.readyForUpdate,
      imageRef: env("JOSHU_IMAGE_REF"),
      registryAuthOk,
    },
  });

  if (!res.ok) {
    console.warn(`[instance-agent] heartbeat failed: ${res.status}`);
    return;
  }

  const data = (await res.json()) as { commands?: Command[]; pollIntervalSec?: number };
  const intervalMs = (data.pollIntervalSec ?? POLL_INTERVAL_SEC) * 1000;

  for (const cmd of data.commands ?? []) {
    const skewMs = Math.abs(Date.now() - new Date(cmd.issuedAt).getTime());
    if (skewMs > 5 * 60 * 1000) {
      console.warn(`[instance-agent] skipping stale command ${cmd.id}`);
      continue;
    }
    if (!verifySignature(cmd.id, cmd.type, cmd.issuedAt, cmd.payload, cmd.signature)) {
      console.warn(`[instance-agent] invalid signature for command ${cmd.id}`);
      continue;
    }
    try {
      console.info(`[instance-agent] executing ${cmd.type} (${cmd.id})`);
      await executeCommand(cmd);
      await ackCommand(cmd.id, "succeeded");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[instance-agent] command ${cmd.id} failed: ${msg}`);
      await ackCommand(cmd.id, "failed", msg);
    }
  }

  setTimeout(() => void heartbeatLoop(), intervalMs);
}

async function resumePendingUpdateIfAny(): Promise<void> {
  const pending = await readPendingUpdate();
  if (!pending) return;
  await clearPendingUpdate();
  const cmd: Command = {
    id: pending.commandId,
    type: pending.commandType,
    issuedAt: pending.issuedAt,
    signature: "",
    payload: pending.payload,
  };
  console.info(`[instance-agent] resuming pending ${cmd.type} (${cmd.id})`);
  try {
    await executeCommand(cmd);
    await ackCommand(cmd.id, "succeeded");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[instance-agent] resumed command ${cmd.id} failed: ${msg}`);
    await ackCommand(cmd.id, "failed", msg);
  }
}

async function main(): Promise<void> {
  const standalone =
    env("JOSHU_STANDALONE", "") === "1" ||
    env("STANDALONE", "") === "1" ||
    env("JOSHU_STANDALONE", "").toLowerCase() === "true";

  if (standalone) {
    console.info(
      "[instance-agent] STANDALONE mode — control plane registration disabled; exiting cleanly",
    );
    return;
  }

  if (!INSTANCE_ID || !AGENT_TOKEN || !CONTROL_PLANE_URL) {
    console.error(
      "[instance-agent] require JOSHU_INSTANCE_ID, INSTANCE_AGENT_TOKEN, CONTROL_PLANE_URL (or set JOSHU_STANDALONE=1)",
    );
    process.exit(1);
  }

  const health = await fetchJoshuHealth();
  await registerOnce(health.releaseVersion);

  console.info(
    `[instance-agent] started instance=${INSTANCE_ID} plane=${CONTROL_PLANE_URL} health=${JOSHU_HEALTH_URL}`,
  );

  await resumePendingUpdateIfAny();
  await heartbeatLoop();
}

main().catch((err) => {
  console.error("[instance-agent] fatal", err);
  process.exit(1);
});
