/**
 * Unit tests of the runs of recurring reports (change recurring-research-reports, tasks 3.1 to 3.6,
 * 3.8, and 4.1, and change research-report-topics, groups 1, 2, and 4): the run route, the collect
 * period, the group and compare steps, the story status, the themes and their checks, the text of
 * each channel, the saved files, the quiet mark, the failure note, and the delivery on each channel.
 * No network.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { RecurringStore } from "../src/research/recurring/store.ts";
import { RecurringService } from "../src/research/recurring/service.ts";
import { RecurringRunner, runRecurringReport, RUN_LIMITS_MS } from "../src/research/recurring/run.ts";
import { applyRun, compareStories, groupStories, STORY_KEEP_DAYS } from "../src/research/recurring/stories.ts";
import { buildThemes, MAX_THEMES, notesThemeLimit } from "../src/research/themes/index.ts";
import { themeLinks } from "../src/research/themes/links.ts";
import { PAGES_PER_REPORT, PAGES_PER_THEME } from "../src/research/themes/read.ts";
import { themesEmailText, themesText } from "../src/research/themes/text.ts";
import { collectLane, isIndexPage, MAX_TERMS_PER_RUN, resolveRedirect, runTerms } from "../src/research/recurring/collect.ts";
import { deliver, emailRecipients, emailText, linkLabel } from "../src/research/recurring/delivery.ts";
import { registerRecurringRoutes } from "../src/research/recurring/routes.ts";
import { sendReport } from "../src/research/routes.ts";
import { makeRepeatUpdate, reportLane } from "../src/research/recurring/repeat.ts";
import { digestHtml, laneHistory, renderUpdateHtml, renderUpdatePdf } from "../src/research/recurring/updatePdf.ts";
import { reportLinkSecret, resolveSignedUpdate, updateLink } from "../src/research/reportLinks.ts";

const DAY = 86_400_000;

function tmpRoots() {
  const desktopRoot = fs.mkdtempSync(path.join(os.tmpdir(), "research-run-"));
  const filesRoot = path.join(desktopRoot, "joshu's files");
  fs.mkdirSync(filesRoot, { recursive: true });
  return { desktopRoot, filesRoot };
}

function reply(content) {
  return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(content) } }] }) };
}

/**
 * A fake OpenRouter for every model step of a run. Items carry a tag in their title, for example
 * "{army}", and the group step makes one story for each tag. The compare step matches stories by tag.
 */
function runModel(opts = {}) {
  const requests = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    const title = init.headers["X-Title"] ?? "";
    const user = body.messages[1].content;
    requests.push({ title, user, body });
    if (opts.fail?.some((s) => title.includes(`(${s})`))) return { ok: false, status: 500, json: async () => ({}) };
    if (title.includes("(plan)")) {
      const topics = [...user.matchAll(/^\d+\. (.*?)(?: \(hints|$)/gm)].map((m) => m[1]);
      return reply({ lanes: topics.map((t) => ({ topic: t, picks: ["web", "reddit", "youtube"], reason: "Coverage.", web_queries: [`${t} news`, `${t} deals`], news_query: t, social_query: t, scholar_query: "", company: null })) });
    }
    if (title.includes("(group)")) {
      const byTag = new Map();
      for (const m of user.matchAll(/^\[(n\d+)\] [^:]*: \{(\w+)\}/gm)) {
        if (m[2] === "spam") continue;
        byTag.set(m[2], [...(byTag.get(m[2]) ?? []), m[1]]);
      }
      return reply({ stories: [...byTag.entries()].map(([tag, items]) => ({ title: `Story ${tag}`, summary: `About ${tag}.`, items })) });
    }
    if (title.includes("(compare)")) {
      const today = [...user.matchAll(/^\[(r\d+)\] \(topic: ([^,)]*)[^)]*\) Story (\w+)/gm)].map((m) => ({ key: m[1], topic: m[2], tag: m[3] }));
      const earlier = [...user.matchAll(/^\[(S\d+)\] \(topic: [^)]*\) Story (\w+)/gm)].map((m) => ({ id: m[1], tag: m[2] }));
      const matches = today.flatMap((t) => earlier.filter((e) => e.tag === t.tag).map((e) => ({ story: t.key, earlier: e.id })));
      const same = today.flatMap((t, i) => today.slice(0, i).filter((o) => o.tag === t.tag && o.topic !== t.topic).map((o) => ({ story: t.key, as: o.key })));
      return reply({ matches, same });
    }
    if (title.includes("(themes)")) {
      // One theme for each story, at most the limit of the prompt.
      const limit = Number(/At most (\d+) themes/.exec(body.messages[0].content)?.[1] ?? 99);
      const stories = [...user.matchAll(/^\[(S\d+)\] \((new|developing)\) Story (\w+)\./gm)];
      return reply({ themes: stories.slice(0, limit).map((m) => ({ label: `Theme ${m[3]}`, stories: [m[1]] })) });
    }
    if (title.includes("(extract)")) {
      // The text of each page is its quote.
      const facts = [...user.matchAll(/^\[(p\d+)\] [^\n]*\n([^\n]+)$/gm)].map((m) => ({ claim: `Fact of ${m[1]}.`, quote: m[2].trim(), page_id: m[1] }));
      return reply({ facts });
    }
    if (body.messages[0].content.startsWith("You write one theme")) {
      const ids = [...user.matchAll(/^(F\d+) /gm)].map((m) => m[1]);
      const theme = /^Theme \([^)]*\): (.*)$/m.exec(user)?.[1] ?? "Theme";
      const lines = [`${theme} has news [${ids[0]}].`];
      if (opts.invent) lines.push(`The contract is worth $40 million [${ids[0]}].`);
      if (opts.unknown) lines.push("A story that does not exist [F999].");
      return reply({ headline: `${theme} headline`, body: lines.join(" ") });
    }
    // The summary of the themes.
    const cite = /\[(F\d+)\]/.exec(user)?.[1];
    return reply({ summary: `Robots made news this week [${cite}].`, chat: "Robots made news this week." });
  };
  return { fetchImpl, requests };
}

/** Pages for each query: the query words pick the pages of `PAGES`. */
function fakeExa(pages, calls = []) {
  return {
    calls,
    async search(req) {
      calls.push(req);
      return (pages[req.query] ?? []).map((p) => ({ url: p.url, title: p.title, ...(p.date ? { publishedDate: p.date } : {}), highlights: [p.text ?? p.title] }));
    },
    async contents() {
      return [];
    },
  };
}

const NO_SOCIAL = { client: null, unavailable: "content router off" };

function fakeSenders(log, opts = {}) {
  return {
    profileEmails: () => [{ email: "owner@example.com", name: "Owner" }, { email: "owner.home@example.com", name: "Owner" }],
    async email(to, subject, body, attachments) {
      log.push({ channel: "email", to: to.map((t) => t.email), subject, body, attachments });
      if (opts.failEmail) throw new Error("Nylas down");
      return "msg-1";
    },
    async ownerText(input) {
      log.push({ channel: "sms", text: input.sms, subject: input.emailSubject });
      return opts.smsFallsBack ? { delivered: true, channel: "email" } : { delivered: true, channel: "sms" };
    },
    async origin(channel) {
      return opts.origins?.[channel] ?? null;
    },
    async chat(channel, origin, text) {
      log.push({ channel, to: origin.replyAddress, text });
      return { delivered: true };
    },
  };
}

function setupFixture(roots, overrides = {}) {
  const store = new RecurringStore(roots);
  const at = "2026-10-01T00:00:00.000Z";
  const lane = (id, topic) => ({ id, topic, addedAt: at, plan: { picks: ["web"], reason: "", webQueries: [`${topic} news`], newsQuery: topic, socialQuery: topic, scholarQuery: "", madeAt: at } });
  const setup = {
    schemaVersion: 1,
    id: "rr_0000aaaa",
    slug: "robots",
    name: "Robots",
    lanes: [lane("l1", "humanoid robots"), lane("l2", "defense contracts")],
    sources: "auto",
    schedule: "0 7 * * 1-5",
    channel: "sms",
    notes: "",
    state: "active",
    scriptName: "research-recurring-rr_0000aaaa.sh",
    createdAt: at,
    updatedAt: at,
    nothingNewInARow: 0,
    ...overrides,
  };
  store.create(setup);
  return { store, setup };
}

function page(url, tag, date = "2026-10-29T08:00:00.000Z", text) {
  return { url, title: `{${tag}} headline ${url.split("/").pop()}`, date, text };
}

function deps(over = {}) {
  const log = over.log ?? [];
  return {
    projectRoot: "/unused",
    exa: over.exa,
    composio: null,
    social: NO_SOCIAL,
    llm: { fetchImpl: (over.model ?? runModel()).fetchImpl, apiKey: "k", model: "m" },
    senders: fakeSenders(log, over.senders),
    now: () => over.now ?? new Date("2026-10-30T14:00:00.000Z"),
    timezone: "America/Los_Angeles",
    ...(over.writePdf ? { writePdf: over.writePdf } : {}),
  };
}

async function testGroupAndCompare() {
  const lanes = [{ id: "l1", topic: "humanoid robots" }, { id: "l2", topic: "defense contracts" }];
  const items = [
    { key: "n1", laneId: "l1", url: "https://news.example/army", source: "web", sourceLabel: "news.example", title: "{army} news", text: "" },
    { key: "n2", laneId: "l1", url: "https://reddit.com/r/robots/army", source: "reddit", sourceLabel: "Reddit", title: "{army} thread", text: "" },
    { key: "n3", laneId: "l1", url: "https://youtube.com/watch?v=army", source: "youtube", sourceLabel: "YouTube", title: "{army} video", text: "" },
    { key: "n4", laneId: "l1", url: "https://spam.example/x", source: "web", sourceLabel: "spam.example", title: "{spam} buy now", text: "" },
    { key: "n5", laneId: "l2", url: "https://gov.example/army-award", source: "web", sourceLabel: "gov.example", title: "{army} award", text: "" },
    { key: "n6", laneId: "l2", url: "https://gov.example/navy", source: "web", sourceLabel: "gov.example", title: "{navy} award", text: "" },
  ];
  const model = runModel();
  const llm = { fetchImpl: model.fetchImpl, apiKey: "k", model: "m" };
  const stories = await groupStories(lanes, items, Date.now() + 5000, llm);
  assert.equal(model.requests.filter((r) => r.title.includes("(group)")).length, 1, "one group call for all lanes (change research-report-topics, D3)");
  assert.match(model.requests[0].user, /^Topics:\n- humanoid robots\n- defense contracts\n/, "the group call names every topic");
  assert.match(model.requests[0].body.messages[0].content, /Leave out pages that report no event/, "the group step leaves out pages that report no event");
  // A run with more than 120 items groups each lane in its own call, so that one prompt stays small.
  const many = Array.from({ length: 130 }, (_, i) => ({ ...items[0], key: `n${i + 1}`, laneId: i % 2 ? "l2" : "l1", url: `https://news.example/army-${i}` }));
  const bigModel = runModel();
  const big = await groupStories(lanes, many, Date.now() + 5000, { ...llm, fetchImpl: bigModel.fetchImpl });
  assert.equal(bigModel.requests.filter((r) => r.title.includes("(group)")).length, 2, "one group call for each lane above 120 items");
  assert.deepEqual(new Set(big.map((s) => s.laneId)), new Set(["l1", "l2"]));
  // What the topic means and the notes of the owner reach the group step (D14).
  const described = [{ ...lanes[0], plan: { about: "Robots with a human shape.", notAbout: ["Humanoid, the band"] } }];
  const model2 = runModel();
  await groupStories(described, items.filter((i) => i.laneId === "l1"), Date.now() + 5000, { ...llm, fetchImpl: model2.fetchImpl }, "not the band");
  const groupUser = model2.requests.find((r) => r.title.includes("(group)")).user;
  assert.match(groupUser, /^Topic: humanoid robots\nAbout: Robots with a human shape\.\nNot about: Humanoid, the band\nNotes of the owner: not the band\n/);
  assert.ok(!stories.some((s) => s.items.some((i) => i.key === "n4")), "off-topic items are left out");
  const empty = { schemaVersion: 1, nextNumber: 1, stories: [] };
  const now = new Date("2026-10-30T14:00:00.000Z");
  const result = await compareStories(stories, empty, { lanes, startingLanes: new Set(), run: "2026-10-30-0700", now, deadline: Date.now() + 5000, llm });
  const army = result.stories.find((s) => s.title === "Story army");
  assert.equal(army.items.length, 4, "the story of two lanes is one story");
  assert.equal(army.laneId, "l1", "a story belongs to the lane of its first item");
  assert.deepEqual(army.sources, ["Web and news", "Reddit", "YouTube"], "one event on three sources");
  assert.equal(result.stories.filter((s) => s.title === "Story army").length, 1);
  assert.ok(result.stories.every((s) => s.status === "new"));

  // A match by link needs no model call.
  const stored = applyRun(empty, result, { run: "2026-10-30-0700", now, shown: new Set(result.stories.map((s) => s.id)) });
  const again = [{ key: "r1", laneId: "l1", title: "Other words", summary: "", items: [items[0]] }];
  const before = model.requests.length;
  const second = await compareStories(again, stored, { lanes: [lanes[0]], startingLanes: new Set(), run: "2026-10-31-0700", now: new Date(now.getTime() + DAY), deadline: Date.now() + 5000, llm });
  assert.equal(model.requests.length, before, "no model call for a match by link");
  assert.equal(second.stories[0].id, army.id);
  assert.equal(second.stories[0].status, "quiet", "the same pages again");
  console.log("ok group and compare: three sources in one story, two lanes, match by link");
}

function testStatusAndStore() {
  const now = new Date("2026-10-30T14:00:00.000Z");
  const item = (url) => ({ url, source: "web", sourceLabel: "x", title: url, firstRun: "r0" });
  const file = {
    schemaVersion: 1,
    nextNumber: 3,
    stories: [
      { id: "S1", laneId: "l1", title: "Old", summary: "", firstRun: new Date(now.getTime() - 70 * DAY).toISOString(), lastRun: new Date(now.getTime() - (STORY_KEEP_DAYS + 1) * DAY).toISOString(), items: [item("https://a/1")] },
      { id: "S2", laneId: "l1", title: "Recent", summary: "", firstRun: now.toISOString(), lastRun: new Date(now.getTime() - DAY).toISOString(), items: [item("https://a/2")] },
    ],
  };
  const result = {
    nextNumber: 4,
    stories: [
      { id: "S2", laneId: "l1", title: "Recent", summary: "s", status: "developing", sources: [], items: [item("https://a/2"), item("https://a/3")], newItems: ["https://a/3"] },
      { id: "S3", laneId: "l1", title: "New", summary: "s", status: "new", sources: [], items: [item("https://a/4")], newItems: ["https://a/4"] },
    ],
  };
  const next = applyRun(file, result, { run: "2026-10-30-0700", now, shown: new Set(["S2", "S3"]) });
  assert.deepEqual(next.stories.map((s) => s.id).sort(), ["S2", "S3"], "a story not found for 60 days is dropped");
  assert.equal(next.stories.find((s) => s.id === "S2").items.length, 2, "the new item joins the story");
  assert.equal(next.nextNumber, 4);
  console.log("ok story status and stored stories: developing, new, dropped after 60 days");
}

function testThemeText() {
  const theme = (index, title, links) => ({ index, title, label: title, body: `${title} happened [F1].\n\nMore about it [F2].`, factIds: ["F1", "F2"], kind: "news", storyIds: [], links });
  const army = theme(0, "Army buys robots", [
    { url: "https://news.example/a", site: "news.example", title: "Army signs deal" },
    { url: "https://reddit.com/b", site: "Reddit", title: "Thread", counter: "812 upvotes" },
  ]);
  const navy = theme(1, "Navy tests drones", [{ url: "https://gov.example/n", site: "gov.example", title: "Navy test" }]);
  const summary = "Two buyers moved this week [F1].";
  const sms = themesText(summary, [army, navy], "sms");
  assert.equal(sms, "Two buyers moved this week.\n\n• Army buys robots: https://news.example/a\n• Navy tests drones: https://gov.example/n", "a text message: the summary and one line for each theme");
  assert.equal(themesText(summary, [army], "slack"), "Two buyers moved this week.\n\n• *Army buys robots* <https://news.example/a|news.example>", "Slack");
  assert.equal(themesText(summary, [army], "telegram"), "Two buyers moved this week.\n\n• Army buys robots: https://news.example/a");
  const email = themesText(summary, [army, navy], "email");
  assert.ok(email.startsWith("Two buyers moved this week.\n\n### Army buys robots\n\nArmy buys robots happened.\n\nMore about it."), "the email has every paragraph without citations");
  assert.ok(email.includes("[Army signs deal](https://news.example/a) (news.example)"), "the lead link");
  assert.ok(email.includes("More: [Reddit, 812 upvotes](https://reddit.com/b)"), "the other links with the engagement of a post");
  assert.ok(!/\[F\d+\]/.test(email), "no raw citation");
  const short = themesEmailText(summary, [army], { firstParagraph: true });
  assert.ok(short.includes("Army buys robots happened.") && !short.includes("More about it") && !short.includes("More:"), "the email of a Research report has the first paragraph and the lead link");
  // A theme of 7 themes with long paragraphs stays far below the 102 KB where Gmail cuts an email.
  const seven = Array.from({ length: 7 }, (_, i) => ({ ...army, index: i, body: `${"A long sentence about the theme. ".repeat(20)}[F1]\n\n${"More. ".repeat(40)}` }));
  assert.ok(Buffer.byteLength(themesText(summary, seven, "email")) < 100_000);

  // The links of a theme: a direct link before a Google News redirect, a news article first.
  const story = { id: "S1", laneId: "l1", title: "t", summary: "", status: "new", sources: [], newItems: [], items: [
    { url: "https://reddit.com/r/x", source: "reddit", sourceLabel: "Reddit", title: "post", engagement: { score: 12 }, firstRun: "r" },
    { url: "https://www.google.com/goto?url=x", source: "news", sourceLabel: "Google News", title: "redirect", firstRun: "r" },
    { url: "https://site.example/2026/10/a", source: "web", sourceLabel: "site.example", title: "web page", firstRun: "r" },
  ] };
  const links = themeLinks({ storyIds: ["S1"], factIds: [] }, new Map([["S1", story]]), new Map(), new Map());
  assert.equal(links[0].url, "https://site.example/2026/10/a", "the lead link is a direct link");
  assert.equal(links.find((l) => l.site === "Reddit").counter, "12 upvotes");
  const onlyRedirect = themeLinks({ storyIds: ["S1"], factIds: [] }, new Map([["S1", { ...story, items: [story.items[1]] }]]), new Map(), new Map());
  assert.equal(onlyRedirect[0].site, "Google News", "a redirect when it is the only link");
  console.log("ok theme text of each channel, email size, links of a theme");
}

async function testThemeSteps() {
  const model = runModel({ invent: true, unknown: true });
  const llm = { fetchImpl: model.fetchImpl, apiKey: "k", model: "m" };
  const tags = ["army", "navy", "figure", "drone", "tesla", "boston", "unitree", "agility", "apptronik", "sanctuary", "fourier", "xpeng"];
  const stories = tags.map((tag, i) => ({
    id: `S${i + 1}`, laneId: i < 6 ? "l1" : "l2", title: `Story ${tag}`, summary: `About ${tag}.`, status: i === 0 ? "developing" : "new", sources: ["Web and news"],
    items: [{ url: `https://n.example/${tag}`, source: "web", sourceLabel: "n.example", title: `{${tag}} item`, text: `${tag} news text of the item`, firstRun: "r" }],
    newItems: [`https://n.example/${tag}`],
  }));
  const contents = [];
  const exa = { search: async () => [], contents: async (urls) => (contents.push(urls), urls.map((url) => ({ url, text: `${url.split("/").pop()} full text of the page, read in full by Exa for the theme.` }))) };
  const limits = { themes: 5000, read: 5000, extract: 5000, write: 5000, summary: 5000 };
  const built = await buildThemes({ mode: "update", topic: "Robots", plan: { about: "Robots with a human shape." }, notes: "at most 5 items, one line on why each one matters", stories, limit: notesThemeLimit("at most 5 items"), exa, limits, llm });
  assert.equal(built.themes.length, 5, "the notes limit counts themes");
  assert.ok(built.themes.every((t) => t.links?.length && t.storyIds?.length), "each theme has its stories and links");
  assert.ok(built.themes.every((t) => !t.body.includes("$40 million")), "the invented number is dropped");
  assert.ok(built.dropped.some((d) => /F999/.test(d)), "a sentence with an unknown fact is dropped");
  assert.ok(built.summary.summary.startsWith("Robots made news"));
  assert.equal(contents.flat().length, 5, "the pages of each theme are read in full");
  const user = (step) => model.requests.filter((r) => r.title.includes(`(${step})`)).map((r) => r.user);
  assert.ok(user("extract").every((u) => /read in full by Exa/.test(u)), "the fact step reads the full text of the pages");
  assert.ok(user("write").some((u) => u.includes("Notes of the owner: at most 5 items, one line on why each one matters")), "the notes reach the writer");
  assert.ok(user("write").some((u) => /Other themes of the report:\n- Theme /.test(u)), "the writer gets the headlines of the other themes");
  assert.ok(user("write").some((u) => /Story army \(developing; earlier: About army\.\)/.test(u)), "a developing story comes with its earlier summary");
  assert.ok(model.requests.every((r) => r.body.provider.data_collection === "deny"), "no-training routing");
  assert.equal(MAX_THEMES, 7);
  assert.ok(PAGES_PER_THEME === 4 && PAGES_PER_REPORT === 20);
  const all = await buildThemes({ mode: "update", topic: "Robots", plan: {}, notes: "", stories, exa, limits, llm });
  assert.equal(all.themes.length, MAX_THEMES, "at most 7 themes");

  // The limit of the notes, in code.
  assert.equal(notesThemeLimit("At most 8 items. ALL-CAPS headings."), 8);
  assert.equal(notesThemeLimit("keep it to 5 stories, one line each"), 5);
  assert.equal(notesThemeLimit("Keep it to 5."), 5);
  assert.equal(notesThemeLimit("10 items max"), 10);
  assert.equal(notesThemeLimit("keep it to 2 minutes of reading"), undefined);
  assert.equal(notesThemeLimit("one line on why it matters"), undefined);

  for (const index of ["https://www.therobotreport.com/robotics-news/", "https://www.therobotreport.com/category/news/", "https://example.com/", "https://example.com/tag/robots", "https://vuntum.com/en/news"]) assert.ok(isIndexPage(index), index);
  for (const article of ["https://www.reuters.com/technology/army-humanoid-robots-2026-10-28/", "https://cloud.google.com/blog/products/ai/gemini-robotics", "https://example.com/news-of-the-day-army-robots"]) assert.ok(!isIndexPage(article), article);
  // A Google News redirect becomes the article link.
  assert.equal(await resolveRedirect("https://www.google.com/goto?url=CAES", Date.now() + 5000, async (u) => ({ headers: { get: (k) => (k === "location" ? "https://www.reuters.com/world/a-2026-10-28/" : null) } })), "https://www.reuters.com/world/a-2026-10-28/");
  assert.equal(await resolveRedirect("https://www.google.com/goto?url=bad", Date.now() + 5000, async () => ({ headers: { get: () => null } })), "https://www.google.com/goto?url=bad", "no location keeps the link");
  assert.equal(await resolveRedirect("https://site.example/a", Date.now() + 5000, async () => { throw new Error("no call"); }), "https://site.example/a", "a direct link makes no call");
  console.log("ok theme steps: notes limit, read in full, facts, checks, writer input, index pages, redirects");
}

async function testUndatedPages() {
  // A web page without a date is left out of a report update (change research-report-topics, D4).
  const roots = tmpRoots();
  try {
    const { store, setup } = setupFixture(roots, { lanes: [{ id: "l1", topic: "claims AI", addedAt: "2026-10-01T00:00:00.000Z", plan: { picks: ["web"], reason: "", webQueries: ["claims AI news"], newsQuery: "claims AI", socialQuery: "claims AI", scholarQuery: "", about: "AI for insurance claims.", madeAt: "2026-10-01T00:00:00.000Z" } }] });
    const model = runModel();
    const exa = fakeExa({ "claims AI news": [page("https://vendor.example/resource-hub", "hub", null), page("https://news.example/round", "round")] });
    const r = await runRecurringReport(store, setup.id, deps({ exa, model }));
    assert.equal(r.result, "delivered");
    const group = model.requests.find((q) => q.title.includes("(group)")).user;
    assert.ok(!group.includes("resource-hub") && !group.includes("{hub}"), "the vendor page without a date never reaches the group step");
    assert.ok(group.includes("{round}"));
    console.log("ok a web page without a date is left out of a report update");
  } finally {
    fs.rmSync(roots.desktopRoot, { recursive: true, force: true });
  }
}

async function testRunFilesAndPeriods() {
  const roots = tmpRoots();
  try {
    const { store, setup } = setupFixture(roots);
    const exaCalls = [];
    const day1 = {
      "humanoid robots news": [page("https://news.example/army", "army"), page("https://news.example/figure", "figure")],
      "defense contracts news": [page("https://gov.example/army", "army"), page("https://gov.example/navy", "navy")],
    };
    const log = [];
    const now1 = new Date("2026-10-30T14:00:00.000Z");
    const first = await runRecurringReport(store, setup.id, deps({ exa: fakeExa(day1, exaCalls), log, now: now1 }));
    assert.equal(first.result, "delivered", JSON.stringify(first));
    assert.equal(exaCalls[0].startPublishedDate, new Date(now1.getTime() - 7 * DAY).toISOString(), "a starting update covers 7 days");
    const folder = store.folder(setup);
    const run1 = path.join(folder, "updates", "2026-10-30-0700");
    assert.ok(fs.existsSync(path.join(run1, "update.json")) && fs.existsSync(path.join(run1, "update.md")));
    const u1 = JSON.parse(fs.readFileSync(path.join(run1, "update.json"), "utf8"));
    assert.ok(u1.stories.every((s) => s.status === "new"), "every story of a starting update is new");
    assert.ok(u1.lanes.every((l) => l.starting));
    assert.equal(u1.stories.filter((s) => s.title === "Story army").length, 1, "the army story once, in the first lane");
    assert.match(fs.readFileSync(path.join(run1, "update.md"), "utf8"), /^# Robots: October 30/);
    assert.equal(u1.schemaVersion, 2);
    assert.equal(u1.themes.length, 3, "one theme for each story here, not one section for each lane");
    assert.ok(u1.facts.length && u1.pages.length, "the facts and pages that the themes cite");
    assert.match(log[0].text, /^Robots made news this week\.\n\n• /, "a text message has the summary and one line for each theme");
    assert.equal(log.length, 1);
    assert.equal(log[0].channel, "sms");
    assert.equal(log[0].subject, "Robots: October 30");
    const stories1 = JSON.parse(fs.readFileSync(path.join(folder, "stories.json"), "utf8"));
    assert.equal(stories1.stories.length, 3);

    // Day 2: a new item about the army story, the figure story again with the same page.
    const day2 = {
      "humanoid robots news": [page("https://news.example/figure", "figure"), page("https://news.example/army-2", "army")],
      "defense contracts news": [],
    };
    const now2 = new Date(now1.getTime() + DAY);
    exaCalls.length = 0;
    const second = await runRecurringReport(store, setup.id, deps({ exa: fakeExa(day2, exaCalls), log, now: now2 }));
    assert.equal(second.result, "delivered");
    assert.equal(exaCalls[0].startPublishedDate, now1.toISOString(), "a normal run covers the period since the last update");
    const u2 = JSON.parse(fs.readFileSync(path.join(folder, "updates", "2026-10-31-0700", "update.json"), "utf8"));
    assert.equal(u2.stories.find((s) => s.title === "Story army").status, "developing", "known story with news");
    assert.equal(u2.stories.find((s) => s.title === "Story figure").status, "quiet", "known story without news");
    const figure = u2.stories.find((s) => s.title === "Story figure").id;
    assert.ok(!u2.themes.some((t) => t.storyIds.includes(figure)), "a quiet story is in no theme");
    assert.match(log.at(-1).text, /Theme army/, "the developing story is in a theme");

    // Day 3: the run fails; day 4 covers the period since day 2.
    const now3 = new Date(now2.getTime() + DAY);
    const storiesBefore = fs.readFileSync(path.join(folder, "stories.json"), "utf8");
    const failed = await runRecurringReport(store, setup.id, deps({ exa: fakeExa(day2), log, now: now3, model: runModel({ fail: ["group"] }) }));
    assert.equal(failed.result, "failed");
    assert.equal(failed.step, "group", "the step name of the failure");
    assert.equal(fs.readFileSync(path.join(folder, "stories.json"), "utf8"), storiesBefore, "a failed run does not change stories.json");
    assert.match(log.at(-1).text, /failed/);
    assert.ok(!fs.existsSync(path.join(folder, "updates", "2026-11-01-0700")), "no report update for a failed run");
    exaCalls.length = 0;
    await runRecurringReport(store, setup.id, deps({ exa: fakeExa(day2, exaCalls), log, now: new Date(now3.getTime() + DAY) }));
    assert.equal(exaCalls[0].startPublishedDate, now2.toISOString(), "the run after a failure covers the missed period");

    // Nothing new: update.json only, no message, and quiet after 5 runs.
    let at = now3.getTime() + DAY;
    const sentBefore = log.length;
    for (let i = 0; i < 5; i += 1) {
      at += DAY;
      const r = await runRecurringReport(store, setup.id, deps({ exa: fakeExa(day2), log, now: new Date(at) }));
      assert.equal(r.result, "nothing new");
    }
    assert.equal(log.length, sentBefore, "a run with nothing new sends nothing");
    const lastRun = store.get(setup.id).lastRun;
    const nothingFolder = path.join(roots.filesRoot, lastRun.folder);
    assert.ok(fs.existsSync(path.join(nothingFolder, "update.json")) && !fs.existsSync(path.join(nothingFolder, "update.md")));
    const svc = new RecurringService({ projectRoot: "/unused", store, scriptsDir: roots.desktopRoot, cron: async () => ({ success: true }), now: () => new Date(at), available: () => ["web"] });
    assert.equal(svc.list()[0].quiet, true, "quiet after 5 runs with nothing new");

    // The owner asked for a "nothing new" line.
    await store.update(setup.id, (s) => ((s.nothingNewLine = true), { result: undefined, changed: true }));
    await runRecurringReport(store, setup.id, deps({ exa: fakeExa(day2), log, now: new Date(at + DAY) }));
    assert.match(log.at(-1).text, /Nothing new in "Robots"/);
    console.log("ok runs: starting update, periods, developing and quiet, failed run, nothing new, quiet mark");
  } finally {
    fs.rmSync(roots.desktopRoot, { recursive: true, force: true });
  }
}

async function testEmailPdf() {
  const day1 = { "humanoid robots news": [page("https://news.example/army", "army")], "defense contracts news": [page("https://gov.example/navy", "navy")] };
  for (const failPdf of [false, true]) {
    const roots = tmpRoots();
    try {
      const { store, setup } = setupFixture(roots, { channel: "email" });
      const log = [];
      const writePdf = async (_h, p) => {
        if (failPdf) throw new Error("Chromium missing");
        fs.writeFileSync(p, "%PDF-1.7 fake");
      };
      const run = await runRecurringReport(store, setup.id, deps({ exa: fakeExa(day1, []), log, writePdf }));
      assert.equal(run.result, "delivered", JSON.stringify(run));
      assert.equal(log.length, 1);
      assert.match(log[0].body, /^Robots made news this week\.\n\n### Theme army headline/, "the email has the whole update in its body");
      assert.match(log[0].body, /\[\{army\} headline army\]\(https:\/\/news\.example\/army\) \(news\.example\)/, "with the lead link of each theme");
      if (failPdf) assert.equal(log[0].attachments, undefined, "a PDF that fails is left out, and the email still goes");
      else {
        assert.equal(log[0].attachments.length, 1, "an email update has the update PDF attached");
        assert.deepEqual([log[0].attachments[0].filename, log[0].attachments[0].contentType], ["robots-2026-10-30-0700.pdf", "application/pdf"]);
        assert.ok(fs.existsSync(path.join(store.folder(setup), "updates", "2026-10-30-0700", "update.pdf")));
      }
    } finally {
      fs.rmSync(roots.desktopRoot, { recursive: true, force: true });
    }
  }
  console.log("ok email update: the whole update in the body, update PDF attached, email without it when the PDF fails");
}

async function testStepFailures() {
  for (const [stepName, over] of [
    ["search", { exa: { search: async () => { throw new Error("Exa 500"); } } }],
    ["compare", { model: runModel({ fail: ["compare"] }) }],
    ["write", { model: runModel({ fail: ["write"] }) }],
  ]) {
    const roots = tmpRoots();
    try {
      const { store, setup } = setupFixture(roots);
      // Lanes that ran before, so that the compare step compares with the stored story.
      await store.update(setup.id, (s) => (s.lanes.forEach((l) => (l.firstRunAt = "2026-10-01T00:00:00.000Z")), { result: undefined, changed: true }));
      // A stored story, so that the compare step calls the model.
      fs.writeFileSync(path.join(store.folder(setup), "stories.json"), JSON.stringify({ schemaVersion: 1, nextNumber: 2, stories: [{ id: "S1", laneId: "l1", title: "Story other", summary: "", firstRun: "2026-10-29T00:00:00.000Z", lastRun: "2026-10-29T00:00:00.000Z", items: [] }] }));
      const exa = over.exa ?? fakeExa({ "humanoid robots news": [page("https://n/1", "army")], "defense contracts news": [page("https://n/2", "navy")] });
      const log = [];
      const r = await runRecurringReport(store, setup.id, deps({ ...over, exa, log }));
      assert.equal(r.result, "failed", stepName);
      assert.equal(r.step, stepName);
      assert.equal(log.length, 1, `${stepName}: one failure note`);
      assert.match(log[0].text, /failed/);
      assert.deepEqual(fs.readdirSync(path.join(store.folder(setup), "updates")), [], `${stepName}: no report update`);
    } finally {
      fs.rmSync(roots.desktopRoot, { recursive: true, force: true });
    }
  }
  const path_ = ["collect", "group", "compare", "themes", "read", "extract", "write", "summary", "pictures", "render", "send"].reduce((n, k) => n + RUN_LIMITS_MS[k], 0);
  assert.equal(path_, 750_000, "12.5 minutes in all, inside the 15 minutes after the scheduled time");
  console.log("ok failures name their step, send the failure note, and save no report update");
}

async function testRunnerAndRoute() {
  const roots = tmpRoots();
  try {
    const { store, setup } = setupFixture(roots);
    for (const id of ["rr_0000bbbb", "rr_0000cccc"]) store.create({ ...setup, id, slug: id });
    let release;
    const gate = new Promise((r) => (release = r));
    let running = 0;
    let maxRunning = 0;
    const slowExa = {
      async search() {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        await gate;
        running -= 1;
        return [];
      },
    };
    const runner = new RecurringRunner(store, () => deps({ exa: slowExa }));
    const rt = { service: { store }, runner, runDeps: () => deps({ exa: slowExa }) };
    const app = express();
    app.use(express.json());
    const router = express.Router();
    registerRecurringRoutes(router, { projectRoot: "/unused", runtime: () => rt, allowApp: async () => true, allowLocal: () => true });
    app.use("/joshu", router);
    const server = app.listen(0);
    const base = `http://127.0.0.1:${server.address().port}/joshu/api/research/recurring`;
    try {
      const a = await fetch(`${base}/${setup.id}/run`, { method: "POST" });
      assert.equal(a.status, 202, "the run route answers 202 at once");
      assert.equal((await a.json()).run, "started");
      assert.equal((await (await fetch(`${base}/${setup.id}/run`, { method: "POST" })).json()).run, "skipped", "a report that is still running is skipped");
      assert.equal((await (await fetch(`${base}/rr_0000bbbb/run`, { method: "POST" })).json()).run, "started");
      assert.equal((await (await fetch(`${base}/rr_0000cccc/run`, { method: "POST" })).json()).run, "queued", "at most two runs at once");
      assert.equal((await fetch(`${base}/rr_ffffffff/run`, { method: "POST" })).status, 404);
      await new Promise((r) => setTimeout(r, 50));
      assert.ok(maxRunning <= 2 * 2, "two runs with two lanes each");
      release();
      await runner.idle();
      assert.ok(!store.get(setup.id).running, "the running mark is cleared");
      assert.ok(store.get("rr_0000cccc").lastRun, "the queued run ran");
    } finally {
      server.close();
    }

    // Start after a crash: a run that was left running is failed, with the failure note.
    await store.update(setup.id, (s) => ((s.running = { startedAt: "2026-10-30T14:00:00.000Z", runId: "x" }), { result: undefined, changed: true }));
    const log = [];
    const after = new RecurringRunner(store, () => deps({ exa: slowExa, log }));
    assert.deepEqual(await after.recoverInterrupted(), [setup.id]);
    assert.equal(store.get(setup.id).lastRun.result, "failed");
    assert.ok(!store.get(setup.id).running);
    assert.match(log[0].text, /failed/);
    console.log("ok run route: 202, skip, two at once, start after a crash");
  } finally {
    fs.rmSync(roots.desktopRoot, { recursive: true, force: true });
  }
}

async function testDelivery() {
  const msg = { subject: "Robots: October 30", text: "• Story [link]", dedupeKey: "k" };
  let log = [];
  let r = await deliver("email", msg, fakeSenders(log));
  assert.deepEqual([r.delivered, r.channel, r.messageId], [true, "email", "msg-1"]);
  assert.deepEqual(log[0].to, ["owner@example.com"], "the primary address by default");
  assert.equal(log[0].subject, "Robots: October 30");
  log = [];
  await deliver("email", { ...msg, emailTo: ["owner@example.com", "owner.home@example.com", "stranger@evil.example"] }, fakeSenders(log));
  assert.deepEqual(log[0].to, ["owner@example.com", "owner.home@example.com"], "a recipient that is not in the profile is never mailed");
  assert.deepEqual(emailRecipients([{ email: "a@x" }], ["b@y"]), [{ email: "a@x" }]);
  log = [];
  await deliver("email", { ...msg, text: "Humanoid robots\n\nA story. https://www.reuters.com/a https://www.google.com/goto?url=x\n\nSee [the site](https://site.example/b).", headings: ["Humanoid robots"] }, fakeSenders(log));
  assert.equal(
    log[0].body,
    "### Humanoid robots\n\nA story. [reuters.com](https://www.reuters.com/a) [Google News](https://www.google.com/goto?url=x)\n\nSee [the site](https://site.example/b).",
    "email: the topic is a heading, and a bare link shows its site",
  );
  assert.equal(emailText("Ends with a link https://a.example/x."), "Ends with a link [a.example](https://a.example/x).", "the period after a link stays out of the link");
  assert.equal(linkLabel("not a url"), "not a url");
  log = [];
  r = await deliver("sms", msg, fakeSenders(log));
  assert.deepEqual([r.delivered, r.channel], [true, "sms"]);
  r = await deliver("sms", msg, fakeSenders(log, { smsFallsBack: true }));
  assert.equal(r.channel, "email", "an SMS that fails goes by email");
  log = [];
  r = await deliver("slack", msg, fakeSenders(log, { origins: { slack: { replyAddress: "D123", threadId: "1.2" } } }));
  assert.deepEqual([r.channel, log[0].channel, log[0].to], ["slack", "slack", "D123"]);
  log = [];
  r = await deliver("telegram", msg, fakeSenders(log, { origins: { telegram: { replyAddress: "42" } } }));
  assert.deepEqual([r.channel, log[0].to], ["telegram", "42"]);
  log = [];
  r = await deliver("slack", msg, fakeSenders(log));
  assert.equal(r.channel, "sms", "without a Slack origin the box sends on the owner text channel");
  r = await deliver("email", msg, fakeSenders([], { failEmail: true }));
  assert.equal(r.delivered, false);

  // A one-time Research report from the Research app (task 4.2).
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "research-send-"));
  try {
    const pdfPath = path.join(tmp, "report.pdf");
    fs.writeFileSync(pdfPath, "%PDF-1.7 fake");
    const report = { id: "2026-10-30-e-bikes", topic: "e-bikes", summary: "Subscriptions grow.", pdfPath };
    const sent = [];
    const senders = fakeSenders(sent);
    let attachments;
    senders.email = async (to, subject, body, atts) => ((attachments = atts), sent.push({ channel: "email", subject, body }), "msg-2");
    r = await sendReport(report, "email", "https://box/r/x/report.pdf", senders);
    assert.deepEqual([r.delivered, r.channel], [true, "email"]);
    assert.equal(attachments[0].filename, "2026-10-30-e-bikes.pdf", "the PDF is attached in email");
    assert.equal(attachments[0].contentType, "application/pdf");
    assert.ok(!sent[0].body.includes("https://box/r/x"), "no link when the PDF is attached");
    r = await sendReport(report, "sms", "https://box/r/x/report.pdf", senders);
    assert.equal(r.channel, "sms");
    assert.match(sent.at(-1).text, /https:\/\/box\/r\/x\/report\.pdf/, "the report link in a text message");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log("ok delivery: email recipients from the profile, SMS fallback, Slack and Telegram origins, Research report from the app");
}

async function testAppRoutes() {
  const roots = tmpRoots();
  try {
    const store = new RecurringStore(roots);
    const cronCalls = [];
    const service = new RecurringService({
      projectRoot: "/unused",
      store,
      scriptsDir: path.join(roots.desktopRoot, "scripts"),
      cron: async (p) => (cronCalls.push(p), { success: true, job_id: "job1", job: { next_run_at: "2026-11-02T07:00:00-08:00" } }),
      now: () => new Date("2026-10-30T17:00:00.000Z"),
      available: () => ["web", "reddit"],
      llm: { fetchImpl: runModel().fetchImpl, apiKey: "k", model: "m" },
    });
    let allowed = true;
    const rt = { service, runner: { trigger: async () => "started" }, runDeps: () => deps({}) };
    const app = express();
    app.use(express.json());
    const router = express.Router();
    registerRecurringRoutes(router, { projectRoot: roots.desktopRoot, runtime: () => rt, allowApp: async () => allowed, allowLocal: () => false, channels: async () => ({ email: true, sms: true, slack: false, telegram: false }) });
    app.use("/joshu", router);
    const server = app.listen(0);
    const base = `http://127.0.0.1:${server.address().port}/joshu/api/research`;
    const call = async (method, p, body) => {
      const r = await fetch(`${base}${p}`, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, body: await r.json() };
    };
    try {
      const made = await call("POST", "/recurring", { topics: ["humanoid robots", "defense contracts"], days: ["mon", "tue", "wed", "thu", "fri"], times: ["07:00"], sources: "auto", channel: "email", notes: "", origin: "app" });
      assert.equal(made.status, 201);
      const id = made.body.report.id;
      assert.equal(store.get(id).origin, "app");
      assert.equal(made.body.report.lanes[0].reason !== undefined, true, "the app shows the reason of each pick");
      // A change through a route shows in the list that the plugin tool research_recurring_list reads.
      assert.equal((await call("PATCH", `/recurring/${id}`, { days: ["mon"] })).status, 200);
      const listed = await call("GET", "/recurring");
      assert.equal(listed.body.reports[0].scheduleText, "7:00 am, Mondays");
      assert.equal((await call("POST", `/recurring/${id}/pause`)).body.report.state, "paused");
      assert.equal((await call("POST", `/recurring/${id}/resume`)).body.report.state, "active");
      assert.deepEqual((await call("GET", `/recurring/${id}/updates`)).body.updates, []);
      assert.deepEqual((await call("GET", `/recurring/${id}/stories`)).body.stories, []);
      assert.deepEqual((await call("GET", "/channels")).body.channels, { email: true, sms: true, slack: false, telegram: false });
      assert.equal((await call("DELETE", `/recurring/${id}`)).status, 200);
      assert.equal((await call("GET", `/recurring/${id}/updates`)).status, 404);
      assert.equal((await call("POST", `/recurring/${id}/run`)).status, 403, "the run route is localhost-only");
      allowed = false;
      assert.equal((await call("GET", "/recurring")).status, 403, "the app routes need the desktop session");
      assert.equal((await call("POST", "/recurring", { topics: ["x"] })).status, 403);
      console.log("ok app routes: create, change, pause, resume, delete, updates, stories, channels, session check");
    } finally {
      server.close();
    }
  } finally {
    fs.rmSync(roots.desktopRoot, { recursive: true, force: true });
  }
}

/** A Research report folder from October 21 with one stored story (task 5.1). */
function reportFixture(roots) {
  const id = "2026-10-21-clara-analytics";
  const folder = path.join(roots.filesRoot, "Research", id);
  fs.mkdirSync(folder, { recursive: true });
  const at = "2026-10-21T16:00:00.000Z";
  const data = {
    schemaVersion: 2,
    id,
    topic: "Clara Analytics",
    requestedAt: at,
    research: {
      topic: "Clara Analytics",
      plan: { brief: "", subQuestions: [{ id: "q1", question: "News?", recentQuery: "clara analytics news", evergreenQuery: "clara analytics" }], socialQuery: "clara analytics" },
      pages: [],
      facts: [],
      social: [],
      sources: [{ name: "web", label: "Web (Exa)", state: "returned items", engineStatus: "ok" }],
    },
    text: { themes: [] },
    pictures: [],
  };
  fs.writeFileSync(path.join(folder, "report.json"), JSON.stringify(data));
  fs.writeFileSync(path.join(folder, "report.pdf"), "%PDF");
  fs.writeFileSync(
    path.join(folder, "stories.json"),
    JSON.stringify({ schemaVersion: 1, nextNumber: 2, stories: [{ id: "S1", laneId: "l1", title: "Story funding", summary: "Clara raised money.", firstRun: at, lastRun: at, items: [{ url: "https://news.example/funding", source: "web", sourceLabel: "news.example", title: "{funding} round", firstRun: id }] }] }),
  );
  return { id, folder };
}

async function testRepeatAndPdf() {
  const roots = tmpRoots();
  try {
    const { id, folder } = reportFixture(roots);
    const exaCalls = [];
    const exa = fakeExa({ "clara analytics news": [page("https://news.example/funding", "funding"), page("https://news.example/funding-2", "funding", "2026-11-03T10:00:00.000Z"), page("https://news.example/hire", "hire", "2026-11-02T10:00:00.000Z")] }, exaCalls);
    const now = new Date("2026-11-04T17:30:00.000Z");
    const result = await makeRepeatUpdate(roots, id, "email", deps({ exa, now }));
    assert.equal(exaCalls[0].startPublishedDate, "2026-10-21T16:00:00.000Z", "the period since the Research report");
    assert.equal(result.updateId, `${id}/updates/2026-11-04-0930`);
    assert.equal(result.developingStories, 1, "a story of the Research report comes back as developing");
    assert.equal(result.newStories, 1);
    const update = JSON.parse(fs.readFileSync(path.join(folder, "updates", "2026-11-04-0930", "update.json"), "utf8"));
    assert.equal(update.kind, "repeat");
    assert.equal(update.stories.find((s) => s.id === "S1").status, "developing");
    assert.ok(fs.existsSync(path.join(folder, "updates", "2026-11-04-0930", "update.md")));
    assert.ok(result.digest.includes("https://news.example/funding-2"), "the text links the new item");
    const themed = renderUpdateHtml(update, [update], "November 4", "", "America/Los_Angeles");
    assert.ok(themed.includes('id="theme-1"') && themed.includes('class="theme-links"'), "the PDF of a report update with themes has each theme with its links");
    assert.match(themed, /<span class="theme-kind">Developing<\/span>/, "a theme with a developing story says so");
    assert.doesNotMatch(themed, /\[F\d+\]/, "no raw citation in the PDF");

    // The PDF of the report update, and the chart data of the lanes.
    let written = 0;
    const pdf = await renderUpdatePdf(roots, result.updateId, { writePdf: async (_h, p) => ((written += 1), fs.writeFileSync(p, "%PDF-1.7 fake")) });
    assert.equal(pdf.pdfFilesPath, `Research/${result.updateId}/update.pdf`);
    await renderUpdatePdf(roots, result.updateId, { writePdf: async () => (written += 1) });
    assert.equal(written, 1, "a PDF that is there is used again");
    const history = laneHistory([
      { run: "2026-10-30-0700", lanes: [{ id: "l1", topic: "a" }], stories: [{ laneId: "l1", status: "new", newItems: ["x", "y"] }] },
      { run: "2026-10-30-1700", lanes: [{ id: "l1", topic: "a" }], stories: [{ laneId: "l1", status: "quiet", newItems: [] }, { laneId: "l1", status: "developing", newItems: ["z"] }] },
      { run: "2026-10-31-0700", lanes: [{ id: "l1", topic: "a" }, { id: "l2", topic: "b" }], stories: [{ laneId: "l2", status: "new", newItems: ["w"] }] },
    ]);
    assert.deepEqual(history.map((h) => h.days), [[{ day: "2026-10-30", count: 3 }, { day: "2026-10-31", count: 0 }], [{ day: "2026-10-30", count: 0 }, { day: "2026-10-31", count: 1 }]], "new items of each lane by day");
    await assert.rejects(renderUpdatePdf(roots, "../etc/updates/2026-11-04-0930"), (e) => e.step === "store");
    // 2026-10-29 on a box: a run at 10:08 pm Pacific said "since Oct 30" because the period start was read in UTC.
    const html = renderUpdateHtml(
      { name: "Robots", run: "2026-10-29-2208", period: { from: "2026-10-30T05:01:00.000Z" }, lanes: [], stories: [], sources: [] },
      [],
      "October 29",
      "",
      "America/Los_Angeles",
    );
    assert.ok(html.includes("<dd>Since October 29</dd>") && html.includes("<em>October 29</em>"), "the dates of the PDF are in the owner timezone");
    assert.ok(html.includes("Report update</span>") && html.includes('class="contents"') && html.includes("--serif"), "the page uses the design of the Research report");

    // Report links of both folder shapes.
    const secret = Buffer.alloc(32, 7);
    const recurringId = "Recurring/robots/updates/2026-10-31-0700";
    fs.mkdirSync(path.join(roots.filesRoot, "Research", recurringId), { recursive: true });
    fs.writeFileSync(path.join(roots.filesRoot, "Research", recurringId, "update.pdf"), "%PDF");
    for (const updateId of [result.updateId, recurringId]) {
      const link = updateLink(updateId, secret, "https://box.example/joshu");
      const [, rest] = link.split("/api/research/u/");
      const sig = rest.split("/").at(-2);
      assert.ok(resolveSignedUpdate(roots, secret, updateId, sig), `link of ${updateId}`);
      const flipped = `${sig.slice(0, -1)}${sig.endsWith("A") ? "B" : "A"}`;
      assert.equal(resolveSignedUpdate(roots, secret, updateId, flipped), null, "a wrong signature");
    }
    assert.equal(resolveSignedUpdate(roots, secret, "Recurring/../../x/updates/2026-10-31-0700", "A".repeat(22)), null, "a path with .. is refused");

    // The public route: a path with .. gets 404.
    const rt = { service: { store: new RecurringStore(roots) }, runner: null, runDeps: () => deps({ exa }) };
    const app = express();
    const router = express.Router();
    registerRecurringRoutes(router, { projectRoot: roots.desktopRoot, runtime: () => rt, allowLocal: () => true, publicBase: "http://x/joshu" });
    app.use("/joshu", router);
    const server = app.listen(0);
    try {
      const base = `http://127.0.0.1:${server.address().port}/joshu`;
      const good = updateLink(recurringId, reportLinkSecret(roots.desktopRoot), base);
      assert.equal((await fetch(good)).status, 200);
      const sig = good.split("/").at(-2);
      assert.equal((await fetch(`${base}/api/research/u/Recurring/..%2F..%2Fx/updates/2026-10-31-0700/${sig}/update.pdf`)).status, 404);
      assert.equal((await fetch(`${base}/api/research/u/${recurringId}/${"A".repeat(22)}/update.pdf`)).status, 404);
    } finally {
      server.close();
    }
    console.log("ok report update on request, update PDF, chart data, report links of both shapes");
  } finally {
    fs.rmSync(roots.desktopRoot, { recursive: true, force: true });
  }
}

/** Each story keeps its own links next to its sentence, also when the writer puts many stories in one paragraph. */
function testOldDigestPdf() {
  // A report update from before the themes keeps its digest. Its PDF puts the citation numbers after
  // each sentence, not at the end of the paragraph.
  const linked = "Hippo reported $9 million in net income. https://insurancejournal.example/hippo https://x.example/post Wisedocs published a comparison. https://wisedocs.example/hub Five Sigma partnered with Amarillo. https://fintech.example/five-sigma";
  const no = new Map([["https://insurancejournal.example/hippo", 1], ["https://x.example/post", 2], ["https://wisedocs.example/hub", 3]]);
  const html = digestHtml(`CLARA Analytics\n\n${linked}`, ["CLARA Analytics"], no);
  assert.ok(html.startsWith('<h4 class="lane-label">'), html);
  assert.ok(html.includes('net income.<span class="cite"><a href="#p1">1</a>,<a href="#p2">2</a></span> Wisedocs published a comparison.<span class="cite"><a href="#p3">3</a></span> Five Sigma'), html);
  assert.ok(html.includes('Amarillo. <a href="https://fintech.example/five-sigma">'), "a link with no number shows its site");
  console.log("ok PDF of an older report update: the citations of each sentence follow the sentence");
}

/** The search terms of a run: the limit for each run, and one Exa and one Google News search for each term. */
async function testSearchTerms() {
  const plan = (named, expanded) => ({ namedTerms: named, expandedTerms: Array.from({ length: expanded }, (_, i) => `${named[0]} e${i}`) });
  const terms = runTerms([plan(["A"], 10), plan(["B", "C"], 10), undefined, plan(["D"], 10)]);
  assert.equal(terms.flat().length, MAX_TERMS_PER_RUN);
  assert.deepEqual(terms[0], ["A", "A e0", "A e1", "A e2", "A e3"], "named terms first, then expanded terms of the lanes in turn");
  assert.deepEqual(terms[1], ["B", "C", "B e0", "B e1", "B e2", "B e3"]);
  assert.deepEqual(terms[2], [], "a lane plan without search terms gets none");
  assert.deepEqual(terms[3].length, 5);
  const many = runTerms([{ namedTerms: Array.from({ length: 20 }, (_, i) => `n${i}`), expandedTerms: ["x"] }]);
  assert.deepEqual(many[0].length, 20, "every named term is searched, also past the limit");

  const exaCalls = [];
  const exa = fakeExa({ "EvolutionIQ": [page("https://news.example/eiq", "eiq")], "CLARA Analytics": [page("https://news.example/clara", "clara")] }, exaCalls);
  const newsCalls = [];
  const composio = {
    async news(query) {
      newsCalls.push(query);
      if (query === "EvolutionIQ") throw new Error("Composio down");
      return [{ url: `https://press.example/${query.replace(/\W/g, "")}`, title: query, publishedDate: "2026-10-29", highlights: [] }];
    },
  };
  const lane = { id: "l1", topic: "CLARA Analytics", addedAt: "2026-10-01", plan: { picks: ["web"], reason: "", webQueries: ["clara analytics claims AI"], newsQuery: "CLARA Analytics", socialQuery: "", scholarQuery: "", madeAt: "2026-10-01" } };
  const period = { from: "2026-10-23T00:00:00.000Z", fromDay: "2026-10-23", to: "2026-10-30T00:00:00.000Z", days: 7 };
  const out = await collectLane(lane, ["web"], period, Date.now() + 5000, { exa, composio, social: NO_SOCIAL }, ["CLARA Analytics", "EvolutionIQ"]);
  assert.deepEqual(exaCalls.map((c) => [c.query, c.numResults]), [["clara analytics claims AI", 8], ["CLARA Analytics", 5], ["EvolutionIQ", 5]], "one Exa search for each term, with fewer results");
  assert.deepEqual(newsCalls, ["CLARA Analytics", "EvolutionIQ"], "a term that repeats the news query is searched once");
  assert.equal(out.webSearches, 3);
  assert.ok(out.items.some((i) => i.url === "https://news.example/eiq"));
  const news = out.sources.find((s) => s.name === "news");
  assert.equal(news.state, "returned items", "one failed news search does not fail Google News");
  assert.equal(news.engineStatus, "1 of 2 searches failed");
  console.log("ok search terms: named terms always, expanded terms in turn up to the limit, one Exa and one Google News search each");
}

/** A meaning model: answers the call for what the topics of old lane plans mean, and passes the rest on. */
function meaningModel(opts = {}) {
  const base = runModel();
  const meaning = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    if (!body.messages[0].content.startsWith("You say what the topics")) return base.fetchImpl(url, init);
    const user = body.messages[1].content;
    meaning.push(user);
    if (opts.fail) return { ok: false, status: 500, json: async () => ({}) };
    const topics = [...user.matchAll(/^\d+\. (.*?)(?: \(hints|$)/gm)].map((m) => m[1]);
    return reply({
      lanes: topics.map((t) => ({ topic: t, about: `Robots with a human shape (${t}).`, not_about: ["Humanoid, the band"], named_terms: [t], expanded_terms: ["Figure AI", "Agility Robotics"], web_queries: ["changed"], picks: ["tiktok"] })),
    });
  };
  return { fetchImpl, requests: base.requests, meaning };
}

/**
 * A lane plan from before D14 gets what its topic means, and a lane plan from before change
 * research-keyword-expansion gets its search terms; both keep their queries and sources.
 */
async function testOldLanePlanMeaning() {
  const roots = tmpRoots();
  const roots2 = tmpRoots();
  try {
    const { store, setup } = setupFixture(roots, { notes: "not the band" });
    const before = structuredClone(setup.lanes);
    // Lane l2 already says what it means.
    await store.update(setup.id, (s) => ((s.lanes[1].plan.about = "Defense contracts of the US."), { result: undefined, changed: true }));
    const day1 = { "humanoid robots news": [page("https://news.example/army", "army")], "defense contracts news": [page("https://gov.example/navy", "navy")] };
    const model = meaningModel();
    const run = await runRecurringReport(store, setup.id, deps({ exa: fakeExa(day1), model }));
    assert.equal(run.result, "delivered", JSON.stringify(run));
    assert.equal(model.meaning.length, 1, "one call for the lanes with no meaning or no search terms");
    assert.match(model.meaning[0], /^Notes of the owner: not the band\nTopics:\n1\. humanoid robots\n2\. defense contracts$/, "both lanes, with the notes");
    const saved = store.get(setup.id);
    const l1 = saved.lanes[0].plan;
    assert.equal(l1.about, "Robots with a human shape (humanoid robots).");
    assert.deepEqual(l1.notAbout, ["Humanoid, the band"]);
    assert.deepEqual(l1.namedTerms, ["humanoid robots"]);
    assert.deepEqual(l1.expandedTerms, ["Figure AI", "Agility Robotics"]);
    const { about: _a, notAbout: _n, namedTerms: _t, expandedTerms: _e, ...rest } = l1;
    assert.deepEqual(rest, before[0].plan, "the queries, the sources, and the date of the lane plan stay the same");
    const l2 = saved.lanes[1].plan;
    assert.equal(l2.about, "Defense contracts of the US.", "a lane with a meaning keeps it");
    assert.equal(l2.notAbout, undefined);
    assert.deepEqual(l2.namedTerms, ["defense contracts"], "a lane with a meaning and no search terms gets the search terms");
    const group = model.requests.filter((r) => r.title.includes("(group)")).map((r) => r.user);
    assert.ok(
      group.some((u) => u.startsWith("Topics:\n- humanoid robots\n  About: Robots with a human shape (humanoid robots).\n  Not about: Humanoid, the band\n  Follows: humanoid robots; Figure AI; Agility Robotics\n")),
      "the group step of the same run gets the meaning and the search terms",
    );
    await runRecurringReport(store, setup.id, deps({ exa: fakeExa(day1), model, now: new Date("2026-10-31T14:00:00.000Z") }));
    assert.equal(model.meaning.length, 1, "no call when every lane has a meaning and search terms");

    // When the call fails, the run goes on, and the next run tries again.
    const { store: store2, setup: setup2 } = setupFixture(roots2);
    const failing = meaningModel({ fail: true });
    const r2 = await runRecurringReport(store2, setup2.id, deps({ exa: fakeExa(day1), model: failing }));
    assert.equal(r2.result, "delivered");
    assert.ok(failing.meaning.length >= 1);
    assert.ok(store2.get(setup2.id).lanes.every((l) => !l.plan.about), "nothing saved");

    // A report update on request takes the meaning from the plan of the Research report.
    const { lane } = reportLane({ topic: "CLARA Analytics", requestedAt: "2026-10-30T00:00:00.000Z", research: { plan: { subQuestions: [], about: "The claims AI company.", notAbout: ["Clara, the agent of Hippo"] }, sources: [] } });
    assert.equal(lane.plan.about, "The claims AI company.");
    assert.deepEqual(lane.plan.notAbout, ["Clara, the agent of Hippo"]);
    assert.equal(lane.plan.namedTerms, undefined, "a Research report without search terms gives a lane without them");
    const { lane: withTerms } = reportLane({ topic: "CLARA Analytics", requestedAt: "2026-10-30T00:00:00.000Z", research: { plan: { subQuestions: [], namedTerms: ["CLARA Analytics"], expandedTerms: ["EvolutionIQ"] }, sources: [] } });
    assert.deepEqual([withTerms.plan.namedTerms, withTerms.plan.expandedTerms], [["CLARA Analytics"], ["EvolutionIQ"]], "a report update on request searches the terms of the Research report");
    console.log("ok old lane plans: one call fills in what the topic means and the search terms, queries and sources stay, the group step gets them");
  } finally {
    fs.rmSync(roots.desktopRoot, { recursive: true, force: true });
    fs.rmSync(roots2.desktopRoot, { recursive: true, force: true });
  }
}

await testGroupAndCompare();
testStatusAndStore();
testThemeText();
await testThemeSteps();
await testUndatedPages();
testOldDigestPdf();
await testOldLanePlanMeaning();
await testSearchTerms();
await testRunFilesAndPeriods();
await testEmailPdf();
await testStepFailures();
await testRunnerAndRoute();
await testDelivery();
await testRepeatAndPdf();
await testAppRoutes();
console.log("research recurring runs: all tests passed");
