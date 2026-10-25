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

// Bare URLs must become clickable anchors (Nylas HTML body).
const withUrl = plainTextToSimpleEmailHtml("See https://joshu.me/docs for details.");
assert(withUrl.includes('href="https://joshu.me/docs"'), "bare URL becomes href");
assert(withUrl.includes("<a "), "bare URL wrapped in anchor");
assert(!withUrl.includes("https://joshu.me/docs for"), "trailing prose not swallowed into href");

const mdLink = plainTextToSimpleEmailHtml("Open [the portal](https://hello.joshu.me).");
assert(mdLink.includes('href="https://hello.joshu.me"'), "markdown link href");
assert(mdLink.includes(">the portal</a>"), "markdown link label");
assert(!mdLink.includes("[the portal]"), "markdown link syntax stripped");

const rich = plainTextToSimpleEmailHtml("**Bold** and *italic* plus `code`.");
assert(rich.includes("<strong>Bold</strong>"), "bold markdown");
assert(rich.includes("<em>italic</em>"), "italic markdown");
assert(rich.includes("<code"), "inline code");

const list = plainTextToSimpleEmailHtml("- First\n- Second");
assert(list.includes("<ul"), "unordered list");
assert(list.includes("<li") && list.includes("First") && list.includes("Second"), "list items");

const ordered = plainTextToSimpleEmailHtml("1. Alpha\n2. Beta");
assert(ordered.includes("<ol"), "ordered list");

const heading = plainTextToSimpleEmailHtml("# Morning brief");
assert(heading.includes("font-weight:600"), "heading weight");
assert(heading.includes("Morning brief"), "heading text");
assert(!heading.includes("# Morning"), "heading hash stripped");

const signed = buildJoshuSignedEmailHtml("Hi there — https://joshu.me", {
  name: "Ava",
  ownerDisplayName: "Sam Owner",
  portraitImageUrl: "https://example.com/p.jpg",
});
assert(signed.includes("Ava"), "signature includes name");
assert(signed.includes("Sam Owner&#39;s Joshu"), "signature includes owner role line");
assert(signed.includes("Get your Joshu: https://joshu.me"), "signature includes signup CTA");
assert(signed.includes("Hi there"), "body preserved");
assert(signed.includes('href="https://joshu.me"'), "signed body linkifies URL");
assert(signed.includes("<hr"), "divider before signature");

console.log("test-email-signature: ok");
