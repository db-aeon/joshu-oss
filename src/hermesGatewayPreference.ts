import fs from "node:fs";
import path from "node:path";
import { joshuConfigDir } from "./nylas/paths.js";

export interface HermesGatewayPreference {
  enabled: boolean;
  updatedAt: string;
}

const PREFERENCE_FILENAME = "gateway-auto-start.json";

export function hermesGatewayPreferencePath(projectRoot = process.cwd()): string | null {
  const dir = joshuConfigDir(projectRoot);
  if (!dir) return null;
  return path.join(dir, PREFERENCE_FILENAME);
}

/** User preference overrides HERMES_API_AUTO_START when the file exists. */
export function readHermesGatewayPreference(projectRoot = process.cwd()): boolean | null {
  const filePath = hermesGatewayPreferencePath(projectRoot);
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as HermesGatewayPreference;
    return typeof raw.enabled === "boolean" ? raw.enabled : null;
  } catch {
    return null;
  }
}

export function writeHermesGatewayPreference(projectRoot: string, enabled: boolean): void {
  const filePath = hermesGatewayPreferencePath(projectRoot);
  if (!filePath) {
    throw new Error("Joshu config directory unavailable");
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const payload: HermesGatewayPreference = {
    enabled,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}
