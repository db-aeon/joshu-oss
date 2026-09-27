#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const target = process.argv[2] ?? "/app/server.js";
let source = readFileSync(target, "utf8");

const alreadyHasPopupPatch = source.includes("__hitlSingleTabPopupPatch");

const popupHandlerV2 = ` page.on('popup', async (popup) => {
 try {
 // __hitlPopupCoerceV2 — Slack/OAuth magic links need the popup redirect chain to finish first
 const slackMagic = (u) => /\\/z-app-/.test(String(u || ''));
 await popup.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
 if (!popup.url() || popup.url() === 'about:blank') {
 await popup.waitForURL((u) => u && u !== 'about:blank', { timeout: 60000 }).catch(() => {});
 }
 let url = popup.url();
 if (!url || url === 'about:blank') {
 await popup.close().catch(() => {});
 return;
 }
 const magic = slackMagic(url);
 const navTimeout = magic ? 90000 : 30000;
 await popup.waitForLoadState('load', { timeout: magic ? 60000 : 15000 }).catch(() => {});
 url = popup.url() || url;
 try {
 await page.evaluate((targetUrl) => { window.location.assign(String(targetUrl)); }, url);
 await page.waitForLoadState('domcontentloaded', { timeout: navTimeout });
 } catch (err) {
 log('warn', 'popup assign navigation failed', { url, error: err.message });
 await page.goto(url, { waitUntil: 'domcontentloaded', timeout: navTimeout }).catch((err2) => {
 log('warn', 'popup same-tab navigation failed', { url, error: err2.message });
 });
 }
 await popup.close().catch(() => {});
 log('info', 'popup coerced into opener tab', { url });
 } catch (err) {
 log('warn', 'popup coercion failed', { error: err.message });
 await popup.close().catch(() => {});
 }
 });`;

const popupHandlerV3 = ` page.on('popup', async (popup) => {
 try {
 // __hitlPopupCoerceV3 — leave Google/GitHub/Microsoft/Apple OAuth in the popup until the site closes it
 const slackMagic = (u) => /\\/z-app-/.test(String(u || ''));
 const oauthIdp = (u) => /accounts\\.google\\.com|accounts\\.youtube\\.com|login\\.microsoftonline\\.com|login\\.live\\.com|github\\.com\\/login|github\\.com\\/session|github\\.com\\/sessions|appleid\\.apple\\.com/.test(String(u || ''));
 await popup.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
 if (!popup.url() || popup.url() === 'about:blank') {
 await popup.waitForURL((u) => u && u !== 'about:blank', { timeout: 60000 }).catch(() => {});
 }
 let url = popup.url();
 if (!url || url === 'about:blank') {
 await popup.close().catch(() => {});
 return;
 }
 if (oauthIdp(url)) {
 log('info', 'hitl oauth popup left open for IdP', { url });
 await popup.bringToFront().catch(() => {});
 await popup.evaluate(() => { try { window.moveTo(0, 0); window.resizeTo(screen.availWidth, screen.availHeight); } catch (e) {} }).catch(() => {});
 return;
 }
 const magic = slackMagic(url);
 const navTimeout = magic ? 90000 : 30000;
 await popup.waitForLoadState('load', { timeout: magic ? 60000 : 15000 }).catch(() => {});
 url = popup.url() || url;
 try {
 await page.evaluate((targetUrl) => { window.location.assign(String(targetUrl)); }, url);
 await page.waitForLoadState('domcontentloaded', { timeout: navTimeout });
 } catch (err) {
 log('warn', 'popup assign navigation failed', { url, error: err.message });
 await page.goto(url, { waitUntil: 'domcontentloaded', timeout: navTimeout }).catch((err2) => {
 log('warn', 'popup same-tab navigation failed', { url, error: err2.message });
 });
 }
 await popup.close().catch(() => {});
 log('info', 'popup coerced into opener tab', { url });
 } catch (err) {
 log('warn', 'popup coercion failed', { error: err.message });
 await popup.close().catch(() => {});
 }
 });`;

const popupHandlerV4 = ` page.on('popup', async (popup) => {
 try {
 // __hitlPopupCoerceV4 — leave IdP OAuth in the popup; do not resize (Google GIS/ITP hangs on gsi/transform)
 const slackMagic = (u) => /\\/z-app-/.test(String(u || ''));
 const oauthIdp = (u) => /accounts\\.google\\.com|accounts\\.youtube\\.com|login\\.microsoftonline\\.com|login\\.live\\.com|github\\.com\\/login|github\\.com\\/session|github\\.com\\/sessions|appleid\\.apple\\.com/.test(String(u || ''));
 await popup.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
 if (!popup.url() || popup.url() === 'about:blank') {
 await popup.waitForURL((u) => u && u !== 'about:blank', { timeout: 60000 }).catch(() => {});
 }
 let url = popup.url();
 if (!url || url === 'about:blank') {
 await popup.close().catch(() => {});
 return;
 }
 if (oauthIdp(url)) {
 log('info', 'hitl oauth popup left open for IdP', { url });
 await popup.bringToFront().catch(() => {});
 return;
 }
 const magic = slackMagic(url);
 const navTimeout = magic ? 90000 : 30000;
 await popup.waitForLoadState('load', { timeout: magic ? 60000 : 15000 }).catch(() => {});
 url = popup.url() || url;
 try {
 await page.evaluate((targetUrl) => { window.location.assign(String(targetUrl)); }, url);
 await page.waitForLoadState('domcontentloaded', { timeout: navTimeout });
 } catch (err) {
 log('warn', 'popup assign navigation failed', { url, error: err.message });
 await page.goto(url, { waitUntil: 'domcontentloaded', timeout: navTimeout }).catch((err2) => {
 log('warn', 'popup same-tab navigation failed', { url, error: err2.message });
 });
 }
 await popup.close().catch(() => {});
 log('info', 'popup coerced into opener tab', { url });
 } catch (err) {
 log('warn', 'popup coercion failed', { error: err.message });
 await popup.close().catch(() => {});
 }
 });`;

// Kept for idempotent v5 → v6 upgrade on already-patched /app/server.js.
const popupHandlerV5 = ` page.on('popup', async (popup) => {
 try {
 // __hitlPopupCoerceV5 — wait on the IdP, then put the app callback into the opener (classic OAuth)
 const slackMagic = (u) => /\\/z-app-/.test(String(u || ''));
 const oauthIdp = (u) => /accounts\\.google\\.com|accounts\\.youtube\\.com|login\\.microsoftonline\\.com|login\\.live\\.com|github\\.com\\/login|github\\.com\\/session|github\\.com\\/sessions|appleid\\.apple\\.com/.test(String(u || ''));
 await popup.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
 if (!popup.url() || popup.url() === 'about:blank') {
 await popup.waitForURL((u) => u && u !== 'about:blank', { timeout: 60000 }).catch(() => {});
 }
 let url = popup.url();
 if (!url || url === 'about:blank') {
 await popup.close().catch(() => {});
 return;
 }
 if (oauthIdp(url)) {
 log('info', 'hitl oauth popup waiting for callback', { url });
 await popup.bringToFront().catch(() => {});
 await popup.waitForURL((u) => {
 const s = String(u || '');
 return Boolean(s) && s !== 'about:blank' && !oauthIdp(s);
 }, { timeout: 300000 }).catch(() => {});
 if (popup.isClosed()) {
 log('info', 'hitl oauth popup closed by site', {});
 return;
 }
 url = popup.url() || url;
 if (oauthIdp(url)) {
 log('info', 'hitl oauth popup still on IdP — leaving open', { url });
 return;
 }
 }
 const magic = slackMagic(url);
 const navTimeout = magic ? 90000 : 30000;
 await popup.waitForLoadState('load', { timeout: magic ? 60000 : 15000 }).catch(() => {});
 url = popup.url() || url;
 try {
 await page.evaluate((targetUrl) => { window.location.assign(String(targetUrl)); }, url);
 await page.waitForLoadState('domcontentloaded', { timeout: navTimeout });
 } catch (err) {
 log('warn', 'popup assign navigation failed', { url, error: err.message });
 await page.goto(url, { waitUntil: 'domcontentloaded', timeout: navTimeout }).catch((err2) => {
 log('warn', 'popup same-tab navigation failed', { url, error: err2.message });
 });
 }
 await popup.close().catch(() => {});
 log('info', 'popup coerced into opener tab', { url });
 } catch (err) {
 log('warn', 'popup coercion failed', { error: err.message });
 await popup.close().catch(() => {});
 }
 });`;

const popupHandlerV6 = ` page.on('popup', async (popup) => {
 try {
 // __hitlPopupCoerceV6 — wait on IdP (no early bail), then assign app callback to opener
 const slackMagic = (u) => /\\/z-app-/.test(String(u || ''));
 const oauthIdp = (u) => /accounts\\.google\\.com|accounts\\.youtube\\.com|login\\.microsoftonline\\.com|login\\.live\\.com|github\\.com\\/login|github\\.com\\/session|github\\.com\\/sessions|appleid\\.apple\\.com/.test(String(u || ''));
 const oauthCallbackUrl = (u) => {
 const s = String(u || '');
 return Boolean(s) && s !== 'about:blank' && !oauthIdp(s);
 };
 const readPopupUrl = () => {
 try { return popup.url(); } catch (_) { return ''; }
 };
 const waitOAuthCallback = async () => {
 const deadline = Date.now() + 900000;
 while (!popup.isClosed() && Date.now() < deadline) {
 const cur = readPopupUrl();
 if (oauthCallbackUrl(cur)) return cur;
 await popup.waitForURL(oauthCallbackUrl, { timeout: 30000 }).catch(() => {});
 }
 if (popup.isClosed()) return null;
 const cur = readPopupUrl();
 if (oauthCallbackUrl(cur)) return cur;
 log('info', 'hitl oauth popup still on IdP — listening for callback', { url: cur || readPopupUrl() });
 return await new Promise((resolve) => {
 let settled = false;
 const finish = (value) => {
 if (settled) return;
 settled = true;
 popup.off('framenavigated', onNav);
 clearTimeout(timer);
 resolve(value);
 };
 const onNav = () => {
 if (popup.isClosed()) finish(null);
 else {
 const next = readPopupUrl();
 if (oauthCallbackUrl(next)) finish(next);
 }
 };
 popup.on('framenavigated', onNav);
 popup.once('close', () => finish(null));
 const timer = setTimeout(() => finish(null), Math.max(0, deadline - Date.now()));
 onNav();
 });
 };
 await popup.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
 if (!readPopupUrl() || readPopupUrl() === 'about:blank') {
 await popup.waitForURL((u) => u && u !== 'about:blank', { timeout: 60000 }).catch(() => {});
 }
 let url = readPopupUrl();
 if (!url || url === 'about:blank') {
 await popup.close().catch(() => {});
 return;
 }
 if (oauthIdp(url)) {
 log('info', 'hitl oauth popup waiting for callback', { url });
 await popup.bringToFront().catch(() => {});
 const callbackUrl = await waitOAuthCallback();
 if (!callbackUrl) {
 if (!popup.isClosed()) log('info', 'hitl oauth popup listener ended — leaving open', { url: readPopupUrl() });
 return;
 }
 url = callbackUrl;
 }
 const magic = slackMagic(url);
 const navTimeout = magic ? 90000 : 30000;
 await popup.waitForLoadState('load', { timeout: magic ? 60000 : 15000 }).catch(() => {});
 url = popup.url() || url;
 try {
 await page.evaluate((targetUrl) => { window.location.assign(String(targetUrl)); }, url);
 await page.waitForLoadState('domcontentloaded', { timeout: navTimeout });
 } catch (err) {
 log('warn', 'popup assign navigation failed', { url, error: err.message });
 await page.goto(url, { waitUntil: 'domcontentloaded', timeout: navTimeout }).catch((err2) => {
 log('warn', 'popup same-tab navigation failed', { url, error: err2.message });
 });
 }
 await popup.close().catch(() => {});
 log('info', 'popup coerced into opener tab', { url });
 } catch (err) {
 log('warn', 'popup coercion failed', { error: err.message });
 await popup.close().catch(() => {});
 }
 });`;

const popupPatch = `function createTabState(page) {
 if (process.env.HITL_FORCE_SINGLE_VISIBLE_PAGE !== 'false' && !page.__hitlSingleTabPopupPatch) {
 page.__hitlSingleTabPopupPatch = true;
${popupHandlerV6}
 }
`;

if (!alreadyHasPopupPatch && !source.includes("function createTabState(page) {\n")) {
  throw new Error(`Could not find createTabState() in ${target}`);
}
if (!alreadyHasPopupPatch) {
  source = source.replace("function createTabState(page) {\n", popupPatch);
}

// Camofox 1.16+ registers popups as managed tabs (JO-2456). HITL single-tab uses
// createTabState popup coercion instead — skip attachPopupHandler to avoid OAuth races.
const attachPopupSkipNeedle = "function attachPopupHandler(page, userId, sessionKey) {\n  page.on('popup', (popupPage) => {";
const attachPopupSkipPatch = `function attachPopupHandler(page, userId, sessionKey) {
  if (process.env.HITL_FORCE_SINGLE_VISIBLE_PAGE !== 'false') {
    return;
  }
  page.on('popup', (popupPage) => {`;
if (
  source.includes(attachPopupSkipNeedle) &&
  !source.includes("HITL single-tab uses createTabState popup coercion")
) {
  source = source.replace(attachPopupSkipNeedle, attachPopupSkipPatch);
  console.log(`[joshu] patched attachPopupHandler for HITL single-tab in ${target}`);
}

const viewportHelper = `
function __hitlViewportFromEnv() {
 const fromResolution = String(process.env.VNC_RESOLUTION || '').match(/^(\\d+)x(\\d+)/);
 const width = Number(process.env.CAMOFOX_VIEWPORT_WIDTH || fromResolution?.[1] || 1024);
 const height = Number(process.env.CAMOFOX_VIEWPORT_HEIGHT || fromResolution?.[2] || 768);
 return {
 width: Number.isFinite(width) && width > 0 ? width : 1024,
 height: Number.isFinite(height) && height > 0 ? height : 768,
 };
}

function __hitlStartUrlFromEnv() {
  // Empty / about:blank → no auto-navigate (do not coerce to news.google).
  const raw = String(process.env.CAMOFOX_START_URL || '').trim();
  if (!raw || raw === 'about:blank' || raw === 'about:home') return '';
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    return parsed.toString();
  } catch (_) {
    return '';
  }
}

// HITL_COLD_LAUNCH_WARM — after idle shutdown, load CAMOFOX_START_URL before heavy SPA first paint.
let __hitlBrowserColdLaunch = false;

function __hitlMarkBrowserColdLaunch() {
  __hitlBrowserColdLaunch = true;
}

function __hitlClearBrowserColdLaunch() {
  __hitlBrowserColdLaunch = false;
}

function __hitlNormalizeNavUrl(raw) {
  if (!raw) return '';
  try {
    const u = new URL(String(raw));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.toString();
  } catch (_) {
    return '';
  }
}

function __hitlUrlsEquivalent(a, b) {
  const na = __hitlNormalizeNavUrl(a);
  const nb = __hitlNormalizeNavUrl(b);
  if (!na || !nb) return false;
  try {
    const ua = new URL(na);
    const ub = new URL(nb);
    ua.hash = '';
    ub.hash = '';
    return ua.toString() === ub.toString();
  } catch (_) {
    return na === nb;
  }
}

async function __hitlWarmBeforeHeavyNav(page, targetUrl, reqId) {
  const target = __hitlNormalizeNavUrl(targetUrl);
  if (!target) return;
  const warmUrl = __hitlStartUrlFromEnv();
  // _lastBrowserRestartAt covers races where the cold flag was cleared before first nav.
  const recentlyLaunched =
    typeof _lastBrowserRestartAt === 'number' &&
    _lastBrowserRestartAt > 0 &&
    Date.now() - _lastBrowserRestartAt < 120000;
  const needsWarm =
    (__hitlBrowserColdLaunch || recentlyLaunched) &&
    warmUrl &&
    !__hitlUrlsEquivalent(target, warmUrl);
  if (!needsWarm) return;
  log('info', 'hitl cold launch warm before heavy nav', { reqId: reqId || null, warmUrl, targetUrl: target });
  try {
    await withPageLoadDuration('cold_warm', () =>
      page.goto(warmUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }),
    );
  } catch (err) {
    log('warn', 'hitl cold launch warm failed; continuing to target', { reqId: reqId || null, warmUrl, error: err.message });
  } finally {
    __hitlClearBrowserColdLaunch();
  }
}

async function __hitlGotoWithColdWarm(page, url, reqId, label = 'open_url') {
  await __hitlWarmBeforeHeavyNav(page, url, reqId);
  await withPageLoadDuration(label, () => page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }));
}

async function __hitlGotoWithColdWarmNavigate(page, url, reqId, label = 'open_url') {
  await __hitlWarmBeforeHeavyNav(page, url, reqId);
  return withPageLoadDuration(label, () => navigatePage(page, url));
}

// Camoufox images ship Firefox 135; sites like Slack block it ("browser not supported").
// Spoof a newer rv: in the fingerprint via launchOptions ff_version (not the binary).
function __hitlFfVersionFromEnv() {
  const raw = String(process.env.CAMOFOX_FF_VERSION ?? '139').trim();
  if (!raw || raw === '0' || raw.toLowerCase() === 'false' || raw.toLowerCase() === 'off') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 139;
}

function __hitlFfLaunchOverrides() {
  const ff = __hitlFfVersionFromEnv();
  if (!ff) return {};
  return { ff_version: ff, i_know_what_im_doing: true };
}

`;

if (!source.includes("function __hitlViewportFromEnv()")) {
  if (!source.includes("// Virtual display for WebGL support and anti-detection.")) {
    throw new Error(`Could not find viewport helper insertion point in ${target}`);
  }
  source = source.replace("// Virtual display for WebGL support and anti-detection.", `${viewportHelper}\n// Virtual display for WebGL support and anti-detection.`);
} else if (!source.includes("async function __hitlGotoWithColdWarmNavigate(")) {
  const navigateHelperOnly = `
async function __hitlGotoWithColdWarmNavigate(page, url, reqId, label = 'open_url') {
  await __hitlWarmBeforeHeavyNav(page, url, reqId);
  return withPageLoadDuration(label, () => navigatePage(page, url));
}
`;
  if (source.includes("async function __hitlGotoWithColdWarm(")) {
    source = source.replace(
      /async function __hitlGotoWithColdWarm\([\s\S]*?\n\}\n/,
      (block) => block + navigateHelperOnly,
    );
    console.log(`[joshu] inserted __hitlGotoWithColdWarmNavigate in ${target}`);
  }
}
if (!source.includes("async function __hitlGotoWithColdWarm(")) {
  const coldWarmOnly = `
// HITL_COLD_LAUNCH_WARM — after idle shutdown, load CAMOFOX_START_URL before heavy SPA first paint.
let __hitlBrowserColdLaunch = false;

function __hitlMarkBrowserColdLaunch() {
  __hitlBrowserColdLaunch = true;
}

function __hitlClearBrowserColdLaunch() {
  __hitlBrowserColdLaunch = false;
}

function __hitlNormalizeNavUrl(raw) {
  if (!raw) return '';
  try {
    const u = new URL(String(raw));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.toString();
  } catch (_) {
    return '';
  }
}

function __hitlUrlsEquivalent(a, b) {
  const na = __hitlNormalizeNavUrl(a);
  const nb = __hitlNormalizeNavUrl(b);
  if (!na || !nb) return false;
  try {
    const ua = new URL(na);
    const ub = new URL(nb);
    ua.hash = '';
    ub.hash = '';
    return ua.toString() === ub.toString();
  } catch (_) {
    return na === nb;
  }
}

async function __hitlWarmBeforeHeavyNav(page, targetUrl, reqId) {
  const target = __hitlNormalizeNavUrl(targetUrl);
  if (!target) return;
  const warmUrl = __hitlStartUrlFromEnv();
  // _lastBrowserRestartAt covers races where the cold flag was cleared before first nav.
  const recentlyLaunched =
    typeof _lastBrowserRestartAt === 'number' &&
    _lastBrowserRestartAt > 0 &&
    Date.now() - _lastBrowserRestartAt < 120000;
  const needsWarm =
    (__hitlBrowserColdLaunch || recentlyLaunched) &&
    warmUrl &&
    !__hitlUrlsEquivalent(target, warmUrl);
  if (!needsWarm) return;
  log('info', 'hitl cold launch warm before heavy nav', { reqId: reqId || null, warmUrl, targetUrl: target });
  try {
    await withPageLoadDuration('cold_warm', () =>
      page.goto(warmUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }),
    );
  } catch (err) {
    log('warn', 'hitl cold launch warm failed; continuing to target', { reqId: reqId || null, warmUrl, error: err.message });
  } finally {
    __hitlClearBrowserColdLaunch();
  }
}

async function __hitlGotoWithColdWarm(page, url, reqId, label = 'open_url') {
  await __hitlWarmBeforeHeavyNav(page, url, reqId);
  await withPageLoadDuration(label, () => page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }));
}
`;
  if (source.includes("function __hitlStartUrlFromEnv()")) {
    source = source.replace(
      /function __hitlStartUrlFromEnv\(\) \{[\s\S]*?\n\}\n/,
      (block) => block + coldWarmOnly,
    );
  } else {
    console.warn(`[joshu] cold-launch warm helpers insertion point not found in ${target}; skipping`);
  }
}

const localeHelperOnly = `
// With PROXY_* + geoip, Camoufox picks locale from regional language distribution (US can skew Spanish).
// locale in launchOptions overrides geoip-derived language for Intl + Accept-Language.
function __hitlLocaleFromEnv() {
  const raw = String(process.env.CAMOFOX_LOCALE ?? 'en-US').trim();
  if (!raw || raw === '0' || raw.toLowerCase() === 'false' || raw.toLowerCase() === 'off') return undefined;
  return raw;
}
`;

const ffHelperOnly = `
// Camoufox images ship Firefox 135; sites like Slack block it ("browser not supported").
// Spoof a newer rv: in the fingerprint via launchOptions ff_version (not the binary).
function __hitlFfVersionFromEnv() {
  const raw = String(process.env.CAMOFOX_FF_VERSION ?? '139').trim();
  if (!raw || raw === '0' || raw.toLowerCase() === 'false' || raw.toLowerCase() === 'off') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 139;
}
${localeHelperOnly}
function __hitlFfLaunchOverrides() {
  const ff = __hitlFfVersionFromEnv();
  if (!ff) return {};
  return { ff_version: ff, i_know_what_im_doing: true };
}
`;

if (!source.includes("function __hitlLocaleFromEnv()")) {
  if (source.includes("function __hitlFfVersionFromEnv()")) {
    source = source.replace(
      /function __hitlFfVersionFromEnv\(\) \{[\s\S]*?\n\}\n/,
      (block) => block + localeHelperOnly,
    );
    console.log(`[joshu] inserted __hitlLocaleFromEnv in ${target}`);
  } else if (source.includes("function __hitlStartUrlFromEnv()")) {
    source = source.replace(
      /function __hitlStartUrlFromEnv\(\) \{[\s\S]*?\n\}\n/,
      (block) => block + localeHelperOnly,
    );
    console.log(`[joshu] inserted __hitlLocaleFromEnv in ${target}`);
  } else {
    console.warn(`[joshu] __hitlLocaleFromEnv insertion point not found in ${target}; skipping`);
  }
}

if (!source.includes("function __hitlFfLaunchOverrides()")) {
  if (source.includes("function __hitlStartUrlFromEnv()")) {
    source = source.replace(
      /function __hitlStartUrlFromEnv\(\) \{[\s\S]*?\n\}\n/,
      (block) => block + ffHelperOnly,
    );
  } else if (source.includes("function __hitlViewportFromEnv()")) {
    source = source.replace(
      /function __hitlViewportFromEnv\(\) \{[\s\S]*?\n\}\n/,
      (block) => block + ffHelperOnly,
    );
  } else {
    console.warn(`[joshu] __hitlFfLaunchOverrides insertion point not found in ${target}; skipping`);
  }
}

const fitBrowserHelper = `
async function __hitlFitBrowserWindow(page, override) {
 const env = __hitlViewportFromEnv();
 const width = Math.max(320, Math.min(4096, Math.floor(Number(override?.width ?? env.width))));
 const height = Math.max(240, Math.min(4096, Math.floor(Number(override?.height ?? env.height))));
 if (!Number.isFinite(width) || !Number.isFinite(height)) return;
 await page.setViewportSize({ width, height }).catch(() => {});
 await page.evaluate(({ width, height }) => {
   try { window.moveTo(0, 0); } catch (_) {}
   const sw = window.screen?.width || width;
   const sh = window.screen?.height || height;
   try { window.resizeTo(sw, sh); } catch (_) {}
   try { window.resizeTo(width, height); } catch (_) {}
 }, { width, height }).catch(() => {});
}
`;

if (!source.includes("async function __hitlFitBrowserWindow(")) {
  if (source.includes("function __hitlStartUrlFromEnv()")) {
    source = source.replace(
      "function __hitlStartUrlFromEnv() {",
      `${fitBrowserHelper}\nfunction __hitlStartUrlFromEnv() {`,
    );
  } else if (source.includes("function __hitlViewportFromEnv()")) {
    source = source.replace(
      "function __hitlViewportFromEnv() {",
      `${fitBrowserHelper}\nfunction __hitlViewportFromEnv() {`,
    );
  } else {
    console.warn(`[joshu] __hitlFitBrowserWindow insertion point not found in ${target}; skipping`);
  }
} else if (!source.includes("async function __hitlFitBrowserWindow(page, override)")) {
  const legacyFitStart = source.indexOf("async function __hitlFitBrowserWindow(page) {");
  if (legacyFitStart >= 0) {
    let depth = 0;
    let end = legacyFitStart;
    for (let i = legacyFitStart; i < source.length; i++) {
      const ch = source[i];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    source = source.slice(0, legacyFitStart) + fitBrowserHelper.trim() + source.slice(end);
  } else {
    console.warn(`[joshu] legacy __hitlFitBrowserWindow(page) not found in ${target}; skipping upgrade`);
  }
}

source = source.replaceAll(
  "viewport: { width: 1280, height: 720 },",
  "viewport: __hitlViewportFromEnv(),",
);

// Close only the requesting user's tabs — not every Camofox session (Hermes vs Joshu
// must not destroy each other's visible page when one side creates a tab).
const sessionTabCleanupHelper = `
async function __hitlCloseExistingTabsForSession(session, userKey, reqId, reason) {
 if (process.env.HITL_FORCE_SINGLE_VISIBLE_PAGE === 'false') return;
 if (!session?.tabGroups) return;
 for (const [groupKey, group] of session.tabGroups) {
 for (const [tabId, tabState] of group) {
 await safePageClose(tabState.page);
 const lock = tabLocks.get(tabId);
 if (lock) { lock.drain(); tabLocks.delete(tabId); }
 pluginEvents.emit('tab:destroyed', { userId: userKey || null, tabId, reason });
 log('info', 'hitl closed existing tab before create', { reqId, userId: userKey, groupKey, tabId, reason });
 }
 group.clear();
 if (group.size === 0) session.tabGroups.delete(groupKey);
 }
 refreshTabLockQueueDepth();
 refreshActiveTabsGauge();
}
`;

const legacyGlobalCleanup = "async function __hitlCloseAllVisibleTabs(";
if (source.includes(legacyGlobalCleanup)) {
  source = source.replace(
    /async function __hitlCloseAllVisibleTabs\([\s\S]*?^}\n/m,
    sessionTabCleanupHelper.trim() + "\n",
  );
  source = source.replace(
    /await __hitlCloseAllVisibleTabs\(req\.reqId, 'hitl_single_visible_page_create_before_limits'\);/g,
    "await __hitlCloseExistingTabsForSession(session, userId, req.reqId, 'hitl_single_visible_page_create_before_limits');",
  );
  source = source.replace(
    /await __hitlCloseAllVisibleTabs\(req\.reqId, 'hitl_single_visible_page_create'\);/g,
    "await __hitlCloseExistingTabsForSession(session, userId, req.reqId, 'hitl_single_visible_page_create');",
  );
} else if (!source.includes("async function __hitlCloseExistingTabsForSession(")) {
  if (!source.includes("async function recycleOldestTab(session, reqId, userId) {\n")) {
    throw new Error(`Could not find recycleOldestTab() in ${target}`);
  }
  source = source.replace("async function recycleOldestTab(session, reqId, userId) {\n", `${sessionTabCleanupHelper}\nasync function recycleOldestTab(session, reqId, userId) {\n`);
}

const createNeedle = "      const group = getTabGroup(session, resolvedSessionKey);\n      \n      const page = await session.context.newPage();";
const staleCreatePatch = "      const group = getTabGroup(session, resolvedSessionKey);\n      await __hitlCloseAllVisibleTabs(req.reqId, 'hitl_single_visible_page_create');\n      \n      const page = await session.context.newPage();";
const createPatch = "      await __hitlCloseAllVisibleTabs(req.reqId, 'hitl_single_visible_page_create');\n      const group = getTabGroup(session, resolvedSessionKey);\n      \n      const page = await session.context.newPage();";
if (source.includes(staleCreatePatch)) {
  source = source.replace(staleCreatePatch, createNeedle);
}
if (source.includes(createPatch)) {
  source = source.replace(createPatch, createNeedle);
}

const beforeLimitVariants = [
  {
    needle:
      "      const session = await getSession(userId, { trace: !!trace });\n      \n      let totalTabs = 0;",
    patch:
      "      const session = await getSession(userId, { trace: !!trace });\n      await __hitlCloseExistingTabsForSession(session, userId, req.reqId, 'hitl_single_visible_page_create_before_limits');\n      \n      let totalTabs = 0;",
  },
  {
    needle:
      "      let session = await getSession(userId, { trace: !!trace });\n      \n      let totalTabs = 0;",
    patch:
      "      let session = await getSession(userId, { trace: !!trace });\n      await __hitlCloseExistingTabsForSession(session, userId, req.reqId, 'hitl_single_visible_page_create_before_limits');\n      \n      let totalTabs = 0;",
  },
];
let beforeLimitApplied = false;
for (const { needle, patch } of beforeLimitVariants) {
  if (source.includes(needle) && !source.includes("hitl_single_visible_page_create_before_limits")) {
    source = source.replace(needle, patch);
    beforeLimitApplied = true;
    break;
  }
}
if (
  !beforeLimitApplied &&
  !source.includes("hitl_single_visible_page_create_before_limits") &&
  !source.includes("__hitlCloseExistingTabsForSession(session, userId")
) {
  throw new Error(`Could not find /tabs pre-limit cleanup insertion point in ${target}`);
}

const viewportRoute = `
app.post('/tabs/:tabId/viewport', async (req, res) => {
  try {
    const { tabId } = req.params;
    const { userId, width, height } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const session = sessions.get(normalizeUserId(userId));
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const found = findTab(session, tabId);
    if (!found) return res.status(404).json({ error: 'Tab not found' });

    const nextWidth = Math.max(320, Math.min(4096, Math.floor(Number(width))));
    const nextHeight = Math.max(240, Math.min(4096, Math.floor(Number(height))));
    if (!Number.isFinite(nextWidth) || !Number.isFinite(nextHeight)) {
      return res.status(400).json({ error: 'width and height must be finite numbers' });
    }

    await __hitlFitBrowserWindow(found.tabState.page, { width: nextWidth, height: nextHeight });

    log('info', 'hitl viewport resized', { reqId: req.reqId, tabId, userId, width: nextWidth, height: nextHeight });
    res.json({ ok: true, width: nextWidth, height: nextHeight });
  } catch (err) {
    log('warn', 'hitl viewport resize failed', { reqId: req.reqId, error: err.message });
    handleRouteError(err, req, res);
  }
});

`;

const viewportFitCall =
  "await __hitlFitBrowserWindow(found.tabState.page, { width: nextWidth, height: nextHeight });";

function replaceViewportRouteBlock(src) {
  const marker = "app.post('/tabs/:tabId/viewport', async (req, res) => {";
  const start = src.indexOf(marker);
  if (start < 0) return src;
  let depth = 0;
  let end = start;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        end = i + 1;
        // Upstream route closes with `});` — must consume `)` as well as `;`, or re-patch leaves `}););`.
        while (end < src.length && /[);\r\n\s]/.test(src[end])) end++;
        break;
      }
    }
  }
  return src.slice(0, start) + viewportRoute.trim() + src.slice(end);
}

if (!source.includes(viewportFitCall)) {
  if (source.includes("app.post('/tabs/:tabId/viewport'")) {
    source = replaceViewportRouteBlock(source);
  } else if (!source.includes("hitl viewport resized")) {
    const viewportRouteNeedle = "// Navigate\n";
    if (!source.includes(viewportRouteNeedle)) {
      throw new Error(`Could not find viewport route insertion point in ${target}`);
    }
    source = source.replace(viewportRouteNeedle, `${viewportRoute}// Navigate\n`);
  } else {
    throw new Error(`Camofox viewport route exists but is not upgradeable in ${target}`);
  }
}

if (!source.includes("app.post('/tabs/:tabId/viewport'")) {
  throw new Error(`Camofox viewport resize route was not installed in ${target}`);
}

// Camoufox fingerprints screen/window at launch (defaults ~1920x1080). Playwright
// setViewportSize cannot override that — pass window size into launchOptions.
// Camofox 1.6+ may insert `executable_path` and/or partial firefox_user_prefs before the closer.
const launchOptionsPatch = `      const __hitlVp = __hitlViewportFromEnv();
      const options = await launchOptions({
        executable_path: externalCamoufox?.executablePath,
        headless: useVirtualDisplay ? false : true,
        os: hostOS,
        humanize: true,
        enable_cache: true,
        proxy: launchProxy,
        geoip: !!launchProxy,
        locale: __hitlLocaleFromEnv(),
        virtual_display: vdDisplay,
        window: [__hitlVp.width, __hitlVp.height],
        ...__hitlFfLaunchOverrides(),
        firefox_user_prefs: {
          'browser.link.open_newwindow': 1,
          'browser.link.open_newwindow.restriction': 0,
          'browser.link.open_newwindow.override.external': 1,
        },
      });`;

if (!source.includes("window: [__hitlVp.width, __hitlVp.height]")) {
  // Prefer a surgical insert after `virtual_display` — full-block replace is fragile on
  // Camofox 1.6 when firefox_user_prefs (or other keys) sit between vdDisplay and `});`,
  // and a wrong closer can truncate the launch function (browser stays null → newContext crash).
  const start = source.indexOf("const options = await launchOptions({");
  const vdLine = start >= 0 ? source.indexOf("virtual_display: vdDisplay,", start) : -1;
  if (start >= 0 && vdLine > start) {
    const optLine = source.lastIndexOf("\n", start) + 1;
    let next = source;
    if (!next.slice(Math.max(0, optLine - 120), optLine).includes("__hitlVp = __hitlViewportFromEnv()")) {
      next = next.slice(0, optLine) + "      const __hitlVp = __hitlViewportFromEnv();\n" + next.slice(optLine);
    }
    const vd2 = next.indexOf("virtual_display: vdDisplay,", next.indexOf("const options = await launchOptions({"));
    const end2 = next.indexOf("\n", vd2);
    next =
      next.slice(0, end2) +
      "\n        window: [__hitlVp.width, __hitlVp.height],\n        ...__hitlFfLaunchOverrides()," +
      next.slice(end2);
    source = next;
    console.log(`[joshu] inserted launchOptions window size via virtual_display line in ${target}`);
  } else {
    // Legacy full-block replace (older Camofox layouts without prefs between vd and closer).
    const launchStart = source.indexOf("      const options = await launchOptions({");
    const vdMarker = launchStart >= 0 ? source.indexOf("virtual_display: vdDisplay,", launchStart) : -1;
    const launchEnd = vdMarker >= 0 ? source.indexOf("\n      });", vdMarker) : -1;
    if (
      launchStart >= 0 &&
      vdMarker > launchStart &&
      launchEnd > vdMarker &&
      source.includes("await firefox.launch(options)", launchEnd)
    ) {
      source =
        source.slice(0, launchStart) +
        launchOptionsPatch +
        source.slice(launchEnd + "\n      });".length);
      console.log(`[joshu] replaced launchOptions block with window size in ${target}`);
    } else {
      console.warn(`[joshu] launchOptions window-size patch point not found in ${target}; skipping`);
    }
  }
} else if (!source.includes("__hitlFfLaunchOverrides()")) {
  source = source.replace(
    "        window: [__hitlVp.width, __hitlVp.height],\n",
    "        window: [__hitlVp.width, __hitlVp.height],\n        ...__hitlFfLaunchOverrides(),\n",
  );
}
source = source.replace(
  /\n\s+ff_version: \d+,\n\s+i_know_what_im_doing: true,\n/g,
  "\n        ...__hitlFfLaunchOverrides(),\n",
);
while (source.includes("...__hitlFfLaunchOverrides(),\n        ...__hitlFfLaunchOverrides(),")) {
  source = source.replace(
    "...__hitlFfLaunchOverrides(),\n        ...__hitlFfLaunchOverrides(),",
    "...__hitlFfLaunchOverrides(),",
  );
}

// Force English when residential proxy + geoip skew locale (Decodo US exits can still pick es-*).
const launchLocaleNeedle =
  "locale: launchLocale({ hasProxy: !!proxyPool, directIdentity: CONFIG.directIdentity }),";
const launchLocalePatch =
  "locale: __hitlLocaleFromEnv() ?? launchLocale({ hasProxy: !!proxyPool, directIdentity: CONFIG.directIdentity }),";
if (!source.includes("locale: __hitlLocaleFromEnv()")) {
  if (source.includes(launchLocaleNeedle)) {
    source = source.replace(launchLocaleNeedle, launchLocalePatch);
    console.log(`[joshu] patched launchLocale → __hitlLocaleFromEnv in ${target}`);
  } else if (source.includes("geoip: !!launchProxy,")) {
    source = source.replace(
      "        geoip: !!launchProxy,\n",
      "        geoip: !!launchProxy,\n        locale: __hitlLocaleFromEnv(),\n",
    );
    console.log(`[joshu] inserted launchOptions locale in ${target}`);
  } else {
    console.warn(`[joshu] launchOptions geoip patch point not found in ${target}; skipping locale`);
  }
}
// Camofox 1.16+ — buildLaunchOptionsWithGeoipFallback (replaces direct launchOptions call).
if (!source.includes("window: [__hitlVp.width, __hitlVp.height]")) {
  const blStart = source.indexOf("const options = await buildLaunchOptionsWithGeoipFallback({");
  if (blStart >= 0) {
    const optLine = source.lastIndexOf("\n", blStart) + 1;
    if (!source.slice(Math.max(0, optLine - 120), optLine).includes("__hitlVp = __hitlViewportFromEnv()")) {
      source = source.slice(0, optLine) + "      const __hitlVp = __hitlViewportFromEnv();\n" + source.slice(optLine);
    }
    if (source.includes(launchLocaleNeedle)) {
      source = source.replace(launchLocaleNeedle, launchLocalePatch);
    }
    const vdIdx = source.indexOf("virtual_display: vdDisplay,", source.indexOf("buildLaunchOptionsWithGeoipFallback({"));
    const vdEnd = vdIdx > 0 ? source.indexOf("\n", vdIdx) : -1;
    if (vdIdx > 0 && vdEnd > vdIdx) {
      source =
        source.slice(0, vdEnd) +
        "\n        window: [__hitlVp.width, __hitlVp.height],\n        ...__hitlFfLaunchOverrides()," +
        source.slice(vdEnd);
      console.log(`[joshu] inserted buildLaunchOptions window size in ${target}`);
    }
  }
}
if (!source.includes("HITL — single-tab window.open prefs")) {
  const prefsMergeNeedle = "      options.proxy = normalizePlaywrightProxy(options.proxy);\n";
  const prefsMergePatch = `      options.proxy = normalizePlaywrightProxy(options.proxy);
      // HITL — single-tab window.open prefs
      options.firefox_user_prefs = {
        ...(options.firefox_user_prefs || {}),
        'browser.link.open_newwindow': 1,
        'browser.link.open_newwindow.restriction': 0,
        'browser.link.open_newwindow.override.external': 1,
      };
`;
  if (source.includes(prefsMergeNeedle)) {
    source = source.replace(prefsMergeNeedle, prefsMergePatch);
    console.log(`[joshu] merged firefox_user_prefs after buildLaunchOptions in ${target}`);
  }
}
// Remove duplicate locale key if an older patch inserted __hitlLocaleFromEnv before launchLocale.
source = source.replace(
  /geoip: !!launchProxy,\n\s+locale: __hitlLocaleFromEnv\(\),\n(\s+locale: launchLocale)/g,
  "geoip: !!launchProxy,\n        locale: __hitlLocaleFromEnv() ?? launchLocale",
);

const tabCreateOpenNeedle = `      if (url) {
        const urlErr = validateUrl(url);
        if (urlErr) throw Object.assign(new Error(urlErr), { statusCode: 400 });
        tabState.lastRequestedUrl = url;
        await withPageLoadDuration('open_url', () => page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }));
        tabState.visitedUrls.add(url);
      }`;

const tabCreateOpenPatch = `      const __hitlOpenUrl = url || __hitlStartUrlFromEnv();
      if (__hitlOpenUrl) {
        const urlErr = validateUrl(__hitlOpenUrl);
        if (urlErr) throw Object.assign(new Error(urlErr), { statusCode: 400 });
        tabState.lastRequestedUrl = __hitlOpenUrl;
        await withPageLoadDuration('open_url', () => page.goto(__hitlOpenUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }));
        tabState.visitedUrls.add(__hitlOpenUrl);
      }`;

if (source.includes(tabCreateOpenNeedle)) {
  source = source.replace(tabCreateOpenNeedle, tabCreateOpenPatch);
} else if (!source.includes("__hitlOpenUrl = url || __hitlStartUrlFromEnv()")) {
  const tabCreateOpenNeedle16 = `      if (url) {
        const urlErr = validateUrl(url);
        if (urlErr) throw Object.assign(new Error(urlErr), { statusCode: 400 });
        tabState.lastRequestedUrl = url;
        try {
          const navigationResponse = await withPageLoadDuration('open_url', () => navigatePage(page, url));`;
  const tabCreateOpenPatch16 = `      const __hitlOpenUrl = url || __hitlStartUrlFromEnv();
      if (__hitlOpenUrl) {
        const urlErr = validateUrl(__hitlOpenUrl);
        if (urlErr) throw Object.assign(new Error(urlErr), { statusCode: 400 });
        tabState.lastRequestedUrl = __hitlOpenUrl;
        try {
          const navigationResponse = await withPageLoadDuration('open_url', () => __hitlGotoWithColdWarmNavigate(page, __hitlOpenUrl, req.reqId));`;
  if (source.includes(tabCreateOpenNeedle16)) {
    source = source.replace(tabCreateOpenNeedle16, tabCreateOpenPatch16);
    console.log(`[joshu] patched tab create navigatePage start URL in ${target}`);
  } else {
    console.warn(`[joshu] tab create start URL patch point not found in ${target}; skipping`);
  }
}

const tabCreateFitNeedle = `        tabState.visitedUrls.add(__hitlOpenUrl);
      }
      
      pluginEvents.emit('tab:created', { userId, tabId, page, url: page.url() });`;

const tabCreateFitPatch = `        tabState.visitedUrls.add(__hitlOpenUrl);
      }

      await __hitlFitBrowserWindow(page);
      
      pluginEvents.emit('tab:created', { userId, tabId, page, url: page.url() });`;

if (source.includes(tabCreateFitNeedle)) {
  source = source.replace(tabCreateFitNeedle, tabCreateFitPatch);
} else if (!source.includes("await __hitlFitBrowserWindow(page);")) {
  const tabCreateFitNeedle16 = `        tabState.visitedUrls.add(url);
      }
      
      pluginEvents.emit('tab:created', { userId, tabId, page, url: page.url() });
      log('info', 'tab created', { reqId: req.reqId, tabId, userId, sessionKey: resolvedSessionKey, url: page.url() });`;
  const tabCreateFitPatch16 = `        tabState.visitedUrls.add(__hitlOpenUrl);
      }

      await __hitlFitBrowserWindow(page);
      
      pluginEvents.emit('tab:created', { userId, tabId, page, url: page.url() });
      log('info', 'tab created', { reqId: req.reqId, tabId, userId, sessionKey: resolvedSessionKey, url: page.url() });`;
  if (source.includes(tabCreateFitNeedle16)) {
    source = source.replace(tabCreateFitNeedle16, tabCreateFitPatch16);
    console.log(`[joshu] patched tab create window-fit (navigatePage) in ${target}`);
  } else {
    console.warn(`[joshu] tab create window-fit patch point not found in ${target}; skipping`);
  }
}

if (!source.includes("firefox_user_prefs")) {
  const firefoxPrefs = `firefox_user_prefs: {
          'browser.link.open_newwindow': 1,
          'browser.link.open_newwindow.restriction': 0,
          'browser.link.open_newwindow.override.external': 1,
        },
        `;
  const launchCloseRe =
    /(virtual_display: vdDisplay,\n(?:\s+window: \[__hitlVp\.width, __hitlVp\.height\],\n)?)(\s+\}\);)/;
  if (launchCloseRe.test(source)) {
    source = source.replace(launchCloseRe, `$1${firefoxPrefs}$2`);
  } else {
    console.warn(`[joshu] launchOptions() insertion point not found in ${target}; skipping Firefox pref patch`);
  }
}

source = source.replaceAll(
  "await __hitlFitBrowserWindow(found.tabState.page);",
  viewportFitCall,
);

if (!source.includes("async function __hitlFitBrowserWindow(page, override)")) {
  throw new Error(`__hitlFitBrowserWindow(page, override) was not installed in ${target}`);
}
if (!source.includes(viewportFitCall)) {
  throw new Error(`Camofox viewport route must call __hitlFitBrowserWindow with width/height in ${target}`);
}

// ---------------------------------------------------------------------------
// HITL clipboard: insert into the focused field (Joshu paste) and read selection.
// x11vnc does not reliably sync Firefox clipboard to the Mac/host.
// page.evaluate(fn, arg) avoids Camofox /type (needs a snapshot ref) and the
// 64KB /evaluate expression cap.
// ---------------------------------------------------------------------------
const hitlClipboardNeedles = [
  "// Press key\n/**\n * @openapi\n * /tabs/{tabId}/press:",
  "app.post('/tabs/:tabId/press', async (req, res) => {",
];

if (!source.includes("HITL_INSERT_TEXT_ROUTE")) {
  const insertRoute = `
// HITL_INSERT_TEXT_ROUTE — paste into focused page control without VNC keysyms
app.post('/tabs/:tabId/insert-text', async (req, res) => {
  const tabId = req.params.tabId;
  try {
    const { userId, text, selectAll } = req.body || {};
    const session = sessions.get(normalizeUserId(userId));
    const found = session && findTab(session, tabId);
    if (!found) return tabNotFoundResponse(res, tabId);
    session.lastAccess = Date.now();
    const { tabState } = found;
    tabState.toolCalls++; tabState.consecutiveTimeouts = 0; tabState.consecutiveFailures = 0;
    const payload = { text: String(text || ''), selectAll: selectAll === true };
    const result = await withTabLock(tabId, async () => {
      return await tabState.page.evaluate(({ text, selectAll }) => {
        let el = document.activeElement;
        while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
        if (!el || el === document.body || el === document.documentElement) return { ok: false, reason: 'no-field' };
        const tag = String(el.tagName || '').toUpperCase();
        const type = tag === 'INPUT' ? String(el.type || 'text').toLowerCase() : '';
        const skip = ['button', 'submit', 'checkbox', 'radio', 'file', 'image', 'reset', 'hidden', 'color', 'range'];
        if (tag === 'INPUT' && skip.includes(type)) return { ok: false, reason: 'non-text-input' };
        if (tag === 'INPUT' || tag === 'TEXTAREA') {
          if (el.disabled || el.readOnly) return { ok: false, reason: 'readonly' };
          const value = String(el.value || '');
          const start = selectAll ? 0 : (el.selectionStart == null ? value.length : el.selectionStart);
          const end = selectAll ? value.length : (el.selectionEnd == null ? start : el.selectionEnd);
          const next = value.slice(0, start) + text + value.slice(end);
          const proto = tag === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const desc = Object.getOwnPropertyDescriptor(proto, 'value');
          if (desc && desc.set) desc.set.call(el, next);
          else el.value = next;
          try { el.setSelectionRange(start + text.length, start + text.length); } catch (e) {}
          el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertFromPaste', data: text }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return { ok: true, via: 'value', chars: text.length };
        }
        if (el.isContentEditable) {
          el.focus();
          if (selectAll) document.execCommand('selectAll', false, null);
          const okEdit = document.execCommand('insertText', false, text);
          return { ok: !!okEdit, via: 'execCommand', chars: text.length };
        }
        const okAny = document.execCommand('insertText', false, text);
        if (okAny) return { ok: true, via: 'execCommand-fallback', chars: text.length };
        return { ok: false, reason: 'not-a-field' };
      }, payload);
    });
    res.json(result || { ok: false, reason: 'no-field' });
  } catch (err) {
    log('error', 'insert-text failed', { reqId: req.reqId, error: err.message });
    handleRouteError(err, req, res);
  }
});

`;
  let insertInserted = false;
  for (const needle of hitlClipboardNeedles) {
    if (source.includes(needle)) {
      source = source.replace(needle, insertRoute + needle);
      insertInserted = true;
      break;
    }
  }
  if (!insertInserted) {
    console.warn(`[joshu] insert-text route insertion point not found in ${target}; skipping`);
  }
}

if (!source.includes("HITL_SELECTION_ROUTE")) {
  const selectionRoute = `
// HITL_SELECTION_ROUTE — read focused/selected text without VNC clipboard (x11vnc drops it)
app.post('/tabs/:tabId/selection', async (req, res) => {
  const tabId = req.params.tabId;
  try {
    const { userId } = req.body || {};
    const session = sessions.get(normalizeUserId(userId));
    const found = session && findTab(session, tabId);
    if (!found) return tabNotFoundResponse(res, tabId);
    session.lastAccess = Date.now();
    const { tabState } = found;
    tabState.toolCalls++; tabState.consecutiveTimeouts = 0; tabState.consecutiveFailures = 0;
    const text = await withTabLock(tabId, async () => {
      return await tabState.page.evaluate(() => {
        let el = document.activeElement;
        while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
        if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && typeof el.selectionStart === 'number') {
          const start = el.selectionStart ?? 0;
          const end = el.selectionEnd ?? 0;
          if (end > start) return String(el.value || '').slice(start, end);
          return String(el.value || '');
        }
        if (el && el.isContentEditable) {
          const inner = String(window.getSelection ? window.getSelection() : '') || '';
          if (inner.trim()) return inner;
          return String(el.innerText || el.textContent || '');
        }
        return window.getSelection ? String(window.getSelection() || '') : '';
      });
    });
    res.json({ ok: true, text: text || '' });
  } catch (err) {
    log('error', 'selection failed', { reqId: req.reqId, error: err.message });
    handleRouteError(err, req, res);
  }
});

`;
  const selectionNeedles = [
    "// Press key\n/**\n * @openapi\n * /tabs/{tabId}/press:",
    "app.post('/tabs/:tabId/press', async (req, res) => {",
  ];
  let selectionInserted = false;
  for (const needle of selectionNeedles) {
    if (source.includes(needle)) {
      source = source.replace(needle, selectionRoute + needle);
      selectionInserted = true;
      break;
    }
  }
  if (!selectionInserted) {
    console.warn(`[joshu] selection route insertion point not found in ${target}; skipping`);
  }
}

if (!source.includes("HITL_FORM_FIELDS_ROUTE")) {
  const formFieldsRoute = `
// HITL_FORM_FIELDS_ROUTE — enumerate fillable controls + buttons (no password/card values)
app.post('/tabs/:tabId/form-fields', async (req, res) => {
  const tabId = req.params.tabId;
  try {
    const { userId } = req.body || {};
    const session = sessions.get(normalizeUserId(userId));
    const found = session && findTab(session, tabId);
    if (!found) return tabNotFoundResponse(res, tabId);
    session.lastAccess = Date.now();
    const { tabState } = found;
    tabState.toolCalls++; tabState.consecutiveTimeouts = 0; tabState.consecutiveFailures = 0;
    const result = await withTabLock(tabId, async () => {
      const frames = tabState.page.frames();
      const fields = [];
      const buttons = [];
      for (let i = 0; i < frames.length; i++) {
        const part = await frames[i].evaluate((frameIndex) => {
          const MAX_FIELDS = 16;
          const SKIP_TYPES = ['hidden', 'button', 'submit', 'file', 'image', 'reset', 'color', 'range'];
          const SECRET_TYPES = ['password'];
          const SECRET_AUTO = ['current-password', 'new-password', 'cc-number', 'cc-csc', 'cc-exp', 'cc-exp-month', 'cc-exp-year', 'one-time-code'];
          function usable(el) {
            if (!el || el.disabled) return false;
            try {
              const style = window.getComputedStyle(el);
              if (style.display === 'none' || style.visibility === 'hidden') return false;
              if (Number(style.opacity) === 0) return false;
            } catch (e) {}
            const r = el.getBoundingClientRect();
            if ((r.width < 2 && r.height < 2) && el.offsetWidth < 2 && el.offsetHeight < 2) return false;
            return true;
          }
          function labelFor(el) {
            const aria = String(el.getAttribute('aria-label') || '').trim();
            if (aria) return aria.slice(0, 80);
            const id = el.id ? String(el.id) : '';
            if (id) {
              try {
                const lab = document.querySelector('label[for="' + CSS.escape(id) + '"]');
                if (lab) return String(lab.innerText || lab.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
              } catch (e) {}
            }
            const wrap = el.closest && el.closest('label');
            if (wrap) return String(wrap.innerText || wrap.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
            return String(el.getAttribute('placeholder') || el.getAttribute('name') || '').slice(0, 80);
          }
          function walkRoots(root, visit) {
            if (!root || !root.querySelectorAll) return;
            visit(root);
            const all = root.querySelectorAll('*');
            for (let n = 0; n < all.length; n++) {
              if (all[n].shadowRoot) walkRoots(all[n].shadowRoot, visit);
            }
          }
          const outFields = [];
          const outButtons = [];
          let fieldN = 0;
          let buttonN = 0;
          walkRoots(document, (root) => {
            const nodes = root.querySelectorAll('input, textarea, select, [contenteditable="true"], [contenteditable=""]');
            for (let n = 0; n < nodes.length; n++) {
              if (outFields.length >= MAX_FIELDS) break;
              const el = nodes[n];
              const tag = String(el.tagName || '').toUpperCase();
              const type = tag === 'INPUT' ? String(el.type || 'text').toLowerCase() : (tag === 'TEXTAREA' ? 'textarea' : tag === 'SELECT' ? 'select' : 'text');
              if (tag === 'INPUT' && SKIP_TYPES.indexOf(type) !== -1) continue;
              if (!usable(el)) continue;
              const hid = 'f' + frameIndex + '-e' + fieldN;
              fieldN += 1;
              el.setAttribute('data-joshu-handoff', hid);
              const autocomplete = String(el.getAttribute('autocomplete') || '').trim();
              const secret = SECRET_TYPES.indexOf(type) !== -1 || SECRET_AUTO.indexOf(autocomplete.toLowerCase()) !== -1;
              const rec = {
                id: hid,
                tag: tag,
                type: type,
                name: String(el.getAttribute('name') || '').slice(0, 80),
                elementId: String(el.id || '').slice(0, 80),
                autocomplete: autocomplete.slice(0, 80),
                placeholder: String(el.getAttribute('placeholder') || '').slice(0, 80),
                label: labelFor(el),
              };
              if (tag === 'SELECT') {
                rec.options = [];
                const opts = el.options || [];
                // Birth years / country lists run 100–250 entries (overlay dropdown).
                for (let o = 0; o < opts.length && rec.options.length < 300; o++) {
                  rec.options.push({
                    value: String(opts[o].value || ''),
                    label: String(opts[o].text || opts[o].value || '').slice(0, 80),
                  });
                }
              }
              if (type === 'checkbox' || type === 'radio') rec.checked = !!el.checked;
              if (!secret && tag !== 'SELECT' && type !== 'checkbox' && type !== 'radio' && typeof el.value === 'string' && el.value) {
                rec.value = String(el.value).slice(0, 200);
              }
              outFields.push(rec);
            }
            const btnNodes = root.querySelectorAll('button, input[type="submit"], input[type="button"], [role="button"]');
            for (let n = 0; n < btnNodes.length; n++) {
              if (outButtons.length >= 12) break;
              const el = btnNodes[n];
              if (!usable(el)) continue;
              const hid = 'f' + frameIndex + '-b' + buttonN;
              buttonN += 1;
              el.setAttribute('data-joshu-handoff', hid);
              const text = String(el.innerText || el.value || el.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
              outButtons.push({
                id: hid,
                text: text,
                type: String(el.type || el.getAttribute('type') || 'button').toLowerCase(),
                ariaLabel: String(el.getAttribute('aria-label') || '').slice(0, 80),
              });
            }
          });
          return { fields: outFields, buttons: outButtons };
        }, i);
        if (part && Array.isArray(part.fields)) fields.push(...part.fields);
        if (part && Array.isArray(part.buttons)) buttons.push(...part.buttons);
      }
      return { fields: fields.slice(0, 16), buttons: buttons.slice(0, 12) };
    });
    res.json({ ok: true, fields: result.fields || [], buttons: result.buttons || [] });
  } catch (err) {
    log('error', 'form-fields failed', { reqId: req.reqId, error: err.message });
    handleRouteError(err, req, res);
  }
});

`;
  let formFieldsInserted = false;
  for (const needle of hitlClipboardNeedles) {
    if (source.includes(needle)) {
      source = source.replace(needle, formFieldsRoute + needle);
      formFieldsInserted = true;
      break;
    }
  }
  if (!formFieldsInserted) {
    console.warn(`[joshu] form-fields route insertion point not found in ${target}; skipping`);
  }
}

if (!source.includes("HITL_FILL_FORM_ROUTE")) {
  const fillFormRoute = `
// HITL_FILL_FORM_ROUTE — fill stamped controls then click a catalog button id (no LLM)
app.post('/tabs/:tabId/fill-form', async (req, res) => {
  const tabId = req.params.tabId;
  try {
    const { userId, fields, buttonId } = req.body || {};
    const session = sessions.get(normalizeUserId(userId));
    const found = session && findTab(session, tabId);
    if (!found) return tabNotFoundResponse(res, tabId);
    session.lastAccess = Date.now();
    const { tabState } = found;
    tabState.toolCalls++; tabState.consecutiveTimeouts = 0; tabState.consecutiveFailures = 0;
    const items = Array.isArray(fields) ? fields : [];
    const clickId = buttonId ? String(buttonId) : '';
    const result = await withTabLock(tabId, async () => {
      const frames = tabState.page.frames();
      const filled = [];
      const missing = [];
      let clicked = null;
      for (let i = 0; i < frames.length; i++) {
        const prefix = 'f' + i + '-';
        const partFields = items.filter((row) => row && String(row.id || '').indexOf(prefix) === 0).map((row) => ({
          id: String(row.id),
          value: row.value,
        }));
        const partButton = clickId.indexOf(prefix) === 0 ? clickId : '';
        if (!partFields.length && !partButton) continue;
        const part = await frames[i].evaluate(({ fields, buttonId }) => {
          function findStamp(root, id) {
            if (!root || !root.querySelector) return null;
            const direct = root.querySelector('[data-joshu-handoff="' + id + '"]');
            if (direct) return direct;
            const all = root.querySelectorAll('*');
            for (let n = 0; n < all.length; n++) {
              if (all[n].shadowRoot) {
                const hit = findStamp(all[n].shadowRoot, id);
                if (hit) return hit;
              }
            }
            return null;
          }
          function setValue(el, value) {
            const tag = String(el.tagName || '').toUpperCase();
            const type = tag === 'INPUT' ? String(el.type || 'text').toLowerCase() : '';
            if (type === 'checkbox' || type === 'radio') {
              const want = value === true || value === 'true' || value === '1' || value === 'on' || value === 'yes';
              el.checked = !!want;
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
              return 'check';
            }
            if (tag === 'SELECT') {
              el.value = String(value);
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
              return 'select';
            }
            if (el.isContentEditable) {
              el.focus();
              document.execCommand('selectAll', false, null);
              document.execCommand('insertText', false, String(value));
              return 'edit';
            }
            const proto = tag === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            const desc = Object.getOwnPropertyDescriptor(proto, 'value');
            if (desc && desc.set) desc.set.call(el, String(value));
            else el.value = String(value);
            el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertReplacementText', data: String(value) }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return 'value';
          }
          const filled = [];
          const missing = [];
          for (let n = 0; n < fields.length; n++) {
            const item = fields[n];
            const el = findStamp(document, item.id);
            if (!el) { missing.push(item.id); continue; }
            filled.push({ id: item.id, via: setValue(el, item.value) });
          }
          let clicked = null;
          if (buttonId) {
            const btn = findStamp(document, buttonId);
            if (btn) {
              btn.click();
              clicked = buttonId;
            }
          }
          return { filled: filled, missing: missing, clicked: clicked };
        }, { fields: partFields, buttonId: partButton });
        if (part && Array.isArray(part.filled)) filled.push(...part.filled);
        if (part && Array.isArray(part.missing)) missing.push(...part.missing);
        if (part && part.clicked) clicked = part.clicked;
      }
      return { ok: missing.length === 0, filled: filled, missing: missing, clicked: clicked };
    });
    res.json(result || { ok: false, reason: 'no-result' });
  } catch (err) {
    log('error', 'fill-form failed', { reqId: req.reqId, error: err.message });
    handleRouteError(err, req, res);
  }
});

`;
  let fillFormInserted = false;
  for (const needle of hitlClipboardNeedles) {
    if (source.includes(needle)) {
      source = source.replace(needle, fillFormRoute + needle);
      fillFormInserted = true;
      break;
    }
  }
  if (!fillFormInserted) {
    console.warn(`[joshu] fill-form route insertion point not found in ${target}; skipping`);
  }
}

if (!source.includes("HITL_FORM_PAGE_KEY_ROUTE")) {
  const pageKeyRoute = `
// HITL_FORM_PAGE_KEY_ROUTE — URL + control-shape fingerprint without stamping locators
app.post('/tabs/:tabId/form-page-key', async (req, res) => {
  const tabId = req.params.tabId;
  try {
    const { userId } = req.body || {};
    const session = sessions.get(normalizeUserId(userId));
    const found = session && findTab(session, tabId);
    if (!found) return tabNotFoundResponse(res, tabId);
    session.lastAccess = Date.now();
    const { tabState } = found;
    tabState.toolCalls++; tabState.consecutiveTimeouts = 0; tabState.consecutiveFailures = 0;
    const result = await withTabLock(tabId, async () => {
      const frames = tabState.page.frames();
      const parts = [];
      let url = '';
      let title = '';
      for (let i = 0; i < frames.length; i++) {
        const part = await frames[i].evaluate((frameIndex) => {
          const SKIP_TYPES = ['hidden', 'button', 'submit', 'file', 'image', 'reset', 'color', 'range'];
          function usable(el) {
            if (!el || el.disabled) return false;
            try {
              const style = window.getComputedStyle(el);
              if (style.display === 'none' || style.visibility === 'hidden') return false;
            } catch (e) {}
            return true;
          }
          const parts = [];
          document.querySelectorAll('input, textarea, select').forEach((el) => {
            const type = String(el.type || '').toLowerCase();
            if (el.tagName === 'INPUT' && SKIP_TYPES.indexOf(type) !== -1) return;
            if (!usable(el)) return;
            parts.push(['f', String(frameIndex), el.tagName, type, el.name || '', el.id || '', el.getAttribute('placeholder') || ''].join(':'));
          });
          document.querySelectorAll('button, input[type=submit], [role=button]').forEach((el) => {
            if (!usable(el)) return;
            const text = String(el.innerText || el.value || '').replace(/\\s+/g, ' ').trim().slice(0, 40);
            parts.push(['b', String(frameIndex), text].join(':'));
          });
          return { url: String(location.href || ''), title: String(document.title || ''), parts: parts };
        }, i);
        if (part && i === 0) {
          url = part.url || url;
          title = part.title || title;
        }
        if (part && Array.isArray(part.parts)) parts.push(...part.parts);
      }
      return { url: url, title: title, key: parts.slice(0, 24).join('|') };
    });
    res.json({ ok: true, url: result.url || '', title: result.title || '', key: result.key || '' });
  } catch (err) {
    log('error', 'form-page-key failed', { reqId: req.reqId, error: err.message });
    handleRouteError(err, req, res);
  }
});

`;
  let pageKeyInserted = false;
  for (const needle of hitlClipboardNeedles) {
    if (source.includes(needle)) {
      source = source.replace(needle, pageKeyRoute + needle);
      pageKeyInserted = true;
      break;
    }
  }
  if (!pageKeyInserted) {
    console.warn(`[joshu] form-page-key route insertion point not found in ${target}; skipping`);
  }
}

// ---------------------------------------------------------------------------
// Tab reaper: VNC clicks do not increment toolCalls, so default inactivity kill
// would wipe jWeb tabs ~every TAB_INACTIVITY_MS (upstream default 5m).
// Env TAB_INACTIVITY_MS=0 (HITL default) disables; >0 restores upstream behavior.
// ---------------------------------------------------------------------------
const tabInactivityNeedle = "const TAB_INACTIVITY_MS = CONFIG.tabInactivityMs;";
const tabInactivityPatch = `const TAB_INACTIVITY_MS = (() => {
  // HITL default 0: VNC activity is invisible to toolCalls-based reaper.
  const raw = process.env.TAB_INACTIVITY_MS;
  if (raw === undefined || raw === '') return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : CONFIG.tabInactivityMs;
})();`;
if (source.includes(tabInactivityNeedle) && !source.includes("process.env.TAB_INACTIVITY_MS")) {
  source = source.replace(tabInactivityNeedle, tabInactivityPatch);
} else if (
  source.includes("const TAB_INACTIVITY_MS = CONFIG.tabInactivityMs") &&
  !source.includes("process.env.TAB_INACTIVITY_MS")
) {
  source = source.replace(
    /const TAB_INACTIVITY_MS = CONFIG\.tabInactivityMs;?/,
    tabInactivityPatch,
  );
}

const reaperIntervalNeedle = `setInterval(() => {
  const now = Date.now();
  for (const [userId, session] of sessions) {
    for (const [listItemId, group] of session.tabGroups) {
      for (const [tabId, tabState] of group) {
        if (!tabState._lastReaperCheck) {
          tabState._lastReaperCheck = now;
          tabState._lastReaperToolCalls = tabState.toolCalls;
          continue;
        }
        if (tabState.toolCalls === tabState._lastReaperToolCalls) {
          const idleMs = now - tabState._lastReaperCheck;
          if (idleMs >= TAB_INACTIVITY_MS) {`;
const reaperIntervalPatch = `setInterval(() => {
  // HITL/jWeb: VNC clicks do not increment toolCalls; 0 disables the reaper.
  if (!TAB_INACTIVITY_MS || TAB_INACTIVITY_MS <= 0) return;
  const now = Date.now();
  for (const [userId, session] of sessions) {
    for (const [listItemId, group] of session.tabGroups) {
      for (const [tabId, tabState] of group) {
        if (!tabState._lastReaperCheck) {
          tabState._lastReaperCheck = now;
          tabState._lastReaperToolCalls = tabState.toolCalls;
          continue;
        }
        if (tabState.toolCalls === tabState._lastReaperToolCalls) {
          const idleMs = now - tabState._lastReaperCheck;
          if (idleMs >= TAB_INACTIVITY_MS) {`;
if (
  source.includes(reaperIntervalNeedle) &&
  !source.includes("if (!TAB_INACTIVITY_MS || TAB_INACTIVITY_MS <= 0) return;")
) {
  source = source.replace(reaperIntervalNeedle, reaperIntervalPatch);
} else if (!source.includes("if (!TAB_INACTIVITY_MS || TAB_INACTIVITY_MS <= 0) return;")) {
  // Fallback: insert gate right after the reaper setInterval opener near comment.
  const reaperComment = "// Per-tab inactivity reaper — close tabs idle for TAB_INACTIVITY_MS\nsetInterval(() => {\n";
  if (source.includes(reaperComment)) {
    source = source.replace(
      reaperComment,
      `${reaperComment}  // HITL/jWeb: VNC clicks do not increment toolCalls; 0 disables the reaper.\n  if (!TAB_INACTIVITY_MS || TAB_INACTIVITY_MS <= 0) return;\n`,
    );
  } else {
    console.warn(`[joshu] tab reaper gate insertion point not found in ${target}; skipping`);
  }
}

// GET /tabs keepalive — Joshu status polls listTabs(); count as activity.
const tabsGetNeedle = `app.get('/tabs', async (req, res) => {
  try {
    const userId = req.query.userId;
    const session = sessions.get(normalizeUserId(userId));
    
    if (!session) {
      return res.json({ running: true, tabs: [] });
    }
    
    const tabs = [];`;
const tabsGetPatch = `app.get('/tabs', async (req, res) => {
  try {
    const userId = req.query.userId;
    const session = sessions.get(normalizeUserId(userId));
    
    if (!session) {
      return res.json({ running: true, tabs: [] });
    }

    // HITL keepalive: jWeb status polls GET /tabs; count as activity so tab reaper / session timeout do not wipe VNC sessions.
    session.lastAccess = Date.now();
    for (const group of session.tabGroups.values()) {
      for (const tabState of group.values()) {
        tabState._lastReaperCheck = Date.now();
        tabState._lastReaperToolCalls = tabState.toolCalls;
      }
    }
    
    const tabs = [];`;
if (source.includes(tabsGetNeedle) && !source.includes("HITL keepalive: jWeb status polls GET /tabs")) {
  source = source.replace(tabsGetNeedle, tabsGetPatch);
} else if (!source.includes("HITL keepalive: jWeb status polls GET /tabs")) {
  console.warn(`[joshu] GET /tabs keepalive insertion point not found in ${target}; skipping`);
}

// Upgrade legacy popup coercion (closed popup before navigation — breaks Slack z-app 2FA links).
const popupV2Marker = "__hitlPopupCoerceV2";
const popupV3Marker = "__hitlPopupCoerceV3";
const popupV4Marker = "__hitlPopupCoerceV4";
const popupV5Marker = "__hitlPopupCoerceV5";
const popupV6Marker = "__hitlPopupCoerceV6";
const legacyPopupBlock = ` page.on('popup', async (popup) => {
 try {
 await popup.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
 const url = popup.url();
 await popup.close().catch(() => {});
 if (url && url !== 'about:blank') {
 await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((err) => {
 log('warn', 'popup same-tab navigation failed', { url, error: err.message });
 });
 }
 log('info', 'popup coerced into opener tab', { url });
 } catch (err) {
 log('warn', 'popup coercion failed', { error: err.message });
 await popup.close().catch(() => {});
 }
 });`;
if (
  !source.includes(popupV2Marker) &&
  !source.includes(popupV3Marker) &&
  !source.includes(popupV4Marker) &&
  !source.includes(popupV5Marker) &&
  source.includes(legacyPopupBlock)
) {
  source = source.replace(legacyPopupBlock, popupHandlerV6);
  console.log(`[joshu] upgraded popup coercion to v6 in ${target}`);
}
if (source.includes(popupV2Marker) && !source.includes(popupV6Marker) && source.includes(popupHandlerV2)) {
  source = source.replace(popupHandlerV2, popupHandlerV6);
  console.log(`[joshu] upgraded popup coercion v2 → v6 in ${target}`);
}
if (source.includes(popupV3Marker) && !source.includes(popupV6Marker) && source.includes(popupHandlerV3)) {
  source = source.replace(popupHandlerV3, popupHandlerV6);
  console.log(`[joshu] upgraded popup coercion v3 → v6 in ${target}`);
}
if (source.includes(popupV4Marker) && !source.includes(popupV6Marker)) {
  if (source.includes(popupHandlerV4)) {
    source = source.replace(popupHandlerV4, popupHandlerV6);
    console.log(`[joshu] upgraded popup coercion v4 → v6 in ${target}`);
  } else {
    console.warn(`[joshu] popup v4 marker present but handler block not found in ${target}; skipping v6 upgrade`);
  }
}
if (source.includes(popupV5Marker) && !source.includes(popupV6Marker) && source.includes(popupHandlerV5)) {
  source = source.replace(popupHandlerV5, popupHandlerV6);
  console.log(`[joshu] upgraded popup coercion v5 → v6 in ${target}`);
} else if (source.includes(popupV5Marker) && !source.includes(popupV6Marker)) {
  console.warn(`[joshu] popup v5 marker present but handler block not found in ${target}; skipping v6 upgrade`);
}

// ---------------------------------------------------------------------------
// Cold-start warm gate: mark fresh Firefox launches; warm to CAMOFOX_START_URL
// before the first heavy navigation (Calendly-class SPAs crash on cold direct load).
// ---------------------------------------------------------------------------
if (!source.includes("__hitlMarkBrowserColdLaunch();")) {
  const coldLaunchMarkNeedle = `      log('info', 'camoufox launched', {
        attempt,
        maxAttempts,
        virtualDisplay: useVirtualDisplay,
        proxyMode: proxyPool?.mode || null,
        proxyServer: launchProxy?.server || null,
        proxySession: launchProxy?.sessionId || null,
      });
      return browser;`;
  const coldLaunchMarkPatch = `      log('info', 'camoufox launched', {
        attempt,
        maxAttempts,
        virtualDisplay: useVirtualDisplay,
        proxyMode: proxyPool?.mode || null,
        proxyServer: launchProxy?.server || null,
        proxySession: launchProxy?.sessionId || null,
      });
      // HITL_COLD_LAUNCH_WARM
      __hitlMarkBrowserColdLaunch();
      return browser;`;
  if (source.includes(coldLaunchMarkNeedle)) {
    source = source.replace(coldLaunchMarkNeedle, coldLaunchMarkPatch);
  } else {
    const coldLaunchMarkNeedleV16 = `      log('info', 'camoufox launched', {
        attempt,
        maxAttempts,
        virtualDisplay: useVirtualDisplay,
        interactiveMode: CONFIG.interactiveMode,
        proxyMode: proxyPool?.mode || null,
        proxyServer: launchProxy?.server || null,
        proxySession: launchProxy?.sessionId || null,
      });
      return browser;`;
    if (source.includes(coldLaunchMarkNeedleV16)) {
      source = source.replace(coldLaunchMarkNeedleV16, coldLaunchMarkPatch);
      console.log(`[joshu] inserted cold-launch mark (Camofox 1.16 layout) in ${target}`);
    } else {
      console.warn(`[joshu] cold-launch mark insertion point not found in ${target}; skipping`);
    }
  }

  const directGotoNeedle =
    "await withPageLoadDuration('open_url', () => page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }));";
  const directGotoPatch =
    "await __hitlGotoWithColdWarm(page, url, req.reqId);";
  if (source.includes(directGotoNeedle)) {
    source = source.replaceAll(directGotoNeedle, directGotoPatch);
  }

  const retryGotoNeedle =
    "await withPageLoadDuration('open_url', () => retryPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }));";
  const retryGotoPatch =
    "await __hitlGotoWithColdWarm(retryPage, url, req.reqId);";
  if (source.includes(retryGotoNeedle)) {
    source = source.replaceAll(retryGotoNeedle, retryGotoPatch);
  }

  const navigateGotoNeedle =
    "const gotoP = withPageLoadDuration('navigate', () => tabState.page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }));";
  const navigateGotoPatch = `await __hitlWarmBeforeHeavyNav(tabState.page, targetUrl, req.reqId);
          const gotoP = withPageLoadDuration('navigate', () => tabState.page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }));`;
  if (source.includes(navigateGotoNeedle)) {
    source = source.replace(navigateGotoNeedle, navigateGotoPatch);
  } else {
    const navigateGotoNeedle16 =
      "const gotoP = withPageLoadDuration('navigate', () => navigatePage(tabState.page, targetUrl, { timeout: NAVIGATE_TIMEOUT_MS }));";
    const navigateGotoPatch16 = `await __hitlWarmBeforeHeavyNav(tabState.page, targetUrl, req.reqId);
          const gotoP = withPageLoadDuration('navigate', () => navigatePage(tabState.page, targetUrl, { timeout: NAVIGATE_TIMEOUT_MS }));`;
    if (source.includes(navigateGotoNeedle16)) {
      source = source.replace(navigateGotoNeedle16, navigateGotoPatch16);
      console.log(`[joshu] patched tabs/:tabId/navigate cold-warm (navigatePage) in ${target}`);
    } else {
      console.warn(`[joshu] tabs/:tabId/navigate cold-warm insertion point not found in ${target}; skipping`);
    }
  }
} else if (!source.includes("async function __hitlGotoWithColdWarm(")) {
  console.warn(`[joshu] cold-launch mark without helpers in ${target}; re-run patch on clean server.js`);
}

// Upgrade cold-warm helper to also key off _lastBrowserRestartAt (idempotent).
const coldWarmLegacyNeedle = `  const needsWarm =
    __hitlBrowserColdLaunch &&
    warmUrl &&
    !__hitlUrlsEquivalent(target, warmUrl);`;
const coldWarmLegacyPatch = `  // _lastBrowserRestartAt covers races where the cold flag was cleared before first nav.
  const recentlyLaunched =
    typeof _lastBrowserRestartAt === 'number' &&
    _lastBrowserRestartAt > 0 &&
    Date.now() - _lastBrowserRestartAt < 120000;
  const needsWarm =
    (__hitlBrowserColdLaunch || recentlyLaunched) &&
    warmUrl &&
    !__hitlUrlsEquivalent(target, warmUrl);`;
if (source.includes(coldWarmLegacyNeedle)) {
  source = source.replace(coldWarmLegacyNeedle, coldWarmLegacyPatch);
}

// --- HITL_PROXY_TUNNEL_DETECT: rotate Decodo/CDN proxy tunnel failures (522 HTML pages) ---
const PROXY_TUNNEL_MARKER = "HITL_PROXY_TUNNEL_DETECT";
if (!source.includes(PROXY_TUNNEL_MARKER)) {
  const proxyTunnelHelpers = `
// ${PROXY_TUNNEL_MARKER} — generic proxy/CDN tunnel failure pages (522, connection refused HTML).
const __HITL_PROXY_TUNNEL_RE = /proxy server is refusing connections|Error code:\\s*522|502 Bad Gateway or Proxy Error|Camoufox can't establish a connection|Unable to connect to the proxy server|NS_ERROR_PROXY_CONNECTION_REFUSED/i;

async function __hitlIsProxyTunnelErrorPage(page) {
  if (!page || page.isClosed()) return false;
  const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 900) || '').catch(() => '');
  return __HITL_PROXY_TUNNEL_RE.test(bodyText);
}

async function __hitlRotateContextOnProxyTunnel(userId, sessionKey, tabId, previousTabState, reason, reqId) {
  if (!previousTabState?.lastRequestedUrl) return null;
  if ((previousTabState.proxyRetryCount || 0) >= 2) return null;

  browserRestartsTotal.labels(reason).inc();
  const key = normalizeUserId(userId);
  const oldSession = sessions.get(key);
  if (oldSession) {
    await closeSession(key, oldSession, { reason: 'proxy_tunnel_rotate', clearDownloads: true, clearLocks: true });
  }
  const session = await getSession(userId);
  const group = getTabGroup(session, sessionKey);
  const page = await session.context.newPage();
  const tabState = createTabState(page);
  tabState.proxyRetryCount = (previousTabState.proxyRetryCount || 0) + 1;
  tabState.lastRequestedUrl = previousTabState.lastRequestedUrl;
  attachDownloadListener(tabState, tabId, log, pluginEvents, userId);
  group.set(tabId, tabState);
  attachPopupHandler(page, userId, sessionKey);
  refreshActiveTabsGauge();

  log('warn', 'replaying navigation on fresh proxy context', {
    reqId,
    tabId,
    retryCount: tabState.proxyRetryCount,
    url: tabState.lastRequestedUrl,
    proxySession: session.proxySessionId || null,
  });

  await __hitlWarmBeforeHeavyNav(page, tabState.lastRequestedUrl, reqId);
  await withPageLoadDuration('navigate', () => page.goto(tabState.lastRequestedUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }));
  tabState.visitedUrls.add(tabState.lastRequestedUrl);
  return { session, tabState };
}

`;

  const googleUnavailableAnchor = "async function isGoogleUnavailable(page) {";
  if (source.includes(googleUnavailableAnchor)) {
    source = source.replace(googleUnavailableAnchor, `${proxyTunnelHelpers}${googleUnavailableAnchor}`);
  } else {
    console.warn(`[joshu] ${PROXY_TUNNEL_MARKER}: isGoogleUnavailable anchor not found; skipping helpers`);
  }

  const isProxyErrorNeedle = `function isProxyError(err) {
  if (!err) return false;
  const msg = err.message || '';
  return msg.includes('NS_ERROR_PROXY') || msg.includes('proxy connection') || msg.includes('Proxy connection');
}`;
  const isProxyErrorPatch = `function isProxyError(err) {
  if (!err) return false;
  const msg = err.message || '';
  return msg.includes('NS_ERROR_PROXY') || msg.includes('proxy connection') || msg.includes('Proxy connection')
    || msg.includes('Proxy tunnel error') || /\\b522\\b/.test(msg);
}`;
  if (source.includes(isProxyErrorNeedle)) {
    source = source.replace(isProxyErrorNeedle, isProxyErrorPatch);
  }

  const navigateProxyTunnelNeedle = `        if (isGoogleSearch && proxyPool?.canRotateSessions && await isGoogleSearchBlocked(tabState.page)) {
          log('warn', 'google search blocked, rotating browser proxy session', {
            reqId: req.reqId,
            tabId,
            url: tabState.page.url(),
            proxySession: browserLaunchProxy?.sessionId || null,
          });
          await recreateTabOnFreshContext();
          await prewarmGoogleHome();
          await navigateCurrentPage();
        }
        
        // For Google SERP: skip eager ref building during navigate.`;

  const navigateProxyTunnelPatch = `        if (isGoogleSearch && proxyPool?.canRotateSessions && await isGoogleSearchBlocked(tabState.page)) {
          log('warn', 'google search blocked, rotating browser proxy session', {
            reqId: req.reqId,
            tabId,
            url: tabState.page.url(),
            proxySession: browserLaunchProxy?.sessionId || null,
          });
          await recreateTabOnFreshContext();
          await prewarmGoogleHome();
          await navigateCurrentPage();
        }

        // ${PROXY_TUNNEL_MARKER}: 522 / proxy-refused pages often load without throwing goto.
        if (proxyPool?.canRotateSessions && await __hitlIsProxyTunnelErrorPage(tabState.page)) {
          const rotated = await __hitlRotateContextOnProxyTunnel(
            userId,
            currentSessionKey,
            tabId,
            tabState,
            'proxy_tunnel_navigate',
            req.reqId,
          );
          if (rotated) {
            tabState = rotated.tabState;
          }
        }
        
        // For Google SERP: skip eager ref building during navigate.`;

  if (source.includes(navigateProxyTunnelNeedle)) {
    source = source.replace(navigateProxyTunnelNeedle, navigateProxyTunnelPatch);
  } else {
    console.warn(`[joshu] ${PROXY_TUNNEL_MARKER}: navigate insertion point not found; skipping`);
  }

  const snapshotProxyTunnelNeedle = `    const result = await withUserLimit(userId, () => withTimeout((async () => {
      if (proxyPool?.canRotateSessions && isGoogleSearchUrl(tabState.lastRequestedUrl || '')) {`;

  const snapshotProxyTunnelPatch = `    const result = await withUserLimit(userId, () => withTimeout((async () => {
      // ${PROXY_TUNNEL_MARKER}: rotate on proxy tunnel HTML before site-specific checks.
      if (proxyPool?.canRotateSessions && await __hitlIsProxyTunnelErrorPage(tabState.page)) {
        const rotated = await __hitlRotateContextOnProxyTunnel(
          userId,
          found.listItemId,
          req.params.tabId,
          tabState,
          'proxy_tunnel_snapshot',
          req.reqId,
        );
        if (rotated) {
          tabState = rotated.tabState;
          found.tabState = tabState;
        }
      }

      if (proxyPool?.canRotateSessions && isGoogleSearchUrl(tabState.lastRequestedUrl || '')) {`;

  if (source.includes(snapshotProxyTunnelNeedle)) {
    source = source.replace(snapshotProxyTunnelNeedle, snapshotProxyTunnelPatch);
  } else {
    console.warn(`[joshu] ${PROXY_TUNNEL_MARKER}: snapshot insertion point not found; skipping`);
  }
}

writeFileSync(target, source);
console.log(
  `[joshu] patched ${target} for single-tab HITL, viewport, selection clipboard route, tab-reaper keepalive, cold-launch warm, and proxy-tunnel recovery`,
);

// camoufox-js treats any existing addons/<name>/ dir as a successful extract.
// A failed AMO download (or a launch race that mkdir'd UBO) leaves an empty dir;
// confirmPaths then 500s every later launch: "manifest.json is missing" — jWeb
// never warms (validated patrick 2026-09-20 after 0.1.46 recreate).
const addonsJs = join(dirname(resolve(target)), "node_modules/camoufox-js/dist/addons.js");
const ADDON_REPAIR_MARKER = "HITL_ADDON_MANIFEST_REPAIR";
if (existsSync(addonsJs)) {
  let addonsSource = readFileSync(addonsJs, "utf8");
  if (!addonsSource.includes(ADDON_REPAIR_MARKER)) {
    const staleExistsNeedle = `        if (fs.existsSync(addonPath)) {
            addonsList.push(addonPath);
            continue;
        }`;
    const staleExistsPatch = `        if (fs.existsSync(addonPath)) {
            if (fs.existsSync(join(addonPath, "manifest.json"))) {
                addonsList.push(addonPath);
                continue;
            }
            // ${ADDON_REPAIR_MARKER} — incomplete extract is not success.
            fs.rmSync(addonPath, { recursive: true, force: true });
        }`;
    if (addonsSource.includes(staleExistsNeedle)) {
      addonsSource = addonsSource.replace(staleExistsNeedle, staleExistsPatch);
      writeFileSync(addonsJs, addonsSource);
      console.log(`[joshu] patched ${addonsJs} for incomplete addon extract repair`);
    } else {
      console.warn(`[joshu] ${ADDON_REPAIR_MARKER}: addons.js existsSync needle not found; skipping`);
    }
  }
}
