import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const appRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  base: "./",
  root: appRoot,
  server: {
    proxy: {
      "/joshu": "http://127.0.0.1:8788",
    },
  },
  build: {
    // Must not use dist/connectors — tsc emits API modules there (routes.js, etc.).
    outDir: "../../dist/connectors-app",
    emptyOutDir: true,
  },
  plugins: [react()],
});
