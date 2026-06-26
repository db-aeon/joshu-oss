import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptsDir, "..");
const excalidrawRoot = path.resolve(repoRoot, "vendor/excalidraw");

/** Vite resolve aliases for compiling the forked Excalidraw monorepo from source. */
export function excalidrawViteAliases() {
  return [
    {
      find: /^@excalidraw\/common$/,
      replacement: path.resolve(excalidrawRoot, "packages/common/src/index.ts"),
    },
    {
      find: /^@excalidraw\/common\/(.*?)/,
      replacement: path.resolve(excalidrawRoot, "packages/common/src/$1"),
    },
    {
      find: /^@excalidraw\/element$/,
      replacement: path.resolve(excalidrawRoot, "packages/element/src/index.ts"),
    },
    {
      find: /^@excalidraw\/element\/(.*?)/,
      replacement: path.resolve(excalidrawRoot, "packages/element/src/$1"),
    },
    {
      find: /^@excalidraw\/excalidraw$/,
      replacement: path.resolve(excalidrawRoot, "packages/excalidraw/index.tsx"),
    },
    {
      find: /^@excalidraw\/excalidraw\/(.*?)/,
      replacement: path.resolve(excalidrawRoot, "packages/excalidraw/$1"),
    },
    {
      find: /^@excalidraw\/math$/,
      replacement: path.resolve(excalidrawRoot, "packages/math/src/index.ts"),
    },
    {
      find: /^@excalidraw\/math\/(.*?)/,
      replacement: path.resolve(excalidrawRoot, "packages/math/src/$1"),
    },
    {
      find: /^@excalidraw\/utils$/,
      replacement: path.resolve(excalidrawRoot, "packages/utils/src/index.ts"),
    },
    {
      find: /^@excalidraw\/utils\/(.*?)/,
      replacement: path.resolve(excalidrawRoot, "packages/utils/src/$1"),
    },
    {
      find: /^@excalidraw\/fractional-indexing$/,
      replacement: path.resolve(
        excalidrawRoot,
        "packages/fractional-indexing/src/index.ts",
      ),
    },
  ];
}

export { excalidrawRoot, repoRoot };
