import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { defineConfig } from "vite";
import svgr from "vite-plugin-svgr";
import { excalidrawRoot, excalidrawViteAliases, repoRoot } from "../../scripts/excalidraw-vite-aliases.mjs";

const appRoot = fileURLToPath(new URL(".", import.meta.url));
const forkNodeModules = path.join(excalidrawRoot, "node_modules");

export default defineConfig({
  base: "./",
  root: appRoot,
  build: {
    outDir: "../../dist/excalidraw",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("@excalidraw/mermaid-to-excalidraw")) {
            return "mermaid-to-excalidraw";
          }
          if (id.includes("@codemirror/") || id.includes("@lezer/")) {
            return "codemirror.chunk";
          }
        },
      },
    },
  },
  resolve: {
    alias: excalidrawViteAliases(),
    dedupe: ["react", "react-dom"],
    modules: [forkNodeModules, path.join(repoRoot, "node_modules"), "node_modules"],
  },
  css: {
    preprocessorOptions: {
      scss: {
        api: "modern-compiler",
      },
    },
  },
  plugins: [
    react(),
    svgr({
      svgrOptions: {
        ref: true,
        titleProp: true,
      },
      include: [
        path.resolve(appRoot, "../../vendor/excalidraw/**/*.svg"),
        path.resolve(appRoot, "../../node_modules/@excalidraw/**/*.svg"),
      ],
    }),
  ],
});
