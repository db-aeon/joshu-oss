#!/usr/bin/env node
/**
 * Patch /etc/joshu/instance.env — drops duplicate keys, appends canonical rows.
 * Invoked from the instance-agent container via /opt/joshu mount (fresh after git pull).
 */
import { readFile, writeFile } from "node:fs/promises";

function formatEnvValue(value) {
  if (/[\s#'"\\$`]/.test(value)) {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return value;
}

function parseArgs(argv) {
  let file = "/etc/joshu/instance.env";
  const updates = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--file" && argv[i + 1]) {
      file = argv[++i];
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq <= 0) {
      throw new Error(`invalid arg (expected KEY=value): ${arg}`);
    }
    updates[arg.slice(0, eq)] = arg.slice(eq + 1);
  }
  if (Object.keys(updates).length === 0) {
    throw new Error("usage: patch-instance-env.mjs [--file path] KEY=value ...");
  }
  return { file, updates };
}

async function main() {
  const { file, updates } = parseArgs(process.argv);
  let envText = "";
  try {
    envText = await readFile(file, "utf8");
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

  await writeFile(file, `${nextLines.join("\n").trimEnd()}\n`, { mode: 0o600 });
}

main().catch((err) => {
  console.error(`[patch-instance-env] ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
