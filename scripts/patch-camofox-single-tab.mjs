#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";

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

const popupPatch = `function createTabState(page) {
 if (process.env.HITL_FORCE_SINGLE_VISIBLE_PAGE !== 'false' && !page.__hitlSingleTabPopupPatch) {
 page.__hitlSingleTabPopupPatch = true;
${popupHandlerV2}
 }
`;

if (!alreadyHasPopupPatch && !source.includes("function createTabState(page) {\n")) {
  throw new Error(`Could not find createTabState() in ${target}`);
}
if (!alreadyHasPopupPatch) {
  source = source.replace("function createTabState(page) {\n", popupPatch);
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
  const raw = String(process.env.CAMOFOX_START_URL || 'https://news.google.com/').trim();
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'https://news.google.com/';
    return parsed.toString();
  } catch (_) {
    return 'https://news.google.com/';
  }
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
}

const ffHelperOnly = `
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

const beforeLimitNeedle = "      const session = await getSession(userId, { trace: !!trace });\n      \n      let totalTabs = 0;";
const beforeLimitPatch =
  "      const session = await getSession(userId, { trace: !!trace });\n      await __hitlCloseExistingTabsForSession(session, userId, req.reqId, 'hitl_single_visible_page_create_before_limits');\n      \n      let totalTabs = 0;";
if (source.includes(beforeLimitNeedle) && !source.includes("hitl_single_visible_page_create_before_limits")) {
  source = source.replace(beforeLimitNeedle, beforeLimitPatch);
} else if (
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
        while (end < src.length && (src[end] === ";" || src[end] === "\r" || src[end] === "\n")) end++;
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
const launchOptionsNeedle = `      const options = await launchOptions({
        headless: useVirtualDisplay ? false : true,
        os: hostOS,
        humanize: true,
        enable_cache: true,
        proxy: launchProxy,
        geoip: !!launchProxy,
        virtual_display: vdDisplay,
      });`;

const launchOptionsPatch = `      const __hitlVp = __hitlViewportFromEnv();
      const options = await launchOptions({
        headless: useVirtualDisplay ? false : true,
        os: hostOS,
        humanize: true,
        enable_cache: true,
        proxy: launchProxy,
        geoip: !!launchProxy,
        virtual_display: vdDisplay,
        window: [__hitlVp.width, __hitlVp.height],
        ...__hitlFfLaunchOverrides(),
      });`;

if (source.includes(launchOptionsNeedle)) {
  source = source.replace(launchOptionsNeedle, launchOptionsPatch);
} else if (!source.includes("window: [__hitlVp.width, __hitlVp.height]")) {
  console.warn(`[joshu] launchOptions window-size patch point not found in ${target}; skipping`);
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
  console.warn(`[joshu] tab create start URL patch point not found in ${target}; skipping`);
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
  console.warn(`[joshu] tab create window-fit patch point not found in ${target}; skipping`);
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

// Upgrade legacy popup coercion (closed popup before navigation — breaks Slack z-app 2FA links).
const popupV2Marker = "__hitlPopupCoerceV2";
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
if (!source.includes(popupV2Marker) && source.includes(legacyPopupBlock)) {
  source = source.replace(legacyPopupBlock, popupHandlerV2);
  console.log(`[joshu] upgraded popup coercion to v2 in ${target}`);
}

writeFileSync(target, source);
console.log(`[joshu] patched ${target} for single-tab HITL behavior and dynamic viewport resizing`);
