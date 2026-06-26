import path from "node:path";
import { joshuConfigDir } from "../nylas/paths.js";

export function day0StatePath(projectRoot: string): string | null {
  const dir = joshuConfigDir(projectRoot);
  if (!dir) return null;
  return path.join(dir, "day0.json");
}
