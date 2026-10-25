#!/usr/bin/env npx tsx
/**
 * Checks the dialog guard of the shared Chromium session.
 *
 * On a box, 2026-10-20, a Hermes worker closed a beforeunload dialog over its own
 * CDP connection. Playwright then closed the same dialog, Chrome answered
 * "No dialog is showing", and the unhandled rejection made the Joshu server exit.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { closeDialogQuietly, guardDialogs } from "../src/chromiumSession.ts";

const NO_DIALOG = "Protocol error (Page.handleJavaScriptDialog): No dialog is showing";

/** A dialog that another CDP client already closed. */
function fakeDialog(type, message = NO_DIALOG) {
  const calls = [];
  const fail = (name) => async () => {
    calls.push(name);
    const err = new Error(message);
    err.name = "ProtocolError";
    throw err;
  };
  return {
    calls,
    type: () => type,
    accept: fail("accept"),
    dismiss: fail("dismiss"),
    // Playwright's server Dialog.close: accept beforeunload, dismiss the rest.
    close() {
      return type === "beforeunload" ? this.accept() : this.dismiss();
    },
  };
}

/**
 * Same steps as Playwright 1.55 DialogManager.dialogDidOpen: when no listener
 * takes the dialog, close it and drop the result without a catch.
 */
function openDialog(context, dialog) {
  if (!context.emit("dialog", dialog)) dialog.close().then(() => {});
}

/** Run `body` and return the unhandled rejections that it leaves. */
async function unhandledRejections(body) {
  const seen = [];
  const onRejection = (reason) => seen.push(reason);
  process.on("unhandledRejection", onRejection);
  try {
    await body();
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    process.off("unhandledRejection", onRejection);
  }
  return seen;
}

const quiet = { log: console.log, warn: console.warn };
const logged = [];
console.log = (...args) => logged.push(["log", args.join(" ")]);
console.warn = (...args) => logged.push(["warn", args.join(" ")]);

try {
  // 1. Without the guard, the rejection is unhandled: this is the crash.
  {
    const context = new EventEmitter();
    const dialog = fakeDialog("beforeunload");
    const seen = await unhandledRejections(async () => openDialog(context, dialog));
    assert.deepEqual(dialog.calls, ["accept"]);
    assert.equal(seen.length, 1);
    assert.match(String(seen[0]?.message), /No dialog is showing/);
  }

  // 2. With the guard, the same dialog leaves no unhandled rejection.
  {
    const context = new EventEmitter();
    guardDialogs(context);
    const before = fakeDialog("beforeunload");
    const alert = fakeDialog("alert");
    const seen = await unhandledRejections(async () => {
      openDialog(context, before);
      openDialog(context, alert);
    });
    assert.deepEqual(seen, []);
    assert.deepEqual(before.calls, ["accept"]);
    assert.deepEqual(alert.calls, ["dismiss"]);
  }

  // 3. A second guardDialogs call on the same context adds no second listener.
  {
    const context = new EventEmitter();
    guardDialogs(context);
    guardDialogs(context);
    assert.equal(context.listenerCount("dialog"), 1);
  }

  // 4. The race is logged as info; another error is logged as a warning.
  {
    logged.length = 0;
    await closeDialogQuietly(fakeDialog("beforeunload"));
    await closeDialogQuietly(fakeDialog("confirm", "Target closed"));
    assert.equal(logged.length, 2);
    assert.equal(logged[0][0], "log");
    assert.match(logged[0][1], /already closed by another CDP client/);
    assert.equal(logged[1][0], "warn");
    assert.match(logged[1][1], /could not close confirm dialog: Target closed/);
  }

  // 5. A dialog that closes normally logs nothing.
  {
    logged.length = 0;
    const calls = [];
    await closeDialogQuietly({
      type: () => "alert",
      accept: async () => void calls.push("accept"),
      dismiss: async () => void calls.push("dismiss"),
    });
    assert.deepEqual(calls, ["dismiss"]);
    assert.deepEqual(logged, []);
  }
} finally {
  console.log = quiet.log;
  console.warn = quiet.warn;
}

console.log("chromium dialog guard: ok");
