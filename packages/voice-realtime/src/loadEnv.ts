/**
 * Load repo-root .env when the workspace package runs from packages/voice-realtime.
 * npm `-w` does not put dotenv/config on the monorepo root automatically.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const pkgSrcDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(pkgSrcDir, "../../..");
const hermesHome = process.env.HERMES_HOME?.trim() || path.join(process.env.HOME || "", ".hermes");

const files = [
  path.join(repoRoot, ".env"),
  path.join(repoRoot, ".env.twilio.local"),
  path.join(hermesHome, ".env"),
];

for (const file of files) {
  if (existsSync(file)) {
    loadDotenv({ path: file, override: true, quiet: true });
  }
}
