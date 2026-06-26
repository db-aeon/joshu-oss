#!/usr/bin/env node
/**
 * Regression: casual chat should not request full browser snapshot.
 * Usage: npm run test:hermes-browser-sync-policy
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { resolveBrowserSyncLevel } = await import(
  pathToFileURL(path.join(rootDir, "dist/hermesBrowserSyncPolicy.js")).href
);

const cases = [
  {
    name: "casual hey same url",
    input: { userText: "hey", priorUrl: "https://news.google.com/", currentUrl: "https://news.google.com/", hasTab: true, mode: "auto" },
    want: "light",
  },
  {
    name: "browser intent",
    input: { userText: "click the Sign in button", priorUrl: "https://news.google.com/", currentUrl: "https://news.google.com/", hasTab: true, mode: "auto" },
    want: "full",
  },
  {
    name: "url changed",
    input: { userText: "hey", priorUrl: "https://example.com/", currentUrl: "https://news.google.com/", hasTab: true, mode: "auto" },
    want: "full",
  },
  {
    name: "no tab",
    input: { userText: "hey", hasTab: false, mode: "auto" },
    want: "off",
  },
  {
    name: "forced off",
    input: { userText: "click login", hasTab: true, mode: "off" },
    want: "off",
  },
];

for (const c of cases) {
  const got = resolveBrowserSyncLevel(c.input);
  if (got !== c.want) {
    console.error(`FAIL ${c.name}: got ${got}, want ${c.want}`);
    process.exit(1);
  }
}

console.log(`OK: ${cases.length} browser sync policy cases`);
