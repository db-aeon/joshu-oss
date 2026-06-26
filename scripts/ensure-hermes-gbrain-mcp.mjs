#!/usr/bin/env node
/**
 * Merge gbrain MCP + mcp-gbrain toolset into ~/.hermes/config.yaml (VPS images before 0.1.7).
 * Mirrors src/hermesApi.ts ensureJoshuHermesConfig() gbrain block.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

function env(name, fallback = "") {
  return process.env[name]?.trim() || fallback;
}

function resolveFilesPaths() {
  const arozData = path.resolve(env("AROZ_DATA", "/var/lib/arozos"));
  const joshuFilesDirName = env("JOSHU_FILES_DIR_NAME", "joshu's files");
  const usersRoot = path.join(arozData, "files", "users");
  if (!fs.existsSync(usersRoot)) return null;

  const overrideUser = env("JOSHU_AROZ_USER");
  const arozDataResolved = path.resolve(arozData);
  if (arozDataResolved === "/var/lib/arozos" && !overrideUser) {
    return null;
  }
  let userDirs = overrideUser
    ? [overrideUser]
    : fs
        .readdirSync(usersRoot, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .filter((name) => name !== "admin")
        .sort();
  if (userDirs.length === 0 && !overrideUser) {
    userDirs = fs
      .readdirSync(usersRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  }

  for (const user of userDirs) {
    const desktopRoot = path.join(usersRoot, user, "Desktop");
    if (!fs.existsSync(desktopRoot)) continue;
    const filesRoot = path.join(desktopRoot, joshuFilesDirName);
    return {
      arozData,
      desktopRoot: path.resolve(desktopRoot),
      filesRoot: path.resolve(filesRoot),
      arozUser: user,
      gbrainSource: "default",
      joshuFilesDirName,
    };
  }
  return null;
}

function parseToolsets(value) {
  if (Array.isArray(value)) return value.filter((x) => typeof x === "string");
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.filter((x) => typeof x === "string");
    } catch {
      return [value.trim()];
    }
  }
  return [];
}

/** Gateway subprocesses often lack ~/.bun/bin on PATH; always persist an absolute path. */
function resolveGbrainBin() {
  const home = process.env.HOME || "/root";
  const bunDefault = path.join(home, ".bun", "bin", "gbrain");
  const fromEnv = env("GBRAIN_BIN");
  if (fromEnv) {
    if (path.isAbsolute(fromEnv) && fs.existsSync(fromEnv)) return fromEnv;
    if (fs.existsSync(bunDefault)) return bunDefault;
  }
  if (fs.existsSync(bunDefault)) return bunDefault;
  return fromEnv || "gbrain";
}

function resolveWorkspaceScope(filesPaths) {
  if (!filesPaths) return null;
  return {
    terminalCwd: env("JOSHU_HERMES_TERMINAL_CWD") || filesPaths.desktopRoot,
    writeSafeRoot: env("JOSHU_HERMES_WRITE_SAFE_ROOT") || filesPaths.desktopRoot,
  };
}

function formatDotenvValue(value) {
  if (/^[A-Za-z0-9_./:@+-]+$/.test(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Merge keys into ~/.hermes/.env (same shape as src/hermesApi.ts syncHermesDotenv). */
function syncHermesDotenv(hermesHome, entries) {
  const envPath = path.join(hermesHome, ".env");
  let lines = [];
  try {
    lines = fs.readFileSync(envPath, "utf8").split("\n");
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }

  let changed = false;
  for (const [key, value] of Object.entries(entries)) {
    if (!String(value).trim()) continue;
    const next = `${key}=${formatDotenvValue(String(value))}`;
    const idx = lines.findIndex((line) => line === next || line.startsWith(`${key}=`));
    if (idx >= 0) {
      if (lines[idx] !== next) {
        lines[idx] = next;
        changed = true;
      }
    } else {
      lines.push(next);
      changed = true;
    }
  }

  if (!changed) return;
  fs.mkdirSync(hermesHome, { recursive: true });
  fs.writeFileSync(envPath, `${lines.join("\n").replace(/\n*$/, "\n")}`, { mode: 0o600 });
  console.log(`[ensure-hermes-gbrain-mcp] synced Hermes env in ${envPath}`);
}

function main() {
  const hermesHome = env("HERMES_HOME", path.join(process.env.HOME || "/root", ".hermes"));
  const configPath = path.join(hermesHome, "config.yaml");
  let config = {};
  try {
    config = YAML.parse(fs.readFileSync(configPath, "utf8")) || {};
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }

  let changed = false;

  let toolsets = parseToolsets(config.toolsets);
  if (toolsets.length === 0) toolsets = ["hermes-cli", "browser"];
  if (!toolsets.includes("mcp-gbrain")) {
    toolsets.push("mcp-gbrain");
    changed = true;
  }
  // Image 0.1.6 dist/hermesApi.js stores toolsets as a JSON string and resets on !== env default.
  const toolsetsJson = JSON.stringify(toolsets);
  if (
    config.toolsets !== toolsetsJson &&
    JSON.stringify(parseToolsets(config.toolsets)) !== JSON.stringify(toolsets)
  ) {
    config.toolsets = toolsetsJson;
    changed = true;
  }

  const filesPaths = resolveFilesPaths();
  const workspaceScope = resolveWorkspaceScope(filesPaths);

  const gbrainMcpUrl = `${env("GBRAIN_MCP_HTTP_URL", "http://127.0.0.1:8794").replace(/\/+$/, "")}/mcp`;

  const desired = {
    url: gbrainMcpUrl,
    connect_timeout: 120,
    enabled: true,
  };

  config.mcp_servers = config.mcp_servers || {};
  const current = config.mcp_servers.gbrain || {};
  if (
    current.url !== desired.url ||
    typeof current.command === "string" ||
    current.connect_timeout !== desired.connect_timeout ||
    current.enabled !== true
  ) {
    config.mcp_servers.gbrain = desired;
    changed = true;
  }

  const skills = config.skills || {};
  const external = Array.isArray(skills.external_dirs) ? skills.external_dirs : [];
  const skillDir = path.join(repoRoot, "integrations", "hermes", "skills");
  if (!external.includes(skillDir)) {
    external.push(skillDir);
    skills.external_dirs = external;
    config.skills = skills;
    changed = true;
  }

  if (workspaceScope) {
    config.terminal = config.terminal || {};
    if (config.terminal.cwd !== workspaceScope.terminalCwd) {
      config.terminal.cwd = workspaceScope.terminalCwd;
      changed = true;
    }
  }

  if (changed) {
    fs.mkdirSync(hermesHome, { recursive: true });
    fs.writeFileSync(configPath, YAML.stringify(config), "utf8");
    console.log(`[ensure-hermes-gbrain-mcp] updated ${configPath}`);
  } else {
    console.log(`[ensure-hermes-gbrain-mcp] already configured ${configPath}`);
  }

  if (filesPaths && workspaceScope) {
    syncHermesDotenv(hermesHome, {
      AROZ_DATA: filesPaths.arozData,
      JOSHU_AROZ_USER: filesPaths.arozUser,
      JOSHU_DESKTOP_ROOT: filesPaths.desktopRoot,
      JOSHU_FILES_ROOT: filesPaths.filesRoot,
      GBRAIN_SOURCE: filesPaths.gbrainSource,
      JOSHU_FILES_DIR_NAME: filesPaths.joshuFilesDirName,
      JOSHU_REPO_ROOT: repoRoot,
      HERMES_WRITE_SAFE_ROOT: workspaceScope.writeSafeRoot,
    });
    console.log(
      `[ensure-hermes-gbrain-mcp] Hermes workspace: terminal.cwd=${workspaceScope.terminalCwd}, ` +
        `HERMES_WRITE_SAFE_ROOT=${workspaceScope.writeSafeRoot}`,
    );
  }
}

main();
