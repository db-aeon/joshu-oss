import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { defineConfig } from "vite";

const appRoot = fileURLToPath(new URL(".", import.meta.url));
const voiceClientRoot = path.resolve(appRoot, "../../packages/voice-client/src/index.ts");
const platformDataRoot = path.resolve(appRoot, "../../packages/platform-data/src/index.ts");

export default defineConfig({
  base: "./",
  root: appRoot,
  build: {
    outDir: "../../dist/jmail",
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      "@joshu/voice-client": voiceClientRoot,
      "@joshu/platform-data": platformDataRoot,
    },
  },
  plugins: [react()],
  server: {
    proxy: {
      "/joshu/api": {
        target: "http://127.0.0.1:8788",
        changeOrigin: true,
      },
      "/voice": {
        target: "http://127.0.0.1:8788",
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
