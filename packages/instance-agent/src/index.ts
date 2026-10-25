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

import { removeAgentReplaceHelper, replaceAgentContainer, startInstanceAgent } from "./agentReplace.js";
import { ensureRegistryLoginForUpdate, persistGhcrSecretsFile, probeRegistryAuthOk } from "./registryAuth.js";
import { defaultDiagnosticsDeps, runDiagnostics } from "./diagnostics.js";
import { evaluateSnapshotCredStatus, type SnapshotCredStatus } from "./snapshotCreds.js";
import { releaseEnvUpdates } from "./releaseEnv.js";
import { finishReleaseUpdate } from "./releaseFinish.js";
import { getRuntimeDrift } from "./runtimeDrift.js";
import { carryOverJoshuState } from "./stateCarryOver.js";
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
// Mutable: rotate_secrets may replace INSTANCE_AGENT_SIGNING_SECRET without recreating
// this process (we never force-recreate instance-agent mid-command). Reload in-process
// so the next heartbeat command verifies against the new per-box HMAC.
let signingSecret = env("INSTANCE_AGENT_SIGNING_SECRET");
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
/** In the host bundle (change prune-release-images). */
const PRUNE_RELEASE_IMAGES_SCRIPT = path.join(INSTALL_DIR, "deploy", "scripts", "prune-release-images.sh");
/** In the agent image (deploy/Dockerfile.instance-agent). */
const PATCH_INSTANCE_ENV_SCRIPT = env("JOSHU_PATCH_INSTANCE_ENV_SCRIPT", "/app/scripts/patch-instance-env.mjs");
/** Installer of the host bundle, inside the sandbox image (change image-owned-box-runtime). */
const HOST_BUNDLE_INSTALLER = "/opt/joshu/.image/host/deploy/scripts/install-host-bundle.sh";
const JOSHU_SYNC_IDENTITY_URL = env(
  "JOSHU_SYNC_IDENTITY_URL",
  "http://127.0.0.1:8788/joshu/api/instance/sync-companion-identity",
);
const JOSHU_SEND_OWNER_EMAIL_URL = env(
  "JOSHU_SEND_OWNER_EMAIL_URL",
  "http://127.0.0.1:8788/joshu/api/instance/send-owner-email",
);
const JOSHU_DESKTOP_LOGIN_URL = env(
  "JOSHU_DESKTOP_LOGIN_URL",
  "http://127.0.0.1:8788/joshu/api/desktop-login/code",
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
  if (!signingSecret) {
    console.warn("[instance-agent] INSTANCE_AGENT_SIGNING_SECRET unset; rejecting commands");
    return false;
  }
  const body = `${commandId}:${type}:${issuedAt}:${JSON.stringify(payload)}`;
  const expected = createHmac("sha256", signingSecret).update(body).digest("hex");
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
  /** Seconds since the Joshu API started; the failure digest uses it to mark old failures. */
  uptimeSec?: number;
}> {
  try {
    const res = await fetch(JOSHU_HEALTH_URL, { signal: AbortSignal.timeout(10_000) });
    const body = (await res.json()) as {
      healthy?: boolean;
      readyForUpdate?: boolean;
      releaseVersion?: string;
      components?: Record<string, unknown>;
      uptimeSec?: number;
    };
    return {
      uptimeSec: typeof body.uptimeSec === "number" ? body.uptimeSec : undefined,
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

async function resolvePublicVpsIpv4(): Promise<string | undefined> {
  const fromEnv = env("VPS_IPV4");
  if (fromEnv) return fromEnv;

  // DigitalOcean droplet metadata (link-local) — cloud-init cannot know the IP
  // before create, so instance.env often omits VPS_IPV4 on first boot.
  try {
    const res = await fetch(
      "http://169.254.169.254/metadata/v1/interfaces/public/0/ipv4/address",
      { signal: AbortSignal.timeout(2000) },
    );
    if (res.ok) {
      const ip = (await res.text()).trim();
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
        process.env.VPS_IPV4 = ip;
        console.info(`[instance-agent] resolved VPS_IPV4 from DO metadata: ${ip}`);
        return ip;
      }
    }
  } catch {
    // Non-DO or metadata disabled.
  }
  return undefined;
}

async function registerOnce(releaseVersion: string): Promise<void> {
  const res = await postJson("/api/instances/register", {
    instanceId: INSTANCE_ID,
    hostname: HOSTNAME,
    releaseVersion,
    vpsIpv4: await resolvePublicVpsIpv4(),
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

async function ackCommand(
  commandId: string,
  status: "succeeded" | "failed",
  error?: string,
  result?: Record<string, unknown>,
): Promise<void> {
  await postJson(`/api/instances/commands/${commandId}/ack`, {
    instanceId: INSTANCE_ID,
    status,
    error,
    ...(result ? { result } : {}),
  });
}

/** Keys written to /etc/joshu/instance.env during updates — must not leak from agent boot env into compose. */
const COMPOSE_ENV_FILE_KEYS = [
  "JOSHU_IMAGE_REF",
  "JOSHU_VOICE_IMAGE_REF",
  "JOSHU_INSTANCE_AGENT_IMAGE_REF",
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

async function runCompose(args: string[], profiles: string[] = [], timeout = 600_000): Promise<string> {
  const composeArgs = ["compose", "-f", COMPOSE_FILE, "--env-file", COMPOSE_ENV_FILE];
  for (const profile of profiles) {
    composeArgs.push("--profile", profile);
  }
  composeArgs.push(...args);
  const { stdout } = await execFileAsync("docker", composeArgs, {
    timeout,
    env: composeExecEnv(),
  });
  return String(stdout ?? "");
}

/**
 * Before a recreate of joshu-stack: copy the Joshu state of the running stack container
 * from its writable layer into the volume (change joshu-state-volume). Best effort.
 */
async function carryOverStackState(services: string[]): Promise<void> {
  if (!services.includes("joshu-stack")) return;
  const result = await carryOverJoshuState(INSTALL_DIR, (script) =>
    runCompose(["exec", "-T", "joshu-stack", "sh", "-c", script], [], 120_000),
  );
  if (result.ok) {
    console.info(`[instance-agent] joshu state carry-over: ${result.lines.join("; ") || "nothing to copy"}`);
  } else {
    console.warn(
      `[instance-agent] WARNING: joshu state carry-over incomplete: ${result.error ?? result.lines.join("; ")}`,
    );
  }
}

/** Speech-to-speech voice — GHCR image (JOSHU_VOICE_IMAGE_REF). */
async function voiceRealtimeS2sEnabled(): Promise<boolean> {
  const fileEnv = await readEnvFileKeys();
  const mode = fileEnv.JOSHU_VOICE_MODE || env("JOSHU_VOICE_MODE", "realtime_s2s");
  return mode === "realtime_s2s";
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
  if (!voiceRef) {
    throw new Error("voice-realtime update needs JOSHU_VOICE_IMAGE_REF or payload.imageRef");
  }
  await pullVoiceRealtime(voiceRef);
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
    // Fall back when the patch script is missing (local dev).
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

async function pullImage(imageRef: string): Promise<void> {
  console.info(`[instance-agent] pulling ${imageRef}`);
  await execFileAsync("docker", ["pull", "-q", imageRef], { timeout: 900_000 });
}

/**
 * Write the host bundle of the release to INSTALL_DIR/deploy (change image-owned-box-runtime).
 * The installer comes from the sandbox image, so the host needs no copy of it.
 * INSTALL_DIR is mounted at the same path in this container, so the files land on the host.
 */
async function installHostBundle(imageRef: string, version: string): Promise<void> {
  const { stdout: installer } = await execFileAsync(
    "docker",
    ["run", "--rm", "--entrypoint", "cat", imageRef, HOST_BUNDLE_INSTALLER],
    { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
  );
  if (!installer.trim()) {
    throw new Error(`${imageRef} has no host bundle installer (${HOST_BUNDLE_INSTALLER})`);
  }
  await new Promise<void>((resolve, reject) => {
    const child = execFile(
      "bash",
      ["-s"],
      {
        timeout: 300_000,
        env: {
          ...process.env,
          JOSHU_IMAGE_REF: imageRef,
          JOSHU_RELEASE_VERSION: version,
          JOSHU_INSTALL_DIR: INSTALL_DIR,
          JOSHU_SKIP_PULL: "1",
        },
      },
      (err, stdout, stderr) => {
        if (stdout.trim()) console.info(stdout.trim());
        if (err) reject(new Error(`install-host-bundle failed: ${stderr.trim() || err.message}`));
        else resolve();
      },
    );
    child.stdin?.end(installer);
  });
}

/**
 * Remove old release images after a healthy update or rollback (change prune-release-images).
 * The script keeps the current release images and the previous release for a rollback.
 * Best effort: the new release already runs, so a failure here only logs a warning.
 * composeExecEnv() drops the release pins of the boot env, so the script reads them from instance.env.
 */
async function pruneReleaseImages(): Promise<void> {
  try {
    await access(PRUNE_RELEASE_IMAGES_SCRIPT);
  } catch {
    console.info(`[instance-agent] no ${PRUNE_RELEASE_IMAGES_SCRIPT}; old release images stay`);
    return;
  }
  try {
    const { stdout } = await execFileAsync("bash", [PRUNE_RELEASE_IMAGES_SCRIPT], {
      timeout: 600_000,
      env: { ...composeExecEnv(), ENV_FILE: COMPOSE_ENV_FILE },
    });
    if (stdout.trim()) console.info(stdout.trim());
  } catch (err) {
    console.warn(
      `[instance-agent] removing old release images failed: ${err instanceof Error ? err.message : err}`,
    );
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

/**
 * Prepare a release update (change image-owned-box-runtime): install the host bundle and
 * the agent image of the target release, then restart this agent on the new image.
 * The new agent process resumes the command from the pending update file.
 */
async function prepareAgentThenRestart(cmd: Command): Promise<void> {
  const payload = cmd.payload ?? {};
  const envUpdates = releaseEnvUpdates(payload);
  const imageRef = envUpdates.JOSHU_IMAGE_REF || env("JOSHU_IMAGE_REF");
  const version = envUpdates.JOSHU_RELEASE_VERSION || env("JOSHU_RELEASE_VERSION");
  const agentImageRef = envUpdates.JOSHU_INSTANCE_AGENT_IMAGE_REF;
  if (!imageRef || !version || !agentImageRef) {
    throw new Error("release update needs payload.imageRef and payload.version");
  }
  console.info(`[instance-agent] preparing release ${version}: host bundle + agent image`);
  await ensureRegistryLoginForUpdate(payload);
  await assertRegistryAuthForPull();
  // Pull both images before any change on the host. A failed pull stops here.
  await pullImage(imageRef);
  await pullImage(agentImageRef);
  await installHostBundle(imageRef, version);
  await applyReleaseEnvUpdates({ JOSHU_INSTANCE_AGENT_IMAGE_REF: agentImageRef });
  await writePendingUpdate(cmd);
  // The agent replace helper recreates ONLY the agent (--no-deps); the stack recreate
  // happens later in applyReleaseUpdate, in the new agent process (change agent-self-replace).
  try {
    await replaceAgentContainer(
      {
        agentImageRef,
        composeFile: COMPOSE_FILE,
        composeEnvFile: COMPOSE_ENV_FILE,
        installDir: INSTALL_DIR,
        composeProfiles: env("COMPOSE_PROFILES") || undefined,
        composeProjectName: env("COMPOSE_PROJECT_NAME") || undefined,
      },
      agentReplaceDeps,
    );
  } catch (err) {
    // This agent still runs, so no new agent resumes the update.
    await clearPendingUpdate();
    throw err;
  }
}

const agentReplaceDeps = {
  docker: async (args: string[]) =>
    String((await execFileAsync("docker", args, { timeout: 120_000, env: composeExecEnv() })).stdout ?? ""),
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  log: (line: string) => console.info(`[instance-agent] ${line}`),
};

/** Resolve snapshot cred status from instance.env (falling back to process env). */
async function resolveSnapshotCredStatus(): Promise<SnapshotCredStatus> {
  const fileEnv = await readEnvFileKeys();
  return evaluateSnapshotCredStatus((name) => fileEnv[name] ?? process.env[name]);
}

async function preUpdateSnapshot(payload: Record<string, unknown>): Promise<void> {
  if (payload.requiresSnap === false) return;

  const cred = await resolveSnapshotCredStatus();
  // No snapshot bucket configured → nothing to back up; proceed.
  if (!cred.configured) {
    console.info(`[instance-agent] skipping pre-update snap (${cred.reason})`);
    return;
  }
  // Bucket configured but creds are broken (e.g. SA key path points at a missing
  // file). A missing BACKUP must not block an otherwise-reversible update — skip
  // loudly instead of aborting. `readyForUpdate` already surfaces this pre-click.
  if (!cred.ok) {
    console.warn(
      `[instance-agent] WARNING: pre-update snapshot SKIPPED — snapshot credentials look broken: ` +
        `${cred.reason}. Proceeding WITHOUT a pre-update backup; fix the SA key to restore backups.`,
    );
    return;
  }

  // Creds look usable, so we expect the snapshot to succeed — a failure here is a
  // real error (network/permission/bucket) and SHOULD abort the update.
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

/** Deliver a CP-authored owner email via the box Nylas agent mailbox (action-guard bypass). */
async function applySetArozPassword(payload: Record<string, unknown>): Promise<void> {
  const passwordHash =
    typeof payload.passwordHash === "string" ? payload.passwordHash.trim().toLowerCase() : "";
  if (!/^[0-9a-f]{128}$/.test(passwordHash)) {
    throw new Error("set_aroz_password: invalid passwordHash");
  }

  const fileEnv = await readEnvFileKeys();
  const arozUser = (fileEnv.JOSHU_AROZ_USER || env("JOSHU_AROZ_USER")).trim();
  if (!arozUser) {
    throw new Error("set_aroz_password: JOSHU_AROZ_USER is not set");
  }

  const expected =
    typeof payload.username === "string" ? payload.username.trim() : "";
  if (expected && expected.toLowerCase() !== arozUser.toLowerCase()) {
    throw new Error("set_aroz_password: username does not match JOSHU_AROZ_USER");
  }

  const script = path.join(INSTALL_DIR, "scripts/arozos-reset-password.sh");
  await execFileAsync("bash", [script, arozUser], {
    timeout: 300_000,
    env: {
      ...process.env,
      AO_PW_HASH: passwordHash,
      JOSHU_COMPOSE_DIR: path.dirname(COMPOSE_FILE),
      ENV_FILE: COMPOSE_ENV_FILE,
    },
  });
  console.info(`[instance-agent] set_aroz_password applied for ${arozUser}`);
}

/**
 * Admin desktop login (openspec change admin-desktop-login): ask the Joshu API
 * for a one-time login link of the box owner. The link works one time, within
 * two minutes, and the control plane sends the admin to it.
 */
async function applyDesktopLogin(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const adminEmail = typeof payload.adminEmail === "string" ? payload.adminEmail.trim() : "";
  const res = await fetch(JOSHU_DESKTOP_LOGIN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ adminEmail }),
    signal: AbortSignal.timeout(15_000),
  });
  const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || parsed.ok !== true || typeof parsed.url !== "string") {
    const errMsg = typeof parsed.error === "string" ? parsed.error : `HTTP ${res.status}`;
    throw new Error(`desktop-login failed: ${errMsg}`);
  }
  console.info(`[instance-agent] desktop login link made for ${adminEmail || "unknown admin"}`);
  return { url: parsed.url, expiresAt: parsed.expiresAt };
}

async function applySendOwnerEmail(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const to = typeof payload.to === "string" ? payload.to.trim() : "";
  const subject = typeof payload.subject === "string" ? payload.subject.trim() : "";
  const bodyPlain = typeof payload.bodyPlain === "string" ? payload.bodyPlain.trim() : "";
  if (!to || !subject || !bodyPlain) {
    throw new Error("send_owner_email requires to, subject, and bodyPlain");
  }

  const sendId = typeof payload.sendId === "string" ? payload.sendId.trim() : undefined;
  const flowKey = typeof payload.flowKey === "string" ? payload.flowKey.trim() : undefined;

  const res = await fetch(JOSHU_SEND_OWNER_EMAIL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      to,
      subject,
      body: bodyPlain,
      ...(sendId ? { sendId } : {}),
      ...(flowKey ? { flowKey } : {}),
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await res.text().catch(() => "");
  let parsed: Record<string, unknown> = {};
  try {
    parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    parsed = {};
  }
  if (!res.ok) {
    const errMsg =
      typeof parsed.error === "string" ? parsed.error : text.slice(0, 300) || `HTTP ${res.status}`;
    throw new Error(`send-owner-email failed: ${errMsg}`);
  }

  const messageId = typeof parsed.messageId === "string" ? parsed.messageId : undefined;
  const from = typeof parsed.from === "string" ? parsed.from : undefined;
  // Names only — live values (e.g. the unlock passphrase) stay on the box.
  const placeholders = Array.isArray(parsed.placeholders)
    ? parsed.placeholders.filter((p): p is string => typeof p === "string")
    : undefined;
  console.info(
    `[instance-agent] owner email sent` +
      (from ? ` from=${from}` : "") +
      (placeholders?.length ? ` filled=${placeholders.join(",")}` : "") +
      (messageId ? ` messageId=${messageId}` : ""),
  );
  return {
    ...(messageId ? { messageId } : {}),
    ...(from ? { from } : {}),
    ...(placeholders?.length ? { placeholders } : {}),
  };
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

  if (!rollingBack) {
    await preUpdateSnapshot(payload);
  } else {
    console.info("[instance-agent] skipping pre-update snapshot (rollback)");
  }

  const voiceRtEnabled = await voiceRealtimeS2sEnabled();

  await setUpdateInProgress(true);
  const healthGraceStartedAt = Date.now();
  process.env.JOSHU_UPDATE_IN_PROGRESS = "true";
  try {
    await ensureRegistryLoginForUpdate(payload);
    await assertRegistryAuthForPull();

    // Write release pins before compose pull — pull uses --env-file instance.env.
    // If we pull first, a deleted previous tag (e.g. *-hermes-canary) fails the whole update
    // even when payload.imageRef points at a valid GHCR tag.
    await applyReleaseEnvUpdates(envUpdates);

    const pullServices = UPDATE_RECREATE_SERVICES.length > 0 ? UPDATE_RECREATE_SERVICES : ["joshu-stack"];
    await runCompose(["pull", ...pullServices]);

    if (voiceRtEnabled) {
      await syncVoiceRealtimeForUpdate(payload);
    }

    if (UPDATE_RECREATE_SERVICES.length === 0) {
      throw new Error("JOSHU_UPDATE_SERVICES must include at least one service besides instance-agent");
    }
    await carryOverStackState(UPDATE_RECREATE_SERVICES);
    // Never force-recreate instance-agent here — it SIGKILLs this process before ack.
    await runCompose(["up", "-d", "--force-recreate", ...UPDATE_RECREATE_SERVICES]);
    await finishReleaseUpdate({
      waitForHealthy: () => waitForHealthyAfterUpdate(expectedVersion, healthGraceStartedAt),
      recreateVoice: voiceRtEnabled ? recreateVoiceRealtime : undefined,
      pruneImages: pruneReleaseImages,
    });
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

async function executeCommand(cmd: Command): Promise<Record<string, unknown> | void> {
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
    case "send_owner_email":
      return applySendOwnerEmail(payload);
    case "desktop_login":
      return applyDesktopLogin(payload);
    case "diagnostics":
      // Read-only answers for post-release checks (spec box-diagnostics). Changes nothing on the box.
      return runDiagnostics(
        payload,
        defaultDiagnosticsDeps({
          joshuBaseUrl: new URL(JOSHU_HEALTH_URL).origin,
          instanceEnvFile: COMPOSE_ENV_FILE,
          installDir: INSTALL_DIR,
        }),
      ) as unknown as Promise<Record<string, unknown>>;
    case "set_aroz_password":
      await applySetArozPassword(payload);
      break;
    case "rotate_secrets": {
      const secrets = payload.secrets;
      if (secrets && typeof secrets === "object") {
        const map = secrets as Record<string, string>;
        await updateEnvFile(map);
        // Keep HMAC verifier in sync when CP issues a new per-box signing secret.
        // Without this, subsequent commands signed with the new secret fail until
        // the agent container is manually recreated.
        if (Object.prototype.hasOwnProperty.call(map, "INSTANCE_AGENT_SIGNING_SECRET")) {
          const next = String(map.INSTANCE_AGENT_SIGNING_SECRET ?? "").trim();
          signingSecret = next;
          process.env.INSTANCE_AGENT_SIGNING_SECRET = next;
          console.log(
            `[instance-agent] reloaded INSTANCE_AGENT_SIGNING_SECRET (len=${next.length})`,
          );
        }
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
      await carryOverStackState(["joshu-stack"]);
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
  const snapshotAuthOk = (await resolveSnapshotCredStatus()).ok;
  const fileEnv = await readEnvFileKeys();
  const runtimeDrift = await getRuntimeDrift({
    installDir: INSTALL_DIR,
    releaseVersion: fileEnv.JOSHU_RELEASE_VERSION || env("JOSHU_RELEASE_VERSION"),
  }).catch((err: unknown) => ({
    ok: false,
    checkedAt: new Date().toISOString(),
    items: [],
    scanError: err instanceof Error ? err.message : String(err),
  }));
  const res = await postJson("/api/instances/heartbeat", {
    instanceId: INSTANCE_ID,
    reportedAt: new Date().toISOString(),
    releaseVersion: health.releaseVersion,
    healthy: health.healthy,
    // runtimeDrift is informational, like `failures`: it never gates health.
    components: { ...health.components, runtimeDrift },
    host: {
      uptimeSec: os.uptime(),
      memUsedPct: Math.round((1 - os.freemem() / os.totalmem()) * 100),
      loadAvg: os.loadavg(),
      readyForUpdate: health.readyForUpdate,
      imageRef: env("JOSHU_IMAGE_REF"),
      joshuUptimeSec: health.uptimeSec,
      registryAuthOk,
      snapshotAuthOk,
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
      const result = await executeCommand(cmd);
      await ackCommand(cmd.id, "succeeded", undefined, result ?? undefined);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[instance-agent] command ${cmd.id} failed: ${msg}`);
      await ackCommand(cmd.id, "failed", msg);
    }
  }

  setTimeout(() => void heartbeatLoop(), intervalMs);
}

async function resumePendingUpdate(): Promise<void> {
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

  console.info(
    `[instance-agent] started instance=${INSTANCE_ID} plane=${CONTROL_PLANE_URL} health=${JOSHU_HEALTH_URL}`,
  );

  await startInstanceAgent({
    hasPendingUpdate: async () => {
      const pending = (await readPendingUpdate()) !== null;
      if (pending) console.info("[instance-agent] pending update file found; skipping register");
      return pending;
    },
    register: async () => registerOnce((await fetchJoshuHealth()).releaseVersion),
    resumePendingUpdate,
    removeHelper: () => removeAgentReplaceHelper(agentReplaceDeps, false),
    startHeartbeat: heartbeatLoop,
  });
}

main().catch((err) => {
  console.error("[instance-agent] fatal", err);
  process.exit(1);
});
