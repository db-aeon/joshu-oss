/**
 * Read Welcome box-secrets from the shared ArozOS user volume (VPS + local dev).
 * voice-realtime runs in a separate container without vps-start.sh env injection.
 */
import fs from "node:fs";
import path from "node:path";

const BOX_SECRET_KEYS = ["GEMINI_API_KEY", "OPENROUTER_API_KEY", "HINDSIGHT_API_LLM_API_KEY"] as const;

function arozUsersRoot(): string {
  const base = process.env.AROZ_DATA?.trim() || "/var/lib/arozos";
  return path.join(base, "files", "users");
}

/** First non-empty value for `name` across Aroz user box-secrets files. */
export function readBoxSecret(name: (typeof BOX_SECRET_KEYS)[number]): string {
  const usersRoot = arozUsersRoot();
  if (!fs.existsSync(usersRoot)) return "";
  let found = "";
  for (const ent of fs.readdirSync(usersRoot, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const json = path.join(usersRoot, ent.name, ".joshu", "box-secrets", "local-env.json");
    if (!fs.existsSync(json)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(json, "utf8")) as Record<string, unknown>;
      const val = typeof data[name] === "string" ? data[name].trim() : "";
      if (val) {
        found = val;
        break;
      }
    } catch {
      // ignore corrupt file
    }
  }
  return found;
}
