/**
 * Keeps Express static UI (`public/design-system/`) in sync with the canonical package.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const srcDir = path.join(root, "packages", "design-system");
const destDir = path.join(root, "public", "design-system");
const files = ["typography.css", "tokens.css", "base.css"];

fs.mkdirSync(destDir, { recursive: true });
for (const name of files) {
  const from = path.join(srcDir, name);
  const to = path.join(destDir, name);
  fs.copyFileSync(from, to);
}
