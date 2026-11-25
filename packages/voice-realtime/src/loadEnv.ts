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

// In single-container mode (change single-container-mode) the voice service runs inside the
// stack container, where ~/.hermes/.env exists. The voice container of a Compose host has no
// such file, so the start script sets VOICE_REALTIME_SKIP_HERMES_ENV=1 to keep the same values.
const skipHermesEnv = process.env.VOICE_REALTIME_SKIP_HERMES_ENV?.trim() === "1";

const files = [
  path.join(repoRoot, ".env"),
  path.join(repoRoot, ".env.twilio.local"),
  ...(skipHermesEnv ? [] : [path.join(hermesHome, ".env")]),
];

for (const file of files) {
  if (existsSync(file)) {
    loadDotenv({ path: file, override: true, quiet: true });
  }
}
