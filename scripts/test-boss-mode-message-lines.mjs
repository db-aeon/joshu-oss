#!/usr/bin/env npx tsx
/**
 * Multiplayer app: how a team room message reads as a stand-up post, and which lines of a
 * message the card detail shows (apps/boss-mode/src/messageLines.ts).
 *
 * Usage: npm run test:boss-mode-message-lines
 */
import assert from "node:assert/strict";

import { excerptAbout, mentionsCard, parseStandup } from "../apps/boss-mode/src/messageLines.ts";

// The three message shapes that companions wrote in the first real stand-ups, with invented names.
const clara = [
  "Blocked",
  "- HAR-1 insurance application — @Mina, can Maya return it with Sam's inputs?",
  "- HAR-2 signed partner PDF — @Mina, can Maya send it so the partner can sign?",
  "- HAR-3 vendor agreement — @Otto, can Lee confirm the frozen terms?",
  "- HAR-4 creator call — @Otto, can Lee get it arranged?",
].join("\n");

const mina = [
  "Blocked: Waiting on my owner Maya for both asks from Clara —",
  "- HAR-1 insurance application (with Sam's inputs)",
  "- HAR-2 signed partner PDF",
  "@Clara, I asked Maya for both today; I'll post as soon as they're out.",
].join("\n");

const madeleine = [
  "Today",
  "- HAR-4 creator call — following up with the creator to lock a time.",
  "Blocked",
  "- HAR-3 vendor agreement — @Clara, I asked Lee to confirm the frozen terms.",
  "- HAR-5 About page — @Clara, Sam's copy notes are still blocking the About page.",
].join("\n");

let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}\n${error.stack}`);
  }
}

test("a label as a heading over bullets is a stand-up post", () => {
  const sections = parseStandup(clara);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].label, "Blocked");
  assert.equal(sections[0].lines.length, 4);
  assert.match(sections[0].lines[0], /^HAR-1 insurance/, "the bullet mark is gone");
});

test("a label with text, bullets, and a closing line", () => {
  const sections = parseStandup(mina);
  assert.deepEqual(sections.map((s) => s.label), ["Blocked"]);
  assert.equal(sections[0].lead, "Waiting on my owner Maya for both asks from Clara —");
  assert.equal(sections[0].lines.length, 3);
  assert.match(sections[0].lines[2], /^@Clara, I asked Maya/);
});

test("two sections, and the old one-line form", () => {
  assert.deepEqual(parseStandup(madeleine).map((s) => [s.label, s.lines.length]), [["Today", 1], ["Blocked", 2]]);
  const old = parseStandup("Done: Moodboard to the Harbor client (HAR-1)\nToday: Answer Harbor about pricing (HAR-2)");
  assert.deepEqual(old, [
    { label: "Done", lead: "Moodboard to the Harbor client (HAR-1)", lines: [] },
    { label: "Today", lead: "Answer Harbor about pricing (HAR-2)", lines: [] },
  ]);
  assert.deepEqual(parseStandup("**Blocked**\n- HAR-4 price list"), [{ label: "Blocked", lines: ["HAR-4 price list"] }]);
});

test("a normal message is not a stand-up post", () => {
  assert.equal(parseStandup("Today I sent the deck to Harbor (HAR-2)."), null);
  assert.equal(parseStandup("Question about HAR-4: who has the price list?"), null);
  assert.equal(parseStandup("BOSS DECISION: @Iris sends it."), null);
  assert.equal(parseStandup(""), null);
});

test("the card detail shows only the lines about the card", () => {
  const one = excerptAbout(clara, "HAR-1");
  assert.equal(one.kind, "standup");
  assert.equal(one.partial, true);
  assert.deepEqual(one.sections.map((s) => s.label), ["Blocked"]);
  assert.equal(one.sections[0].lines.length, 1);
  assert.match(one.sections[0].lines[0], /^HAR-1 /);

  const five = excerptAbout(madeleine, "HAR-5");
  assert.deepEqual(five.sections.map((s) => [s.label, s.lines.length]), [["Blocked", 1]]);
  const four = excerptAbout(madeleine, "HAR-4");
  assert.deepEqual(four.sections.map((s) => [s.label, s.lines.length]), [["Today", 1]]);
});

test("the lead of a section stays with the lines about the card", () => {
  const out = excerptAbout(mina, "HAR-1");
  assert.equal(out.partial, true);
  assert.equal(out.sections[0].lead, "Waiting on my owner Maya for both asks from Clara —");
  assert.deepEqual(out.sections[0].lines.map((l) => l.slice(0, 5)), ["HAR-1"]);
  const old = excerptAbout("Done: Moodboard (HAR-1)\nToday: Answer Harbor (HAR-2)", "HAR-2");
  assert.deepEqual(old.sections, [{ label: "Today", lead: "Answer Harbor (HAR-2)", lines: [] }]);
});

test("a message only about the card is shown whole", () => {
  const out = excerptAbout("Blocked: I need the new price list. @Otto, can Sam send it today? (HAR-4)", "HAR-4");
  assert.equal(out.partial, false);
  const plain = excerptAbout("Sam sent the price list for HAR-4.", "HAR-4");
  assert.deepEqual(plain, { kind: "text", text: "Sam sent the price list for HAR-4.", partial: false });
});

test("a plain message keeps only its lines that name the card", () => {
  const out = excerptAbout("Two updates.\nHAR-4 is done.\nHAR-5 waits on Maya.", "HAR-4");
  assert.deepEqual(out, { kind: "text", text: "HAR-4 is done.", partial: true });
});

test("a card id matches exactly", () => {
  assert.equal(mentionsCard("HAR-10 is done", "HAR-1"), false);
  assert.equal(mentionsCard("see HAR-1.", "HAR-1"), true);
  assert.equal(mentionsCard("(HAR-1)", "HAR-1"), true);
  assert.equal(excerptAbout("Blocked\n- HAR-10 one\n- HAR-1 two", "HAR-1").sections[0].lines[0], "HAR-1 two");
});

if (failed) {
  console.error(`test:boss-mode-message-lines — ${failed} failed`);
  process.exit(1);
}
console.log("test:boss-mode-message-lines — all passed");
