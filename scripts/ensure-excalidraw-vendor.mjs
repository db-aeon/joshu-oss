import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { excalidrawRoot } from "./excalidraw-vite-aliases.mjs";

const marker = path.join(excalidrawRoot, "packages/element/src/markdownText.ts");

if (!fs.existsSync(marker)) {
  console.error(
    "[joshu-excalidraw] vendor/excalidraw is missing or not initialized.\n" +
      "Run: git submodule update --init --recursive vendor/excalidraw",
  );
  process.exit(1);
}

const forkNodeModules = path.join(excalidrawRoot, "node_modules");
if (!fs.existsSync(forkNodeModules)) {
  console.log("[joshu-excalidraw] installing fork dependencies with yarn");
  const yarnCmd = process.platform === "win32" ? "yarn.cmd" : "yarn";
  const result = spawnSync(yarnCmd, ["install", "--frozen-lockfile"], {
    cwd: excalidrawRoot,
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) {
    const corepack = spawnSync("corepack", ["yarn", "install", "--frozen-lockfile"], {
      cwd: excalidrawRoot,
      stdio: "inherit",
      env: process.env,
    });
    if (corepack.status !== 0) {
      console.error("[joshu-excalidraw] failed to install vendor/excalidraw dependencies");
      process.exit(corepack.status ?? 1);
    }
  }
}

console.log("[joshu-excalidraw] using fork at", excalidrawRoot);
