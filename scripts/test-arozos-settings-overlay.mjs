#!/usr/bin/env node
/**
 * Unit test for the Joshu changes to the ArozOS System Settings page:
 * arozos/web-overlays-vanilla/SystemAO/system_setting/joshu-settings.js.
 *
 * The test runs the file in a sandbox with a small copy of the two browser
 * objects it uses (jQuery.ajaxPrefilter and applocale.getString). It needs no
 * browser, no box, and no package.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(
  path.join(root, "arozos/web-overlays-vanilla/SystemAO/system_setting/joshu-settings.js"),
  "utf8",
);

const prefilters = [];
const locale = {
  "menu/group/Host Information": "Host Information",
  "menu/group/Legal": "關於 ArozOS",
};
const window = {
  jQuery: { ajaxPrefilter: (fn) => prefilters.push(fn) },
  applocale: {
    getString(key, fallback) {
      return locale[key] ?? fallback;
    },
  },
};
vm.runInNewContext(source, { window });

assert.equal(window.__joshuSettingsBranding, true, "the file ran to its end");
assert.equal(prefilters.length, 1, "one ajax prefilter");

/** Send one answer of the server through the prefilter, as jQuery does. */
function answerFor(url, payload) {
  const options = { url };
  prefilters[0](options);
  if (typeof options.dataFilter !== "function") return payload;
  return JSON.parse(options.dataFilter(JSON.stringify(payload), "json"));
}

// The list of groups: the Joshu group and the two unused upstream groups do not show.
const groups = answerFor("../../system/setting/list", [
  { Name: "Host Information", Group: "Info" },
  { Name: "AI Integration", Group: "AInteg" },
  { Name: "About ArOZ", Group: "About" },
  { Name: "Containers", Group: "Container" },
  { Name: "Joshu", Group: "Joshu" },
]);
assert.deepEqual(
  groups.map((g) => g.Group),
  ["Info", "About"],
);

// The About group: no Vendor entry, and one Joshu entry that opens Box State.
const about = answerFor("../../system/setting/list?listGroup=About", [
  { Name: "ArozOS", Group: "About", StartDir: "SystemAO/info/about.html" },
  { Name: "Vendor", Group: "About", StartDir: "SystemAO/vendor/index.html" },
]);
assert.deepEqual(
  about.map((entry) => entry.Name),
  ["ArozOS", "Joshu"],
);
assert.equal(about[1].StartDir, "SystemAO/joshu/box-state.html");
assert.equal(about[1].Group, "About");

// A second Joshu entry is not added when the server already sends one.
const aboutWithJoshu = answerFor("../../system/setting/list?listGroup=About", [
  { Name: "Joshu", Group: "About", StartDir: "SystemAO/joshu/box-state.html" },
]);
assert.equal(aboutWithJoshu.length, 1);

// The group Network has no entry for the TURN relay, and the group Developer
// Options has no entry for the shared spaces.
assert.deepEqual(
  answerFor("../../system/setting/list?listGroup=Network", [
    { Name: "Network Info", Group: "Network" },
    { Name: "Screen Share Relay", Group: "Network" },
  ]).map((entry) => entry.Name),
  ["Network Info"],
);
assert.deepEqual(
  answerFor("../../system/setting/list?listGroup=Advance", [
    { Name: "Shared Spaces", Group: "Advance" },
    { Name: "AGI Runtimes", Group: "Advance" },
  ]).map((entry) => entry.Name),
  ["AGI Runtimes"],
);

// Other groups do not change.
const info = [{ Name: "Vendor", Group: "Info" }];
assert.deepEqual(answerFor("../../system/setting/list?listGroup=Info", info), info);

// An answer that is not JSON does not change, and an object does not change.
const errorOptions = { url: "../../system/setting/list" };
prefilters[0](errorOptions);
assert.equal(errorOptions.dataFilter("<html>error</html>", "json"), "<html>error</html>");
assert.deepEqual(answerFor("../../system/setting/list", { error: "User not logged in" }), {
  error: "User not logged in",
});

// Other endpoints get no data filter.
const otherOptions = { url: "../../system/users/userinfo" };
prefilters[0](otherOptions);
assert.equal(otherOptions.dataFilter, undefined);

// Labels.
const getString = (key, fallback) => window.applocale.getString(key, fallback);
assert.equal(getString("menu/group/About ArOZ", "About ArOZ"), "About");
assert.equal(getString("menu/group/Host Information", "x"), "Host Information");
assert.equal(getString("menu/group/Legal", "x"), "關於 ArozOS", "a translated label stays");
assert.equal(getString("tab/about/ArozOS", "ArozOS"), "About");
assert.equal(getString("tab/about/License", "License"), "License");

console.log("arozos settings overlay: all checks passed");
