/**
 * Shared Hermes subprocess helpers for STT/TTS (Hermes Chat routes + phone gateway).
 */

import { spawn } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Readable } from "node:stream";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function envOr(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.length > 0 ? value : fallback;
}

const HERMES_BIN = envOr("HERMES_BIN", "/Users/danbenyamin/Documents/dev/hermes-agent/venv/bin/hermes");

export function getHermesAgentRoot(): string {
  const resolved = path.resolve(HERMES_BIN);
  const binDir = path.dirname(resolved);
  const venvRoot = path.dirname(binDir);
  return path.dirname(venvRoot);
}

export function getHermesPythonExecutable(): string {
  const resolved = path.resolve(HERMES_BIN);
  const binDir = path.dirname(resolved);
  const venvRoot = path.dirname(binDir);
  return path.join(venvRoot, "bin", process.platform === "win32" ? "python.exe" : "python3");
}

export function getHermesHomeDir(): string {
  const raw = process.env.HERMES_HOME?.trim();
  return raw && raw.length > 0 ? raw : path.join(homedir(), ".hermes");
}

export function hermesScriptsDir(): string {
  return path.resolve(__dirname, "..", "scripts");
}

export function audioMimeForPath(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".ogg")) return "audio/ogg";
  if (lower.endsWith(".wav")) return "audio/wav";
  return "audio/mpeg";
}

export async function spawnHermesPython(
  scriptName: string,
  args: string[],
  stdinUtf8?: string,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const python = getHermesPythonExecutable();
  const scriptPath = path.join(hermesScriptsDir(), scriptName);
  const hermesRoot = getHermesAgentRoot();
  const hermesHome = getHermesHomeDir();

  return await new Promise((resolve, reject) => {
    const child = spawn(python, [scriptPath, ...args], {
      cwd: hermesRoot,
      env: {
        ...process.env,
        HERMES_AGENT_ROOT: hermesRoot,
        HERMES_HOME: hermesHome,
      },
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code }));

    if (stdinUtf8 !== undefined) {
      child.stdin?.write(stdinUtf8, "utf8");
      child.stdin?.end();
    }
  });
}
