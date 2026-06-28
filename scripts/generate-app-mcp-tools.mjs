#!/usr/bin/env node
/**
 * Emit MCP tool stubs from joshu.app.json agent.actions (for Hermes MCP codegen).
 * Usage: node scripts/generate-app-mcp-tools.mjs [projectRoot]
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
const subRoot = path.join(rootDir, "arozos", "subservice");

async function loadManifests() {
  const tools = [];
  let entries;
  try {
    entries = await readdir(subRoot);
  } catch {
    return tools;
  }
  for (const dir of entries) {
    const manifestPath = path.join(subRoot, dir, "joshu.app.json");
    try {
      const raw = JSON.parse(await readFile(manifestPath, "utf8"));
      const actions = raw.agent?.actions ?? [];
      for (const action of actions) {
        if (!action?.name) continue;
        tools.push({
          name: `app_${raw.id}_${action.name}`,
          description: action.description ?? `${raw.name}: ${action.name}`,
          inputSchema: {
            type: "object",
            properties: {
              args: { type: "object", description: "Action arguments" },
            },
          },
          invoke: {
            method: "POST",
            url: `/joshu/api/apps/${raw.id}/invoke`,
            body: { action: action.name, args: "{{args}}" },
          },
        });
      }
    } catch {
      /* skip */
    }
  }
  return tools;
}

const tools = await loadManifests();
console.log(JSON.stringify({ generatedAt: new Date().toISOString(), tools }, null, 2));
