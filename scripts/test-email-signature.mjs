#!/usr/bin/env npx tsx
import {
  buildJoshuSignedEmailHtml,
  plainTextToSimpleEmailHtml,
} from "@joshu/email-signature";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const plain = plainTextToSimpleEmailHtml("Hello,\n\nThis is a test.");
assert(plain.includes("<p"), "plain text becomes paragraphs");
assert(plain.includes("Hello,") && plain.includes("This is a test."), "paragraph content preserved");

const multiline = plainTextToSimpleEmailHtml("Line one\nLine two");
assert(multiline.includes("<br>"), "single newlines become br");

const signed = buildJoshuSignedEmailHtml("Hi there", {
  name: "Patrick",
  ownerDisplayName: "Dan Benyamin",
  portraitImageUrl: "https://example.com/p.jpg",
});
assert(signed.includes("Patrick"), "signature includes name");
assert(signed.includes("Dan Benyamin&#39;s Joshu"), "signature includes owner role line");
assert(signed.includes("Get your Joshu: https://joshu.me"), "signature includes signup CTA");
assert(signed.includes("Hi there"), "body preserved");
assert(signed.includes("<hr"), "divider before signature");

console.log("test-email-signature: ok");
