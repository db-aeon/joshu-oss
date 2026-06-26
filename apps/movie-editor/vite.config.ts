import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { defineConfig } from "vite";

const appRoot = fileURLToPath(new URL(".", import.meta.url));
// Vite root is apps/movie-editor; .env lives at repo root (same as Joshu server).
const repoRoot = path.join(appRoot, "../..");

export default defineConfig({
  base: "./",
  root: appRoot,
  envDir: repoRoot,
  resolve: {
    alias: {
      "@": path.join(appRoot, "src"),
    },
  },
  build: {
    outDir: "../../dist/movie-editor",
    emptyOutDir: true,
  },
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 3005,
    proxy: {
      "/joshu/api": {
        target: "http://127.0.0.1:8788",
        changeOrigin: true,
      },
      "/joshu/media": {
        target: "http://127.0.0.1:8788",
        changeOrigin: true,
      },
    },
  },
});
