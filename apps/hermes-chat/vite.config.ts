import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { defineConfig } from "vite";

const appRoot = fileURLToPath(new URL(".", import.meta.url));
const voiceClientRoot = path.resolve(appRoot, "../../packages/voice-client/src/index.ts");

export default defineConfig({
  base: "./",
  root: appRoot,
  build: {
    outDir: "../../dist/hermes-chat",
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      "@joshu/voice-client": voiceClientRoot,
    },
  },
  plugins: [react()],
});
