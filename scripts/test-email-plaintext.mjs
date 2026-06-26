import assert from "node:assert/strict";
import { extractMessageBody } from "../src/connectors/composio/gmailBodies.js";
import { htmlToPlainText, looksLikeHtml, normalizeDirectBodyField } from "../src/connectors/emailPlaintext.js";

// Amazon-style plain text in Composio `body` field.
const amazonRow = {
  body: "Your Orders\r\n\r\nhttps://www.amazon.com/gp/css/order-history\r\n\r\nThanks for your order!",
  snippet: "Thanks for your order",
};

const amazonBody = extractMessageBody(amazonRow);
assert.ok(amazonBody.includes("Thanks for your order"));
assert.ok(!looksLikeHtml(amazonBody));

// AngelList-style HTML dumped into `body` (no MIME walk).
const htmlRow = {
  body: `<!DOCTYPE html><html><head><style>.x{color:red}</style></head><body><p>Hello Daniel</p><p>Your tax documents are ready.</p></body></html>`,
  snippet: "Your tax documents",
};

const htmlBody = extractMessageBody(htmlRow);
assert.ok(!htmlBody.includes("<!DOCTYPE"), htmlBody.slice(0, 120));
assert.ok(htmlBody.includes("Hello Daniel"), htmlBody);
assert.ok(htmlBody.includes("tax documents"), htmlBody);

// MIME multipart: plain wins over html.
const mimeRow = {
  payload: {
    mimeType: "multipart/alternative",
    parts: [
      {
        mimeType: "text/plain",
        body: { data: Buffer.from("Plain version").toString("base64") },
      },
      {
        mimeType: "text/html",
        body: {
          data: Buffer.from("<html><body><p>HTML version</p></body></html>").toString("base64"),
        },
      },
    ],
  },
  body: "<html><body><p>should not use this</p></body></html>",
};

assert.equal(extractMessageBody(mimeRow), "Plain version");

const converted = normalizeDirectBodyField(htmlRow.body);
assert.equal(converted, htmlToPlainText(htmlRow.body));

console.log("emailPlaintext tests OK");
