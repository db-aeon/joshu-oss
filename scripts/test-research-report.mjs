/**
 * Unit tests of a Research report (change research-reports, groups 3 to 5 and 11): the counts and
 * the charts for follow-up reports, the HTML page, the report store, the whole run with the fakes
 * of scripts/lib/research-test-fakes.mjs, the search for earlier reports, the report links, and
 * the report routes. No network and no engine. scripts/test-research-pipeline.mjs tests the
 * research pipeline.
 * The PDF render needs Chromium and is tested by scripts/test-research-pdf.mjs.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeReportCounts, itemsByDaySvg, themesBySourceSvg } from "../src/research/charts.ts";
import { FAKE_PAGES, fakeDeps as sharedFakeDeps, fakeModel, fakePictureFetch } from "./lib/research-test-fakes.mjs";
import { portraitDataUri } from "../src/research/identity.ts";
import { embeddedFontCss } from "../src/research/fonts.ts";
import { renderReportHtml } from "../src/research/template.ts";
import { makeResearchReport, newsPages, STEP_LIMITS_MS } from "../src/research/make.ts";
import { groupMaxTokens } from "../src/research/recurring/stories.ts";
import { findReports, listReports, newReportId, readReport, reportFolder, researchDir, slugifyTopic } from "../src/research/store.ts";
import { ResearchStepError } from "../src/research/errors.ts";
import os from "node:os";
import http from "node:http";
import express from "express";
import { reportLink, reportLinkSecret, reportsLinkedInText, signReportId, verifyReportSignature } from "../src/research/reportLinks.ts";
import { registerResearchRoutes } from "../src/research/routes.ts";
import { formatOwnerCompletion } from "../src/realtimeGoals/ownerDelivery.ts";
import { smsGsmFold } from "../src/twilioSmsSend.ts";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures", "research");
/** The collected items and themes of a saved collection (the agent JSON of the removed engine), for the charts. */
function collectedFrom(name, collectedAt = "2026-08-05T12:00:00.000Z") {
  const report = JSON.parse(fs.readFileSync(path.join(fixtures, name), "utf8"));
  const items = report.results.map((r, i) => ({
    id: `i${i + 1}`,
    title: r.title || r.summary || r.url,
    summary: r.summary || "",
    url: r.url,
    source: r.source || "",
    sourceLabel: r.source || "",
    publishedAt: r.published_at?.match(/^\d{4}-\d{2}-\d{2}/)?.[0],
    engagement: r.engagement ?? {},
    relevance: r.relevance_score ?? 0,
    theme: typeof r.cluster === "number" ? r.cluster : undefined,
  }));
  const themes = [];
  const newIndex = new Map();
  report.clusters.forEach((c, old) => {
    const members = items.filter((i) => i.theme === old);
    if (!members.length) return;
    newIndex.set(old, themes.length);
    themes.push({ index: themes.length, title: c.title || "", summary: c.summary || "", itemIds: members.map((m) => m.id) });
  });
  for (const item of items) item.theme = item.theme === undefined ? undefined : newIndex.get(item.theme);
  return { topic: "openai", windowDays: report.window_days ?? 30, collectedAt, items, themes, sources: [] };
}

function testCountsAndCharts() {
  const collected = collectedFrom("agent-report.json");
  const counts = computeReportCounts(collected);
  assert.ok(counts.days.length >= 30, "one bar slot for each day of the window");
  assert.equal(counts.days.at(-1).day, "2026-08-05");
  const dated = collected.items.filter((i) => i.publishedAt && i.publishedAt <= "2026-08-05").length;
  assert.equal(counts.days.reduce((sum, d) => sum + d.count, 0), dated, "each dated item is in one bar");
  assert.equal(counts.undated, collected.items.length - dated);
  assert.ok(counts.undated >= 6);
  assert.ok(counts.busyDays.length <= 3);
  for (const day of counts.busyDays) assert.ok(counts.days.find((d) => d.day === day).count >= 2);

  const svg = itemsByDaySvg(counts);
  const bars = (svg.match(/<rect /g) ?? []).length;
  assert.equal(bars, counts.days.filter((d) => d.count > 0).length, "one bar for each day with items");
  assert.equal((svg.match(/class="busy"/g) ?? []).length, counts.busyDays.length, "busy days marked");

  const grid = themesBySourceSvg(counts);
  assert.equal((grid.match(/class="label"/g) ?? []).length, collected.themes.length, "one row for each theme");
  for (const t of counts.themes) {
    const total = t.bySource.reduce((a, b) => a + b, 0);
    assert.equal(total, collected.themes[t.index].itemIds.length, "grid row counts the items of the theme");
  }
  console.log("ok counts and charts");
}

function tempRoots() {
  const desktopRoot = fs.mkdtempSync(path.join(os.tmpdir(), "research-store-"));
  const filesRoot = path.join(desktopRoot, "joshu's files");
  fs.mkdirSync(filesRoot, { recursive: true });
  return { desktopRoot, filesRoot };
}

/** The `fakeDeps` of the shared fakes; `now` also sets the day. */
function fakeDeps(roots, overrides = {}) {
  const now = overrides.now ?? (() => new Date("2026-11-02T15:00:00.000Z"));
  const { now: _now, ...deps } = overrides;
  return sharedFakeDeps(roots, { deps: { now, day: now().toISOString().slice(0, 10), ...deps } }).deps;
}

/** Research and text of one whole run with the fakes. */
async function fakeReportData() {
  const roots = tempRoots();
  try {
    const report = await makeResearchReport("/unused", "Electric bike subscriptions", fakeDeps(roots));
    return JSON.parse(fs.readFileSync(path.join(report.folder, "report.json"), "utf8"));
  } finally {
    fs.rmSync(roots.desktopRoot, { recursive: true, force: true });
  }
}

async function testReportHtml() {
  const { research, text } = await fakeReportData();
  const pictures = new Map([[0, { dataUri: "data:image/png;base64,AAAA", alt: "Chart of subscriptions", site: "site1.example.org", pageUrl: FAKE_PAGES[0].url, width: 400 }]]);
  const html = renderReportHtml({ research, text, pictures, companionName: "Mina", ownerDisplayName: "Maya Ross", fontCss: embeddedFontCss(), reportId: "2026-11-02-x" });
  const order = ["<h1>Electric bike <em>subscriptions</em></h1>", "<dt>Evidence</dt>", 'id="summary"', 'id="background"', 'id="themes"', "Pages and posts"];
  let last = -1;
  for (const marker of order) {
    const at = html.indexOf(marker);
    assert.ok(at > last, `part in order: ${marker}`);
    last = at;
  }
  assert.match(html, new RegExp(`<dd>${research.facts.length} facts from \\d+ pages and posts on \\d+ sites</dd>`));
  // Change research-report-topics: no key findings and no box of social posts; the post is a link of its theme.
  assert.doesNotMatch(html, /id="findings"|id="social"/);
  assert.ok(html.includes('class="theme-links"'), "each theme has its links");
  assert.ok(html.includes("https://reddit.com/r/ebikes/1"), "the social post is a link of its theme");
  assert.match(html, /<span class="theme-kind">Background<\/span>/);
  assert.doesNotMatch(html, /99%/, "a number that no cited fact has is dropped");
  assert.match(html, /Picture: <a href="https:\/\/site1\.example\.org\/article-1">site1\.example\.org<\/a>/);
  assert.match(html, /ask me to compare two providers, or check fees in my city\./);
  assert.ok(html.includes('<div class="name">Mina</div><div class="role">Maya Ross&#39;s Joshu</div>'), "closing card like the email signature");
  assert.match(html, /<div class="portrait" aria-hidden="true">M<\/div>/, "without a portrait, the first letter of the name");
  const withPortrait = renderReportHtml({ research, text, pictures: new Map(), companionName: "Mina", portrait: "data:image/png;base64,AAAA", fontCss: "", reportId: "x" });
  assert.ok(withPortrait.includes('<div class="portrait"><img src="data:image/png;base64,AAAA" alt="Mina"></div>'), "the portrait of the companion, embedded");
  const fetched = [];
  const portrait = await portraitDataUri("https://cdn.example/portrait.png", async (url) => (fetched.push(url), fakePictureFetch()("https://x/share-1.png")));
  assert.match(portrait, /^data:image\/png;base64,/);
  await portraitDataUri("https://cdn.example/portrait.png", async () => { throw new Error("no second download"); });
  assert.equal(fetched.length, 1, "the portrait is downloaded once");
  assert.equal(await portraitDataUri("http://cdn.example/p.png"), undefined, "only https");
  for (const f of research.facts) assert.ok(html.includes(research.pages.find((p) => p.id === f.pageId).url), "the page of each fact is listed");
  // No resource from the internet: the only picture is a data URI. Links to pages are allowed.
  assert.doesNotMatch(html, /<(link|script|iframe|source|video|audio|object|embed)\b/i, "no tag that loads a resource");
  assert.doesNotMatch(html, /<img\b(?![^>]*src="data:)/i, "pictures are embedded");
  assert.doesNotMatch(html, /url\(\s*["']?https?:/i, "no style that loads a resource");
  assert.doesNotMatch(html, /@import/i, "no imported style sheet");
  assert.match(html, /@font-face\{font-family:"Newsreader"/);
  assert.match(html, /data:font\/woff2;base64,/);
  console.log("ok report HTML: parts in order, picture credit, no internet resource, fonts embedded");
}

async function testQuietHtml() {
  const { research, text } = await fakeReportData();
  const few = { ...research, facts: research.facts.slice(0, 5), social: [] };
  const news = text.themes.filter((t) => t.kind === "news").slice(0, 1);
  const html = renderReportHtml({
    research: few,
    text: { ...text, quiet: true, themes: news },
    pictures: new Map(),
    companionName: "Mina",
    fontCss: "",
    reportId: "2026-11-02-x",
  });
  assert.doesNotMatch(html, /id="background"/);
  assert.match(html, /Little was found in the last 30 days/);
  assert.equal((html.match(/<article class="theme">/g) ?? []).length, 1, "only the themes with a cited fact");
  assert.match(html, /<div class="role">Joshu<\/div>/);
  console.log("ok short report HTML");
}

/** A model that answers every step but the write step. */
function failingWriter() {
  const { fetchImpl } = fakeModel();
  return { fetchImpl: async (url, init) => (init.headers["X-Title"].includes("(write)") ? { ok: false, status: 500, json: async () => ({}) } : fetchImpl(url, init)) };
}

async function testStoreAndMake() {
  const roots = tempRoots();
  try {
    assert.equal(slugifyTopic("Electric Bike Subscriptions!"), "electric-bike-subscriptions");
    assert.equal(slugifyTopic("Café über"), "cafe-uber");
    assert.equal(newReportId(roots, "Electric bike subscriptions", "2026-11-02"), "2026-11-02-electric-bike-subscriptions");

    // Plan to render take at most 8 minutes at the limits; the social posts run in parallel (change research-report-topics, D12).
    const { social: _social, ...path_ } = STEP_LIMITS_MS;
    assert.equal(Object.values(path_).reduce((a, b) => a + b, 0), 480_000);
    // The pool of news themes: dated pages of the last 30 days that a news question found. An old or
    // undated page only serves a background theme, and the stock price page is never news.
    const plan = { brief: "", subQuestions: [{ id: "q1", question: "What is it?", kind: "background", recentQuery: "", evergreenQuery: "" }, { id: "q2", question: "News?", kind: "news", recentQuery: "", evergreenQuery: "" }] };
    const pg = (id, publishedAt, foundBy, foundVia = ["web"]) => ({ id, url: `https://x.example/${id}`, title: id, site: "x.example", ...(publishedAt ? { publishedAt } : {}), highlights: [], pictures: [], foundBy, foundVia, score: 0 });
    const pool = newsPages(plan, [pg("p1", "2026-10-20", ["q2"]), pg("p2", "2024-03-01", ["q2"]), pg("p3", undefined, ["q2"]), pg("p4", "2026-10-21", ["q1"]), pg("p5", "2026-10-22", ["q2"], ["prices"])], "2026-10-03");
    assert.deepEqual(pool.map((p) => p.id), ["p1"], "only the recent page of a news question");
    const withTerms = { ...plan, subQuestions: [{ ...plan.subQuestions[0], terms: ["Scale AI"] }, plan.subQuestions[1]] };
    assert.deepEqual(newsPages(withTerms, [pg("p4", "2026-10-21", ["q1"])], "2026-10-03").map((p) => p.id), ["p4"], "a recent page of a question with search terms is news");
    const first = await makeResearchReport("/unused", "Electric bike subscriptions", fakeDeps(roots));
    assert.equal(first.id, "2026-11-02-electric-bike-subscriptions");
    for (const f of ["report.pdf", "report.html", "report.json"]) {
      assert.ok(fs.existsSync(path.join(researchDir(roots), first.id, f)), `${f} written`);
    }
    assert.equal(first.pdfDesktopPath, "joshu's files/Research/2026-11-02-electric-bike-subscriptions/report.pdf");
    assert.equal(first.pdfFilesPath, "Research/2026-11-02-electric-bike-subscriptions/report.pdf");
    assert.equal(first.summary, "Subscriptions are growing in many cities. Repairs are the largest cost. Fees are around 30 euros.");
    const data = JSON.parse(fs.readFileSync(path.join(first.folder, "report.json"), "utf8"));
    assert.equal(data.schemaVersion, 2);
    assert.equal(data.research.day, "2026-11-02");
    assert.ok(data.research.pages.length && data.research.facts.length && data.research.plan.subQuestions.length);
    assert.ok(data.research.facts.every((f) => data.research.pages.some((p) => p.id === f.pageId)), "each fact names its page");
    assert.equal(data.text.model, "test/model");

    // When the group step fails, each dated news page is a story, so the report still has news themes.
    const noGroup = sharedFakeDeps(roots, { model: { failGroup: true }, deps: { now: () => new Date("2026-11-02T15:00:00.000Z"), day: "2026-11-02" } }).deps;
    const withoutGroup = await makeResearchReport("/unused", "Group step fails", noGroup);
    const fallback = JSON.parse(fs.readFileSync(path.join(withoutGroup.folder, "report.json"), "utf8"));
    assert.ok(fallback.text.themes.some((t) => t.kind === "news" && t.storyIds?.length), "news themes from the news pages when the group step fails");
    assert.ok(!fallback.research.pages.some((p) => p.url === "https://reddit.com/r/ebikes/1"), "no unchecked social post without the group step");
    assert.equal(groupMaxTokens(61), 7920, "about 120 tokens for each item");
    assert.equal(groupMaxTokens(200), 12_000, "at most 12,000 tokens");
    const second = await makeResearchReport("/unused", "Electric bike subscriptions", fakeDeps(roots));
    assert.equal(second.id, "2026-11-02-electric-bike-subscriptions-2", "a repeat on the same day gets -2");
    assert.ok(fs.existsSync(first.folder), "the first report stays");

    // A failed step leaves no folder and names the step.
    const before = fs.readdirSync(researchDir(roots)).sort();
    for (const [step, deps] of [
      ["search", { exa: null }],
      ["write", { llm: { ...failingWriter(), apiKey: "sk-test", model: "test/model" } }],
      ["render", { writePdf: async () => { throw new ResearchStepError("render", "boom"); } }],
    ]) {
      await assert.rejects(makeResearchReport("/unused", "Failing topic", fakeDeps(roots, deps)), (err) => err.step === step);
    }
    assert.deepEqual(fs.readdirSync(researchDir(roots)).sort(), before, "no folder after a failure");

    // The old last30days results are never touched.
    const old = path.join(roots.filesRoot, "research", "last30days");
    fs.mkdirSync(old, { recursive: true });
    fs.writeFileSync(path.join(old, "old.md"), "# old\n");
    await makeResearchReport("/unused", "Heat pumps", fakeDeps(roots));
    assert.equal(fs.readFileSync(path.join(old, "old.md"), "utf8"), "# old\n");

    assert.equal(reportFolder(roots, "../../etc"), null);
    assert.equal(reportFolder(roots, "2026-11-02-x/../../y"), null);
    assert.equal(readReport(roots, "2026-11-02-no-such-report"), null);
    console.log("ok report store and the whole run: files, repeat suffix, failures, old results");
  } finally {
    fs.rmSync(roots.desktopRoot, { recursive: true, force: true });
  }
}

async function testFindReports() {
  const roots = tempRoots();
  try {
    let day = 1;
    for (const topic of ["Electric bike subscriptions", "Heat pumps in Canada", "Electric cars"]) {
      const now = () => new Date(`2026-11-0${day}T10:00:00.000Z`);
      await makeResearchReport("/unused", topic, fakeDeps(roots, { now }));
      day += 1;
    }
    assert.equal(listReports(roots).length, 3);
    assert.equal(listReports(roots)[0].topic, "Electric cars", "newest first");
    assert.deepEqual(findReports(roots, "electric bike").map((r) => r.topic), ["Electric bike subscriptions"]);
    assert.deepEqual(findReports(roots, "the electric bike report").map((r) => r.topic), ["Electric bike subscriptions"]);
    assert.equal(findReports(roots, "electric").length, 2);
    assert.deepEqual(findReports(roots, "2026-11-02").map((r) => r.topic), ["Heat pumps in Canada"]);
    assert.equal(findReports(roots, "solar panels").length, 0);
    assert.equal(findReports(roots, "").length, 3);
    console.log("ok find earlier reports by topic and date");
  } finally {
    fs.rmSync(roots.desktopRoot, { recursive: true, force: true });
  }
}

async function testReportLinks() {
  const roots = tempRoots();
  try {
    const report = await makeResearchReport("/unused", "Heat pumps", fakeDeps(roots));
    const projectRoot = roots.desktopRoot;
    const secret = reportLinkSecret(projectRoot);
    assert.equal(secret.length, 32);
    const secretFile = fs.readdirSync(path.join(projectRoot, ".joshu", "research"));
    assert.deepEqual(secretFile, ["link-secret"]);
    assert.equal(fs.statSync(path.join(projectRoot, ".joshu", "research", "link-secret")).mode & 0o777, 0o600);
    assert.ok(reportLinkSecret(projectRoot).equals(secret), "the secret is made once");

    const link = reportLink(report.id, secret, "https://otto.box.example.test/joshu");
    assert.match(link, /^https:\/\/otto\.box\.example\.test\/joshu\/api\/research\/r\/2026-11-02-heat-pumps\/[A-Za-z0-9_-]{22}\/report\.pdf$/);
    assert.ok(/^[\x21-\x7e]+$/.test(link) && !link.includes(";"), "ASCII only, no ;");
    const sms = smsGsmFold(formatOwnerCompletion(`People mostly talk about price. Here is the report: ${link}`, []));
    assert.ok(sms.includes(link), "the link survives the outbox text handling and the SMS fold");
    const own = smsGsmFold(formatOwnerCompletion(`Done.\n${link}`, []));
    assert.ok(own.split("\n").includes(link), "a link on its own line keeps its lower-case scheme");

    const sig = signReportId(secret, report.id);
    assert.ok(verifyReportSignature(secret, report.id, sig));
    assert.ok(!verifyReportSignature(secret, report.id, `${sig.slice(0, -1)}${sig.endsWith("A") ? "B" : "A"}`));
    assert.ok(!verifyReportSignature(secret, "2026-11-02-other", sig));
    assert.deepEqual(reportsLinkedInText(roots, secret, `See ${link} and ${link}`).map((r) => r.id), [report.id]);
    console.log("ok report links: secret, shape, outbox text, signature");
  } finally {
    fs.rmSync(roots.desktopRoot, { recursive: true, force: true });
  }
}

function listen(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app).listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function testRoutes() {
  const roots = tempRoots();
  const projectRoot = roots.desktopRoot;
  let makeCalls = 0;
  const makeOpts = [];
  const app = express();
  const router = express.Router();
  router.use(express.json());
  registerResearchRoutes(router, {
    projectRoot,
    roots,
    publicBase: "https://otto.box.example.test/joshu",
    make: async (topic, opts) => {
      makeCalls += 1;
      makeOpts.push(opts);
      if (topic === "fail") throw new ResearchStepError("collect", "the engine exited with code 1");
      return makeResearchReport("/unused", topic, fakeDeps(roots));
    },
  });
  app.use("/joshu", router);
  const server = await listen(app);
  const base = `http://127.0.0.1:${server.address().port}/joshu`;
  try {
    const viaCaddy = await fetch(`${base}/api/research/reports`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" },
      body: JSON.stringify({ topic: "Heat pumps" }),
    });
    assert.equal(viaCaddy.status, 403, "public requests cannot make reports");
    assert.equal((await fetch(`${base}/api/research/reports?q=x`, { headers: { "x-forwarded-for": "203.0.113.9" } })).status, 403);
    assert.equal(makeCalls, 0);

    const made = await (await fetch(`${base}/api/research/reports`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ topic: "Heat pumps" }),
    })).json();
    assert.equal(made.ok, true);
    for (const field of ["id", "topic", "summary", "sources", "pdfDesktopPath", "pdfFilesPath", "reportLink"]) {
      assert.ok(made.report[field] !== undefined, `result has ${field}`);
    }
    const failed = await (await fetch(`${base}/api/research/reports`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ topic: "fail" }),
    })).json();
    assert.deepEqual([failed.ok, failed.step], [false, "collect"]);

    // The notes and the sections of the owner reach the report (change recurring-research-reports, D14 and D15).
    makeOpts.length = 0;
    await fetch(`${base}/api/research/reports`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ topic: "Garden sheds", notes: "not the band", sections: ["prices", 7, "installers"] }),
    });
    assert.deepEqual(makeOpts[0].request, { notes: "not the band", sections: ["prices", "installers"] }, "notes and the text sections reach make");

    const found = await (await fetch(`${base}/api/research/reports?q=heat`)).json();
    assert.deepEqual(found.reports.map((r) => r.id), [made.report.id]);

    // The public report link.
    const linkPath = new URL(made.report.reportLink).pathname;
    const good = await fetch(`${base}${linkPath.replace(/^\/joshu/, "")}`, { headers: { "x-forwarded-for": "203.0.113.9" } });
    assert.equal(good.status, 200, "the report link needs no sign-in");
    assert.equal(good.headers.get("content-type"), "application/pdf");
    assert.match(good.headers.get("x-robots-tag"), /noindex/);
    assert.equal(await good.text(), "%PDF-1.7 fake");

    const [, , , , , id, sig] = linkPath.split("/");
    const flip = (t) => `${t.slice(0, -1)}${t.endsWith("A") ? "B" : "A"}`;
    for (const bad of [
      `/api/research/r/${id}/${flip(sig)}/report.pdf`,
      `/api/research/r/2026-11-02-electric-bike-subscriptions/${sig}/report.pdf`,
      `/api/research/r/..%2F..%2Fetc/${sig}/report.pdf`,
      `/api/research/r/${id}/${sig}/../report.json`,
    ]) {
      assert.equal((await fetch(`${base}${bad}`)).status, 404, `not found: ${bad}`);
    }
    fs.rmSync(path.join(roots.filesRoot, "Research", id), { recursive: true, force: true });
    assert.equal((await fetch(`${base}${linkPath.replace(/^\/joshu/, "")}`)).status, 404, "deleted report: not found");
    console.log("ok report routes: localhost gate, make, failure, find, public link, tampering, deleted report");
  } finally {
    server.close();
    fs.rmSync(roots.desktopRoot, { recursive: true, force: true });
  }
}

testCountsAndCharts();
await testReportHtml();
await testQuietHtml();
await testStoreAndMake();
await testFindReports();
await testReportLinks();
await testRoutes();
console.log("all research report checks passed");
