#!/usr/bin/env npx tsx
/**
 * Active page of the Browser Use live view: a sign-in popup becomes the active
 * page, and the opener becomes the active page again when the popup closes.
 * Spec: shared-browser (change live-view-follow-popup).
 */
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";

import { WebSocketServer } from "ws";

import {
  cloudBrowserActivePageRunning,
  startCloudBrowserActivePage,
  stopCloudBrowserActivePage,
} from "../src/cloudBrowserActivePage.ts";

/** A fake Browser Use CDP endpoint: /json/version and one browser WebSocket. */
async function fakeBrowser(initialPages) {
  const state = { commands: [], sockets: [], connects: 0 };
  const server = http.createServer((req, res) => {
    const { port } = server.address();
    if (req.url === "/json/version") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/fake` }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const wss = new WebSocketServer({ server });
  wss.on("connection", (socket) => {
    state.connects += 1;
    state.sockets.push(socket);
    socket.on("message", (data) => {
      const message = JSON.parse(String(data));
      state.commands.push(message);
      const result =
        message.method === "Target.getTargets"
          ? { targetInfos: initialPages.map((page) => ({ type: "page", ...page })) }
          : {};
      socket.send(JSON.stringify({ id: message.id, result }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  return {
    cdpUrl: `http://127.0.0.1:${port}`,
    state,
    /** Send a CDP event on the newest browser WebSocket. */
    emit(method, params) {
      state.sockets.at(-1).send(JSON.stringify({ method, params }));
    },
    activations() {
      return state.commands.filter((c) => c.method === "Target.activateTarget").map((c) => c.params.targetId);
    },
    dropConnections() {
      for (const socket of state.sockets) socket.terminate();
    },
    async close() {
      for (const socket of state.sockets) socket.terminate();
      wss.close();
      server.close();
    },
  };
}

async function waitFor(check, label, timeoutMs = 2_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timeout: ${label}`);
}

async function settle(ms = 100) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Start the follower and wait until it listens for new pages. */
async function startOn(browser, opts = {}) {
  startCloudBrowserActivePage(browser.cdpUrl, { reconnectDelayMs: 50, ...opts });
  await waitFor(
    () => browser.state.commands.some((c) => c.method === "Target.setDiscoverTargets"),
    "setDiscoverTargets",
  );
}

const created = (targetId, openerId) => ({ targetInfo: { targetId, type: "page", url: "", ...(openerId ? { openerId } : {}) } });

// 1. A popup with an opener becomes the active page. A page without an opener does not.
{
  const browser = await fakeBrowser([{ targetId: "X" }]);
  await startOn(browser);
  browser.emit("Target.targetCreated", created("H"));
  await settle();
  assert.deepEqual(browser.activations(), [], "page without opener: no command");
  browser.emit("Target.targetCreated", created("P", "X"));
  await waitFor(() => browser.activations().length === 1, "popup activated");
  assert.deepEqual(browser.activations(), ["P"]);

  // 2. The close of the active popup makes the opener the active page.
  browser.emit("Target.targetDestroyed", { targetId: "P" });
  await waitFor(() => browser.activations().length === 2, "opener activated");
  assert.deepEqual(browser.activations(), ["P", "X"]);

  // 3. The close of a page that is not active sends no command.
  browser.emit("Target.targetDestroyed", { targetId: "H" });
  await settle();
  assert.deepEqual(browser.activations(), ["P", "X"], "inactive page closed: no command");
  stopCloudBrowserActivePage();
  await browser.close();
}

// 4. Opener closed before the popup: the newest open page becomes the active page.
{
  const browser = await fakeBrowser([{ targetId: "A" }, { targetId: "X" }]);
  await startOn(browser);
  browser.emit("Target.targetCreated", created("N"));
  browser.emit("Target.targetCreated", created("P", "X"));
  await waitFor(() => browser.activations().length === 1, "popup activated");
  browser.emit("Target.targetDestroyed", { targetId: "X" });
  await settle();
  assert.deepEqual(browser.activations(), ["P"], "opener closed while popup active: no command");
  browser.emit("Target.targetDestroyed", { targetId: "P" });
  await waitFor(() => browser.activations().length === 2, "newest page activated");
  assert.deepEqual(browser.activations(), ["P", "N"]);
  stopCloudBrowserActivePage();
  await browser.close();
}

// 5. BrowserUse.activeTargetChanged changes the active page that the follower knows.
{
  const browser = await fakeBrowser([{ targetId: "A" }, { targetId: "B" }]);
  await startOn(browser);
  browser.emit("BrowserUse.activeTargetChanged", { targetId: "B" });
  await settle();
  browser.emit("Target.targetDestroyed", { targetId: "A" });
  await settle();
  assert.deepEqual(browser.activations(), [], "A was not active: no command");
  browser.emit("Target.targetDestroyed", { targetId: "B" });
  await settle();
  assert.deepEqual(browser.activations(), [], "no open page: no command");
  stopCloudBrowserActivePage();
  await browser.close();
}

// 6. Replayed targetCreated events of open pages do not count as new pages.
{
  const browser = await fakeBrowser([{ targetId: "X" }, { targetId: "P", openerId: "X" }]);
  await startOn(browser);
  browser.emit("Target.targetCreated", created("P", "X"));
  await settle();
  assert.deepEqual(browser.activations(), [], "replayed popup: no command");
  stopCloudBrowserActivePage();
  await browser.close();
}

// 7. The follower connects again after a drop; stop closes the WebSocket and stops reconnects.
{
  const browser = await fakeBrowser([{ targetId: "X" }]);
  await startOn(browser);
  assert.equal(browser.state.connects, 1);
  browser.dropConnections();
  await waitFor(() => browser.state.connects === 2, "reconnect");
  assert.equal(cloudBrowserActivePageRunning(), true);
  stopCloudBrowserActivePage();
  assert.equal(cloudBrowserActivePageRunning(), false);
  await settle();
  browser.dropConnections();
  await settle(200);
  assert.equal(browser.state.connects, 2, "no reconnect after stop");
  await browser.close();
}

console.log("test-cloud-browser-active-page — all passed");
