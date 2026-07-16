#!/usr/bin/env node
/**
 * Regression: companion identity sync must not wipe portrait/owner when env lacks those keys.
 * Usage: node scripts/check-companion-identity-sync.mjs (needs dist/)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { syncCompanionIdentityFromEnv } = await import(
  pathToFileURL(path.join(rootDir, "dist/companionIdentitySync.js")).href
);
const { writeJoshuIdentity, readJoshuIdentity } = await import(
  pathToFileURL(path.join(rootDir, "dist/joshuIdentity.js")).href
);

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "joshu-id-sync-"));
const joshuDir = path.join(tmp, "files", "users", "owner@example.com", ".joshu");
fs.mkdirSync(joshuDir, { recursive: true });
process.env.JOSHU_AROZ_USER = "owner@example.com";
process.env.AROZ_DATA = tmp;
// Point resolve paths — joshuConfigDir uses AROZ_DATA + user
delete process.env.JOSHU_IMAGE_URL;
delete process.env.JOSHU_AVATAR_URL;
delete process.env.JOSHU_VOICE_ID;
delete process.env.JOSHU_OWNER_NAME;
process.env.JOSHU_NAME = "Patrick";
process.env.JOSHU_OWNER_EMAIL = "owner@example.com";

// Seed a good identity as if previously synced
writeJoshuIdentity(
  {
    name: "Patrick",
    imageUrl: "https://example.com/portrait.jpg",
    avatarUrl: "https://example.com/avatar.jpg",
    voiceId: "Sadachbia",
    owner: { displayName: "Dan Benyamin", email: "owner@example.com" },
    source: "control-plane",
  },
  tmp,
);

syncCompanionIdentityFromEnv(tmp, { forceSoul: false });
const after = readJoshuIdentity(tmp);
assert(after?.imageUrl === "https://example.com/portrait.jpg", "portrait preserved when env lacks JOSHU_IMAGE_URL");
assert(after?.avatarUrl === "https://example.com/avatar.jpg", "avatar preserved");
assert(after?.owner.displayName === "Dan Benyamin", "owner displayName preserved when only email in env");
assert(after?.name === "Patrick", "name still Patrick");

// Explicit env update still applies
process.env.JOSHU_OWNER_NAME = "Dan";
process.env.JOSHU_IMAGE_URL = "https://example.com/new-portrait.jpg";
syncCompanionIdentityFromEnv(tmp, { forceSoul: false });
const updated = readJoshuIdentity(tmp);
assert(updated?.owner.displayName === "Dan", "owner updated when env set");
assert(updated?.imageUrl === "https://example.com/new-portrait.jpg", "image updated when env set");

console.log("ok: companion identity sync preserves missing-env fields");
