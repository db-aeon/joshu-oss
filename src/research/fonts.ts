/**
 * The report fonts (Newsreader for text, Work Sans for labels, Silkscreen for small caps labels), embedded in each HTML page as
 * base64 `@font-face`, so the HTML page and the PDF need no internet connection.
 * Design decision D4 of change research-reports. All three fonts use the SIL Open Font License.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type FontFace = {
  family: string;
  file: string;
  /** A number, or a range for a variable font ("300 700"). */
  weight: string;
  style: "normal" | "italic";
  /** Folder under node_modules. */
  pkg: string;
};

/** The fonts of the report design: Newsreader (variable, with optical sizes), Work Sans, and Silkscreen for small labels. */
const FACES: FontFace[] = [
  { family: "Newsreader", file: "newsreader-latin-opsz-normal.woff2", weight: "200 800", style: "normal", pkg: "@fontsource-variable/newsreader" },
  { family: "Newsreader", file: "newsreader-latin-opsz-italic.woff2", weight: "200 800", style: "italic", pkg: "@fontsource-variable/newsreader" },
  { family: "Work Sans", file: "work-sans-latin-400-normal.woff2", weight: "400", style: "normal", pkg: "@fontsource/work-sans" },
  { family: "Work Sans", file: "work-sans-latin-500-normal.woff2", weight: "500", style: "normal", pkg: "@fontsource/work-sans" },
  { family: "Work Sans", file: "work-sans-latin-600-normal.woff2", weight: "600", style: "normal", pkg: "@fontsource/work-sans" },
  { family: "Silkscreen", file: "silkscreen-latin-400-normal.woff2", weight: "400", style: "normal", pkg: "@fontsource/silkscreen" },
];

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

/** `dist/research/fonts/` on a box (runtime assets); the npm package when run from source. */
function fontPath(face: FontFace): string {
  const built = path.join(moduleDir, "fonts", face.file);
  if (fs.existsSync(built)) return built;
  return path.resolve(moduleDir, "..", "..", "node_modules", face.pkg, "files", face.file);
}

let cachedCss: string | null = null;

/** The `@font-face` rules with the font files as base64 data. Throws when a font file is missing. */
export function embeddedFontCss(): string {
  if (cachedCss) return cachedCss;
  cachedCss = FACES.map((face) => {
    const data = fs.readFileSync(fontPath(face)).toString("base64");
    return `@font-face{font-family:"${face.family}";font-style:${face.style};font-weight:${face.weight};font-display:block;src:url(data:font/woff2;base64,${data}) format("woff2");}`;
  }).join("\n");
  return cachedCss;
}
