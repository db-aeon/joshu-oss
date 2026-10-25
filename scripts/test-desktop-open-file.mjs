#!/usr/bin/env npx tsx
/**
 * `openDesktopFile` of @joshu/app-agent: Markdown opens in jNotes, a whiteboard in
 * jWhiteboard, and a click on a file that is already open raises its window instead of
 * opening one more (Multiplayer "What I share" opened a new notes window on each click).
 *
 * Usage: npm run test:desktop-open-file
 */
import assert from "node:assert/strict";

import { findOpenFileWindow, openDesktopFile } from "../packages/app-agent/src/desktopActions.ts";

/** A float window of the ArozOS desktop: a `.floatWindow` element with an iframe. */
function floatWindow(src, hidden = false) {
  const iframe = { getAttribute: (name) => (name === "src" ? src : null) };
  return { iframe, style: { display: hidden ? "none" : "" }, querySelector: (sel) => (sel === "iframe" ? iframe : null) };
}

function fakeDesktop(windows) {
  const desktop = {
    opened: [],
    raised: [],
    document: { querySelectorAll: (sel) => (sel === ".floatWindow" ? windows : []) },
    newFloatWindow(config) {
      this.opened.push(config);
      windows.push(floatWindow(config.url));
    },
    MoveFloatWindowToTop(fw) {
      this.raised.push(fw);
    },
  };
  globalThis.window = { top: desktop, parent: null, location: { hostname: "box.test", protocol: "https:", port: "" } };
  globalThis.window.parent = globalThis.window;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ filesRoot: "/files", desktopRoot: "/desk", joshuFilesDirName: "joshu's files", arozPathPrefix: "user:/Desktop/joshu's files" }),
  });
  return desktop;
}

const notesPath = "user:/Desktop/joshu's files/Teams/studio/notes.md";
const notesParam = encodeURIComponent(JSON.stringify([{ filepath: notesPath, filename: "notes.md" }]));

let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}\n${error.stack}`);
  }
}

await test("Markdown opens in jNotes", async () => {
  const desktop = fakeDesktop([]);
  assert.equal(await openDesktopFile("Teams/studio/notes.md"), true);
  assert.equal(desktop.opened.length, 1);
  assert.equal(desktop.opened[0].url, `md-editor/index.html#${notesParam}`);
  assert.equal(desktop.opened[0].title, "jNotes — notes.md");
});

await test("a second click raises the open notes window instead of opening another", async () => {
  const desktop = fakeDesktop([]);
  await openDesktopFile("Teams/studio/notes.md");
  await openDesktopFile("Teams/studio/notes.md");
  await openDesktopFile("Teams/studio/notes.md");
  assert.equal(desktop.opened.length, 1, "one window for three clicks");
  assert.equal(desktop.raised.length, 2);
});

await test("a minimized notes window is shown again", async () => {
  const hidden = floatWindow(`md-editor/index.html#${notesParam}`, true);
  const desktop = fakeDesktop([hidden]);
  await openDesktopFile("Teams/studio/notes.md");
  assert.equal(desktop.opened.length, 0);
  assert.equal(hidden.style.display, "");
  assert.deepEqual(desktop.raised, [hidden]);
});

await test("another file, or the same file in another app, opens a new window", async () => {
  const desktop = fakeDesktop([floatWindow(`md-editor/index.html#${notesParam}`), floatWindow(`excalidraw/index.html#${notesParam}`)]);
  await openDesktopFile("Teams/family/notes.md");
  assert.equal(desktop.opened.length, 1);
  await openDesktopFile("Planning/board.excalidraw");
  assert.equal(desktop.opened.length, 2);
  assert.equal(desktop.opened[1].url.startsWith("excalidraw/index.html#"), true);
});

await test("findOpenFileWindow matches the exact file", () => {
  const doc = { querySelectorAll: () => [floatWindow(`md-editor/index.html#${notesParam}`)] };
  assert.ok(findOpenFileWindow(doc, "md-editor/index.html", notesPath));
  assert.equal(findOpenFileWindow(doc, "md-editor/index.html", `${notesPath}.bak`), null);
  assert.equal(findOpenFileWindow(doc, "excalidraw/index.html", notesPath), null);
});

if (failed) {
  console.error(`test:desktop-open-file — ${failed} failed`);
  process.exit(1);
}
console.log("test:desktop-open-file — all passed");
