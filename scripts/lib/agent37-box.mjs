// A box in single-container mode on an Agent37 sandbox (change single-container-mode): the
// client of the Agent37 API, and the release update of such a box. The instance agent cannot
// pull an image on a host with no Docker, so a release update is a rebuild of the sandbox
// from the new image. The data root (/data) stays.
//
// Used by scripts/deploy-release.mjs (the canary box) and by the migration script of the
// fleet. A self-hoster with a box on Agent37 can use updateSandboxBox too.
//
// Credentials (environment variable, or else the file):
//   AGENT37_API_KEY                   ~/.config/agent37/key
//   GHCR_READ_USER, GHCR_READ_TOKEN   ~/.config/agent37/ghcr-read-user, ghcr-read-token
//     A registry user and a token that can pull the image. Agent37 does not store them,
//     so each change of the image of a template sends them again.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const A37_API = "https://api.agent37.com";
export const A37_SANDBOX = "https://sandbox.agent37.app";
/** Persistent disk of the sandbox. The start script reads it as JOSHU_DATA_ROOT. */
export const DATA_ROOT = "/data";
/** Template of a running box, and the start script that the image runs. */
export const BOX_TEMPLATE = "joshu-box";
export const BOX_ENTRYPOINT = ["bash", "/opt/joshu/.image/scripts/vps-start.sh"];

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function readFirstLine(path) {
  return existsSync(path) ? readFileSync(path, "utf8").split("\n")[0].trim() || null : null;
}

/** A credential from the environment, or else from a file in ~/.config/agent37/. */
export function agent37Secret(name, file) {
  const value = process.env[name] || readFirstLine(join(homedir(), ".config", "agent37", file));
  if (!value) throw new Error(`credential ${name} is missing (environment variable, or ~/.config/agent37/${file})`);
  return value;
}

export function registryAuth() {
  return { username: agent37Secret("GHCR_READ_USER", "ghcr-read-user"), password: agent37Secret("GHCR_READ_TOKEN", "ghcr-read-token") };
}

export async function http(url, { method = "GET", headers = {}, body, timeoutMs = 60_000 } = {}) {
  const response = await fetch(url, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 300) };
  }
  return { status: response.status, ok: response.ok, json };
}

export async function a37(method, path, body, { allow = [] } = {}) {
  const res = await http(`${A37_API}${path}`, {
    method,
    body,
    headers: { authorization: `Bearer ${agent37Secret("AGENT37_API_KEY", "key")}` },
    timeoutMs: 15 * 60_000,
  });
  if (!res.ok && !allow.includes(res.status)) {
    const error = res.json.error?.code ?? res.json.error ?? res.json.raw ?? "";
    throw new Error(`Agent37 ${method} ${path} answered HTTP ${res.status}: ${JSON.stringify(error)}`);
  }
  return res;
}

/** Runs a command as root on the sandbox. The command text is never printed: it can hold a secret. */
export async function sandboxExec(id, command, { background = false, what = "command" } = {}) {
  const res = await http(`${A37_SANDBOX}/v1/instances/${id}/exec`, {
    method: "POST",
    body: { command, user: "root", ...(background ? { background: true } : {}) },
    headers: { "x-agent37-key": agent37Secret("AGENT37_API_KEY", "key") },
    timeoutMs: 16 * 60_000,
  });
  if (!res.ok) throw new Error(`sandbox exec (${what}) answered HTTP ${res.status}: ${JSON.stringify(res.json.error ?? res.json.raw ?? "")}`);
  return res.json;
}

export async function sandboxRun(id, command, what) {
  const out = await sandboxExec(id, command, { what });
  if (out.exit_code !== 0) throw new Error(`sandbox ${what} failed with exit ${out.exit_code}: ${String(out.stderr).trim().slice(-400)}`);
  return String(out.stdout);
}

export async function waitFor(what, check, { timeoutSec, everySec = 10 }) {
  const deadline = Date.now() + timeoutSec * 1000;
  for (;;) {
    let result = null;
    try {
      result = await check();
    } catch {
      result = null; // The exec API refuses while the sandbox restarts.
    }
    if (result) return result;
    if (Date.now() > deadline) throw new Error(`${what}: not true after ${timeoutSec} seconds`);
    await sleep(everySec * 1000);
  }
}

/** Points a template at an image. Returns the revision that holds that image, or null in a dry run that would change it. */
export async function ensureTemplate(name, imageRef, entrypoint, apply) {
  const found = await a37("GET", `/v1/templates/${name}`, undefined, { allow: [404] });
  if (found.status === 404) {
    if (!apply) return null;
    const made = await a37("POST", "/v1/templates", {
      name,
      image_ref: imageRef,
      registry_auth: registryAuth(),
      default_port: 8080,
      entrypoint,
      description: "Joshu box in single-container mode",
    });
    return made.json.revision ?? 1;
  }
  if (found.json.image_ref === imageRef && JSON.stringify(found.json.entrypoint) === JSON.stringify(entrypoint)) {
    return found.json.revision;
  }
  if (!apply) return null;
  const patched = await a37("PATCH", `/v1/templates/${name}`, { image_ref: imageRef, entrypoint, registry_auth: registryAuth() });
  return patched.json.revision;
}

/** The sandbox of a box: the instance whose name is the slug of the box. */
export async function findSandbox(slug) {
  const instances = (await a37("GET", "/v1/instances")).json.data ?? [];
  const matches = instances.filter((instance) => instance.name === slug);
  if (matches.length !== 1) throw new Error(`expected one Agent37 sandbox named '${slug}', found ${matches.length}`);
  return matches[0];
}

/** `repository:old` and a version → `repository:version`. */
export function imageRefForVersion(currentImageRef, version) {
  const colon = currentImageRef.lastIndexOf(":");
  if (colon < 0 || currentImageRef.slice(colon).includes("/")) throw new Error(`'${currentImageRef}' has no image tag`);
  if (!/^\d+\.\d+\.\d+(-[a-z0-9.]+)?$/.test(version)) throw new Error(`'${version}' is not a version`);
  return `${currentImageRef.slice(0, colon)}:${version}`;
}

/** The release of a version or test tag: 0.1.66 → 0.1.66, and 0.1.65-sc3 → 0.1.65. */
export function releaseOfVersion(version) {
  return version.replace(/-.*$/, "");
}

/**
 * Shell command that sets the release pins of instance.env on the sandbox. The pins must name
 * the image that runs: with the old JOSHU_RELEASE_VERSION the health check reports "drift".
 */
export function releasePinsCommand(imageRef, release) {
  if (!/^[A-Za-z0-9._\/:-]+$/.test(imageRef) || !/^\d+\.\d+\.\d+$/.test(release)) throw new Error("releasePinsCommand: bad image or release");
  return `sed -i -e 's|^JOSHU_IMAGE_REF=.*|JOSHU_IMAGE_REF=${imageRef}|' -e 's|^JOSHU_RELEASE_VERSION=.*|JOSHU_RELEASE_VERSION=${release}|' ${DATA_ROOT}/secrets/instance.env`;
}

async function sandboxHealth(id) {
  const out = await sandboxRun(id, "curl -fsS -m 20 http://127.0.0.1:8788/joshu/api/instance/health 2>/dev/null || echo '{}'", "health");
  return JSON.parse(out.trim().split("\n").pop());
}

/**
 * Release update of a box on an Agent37 sandbox: write the release pins, point the box template
 * at the new image, and rebuild the sandbox. Waits until the box is healthy on the release.
 * Returns { instanceId, imageRef, release, revision }.
 */
export async function updateSandboxBox({ slug, version, dryRun = false, log = () => {} }) {
  const sandbox = await findSandbox(slug);
  const imageRef = imageRefForVersion(sandbox.image_ref, version);
  const release = releaseOfVersion(version);
  log(`${slug}: sandbox ${sandbox.id} runs ${sandbox.image_ref}; the update is a rebuild from ${imageRef}. ${DATA_ROOT} stays`);
  if (sandbox.status !== "running") throw new Error(`sandbox ${sandbox.id} has status ${sandbox.status}, not running`);
  if (dryRun) {
    log(`dry run: write the release pins, point template ${BOX_TEMPLATE} at ${imageRef}, POST /v1/instances/${sandbox.id}/update`);
    return { instanceId: sandbox.id, imageRef, release, revision: null };
  }
  // A rebuild gives the container a new root disk, so a marker outside the data root is gone
  // when the new container runs. (The start time of process 1 is always 0 on the sandbox.)
  const marker = "/tmp/.joshu-pre-update";
  await sandboxRun(sandbox.id, `touch ${marker} && ${releasePinsCommand(imageRef, release)}`, "release pins");
  const revision = await ensureTemplate(BOX_TEMPLATE, imageRef, BOX_ENTRYPOINT, true);
  await a37("POST", `/v1/instances/${sandbox.id}/update`, { template: `${BOX_TEMPLATE}@${revision}` });
  await waitFor("the new container", async () => (await sandboxExec(sandbox.id, `test ! -e ${marker}`, { what: "update marker" })).exit_code === 0, {
    timeoutSec: 900,
  });
  log(`${slug}: the new container runs; waiting for health on ${release}`);
  await waitFor(
    `release ${release} healthy`,
    async () => {
      const health = await sandboxHealth(sandbox.id);
      return health.healthy === true && health.releaseVersion === release;
    },
    { timeoutSec: 1500, everySec: 15 },
  );
  return { instanceId: sandbox.id, imageRef, release, revision };
}
