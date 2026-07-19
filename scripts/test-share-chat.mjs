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
import {
  normalizeSlackChannelName,
  suggestSlackChannelName,
  upsertShareSlackChannel,
  getShareSlackChannel,
  getShareUuidForChannel,
  unlinkShareSlackChannel,
} from "../src/shareChat/slackChannels.ts";
import { extractSlackChannelId } from "../src/shareChat/composioSlackbot.ts";
import { handleComposioShareChatTrigger } from "../src/shareChat/composioTriggers.ts";
import {
  setPersistedComposioAuthConfigId,
  getPersistedComposioAuthConfigId,
  composioToolkitAuthConfigId,
  resolveComposioToolkitAuthConfigs,
  ComposioSlackbotSetupRequiredError,
} from "../src/composioAuthConfigs.ts";
import { buildSlackbotAppManifest } from "../src/connectors/composio/slackbotSetup.ts";

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

// --- Slackbot channel name + registry 1:1 ---
{
  assert(normalizeSlackChannelName("HUA Team Notebook") === "hua-team-notebook", "normalize spaces");
  assert(normalizeSlackChannelName("#My_Channel!") === "my-channel", "strip junk + #");
  assert(suggestSlackChannelName("HUA Team Notebook.md") === "hua-team-notebook", "suggest from filename");
  let threw = false;
  try {
    normalizeSlackChannelName("@@@");
  } catch {
    threw = true;
  }
  assert(threw, "empty after normalize throws");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "joshu-share-slack-ch-"));
  const shareA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const shareB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const now = new Date().toISOString();
  upsertShareSlackChannel(
    {
      shareUuid: shareA,
      channelId: "C11111111",
      channelName: "kb-a",
      isPrivate: true,
      createdAt: now,
      updatedAt: now,
      enabled: true,
    },
    tmp,
  );
  assert(getShareUuidForChannel("C11111111", tmp) === shareA.toLowerCase(), "reverse lookup");
  assert(getShareSlackChannel(shareA, tmp)?.channelName === "kb-a", "forward lookup");

  let mappedConflict = false;
  try {
    upsertShareSlackChannel(
      {
        shareUuid: shareB,
        channelId: "C11111111",
        channelName: "kb-b",
        isPrivate: true,
        createdAt: now,
        updatedAt: now,
        enabled: true,
      },
      tmp,
    );
  } catch (e) {
    mappedConflict = e instanceof Error && e.message === "channel_already_mapped";
  }
  assert(mappedConflict, "same channel cannot map to two shares");

  unlinkShareSlackChannel(shareA, tmp);
  assert(!getShareSlackChannel(shareA, tmp), "unlinked");
  assert(!getShareUuidForChannel("C11111111", tmp), "reverse cleared");
  fs.rmSync(tmp, { recursive: true, force: true });
}

// --- extract channel id from Composio-ish payloads ---
{
  assert(extractSlackChannelId({ channel: { id: "C0ABC12345" } }) === "C0ABC12345", "nested channel.id");
  assert(extractSlackChannelId({ data: { channel_id: "G0PRIVATE01" } }) === "G0PRIVATE01", "channel_id");
  assert(extractSlackChannelId({ ok: true }) === null, "missing id");
}

// --- Composio trigger ignores bots / unmapped channels ---
{
  const ignoredBot = await handleComposioShareChatTrigger({
    triggerSlug: "SLACKBOT_CHANNEL_MESSAGE_RECEIVED",
    payload: { channel: "C999", text: "hi", bot_id: "B1" },
  });
  assert(ignoredBot.ignored === "bot_message", "ignore bot_id");

  const ignoredMap = await handleComposioShareChatTrigger({
    triggerSlug: "SLACKBOT_CHANNEL_MESSAGE_RECEIVED",
    payload: { channel: "CUNMAPPED", text: "what is this?" },
  });
  assert(ignoredMap.ignored === "unmapped_channel", "ignore unmapped");
}

// --- persisted Slackbot auth config (file, not env) ---
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "joshu-composio-ac-"));
  assert(!composioToolkitAuthConfigId("slackbot", tmp), "no auth config yet");
  setPersistedComposioAuthConfigId("slackbot", "ac_test123456", tmp);
  assert(getPersistedComposioAuthConfigId("slackbot", tmp) === "ac_test123456", "persisted id");
  assert(composioToolkitAuthConfigId("slackbot", tmp) === "ac_test123456", "resolved from file");
  assert(resolveComposioToolkitAuthConfigs(tmp).slackbot === "ac_test123456", "in resolve map");

  const prev = process.env.JOSHU_COMPOSIO_SLACKBOT_AUTH_CONFIG_ID;
  process.env.JOSHU_COMPOSIO_SLACKBOT_AUTH_CONFIG_ID = "ac_env_override";
  assert(composioToolkitAuthConfigId("slackbot", tmp) === "ac_env_override", "env overrides file");
  if (prev === undefined) delete process.env.JOSHU_COMPOSIO_SLACKBOT_AUTH_CONFIG_ID;
  else process.env.JOSHU_COMPOSIO_SLACKBOT_AUTH_CONFIG_ID = prev;

  const err = new ComposioSlackbotSetupRequiredError();
  assert(err.code === "slackbot_setup_required", "structured setup error code");
  assert(/Connectors/i.test(err.message), "points at Connectors wizard");

  const manifest = buildSlackbotAppManifest({ botName: "Test Bot" });
  assert(manifest.display_information?.name === "Test Bot", "manifest name");
  assert(Array.isArray(manifest.oauth_config?.scopes?.bot), "bot scopes present");
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("test-share-chat: ok");
