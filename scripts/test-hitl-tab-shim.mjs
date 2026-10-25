#!/usr/bin/env npx tsx
/**
 * Checks the same-tab shim in a fake page:
 * window.open of a sign-in popup opens a real popup, other window.open calls
 * load the URL in the same tab.
 */
import assert from "node:assert/strict";

import { installHitlShim, isOauthPopupUrl, OAUTH_POPUP_URL_MARKERS } from "../src/chromiumSession.ts";

const GIS_POPUP =
  "https://accounts.google.com/gsi/select?client_id=1.apps.googleusercontent.com&ux_mode=popup&origin=https%3A%2F%2Fx.com";

/** Minimal page globals for the shim. Returns the record of native popups. */
function fakePage() {
  const nativeCalls = [];
  const popup = { closed: false };
  const location = { href: "https://x.com/i/flow/login" };
  const node = { querySelectorAll: () => [] };
  const page = {
    location,
    document: { ...node, documentElement: {}, addEventListener: () => undefined },
    MutationObserver: class {
      observe() {}
    },
    Element: class {},
  };
  page.window = page;
  page.open = function (url, name, features) {
    nativeCalls.push({ url: String(url), name, features });
    return popup;
  };
  return { page, location, nativeCalls, popup };
}

/** Run `body` with the fake page as the global window. */
function withPage(page, body) {
  const keys = ["window", "document", "location", "MutationObserver", "Element"];
  const saved = keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  for (const key of keys) {
    Object.defineProperty(globalThis, key, { value: page[key], configurable: true, writable: true });
  }
  try {
    return body();
  } finally {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}

const installers = {
  chromium: () => installHitlShim(OAUTH_POPUP_URL_MARKERS),
};

for (const [name, install] of Object.entries(installers)) {
  // A sign-in popup keeps its opener.
  {
    const { page, location, nativeCalls, popup } = fakePage();
    withPage(page, () => {
      assert.equal(install(), "installed", `${name}: install`);
      assert.equal(install(), "already", `${name}: second install`);
      const result = page.open(GIS_POPUP, "g_auth", "width=500,height=600");
      assert.equal(result, popup, `${name}: sign-in popup returns the popup window`);
    });
    assert.deepEqual(nativeCalls, [{ url: GIS_POPUP, name: "g_auth", features: "width=500,height=600" }]);
    assert.equal(location.href, "https://x.com/i/flow/login", `${name}: opener stays on x.com`);
  }

  // Other window.open calls stay in the same tab.
  {
    const { page, location, nativeCalls } = fakePage();
    withPage(page, () => {
      install();
      assert.equal(page.open("https://example.com/terms", "_blank"), null, `${name}: same-tab open returns null`);
    });
    assert.equal(nativeCalls.length, 0, `${name}: no real popup for other URLs`);
    assert.equal(location.href, "https://example.com/terms", `${name}: same tab loads the URL`);
  }
}

assert.equal(isOauthPopupUrl(GIS_POPUP), true);
assert.equal(isOauthPopupUrl("https://login.microsoftonline.com/common/oauth2"), true);
assert.equal(isOauthPopupUrl("https://x.com/i/flow/login"), false);

console.log("hitl-tab-shim: ok");
