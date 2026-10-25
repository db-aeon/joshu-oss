#!/usr/bin/env npx tsx
/**
 * Unit tests: Gmail mail attachments — attachment metadata in the mail mirror and
 * gmail_fetch_attachment (spec mail-attachments, change gmail-attachments).
 *
 * Usage: npm run test:gmail-attachments
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";

import {
  decodeGmailAttachmentResponse,
  fetchGmailAttachmentToProject,
  GmailAttachmentError,
  parseGmailAttachments,
  safeAttachmentFilename,
  saveAttachmentToProject,
  selectGmailAttachment,
} from "../src/connectors/composio/gmailAttachments.js";
import { buildGmailThreadMirrorBody } from "../src/connectors/composio/gmailMirrorFormat.js";
import { writeMailThreadMirror } from "../src/connectors/mirror.js";

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function b64url(text) {
  return Buffer.from(text).toString("base64url");
}

// --- 1.1 parseGmailAttachments -------------------------------------------------

const worksheetRow = {
  id: "m1",
  payload: {
    mimeType: "multipart/mixed",
    parts: [
      {
        partId: "0",
        mimeType: "multipart/alternative",
        parts: [
          { partId: "0.0", mimeType: "text/plain", filename: "", body: { data: b64url("attached is the updated worksheet") } },
          {
            partId: "0.1",
            mimeType: "multipart/related",
            parts: [
              { partId: "0.1.0", mimeType: "text/html", filename: "", body: { data: b64url("<p>hi</p>") } },
              {
                partId: "0.1.1",
                mimeType: "image/png",
                filename: "logo.png",
                headers: [{ name: "Content-Disposition", value: "inline; filename=\"logo.png\"" }],
                body: { attachmentId: "ANGjdJ_logo", size: 2048 },
              },
            ],
          },
        ],
      },
      {
        partId: "1",
        mimeType: XLSX,
        filename: "worksheet.xlsx",
        headers: [{ name: "Content-Disposition", value: "attachment; filename=\"worksheet.xlsx\"" }],
        body: { attachmentId: "ANGjdJ_ws", size: 12345 },
      },
      {
        partId: "2",
        mimeType: "image/jpeg",
        filename: "photo.jpg",
        headers: [{ name: "Content-Disposition", value: "attachment; filename=\"photo.jpg\"" }],
        body: { attachmentId: "ANGjdJ_photo", size: 999 },
      },
    ],
  },
};

{
  const atts = parseGmailAttachments(worksheetRow, "m1");
  assert.deepEqual(
    atts.map((a) => a.filename),
    ["worksheet.xlsx", "photo.jpg"],
    "nested tree: inline signature image skipped, attached image kept",
  );
  assert.deepEqual(atts[0], {
    filename: "worksheet.xlsx",
    contentType: XLSX,
    size: 12345,
    messageId: "m1",
    attachmentId: "ANGjdJ_ws",
    partId: "1",
  });
}

{
  const atts = parseGmailAttachments(
    {
      id: "m2",
      messageText: "see attachment",
      attachmentList: [{ attachmentId: "A1", filename: "roster.pdf", mimeType: "application/pdf" }],
    },
    "m2",
  );
  assert.deepEqual(atts, [
    { filename: "roster.pdf", contentType: "application/pdf", messageId: "m2", attachmentId: "A1" },
  ]);
}

assert.deepEqual(
  parseGmailAttachments({ payload: { mimeType: "text/plain", body: { data: b64url("x") } } }, "m3"),
  [],
);

// Only a signature logo in the MIME tree: attachmentList must not add the logo back.
assert.deepEqual(
  parseGmailAttachments(
    {
      payload: {
        mimeType: "multipart/related",
        parts: [
          {
            mimeType: "image/png",
            filename: "logo.png",
            headers: [{ name: "Content-Disposition", value: "inline" }],
            body: { attachmentId: "L1", size: 10 },
          },
        ],
      },
      attachmentList: [{ attachmentId: "L1", filename: "logo.png", mimeType: "image/png" }],
    },
    "m4",
  ),
  [],
);

// --- 1.2 mail mirror format ------------------------------------------------------

{
  const [ws] = parseGmailAttachments(worksheetRow, "m1");
  const { bodyMarkdown, threadMessages } = buildGmailThreadMirrorBody([
    { id: "m0", threadId: "t1", from: "a@example.com", subject: "Kickoff", body: "no files", messageTimestamp: 1_700_000_000_000 },
    {
      id: "m1",
      threadId: "t1",
      from: "client@example.com",
      subject: "Re: Kickoff",
      body: "attached is the updated worksheet",
      messageTimestamp: 1_700_000_100_000,
      attachments: [ws],
    },
  ]);
  assert.equal("attachments" in threadMessages[0], false, "message without mail attachments has no key");
  assert.deepEqual(threadMessages[1].attachments, [
    { filename: "worksheet.xlsx", content_type: XLSX, size: 12345, message_id: "m1", attachment_id: "ANGjdJ_ws" },
  ]);
  const [first, second] = bodyMarkdown.split("\n\n---\n\n");
  assert.ok(!first.includes("**Attachments:**"));
  assert.ok(second.includes("**Attachments:**\n- worksheet.xlsx ("), second);
  assert.ok(second.includes("12 KB) — gmail_fetch_attachment messageId=m1"), second);

  // Front matter round trip through the mirror writer.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-att-mirror-"));
  const file = await writeMailThreadMirror({
    threadsDir: dir,
    threadId: "t1",
    frontmatter: { source: "composio:gmail", external_id: "m1", thread_id: "t1", synced_at: "now", thread_messages: threadMessages },
    bodyMarkdown,
  });
  const fm = YAML.parse(fs.readFileSync(file, "utf8").split("---")[1]);
  assert.equal(fm.thread_messages[1].attachments[0].attachment_id, "ANGjdJ_ws");
}

// --- 2.1 selection ---------------------------------------------------------------

const two = parseGmailAttachments(worksheetRow, "m1");
assert.equal(selectGmailAttachment(two, { attachmentId: "ANGjdJ_photo" })?.filename, "photo.jpg");
assert.equal(selectGmailAttachment(two, { filename: "WORKSHEET.xlsx" })?.filename, "worksheet.xlsx");
assert.equal(
  selectGmailAttachment(two, { attachmentId: "stale-id", filename: "worksheet.xlsx" })?.attachmentId,
  "ANGjdJ_ws",
  "stale attachment id falls back to the file name",
);
assert.equal(selectGmailAttachment(two, {}), null, "two attachments and no selection → list");
assert.equal(selectGmailAttachment([two[0]], { attachmentId: "stale-id" })?.filename, "worksheet.xlsx", "stale id, only attachment");
assert.throws(() => selectGmailAttachment(two, { attachmentId: "stale-id" }), (err) => err.status === 404);
assert.equal(selectGmailAttachment([two[0]], {})?.filename, "worksheet.xlsx", "only attachment");
assert.throws(
  () => selectGmailAttachment(two, { filename: "roster.pdf" }),
  (err) => err instanceof GmailAttachmentError && err.status === 404 && /worksheet\.xlsx, photo\.jpg/.test(err.message),
);

// --- 2.1 decode -----------------------------------------------------------------

{
  const d = decodeGmailAttachmentResponse({ data: { size: 5, data: b64url("hello") } });
  assert.equal(d.bytes.toString(), "hello");
  const std = decodeGmailAttachmentResponse({ data: Buffer.from("hi+/").toString("base64") });
  assert.equal(std.bytes.toString(), "hi+/");
  const u = decodeGmailAttachmentResponse({ data: { file: { name: "w.xlsx", mimetype: XLSX, s3url: "https://s3.example/w" } } });
  assert.equal(u.url, "https://s3.example/w");
  assert.throws(
    () => decodeGmailAttachmentResponse({ data: { something: 1 } }),
    (err) => err instanceof GmailAttachmentError && /keys: data/.test(err.message),
  );
}

// --- 2.1 file names and save -----------------------------------------------------

assert.equal(safeAttachmentFilename("../../etc/passwd"), "passwd");
assert.equal(safeAttachmentFilename("..\\..\\x.txt"), "x.txt");
assert.equal(safeAttachmentFilename(".."), "attachment");
assert.equal(safeAttachmentFilename("Q3 report (final).xlsx"), "Q3 report _final_.xlsx");
assert.ok(safeAttachmentFilename(`${"a".repeat(300)}.xlsx`).length <= 120);

const filesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-att-files-"));
{
  const a = await saveAttachmentToProject({ filesRoot, projectSlug: "SigmaTron Kickoff", filename: "worksheet.xlsx", bytes: Buffer.from("v1") });
  assert.equal(a.path, "Projects/sigmatron-kickoff/attachments/worksheet.xlsx");
  assert.equal(a.alreadyPresent, false);
  const again = await saveAttachmentToProject({ filesRoot, projectSlug: "sigmatron-kickoff", filename: "worksheet.xlsx", bytes: Buffer.from("v1") });
  assert.equal(again.path, a.path);
  assert.equal(again.alreadyPresent, true);
  const other = await saveAttachmentToProject({ filesRoot, projectSlug: "sigmatron-kickoff", filename: "worksheet.xlsx", bytes: Buffer.from("v2") });
  assert.equal(other.path, "Projects/sigmatron-kickoff/attachments/worksheet-2.xlsx");
  const dir = path.join(filesRoot, "Projects/sigmatron-kickoff/attachments");
  assert.deepEqual(fs.readdirSync(dir).sort(), ["worksheet-2.xlsx", "worksheet.xlsx"], "no temp files left");
  const evil = await saveAttachmentToProject({ filesRoot, filename: "../../etc/passwd", bytes: Buffer.from("x") });
  assert.equal(evil.path, "Projects/other/attachments/passwd", "no project slug → other");
}

// --- 2.1 fetchGmailAttachmentToProject -------------------------------------------

function deps(attachments, response, extra = {}) {
  const calls = { get: 0 };
  return {
    calls,
    deps: {
      listAttachments: async () => attachments,
      getAttachment: async () => {
        calls.get += 1;
        return response;
      },
      ...extra,
    },
  };
}

{
  const desktopRoot = path.dirname(filesRoot);
  const { deps: d } = deps(two, { data: b64url("sheet-bytes") });
  const out = await fetchGmailAttachmentToProject(
    { filesRoot, desktopRoot, messageId: "m1", filename: "worksheet.xlsx", projectSlug: "kick" },
    d,
  );
  assert.equal(out.saved, true);
  assert.equal(out.path, "Projects/kick/attachments/worksheet.xlsx");
  assert.equal(out.size, "sheet-bytes".length);
  assert.equal(out.desktopPath, `${path.basename(filesRoot)}/Projects/kick/attachments/worksheet.xlsx`);
  assert.equal(fs.readFileSync(path.join(filesRoot, out.path), "utf8"), "sheet-bytes");
}

{
  const { deps: d, calls } = deps(two, { data: b64url("x") });
  const out = await fetchGmailAttachmentToProject({ filesRoot, messageId: "m1" }, d);
  assert.equal(out.saved, false);
  assert.equal(out.attachments.length, 2);
  assert.equal(calls.get, 0, "list result downloads nothing");
}

{
  const big = [{ ...two[0], size: 30_000_000 }];
  const { deps: d, calls } = deps(big, { data: b64url("x") });
  await assert.rejects(
    fetchGmailAttachmentToProject({ filesRoot, messageId: "m1", projectSlug: "big" }, d),
    (err) => err instanceof GmailAttachmentError && err.status === 413 && /30000000 bytes; max 26214400/.test(err.message),
  );
  assert.equal(calls.get, 0, "size limit checked before the download");
  assert.equal(fs.existsSync(path.join(filesRoot, "Projects/big")), false);
}

{
  // Download URL with no size in the metadata; bytes go above the limit while streaming.
  const noSize = [{ filename: "huge.bin", messageId: "m9", attachmentId: "A9" }];
  const fetchImpl = async () => new Response(new Uint8Array(64));
  const { deps: d } = deps(noSize, { data: { file: { s3url: "https://s3.example/huge" } } }, { fetchImpl });
  await assert.rejects(
    fetchGmailAttachmentToProject({ filesRoot, messageId: "m9", projectSlug: "huge", maxBytes: 10 }, d),
    (err) => err instanceof GmailAttachmentError && err.status === 413,
  );
  assert.equal(fs.existsSync(path.join(filesRoot, "Projects/huge/attachments/huge.bin")), false);

  const ok = deps(noSize, { data: { file: { s3url: "https://s3.example/ok" } } }, { fetchImpl: async () => new Response("from-url") });
  const out = await fetchGmailAttachmentToProject({ filesRoot, messageId: "m9", projectSlug: "url" }, ok.deps);
  assert.equal(fs.readFileSync(path.join(filesRoot, out.path), "utf8"), "from-url");
}

{
  // One mail attachment and no selection → saved.
  const { deps: d } = deps([two[0]], { data: b64url("only") });
  const out = await fetchGmailAttachmentToProject({ filesRoot, messageId: "m1", projectSlug: "only" }, d);
  assert.equal(out.saved, true);
  assert.equal(out.path, "Projects/only/attachments/worksheet.xlsx");
}

{
  // JOSHU_GMAIL_MAX_ATTACHMENT_BYTES changes the size limit.
  process.env.JOSHU_GMAIL_MAX_ATTACHMENT_BYTES = "100";
  const { deps: d } = deps([{ ...two[0], size: 101 }], { data: b64url("x") });
  await assert.rejects(
    fetchGmailAttachmentToProject({ filesRoot, messageId: "m1", projectSlug: "env" }, d),
    (err) => err.status === 413 && /max 100\)/.test(err.message),
  );
  delete process.env.JOSHU_GMAIL_MAX_ATTACHMENT_BYTES;
}

{
  const { deps: d } = deps([], {});
  await assert.rejects(
    fetchGmailAttachmentToProject({ filesRoot, messageId: "m0" }, d),
    (err) => err instanceof GmailAttachmentError && err.status === 404,
  );
}

// --- 2.3 connectors MCP tool -----------------------------------------------------

{
  const src = fs.readFileSync(new URL("./joshu-connectors-mcp-http-server.mjs", import.meta.url), "utf8");
  const start = src.indexOf('name: "gmail_fetch_attachment"');
  assert.ok(start > 0, "tool list has gmail_fetch_attachment");
  assert.ok(/required: \["messageId"\]/.test(src.slice(start, start + 2000)), "required input messageId");
  assert.ok(src.includes('if (name === "gmail_fetch_attachment")'), "handler present");
  assert.ok(src.includes('"/api/connectors/mail/gmail/attachments/fetch"'), "handler calls the endpoint");
}

console.log("test-gmail-attachments: ok");
