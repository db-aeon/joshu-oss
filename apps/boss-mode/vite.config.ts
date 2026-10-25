import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

import { bossModeFixture } from "./fixtureApi";

const appRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  base: "./",
  root: appRoot,
  resolve: {
    alias: {
      "@joshu/app-agent": path.resolve(appRoot, "../../packages/app-agent/src"),
    },
  },
  server: {
    proxy: {
      "/joshu": "http://127.0.0.1:8788",
    },
  },
  build: {
    outDir: "../../dist/boss-mode",
    emptyOutDir: true,
  },
  // BOSS_MODE_FIXTURE=<JSON file>: serve the app from a fixture instead of a box (local work only).
  plugins: [react(), ...(process.env.BOSS_MODE_FIXTURE ? [bossModeFixture(path.resolve(process.env.BOSS_MODE_FIXTURE))] : [])],
});
