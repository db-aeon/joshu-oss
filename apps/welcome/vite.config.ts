import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { defineConfig } from "vite";

const appRoot = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = path.resolve(appRoot, "../..");

export default defineConfig({
  base: "./",
  root: appRoot,
  resolve: {
    alias: {
      "@joshu/onboarding": path.join(repoRoot, "src/onboarding"),
    },
  },
  build: {
    outDir: "../../dist/welcome",
    emptyOutDir: true,
  },
  plugins: [react()],
  server: {
    proxy: {
      "/joshu/api": {
        target: "http://127.0.0.1:8788",
        changeOrigin: true,
      },
    },
  },
});
