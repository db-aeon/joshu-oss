/**
 * Tests of the owner outbox upload of Research reports (change research-reports, tasks 7.1 and
 * 7.2): with a file, Slack and Telegram get the PDF with the text; when the upload is refused,
 * they get the text alone; without a file, nothing changes. Uses a fake fetch; no network.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { postSlackMessage, sendTelegramMessage } from "../src/realtimeGoals/delivery.ts";

const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "research-outbox-"));
const pdf = path.join(projectRoot, "report.pdf");
fs.writeFileSync(pdf, "%PDF-1.7 fake");
const file = { path: pdf, filename: "2026-11-02-heat-pumps.pdf", title: "Research report: Heat pumps" };
process.env.SLACK_BOT_TOKEN = "xoxb-test";
process.env.TELEGRAM_BOT_TOKEN = "123:test";

const realFetch = globalThis.fetch;
let calls = [];
function fakeFetch(answer) {
  calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const call = { url: String(url), init };
    calls.push(call);
    const json = answer(call);
    return { ok: json.__status ? json.__status < 400 : true, status: json.__status ?? 200, json: async () => json };
  };
}
const endpoint = (u) => u.replace(/^https:\/\/[^/]+\/(bot[^/]+\/)?(api\/)?/, "");

async function testSlack() {
  const text = "People mostly talk about price.\n\nhttps://otto.box.example.test/joshu/api/research/r/x/y/report.pdf";
  fakeFetch(({ url }) =>
    url.includes("getUploadURLExternal")
      ? { ok: true, upload_url: "https://files.slack.com/upload/v1/abc", file_id: "F1" }
      : url.includes("files.slack.com")
        ? {}
        : { ok: true, files: [{ id: "F1" }] },
  );
  const ok = await postSlackMessage(projectRoot, { channel: "D123", text, dedupeKey: "k", files: [file] });
  assert.deepEqual(ok, { delivered: true, providerId: "F1" });
  assert.deepEqual(calls.map((c) => endpoint(c.url)), ["files.getUploadURLExternal", "upload/v1/abc", "files.completeUploadExternal"]);
  assert.match(calls[0].init.body, /filename=2026-11-02-heat-pumps.pdf&length=13/);
  const complete = JSON.parse(calls[2].init.body);
  assert.deepEqual(complete, { files: [{ id: "F1", title: "Research report: Heat pumps" }], channel_id: "D123", initial_comment: text });

  fakeFetch(({ url }) => (url.includes("getUploadURLExternal") ? { ok: false, error: "missing_scope" } : { ok: true, ts: "1.2" }));
  const refused = await postSlackMessage(projectRoot, { channel: "D123", text, dedupeKey: "k", files: [file] });
  assert.deepEqual(refused, { delivered: true, providerId: "1.2" }, "refused upload: the text with the link goes alone");
  assert.deepEqual(calls.map((c) => endpoint(c.url)), ["files.getUploadURLExternal", "chat.postMessage"]);
  assert.equal(JSON.parse(calls[1].init.body).text, text);

  fakeFetch(() => ({ ok: true, ts: "3.4" }));
  await postSlackMessage(projectRoot, { channel: "D123", text: "plain", dedupeKey: "k" });
  assert.deepEqual(calls.map((c) => endpoint(c.url)), ["chat.postMessage"], "no file: unchanged behavior");
  console.log("ok Slack: upload with the text, refused upload, no file");
}

async function testTelegram() {
  const text = "Summary.\n\nhttps://x/api/research/r/x/y/report.pdf";
  fakeFetch(() => ({ ok: true, result: { message_id: 7 } }));
  const ok = await sendTelegramMessage(projectRoot, { chatId: "42", text, files: [file] });
  assert.deepEqual(ok, { delivered: true, providerId: "7" });
  assert.deepEqual(calls.map((c) => endpoint(c.url)), ["sendDocument"]);
  const form = calls[0].init.body;
  assert.equal(form.get("chat_id"), "42");
  assert.equal(form.get("caption"), text);
  assert.equal(form.get("document").name, "2026-11-02-heat-pumps.pdf");

  fakeFetch(({ url }) => (url.endsWith("sendDocument") ? { ok: false, description: "Bad Request", __status: 400 } : { ok: true, result: { message_id: 8 } }));
  const refused = await sendTelegramMessage(projectRoot, { chatId: "42", text, files: [file] });
  assert.deepEqual(refused, { delivered: true, providerId: "8" });
  assert.deepEqual(calls.map((c) => endpoint(c.url)), ["sendDocument", "sendMessage"]);

  const long = `${"word ".repeat(300)}\nhttps://x/api/research/r/x/y/report.pdf`;
  fakeFetch(() => ({ ok: true, result: { message_id: 9 } }));
  await sendTelegramMessage(projectRoot, { chatId: "42", text: long, files: [file] });
  assert.deepEqual(calls.map((c) => endpoint(c.url)), ["sendMessage", "sendDocument"], "long text: message first, then the document");
  assert.equal(calls[1].init.body.get("caption"), null);

  fakeFetch(() => ({ ok: true, result: { message_id: 10 } }));
  await sendTelegramMessage(projectRoot, { chatId: "42", text: "plain" });
  assert.deepEqual(calls.map((c) => endpoint(c.url)), ["sendMessage"], "no file: unchanged behavior");
  console.log("ok Telegram: document with caption, refused document, long text, no file");
}

try {
  await testSlack();
  await testTelegram();
  console.log("all research outbox checks passed");
} finally {
  globalThis.fetch = realFetch;
  fs.rmSync(projectRoot, { recursive: true, force: true });
}
