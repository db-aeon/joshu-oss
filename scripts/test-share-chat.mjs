#!/usr/bin/env npx tsx
/**
 * Scope + safety unit checks for share-chat (no live gbrain/Slack required).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHmac } from "node:crypto";

import {
  buildSlugPrefixes,
  isPathInsideShare,
  isSlugInsideShare,
  listShareOptionsFromAoDb,
  resolveShareScope,
} from "../src/shareChat/shareScope.ts";
import { sanitizeAnswerText } from "../src/shareChat/answer.ts";
import { checkShareChatRateLimit, resetShareChatRateLimits } from "../src/shareChat/rateLimit.ts";
import { verifySlackRequestSignature } from "../src/shareChat/slackEvents.ts";
import { isSlackSenderAllowed, upsertShareSlackBot, getShareSlackBot, deleteShareSlackBot } from "../src/shareChat/slackRegistry.ts";
import {
  isShareChatEnabled,
  setShareChatEnabled,
  getShareChatFlag,
  clearShareChatFlag,
} from "../src/shareChat/chatFlags.ts";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function makeScope(partial) {
  const scope = {
    uuid: "00000000-0000-4000-8000-000000000001",
    owner: "alice",
    permission: "anyone",
    isFolder: true,
    fileVirtualPath: "user:/Desktop/joshu's files/Projects/demo",
    fileRealPath: "/tmp/share-root/demo",
    displayName: "demo",
    allowedRealRoot: "/tmp/share-root/demo",
    slugPrefixes: buildSlugPrefixes(
      "user:/Desktop/joshu's files/Projects/demo",
      "/tmp/share-root/demo",
    ),
    valid: true,
    ...partial,
  };
  return scope;
}

// --- slug / path scoping ---
{
  const folder = makeScope({ isFolder: true });
  assert(isSlugInsideShare("joshus-files/projects/demo/notes", folder), "folder slug under share");
  assert(!isSlugInsideShare("joshus-files/projects/other/secret", folder), "unrelated folder slug refused");
  assert(isPathInsideShare("/tmp/share-root/demo/a.md", folder), "path under folder");
  assert(!isPathInsideShare("/tmp/share-root/other/a.md", folder), "path outside folder");

  const file = makeScope({
    isFolder: false,
    fileRealPath: "/tmp/share-root/demo/only.md",
    allowedRealRoot: "/tmp/share-root/demo/only.md",
    displayName: "only.md",
    fileVirtualPath: "user:/Desktop/joshu's files/Projects/demo/only.md",
    slugPrefixes: buildSlugPrefixes(
      "user:/Desktop/joshu's files/Projects/demo/only.md",
      "/tmp/share-root/demo/only.md",
    ),
  });
  assert(isSlugInsideShare("joshus-files/projects/demo/only", file), "file share slug");
  assert(!isSlugInsideShare("joshus-files/projects/demo/other", file), "sibling file refused for file share");

  // gbrain turns spaces into hyphens and strips .md — must still match.
  const notebook = makeScope({
    isFolder: false,
    fileRealPath: "/tmp/share-root/HUA Team Notebook.md",
    allowedRealRoot: "/tmp/share-root/HUA Team Notebook.md",
    displayName: "HUA Team Notebook.md",
    fileVirtualPath: "user:/Desktop/joshu's files/HUA Team Notebook.md",
    slugPrefixes: buildSlugPrefixes(
      "user:/Desktop/joshu's files/HUA Team Notebook.md",
      "/tmp/share-root/HUA Team Notebook.md",
    ),
  });
  assert(
    isSlugInsideShare("joshus-files/hua-team-notebook", notebook),
    "hyphenated gbrain slug matches spaced filename",
  );
}

// --- answer sanitization ---
{
  const scope = makeScope({
    fileRealPath: "/var/lib/arozos/files/users/alice/Desktop/joshu's files/Projects/demo",
    allowedRealRoot: "/var/lib/arozos/files/users/alice/Desktop/joshu's files/Projects/demo",
    owner: "alice",
  });
  const cleaned = sanitizeAnswerText(
    "See /var/lib/arozos/files/users/alice/Desktop/secret and owner alice",
    scope,
  );
  assert(!cleaned.includes("/var/lib/arozos/files/users/alice"), "redacts aroz user path");
  assert(!/\balice\b/.test(cleaned), "redacts owner name");
}

// --- rate limit ---
{
  resetShareChatRateLimits();
  let last;
  for (let i = 0; i < 30; i++) {
    last = checkShareChatRateLimit("test:key", { limit: 30, windowMs: 60_000 });
    assert(last.allowed, `request ${i + 1} allowed`);
  }
  last = checkShareChatRateLimit("test:key", { limit: 30, windowMs: 60_000 });
  assert(!last.allowed, "31st request blocked");
}

// --- Slack signature ---
{
  const secret = "test-signing-secret";
  const timestamp = String(Math.floor(Date.now() / 1000));
  const rawBody = '{"type":"event_callback"}';
  const sig =
    "v0=" + createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`).digest("hex");
  assert(
    verifySlackRequestSignature({
      signingSecret: secret,
      timestamp,
      rawBody,
      signature: sig,
    }),
    "valid slack signature",
  );
  assert(
    !verifySlackRequestSignature({
      signingSecret: secret,
      timestamp,
      rawBody,
      signature: "v0=deadbeef",
    }),
    "invalid slack signature rejected",
  );
}

// --- Slack allowlists / isolation ---
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "joshu-share-chat-"));
  // Force registry under temp by stubbing via projectRoot that has no aroz user → .local/share-chat
  const projectRoot = tmp;
  fs.mkdirSync(path.join(projectRoot, ".local"), { recursive: true });

  const shareA = "11111111-1111-4111-8111-111111111111";
  const shareB = "22222222-2222-4222-8222-222222222222";
  upsertShareSlackBot(
    {
      shareUuid: shareA,
      botToken: "xoxb-a",
      signingSecret: "sec-a",
      allowedUserIds: ["U1"],
      allowedChannelIds: ["D1"],
    },
    projectRoot,
  );
  upsertShareSlackBot(
    {
      shareUuid: shareB,
      botToken: "xoxb-b",
      signingSecret: "sec-b",
      allowedUserIds: ["U2"],
      allowedChannelIds: ["D2"],
    },
    projectRoot,
  );

  const a = getShareSlackBot(shareA, projectRoot);
  const b = getShareSlackBot(shareB, projectRoot);
  assert(a && b && a.botToken !== b.botToken, "per-share credentials isolated");
  assert(isSlackSenderAllowed(a, "U1", "D1"), "share A allowlist pass");
  assert(!isSlackSenderAllowed(a, "U2", "D1"), "share A blocks other user");
  assert(!isSlackSenderAllowed(a, "U1", "D2"), "share A blocks other channel");
  assert(isSlackSenderAllowed(b, "U2", "D2"), "share B allowlist pass");

  deleteShareSlackBot(shareA, projectRoot);
  assert(!getShareSlackBot(shareA, projectRoot), "deleted bot gone");
  assert(getShareSlackBot(shareB, projectRoot), "other share bot untouched");
}

// --- ao.db missing → empty / null ---
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "joshu-ao-"));
  assert(listShareOptionsFromAoDb(tmp).length === 0, "missing ao.db → no shares");
  assert(resolveShareScope("00000000-0000-4000-8000-000000000099", tmp) === null, "missing uuid → null");
}

// --- synthetic ao.db blob with one share ---
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "joshu-ao2-"));
  const aroz = path.join(tmp, ".local", "arozos-data");
  const realDir = path.join(aroz, "files", "users", "dan", "Desktop", "joshu's files", "Projects", "scoped");
  fs.mkdirSync(realDir, { recursive: true });
  fs.writeFileSync(path.join(realDir, "inside.md"), "# hello scoped\n");
  fs.mkdirSync(path.join(aroz, "system"), { recursive: true });
  const uuid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const share = {
    UUID: uuid,
    PathHash: "x",
    FileVirtualPath: "user:/Desktop/joshu's files/Projects/scoped",
    FileRealPath: realDir,
    Owner: "dan",
    Accessibles: [],
    Permission: "anyone",
    IsFolder: true,
  };
  // Minimal binary-ish file containing the JSON blob (as ao.db does).
  fs.writeFileSync(path.join(aroz, "system", "ao.db"), Buffer.from(`noise${JSON.stringify(share)}noise`, "utf8"));

  process.env.AROZ_DATA = aroz;
  const scope = resolveShareScope(uuid, tmp);
  assert(scope && scope.valid, "resolved valid share from ao.db");
  assert(scope.isFolder, "folder share");
  assert(isSlugInsideShare("joshus-files/projects/scoped/inside", scope), "folder can answer under path");
  assert(!isSlugInsideShare("joshus-files/projects/other/secret", scope), "folder refuses unrelated");

  // File-only share
  const fileUuid = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const filePath = path.join(realDir, "inside.md");
  const fileShare = {
    ...share,
    UUID: fileUuid,
    FileVirtualPath: "user:/Desktop/joshu's files/Projects/scoped/inside.md",
    FileRealPath: filePath,
    IsFolder: false,
  };
  fs.writeFileSync(
    path.join(aroz, "system", "ao.db"),
    Buffer.from(`${JSON.stringify(share)}${JSON.stringify(fileShare)}`, "utf8"),
  );
  const fileScope = resolveShareScope(fileUuid, tmp);
  assert(fileScope && !fileScope.isFolder, "file share");
  assert(isSlugInsideShare("joshus-files/projects/scoped/inside", fileScope), "file share allows that file");

  // Revoked / non-anyone
  const locked = { ...share, UUID: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", Permission: "signedin" };
  fs.writeFileSync(path.join(aroz, "system", "ao.db"), Buffer.from(JSON.stringify(locked), "utf8"));
  const lockedScope = resolveShareScope(locked.UUID, tmp);
  assert(lockedScope && lockedScope.valid === false, "non-anyone share invalid for public chat");

  delete process.env.AROZ_DATA;
}

// --- chat enable / disable flags ---
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "joshu-share-chat-flags-"));
  const uuid = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  assert(isShareChatEnabled(uuid, tmp) === true, "missing flag defaults to enabled");
  assert(getShareChatFlag(uuid, tmp) === null, "missing flag is null");

  setShareChatEnabled(uuid, false, tmp);
  assert(isShareChatEnabled(uuid, tmp) === false, "explicit disable");
  assert(getShareChatFlag(uuid, tmp) === false, "flag reads false");

  setShareChatEnabled(uuid, true, tmp);
  assert(isShareChatEnabled(uuid, tmp) === true, "re-enable");

  clearShareChatFlag(uuid, tmp);
  assert(getShareChatFlag(uuid, tmp) === null, "cleared flag");
  assert(isShareChatEnabled(uuid, tmp) === true, "cleared flag allows chat again");

  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("test-share-chat: ok");
