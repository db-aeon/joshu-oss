#!/usr/bin/env node
/**
 * Regression: RFC Message-ID cross-mailbox dedup keys.
 * Usage: npm run test:mail-dedup
 */
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { normalizeRfcMessageId, rfcMessageDedupKey } = await import(
  pathToFileURL(path.join(rootDir, "dist/connectors/rfcMessageId.js")).href
);
const {
  buildMailDedupKey,
  mailIngressCanonicalId,
  mailIngressTaskIdempotencyKey,
} = await import(pathToFileURL(path.join(rootDir, "dist/ea/mailDedup.js")).href);

const rfc = "cajx7q8v0001abc123@mail.gmail.com";
const norm = normalizeRfcMessageId(`<${rfc}>`);
if (norm !== rfc) {
  console.error(`FAIL normalize: got ${norm}`);
  process.exit(1);
}

const gmailKey = buildMailDedupKey({
  rfcMessageId: rfc,
  subject: "Re: Great meeting you!",
  receivedAt: "2026-06-17T00:54:41.000Z",
  bodyPreview: "Gmail mirror body with different formatting",
});
const nylasKey = buildMailDedupKey({
  rfcMessageId: rfc,
  subject: "Re: Great meeting you!",
  receivedAt: "2026-06-17T00:54:42.000Z",
  bodyPreview: "> quoted\n\nNylas mirror with different formatting",
});
if (gmailKey !== nylasKey) {
  console.error(`FAIL keys differ: ${gmailKey} vs ${nylasKey}`);
  process.exit(1);
}
if (gmailKey !== rfcMessageDedupKey(rfc)) {
  console.error(`FAIL expected rfc: prefix key`);
  process.exit(1);
}

const fallbackA = buildMailDedupKey({
  subject: "Hello",
  receivedAt: "2026-06-17T12:00:00Z",
  bodyPreview: "same body",
});
const fallbackB = buildMailDedupKey({
  subject: "Hello",
  receivedAt: "2026-06-17T12:00:00Z",
  bodyPreview: "same body",
});
if (fallbackA !== fallbackB || !fallbackA.startsWith("body:")) {
  console.error("FAIL fallback body hash keys");
  process.exit(1);
}

const canonical = mailIngressCanonicalId({
  rfcMessageId: rfc,
  messageId: "19ed312b74cd18b1",
});
const idemGmail = mailIngressTaskIdempotencyKey(canonical);
const idemNylas = mailIngressTaskIdempotencyKey(
  mailIngressCanonicalId({ rfcMessageId: rfc, messageId: "nylas-other-id" }),
);
if (idemGmail !== idemNylas) {
  console.error("FAIL ingress idempotency should match across providers");
  process.exit(1);
}

console.log("OK mail-dedup RFC Message-ID keys");
