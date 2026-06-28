#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { validateJoshuAppManifest } from "./validateManifest.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0] ?? "validate";
  if (cmd !== "validate") {
    console.error(`Unknown command: ${cmd}\nUsage: joshu-app validate <path/to/joshu.app.json>`);
    process.exit(2);
  }
  const manifestPath = path.resolve(args[1] ?? "joshu.app.json");
  const raw = JSON.parse(await readFile(manifestPath, "utf8"));
  const result = validateJoshuAppManifest(raw);
  if (!result.ok) {
    console.error(`Invalid manifest: ${manifestPath}`);
    for (const err of result.errors) console.error(`  - ${err}`);
    process.exit(1);
  }
  console.log(`OK ${manifestPath} (${result.manifest!.id}@${result.manifest!.version})`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
