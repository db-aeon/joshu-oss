/**
 * Unit tests of the research pipeline of Research reports (change research-reports, promise change
 * P7, tasks 11.1 to 11.8 and 11.10): the model call, the Exa client, plan, search and rank, fact
 * extraction, the citation check, pictures, and the whole run with fakes. Also the sources of
 * Composio Search (change research-report-sources, tasks 1.2 to 5.1). No network.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { callJson } from "../src/research/pipeline/llm.ts";
import { makeExaClient, searchAll } from "../src/research/pipeline/exa.ts";
import { makeYouClient, parseWebProvider, webSourceLabel, youResults, youSearchParams, YOU_SEARCH_ENDPOINT } from "../src/research/pipeline/you.ts";
import { checkPlan, fallbackPlan, ownerSections, planResearch, clipWords } from "../src/research/pipeline/plan.ts";
import { rankPages, searchWeb, EXCLUDED_DOMAINS, FIXED_PASSAGE_SCORE, NEWS_PAGES_KEPT, NEWS_PAGES_READ_IN_FULL } from "../src/research/pipeline/search.ts";
import { checkFacts, pagesForQuestion } from "../src/research/pipeline/extract.ts";
import { composioSearchClient, makeComposioSearchClient } from "../src/research/pipeline/composioSearch.ts";
import { collectCompany, filingPages, pricePage, sameCompany } from "../src/research/pipeline/company.ts";
import { limitSentences, sentences, sentenceSupported, verifyText } from "../src/research/pipeline/write.ts";
import { candidates, downloadPicture, imageInfo } from "../src/research/pipeline/pictures.ts";
import { makeResearchReport } from "../src/research/make.ts";
import { fakeRouter, POLY_ENDPOINT, tempHermesHome } from "./lib/content-router-fakes.mjs";
import { RouterError } from "../src/contentRouter/client.ts";
import { itemCounter } from "../src/research/engagement.ts";
import { researchDir } from "../src/research/store.ts";
import { composioFixture, fakeComposio, fakeDeps, fakeExa, fakeModel, fakePng, FAKE_PAGES } from "./lib/research-test-fakes.mjs";

async function testCallJson() {
  const bodies = [];
  let n = 0;
  const fetchImpl = async (_u, init) => {
    bodies.push(JSON.parse(init.body));
    n += 1;
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: n === 1 ? "not json" : '```json\n{"a": 1}\n```' } }] }) };
  };
  const { value } = await callJson({ step: "plan", system: "s", user: "u", deadline: Date.now() + 5000, fetchImpl, apiKey: "k", model: "m" });
  assert.deepEqual(value, { a: 1 });
  assert.equal(bodies.length, 2, "one retry on invalid JSON");
  assert.equal(bodies[0].provider.data_collection, "deny", "no-training routing");
  assert.equal(bodies[0].reasoning.enabled, false, "reasoning off");
  await assert.rejects(callJson({ step: "write", system: "s", user: "u", deadline: Date.now() + 5000, apiKey: "" }), (e) => e.step === "write");
  console.log("ok shared model call: no-training routing, reasoning off, retry");
}

async function testExaClient() {
  const calls = [];
  let active = 0;
  let maxActive = 0;
  let first = true;
  const fetchImpl = async (url, init) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 15));
    active -= 1;
    calls.push({ url, body: JSON.parse(init.body), key: init.headers["x-api-key"] });
    if (first && url.endsWith("/search")) {
      first = false;
      return { ok: false, status: 429, headers: new Map([["retry-after", "0"]]), json: async () => ({}) };
    }
    return { ok: true, status: 200, headers: new Map(), json: async () => ({ results: [{ url: "https://a.org/x", title: "A" }] }) };
  };
  const exa = makeExaClient("exa-key", fetchImpl);
  const deadline = Date.now() + 10_000;
  const out = await searchAll(exa, Array.from({ length: 10 }, (_, i) => ({ query: `q${i}`, startPublishedDate: "2026-10-01T00:00:00.000Z", highlightsQuery: "question" })), deadline);
  assert.equal(out.length, 10);
  assert.ok(out.every((o) => o.results.length === 1), "the 429 was retried");
  assert.ok(maxActive <= 4, `at most four at once, saw ${maxActive}`);
  const search = calls.find((c) => c.url.endsWith("/search"));
  assert.equal(search.key, "exa-key");
  assert.equal(search.body.type, "auto");
  assert.equal(search.body.contents.highlights.query, "question");
  await exa.contents(["https://a.org/x"], deadline);
  const contents = calls.at(-1);
  assert.ok(contents.url.endsWith("/contents"));
  assert.equal(contents.body.text.maxCharacters, 12000);
  assert.equal(contents.body.extras.richImageLinks, 8);
  console.log("ok Exa client: request bodies, four at once, retry after 429");
}

async function testPlan() {
  assert.equal(checkPlan({ sub_questions: [{ question: "a" }] }, "t"), null, "fewer than four is invalid");
  const ok = checkPlan({ brief: "b", sub_questions: [1, 2, 3, 4, 5, 6, 7].map((i) => ({ question: `q${i}`, recent_query: `r${i}`, evergreen_query: `e${i}` })) }, "t");
  assert.equal(ok.subQuestions.length, 6, "at most six");
  assert.deepEqual(ok.subQuestions[0], { id: "q1", question: "q1", kind: "background", recentQuery: "r1", evergreenQuery: "e1" }, "a question without a kind is background");
  assert.equal(checkPlan({ sub_questions: [1, 2, 3, 4].map((i) => ({ question: `q${i}`, kind: i === 2 ? "news" : "other" })) }, "t").subQuestions[1].kind, "news");
  const plan = await planResearch("heat pumps", "2026-11-02", Date.now() + 5000, { ...fakeModel({ failPlan: true }), apiKey: "k" });
  assert.deepEqual(plan, fallbackPlan("heat pumps"), "the fallback plan when the model fails");
  assert.ok(fallbackPlan("heat pumps").subQuestions.every((q) => !q.terms), "the fallback plan has no search terms");

  // The search terms (change research-keyword-expansion): each term goes to the sub-question that lists it, or to the first one.
  const terms = checkPlan(
    {
      named_terms: ["CLARA Analytics", ""],
      expanded_terms: ["EvolutionIQ", "clara analytics", "claims AI funding", "Unlisted"],
      sub_questions: [
        { question: "What it is", terms: [] },
        { question: "Main players", terms: ["evolutionIQ"] },
        { question: "Recent news", terms: ["CLARA Analytics", "claims AI funding"] },
        { question: "Problems" },
      ],
    },
    "CLARA Analytics",
  );
  assert.deepEqual(terms.namedTerms, ["CLARA Analytics"]);
  assert.deepEqual(terms.expandedTerms, ["EvolutionIQ", "claims AI funding", "Unlisted"], "an expanded term that repeats a named term is dropped");
  assert.deepEqual(terms.subQuestions.map((q) => q.terms), [["Unlisted"], ["EvolutionIQ"], ["CLARA Analytics", "claims AI funding"], undefined]);
  console.log("ok plan step, fallback plan, search terms");
}

/**
 * What the topic means and the sections of the owner (change recurring-research-reports, D14 and
 * D15): the plan, the outline, and a whole run with notes and sections.
 */
async function testOwnerRequest() {
  assert.deepEqual(ownerSections([" Funding ", "", "funding", "a  b", "c", "d", "e", "f", "g"]), ["Funding", "a b", "c", "d", "e", "f"], "trimmed, no repeats, at most six");
  // A long section is cut at a whole word, not in the middle of one (a live report of 2026-11-02).
  const long = ownerSections(["the name of the industry: insurtech, and claims intelligence / claims AI", "intelligent document processing (IDP) for claims", `${"word ".repeat(30)}end`]);
  assert.deepEqual(long.slice(0, 2), ["the name of the industry: insurtech, and claims intelligence / claims AI", "intelligent document processing (IDP) for claims"], "a section of normal length stays whole");
  assert.ok(long[2].length <= 100 && long[2].endsWith("word"), "a very long section ends at a whole word");
  assert.equal(clipWords("funding, product launches, and competitors in the space", 30), "funding, product launches", "no dangling and or comma");
  const raw = { brief: "b", about: "CLARA Analytics, the claims AI company.", not_about: ["Clara of Hippo", "", 3], sub_questions: [1, 2, 3, 4].map((i) => ({ question: `q${i}` })) };
  const two = checkPlan(raw, "t", ["funding", "competitors"]);
  assert.deepEqual(two.subQuestions.map((q) => q.section), ["funding", "competitors"], "one sub-question for each owner section, in order");
  assert.equal(two.about, "CLARA Analytics, the claims AI company.");
  assert.deepEqual(two.notAbout, ["Clara of Hippo"]);
  assert.equal(checkPlan({ sub_questions: [{ question: "a" }] }, "t", ["x", "y"]), null, "too few sub-questions for the owner sections");
  assert.ok(checkPlan({ sub_questions: [{ question: "a" }] }, "t", ["x"]), "one owner section needs one sub-question");
  assert.deepEqual(fallbackPlan("heat pumps", ["prices"]).subQuestions, [{ id: "q1", question: "prices: heat pumps", recentQuery: "heat pumps prices", evergreenQuery: "heat pumps prices", section: "prices" }]);
  const sent = [];
  const systems = [];
  const fetchImpl = async (_u, init) => {
    const { messages } = JSON.parse(init.body);
    systems.push(messages[0].content);
    sent.push(messages[1].content);
    return { ok: false, status: 500, json: async () => ({}) };
  };
  const failed = await planResearch("heat pumps", "2026-11-02", Date.now() + 5000, { fetchImpl, apiKey: "k" }, { notes: "not the band", sections: ["prices"] });
  assert.match(systems[0], /named_terms: each company, product, person, or concept that the owner names in the topic or the notes, written as the owner wrote it/, "the plan asks for the names of the owner");
  assert.match(systems[0], /expanded_terms: the search terms that the owner most likely wants/);
  assert.match(sent[0], /Notes of the owner: not the band/);
  assert.match(sent[0], /Sections of the owner:\n1\. prices/);
  assert.deepEqual(failed, fallbackPlan("heat pumps", ["prices"]), "the fallback plan keeps the owner sections");

  const desktopRoot = fs.mkdtempSync(path.join(os.tmpdir(), "research-owner-"));
  const roots = { desktopRoot, filesRoot: path.join(desktopRoot, "joshu's files") };
  fs.mkdirSync(roots.filesRoot, { recursive: true });
  try {
    const request = { notes: " CLARA Analytics, not the Clara agent of Hippo ", sections: ["Growth and demand", "Fees", " fees "] };
    const { deps, model } = fakeDeps(roots, { model: { about: "CLARA Analytics, the claims AI company.", notAbout: ["Clara, the claims voice agent of Hippo"] }, deps: { request } });
    const report = await makeResearchReport("/unused", "CLARA Analytics", deps);
    const data = JSON.parse(fs.readFileSync(path.join(report.folder, "report.json"), "utf8"));
    const user = (step) => model.requests.filter((r) => r.title.includes(`(${step})`)).map((r) => r.body.messages[1].content);
    assert.match(user("plan")[0], /Notes of the owner: CLARA Analytics, not the Clara agent of Hippo\nSections of the owner:\n1\. Growth and demand\n2\. Fees$/);
    assert.ok(user("extract").length && user("extract").every((u) => /\nAbout: CLARA Analytics, the claims AI company\.\nNot about: Clara, the claims voice agent of Hippo\n/.test(u)), "the fact step gets what the topic means and is not");
    assert.ok(user("write").every((u) => /About: CLARA Analytics/.test(u)), "the theme writer and the summary get it too");
    assert.ok(user("group").every((u) => /About: CLARA Analytics/.test(u)), "the group step gets it too");
    assert.deepEqual(data.research.request, { notes: "CLARA Analytics, not the Clara agent of Hippo", sections: ["Growth and demand", "Fees"] }, "report.json keeps the request");
    assert.deepEqual(data.research.plan.subQuestions.map((q) => q.section), ["Growth and demand", "Fees"]);
    assert.deepEqual(data.text.themes.map((t) => t.label), ["Growth and demand", "Fees"], "the report has the owner sections in order");
    // The words of the owner are the label above each section, and the writer gives the headline.
    const html = fs.readFileSync(path.join(report.folder, "report.html"), "utf8");
    assert.ok(html.includes('<span class="theme-kind">Growth and demand</span>') && html.includes('<span class="theme-kind">Fees</span>'), "the section of the owner is the label of its theme");
    assert.ok(data.text.themes.every((t) => t.kind === "section"), "no background theme next to the sections");
  } finally {
    fs.rmSync(desktopRoot, { recursive: true, force: true });
  }
  console.log("ok owner notes and sections: plan, outline, fact step, whole run");
}

async function testSearchAndRank() {
  const result = (url, title) => ({ url, title, highlights: [`about ${title}`], highlightScores: [0.5] });
  const pages = rankPages([
    { subQuestionId: "q1", results: [result("https://a.org/1", "A1"), result("https://a.org/2", "A2"), result("https://a.org/3", "A3"), result("https://www.reddit.com/r/x", "R")] },
    { subQuestionId: "q2", results: [result("https://a.org/1?utm=x", "A1 again"), result("https://b.org/1", "B1")] },
  ]);
  assert.equal(pages.filter((p) => p.site === "a.org").length, 2, "at most two pages for each site");
  assert.ok(!pages.some((p) => p.site === "reddit.com"), "excluded domains are dropped");
  assert.deepEqual(pages[0].foundBy, ["q1", "q2"], "a page found twice is merged and ranks first");
  assert.equal(pages[0].id, "p1");

  const exa = fakeExa();
  const plan = fallbackPlan("ebikes");
  const web = await searchWeb(exa, plan, "2026-11-02", Date.now() + 5000);
  assert.equal(exa.calls.search.length, plan.subQuestions.length * 2, "a recent and an evergreen search for each sub-question");
  const recent = exa.calls.search.filter((r) => r.startPublishedDate);
  assert.equal(recent.length, plan.subQuestions.length);
  assert.equal(recent[0].startPublishedDate, "2026-10-03T00:00:00.000Z", "30 days back");
  assert.ok(exa.calls.search.every((r) => r.excludeDomains === EXCLUDED_DOMAINS));
  assert.ok(web.pages.some((p) => p.text), "the best pages are read in full");
  await assert.rejects(searchWeb(fakeExa({ failSearch: true }), plan, "2026-11-02", Date.now() + 5000), (e) => e.step === "search");

  // Each search term of a sub-question adds one recent Exa search with fewer results (change research-keyword-expansion).
  const termExa = fakeExa();
  const withTerms = { ...plan, subQuestions: plan.subQuestions.map((q, i) => (i === 2 ? { ...q, terms: ["EvolutionIQ", "Tractable"] } : q)) };
  const termWeb = await searchWeb(termExa, withTerms, "2026-11-02", Date.now() + 5000);
  assert.equal(termExa.calls.search.length, plan.subQuestions.length * 2 + 2);
  const termCalls = termExa.calls.search.filter((r) => r.query === "EvolutionIQ" || r.query === "Tractable");
  assert.deepEqual(termCalls.map((r) => [r.numResults, r.startPublishedDate, r.highlightsQuery]), [[5, "2026-10-03T00:00:00.000Z", plan.subQuestions[2].question], [5, "2026-10-03T00:00:00.000Z", plan.subQuestions[2].question]]);
  assert.ok(termWeb.pages.some((p) => p.foundBy.includes(plan.subQuestions[2].id)), "the pages of a term belong to its sub-question");
  console.log("ok search and rank: per-site limit, excluded domains, dates, full text, failure, search terms");
}

function testFacts() {
  const pages = [{ id: "p1", url: "u", title: "t", site: "s", highlights: [], text: "The fee was 30 euros in 2025, said the office.", pictures: [], foundBy: ["q1"], score: 1 }];
  const facts = checkFacts(
    [
      { subQuestionId: "q1", raw: { facts: [
        { claim: "Fee", quote: "The fee was 30 euros in 2025", page_id: "p1" },
        { claim: "Invented", quote: "The fee was 99 euros in 2025", page_id: "p1" },
        { claim: "Unknown page", quote: "The fee was 30 euros in 2025", page_id: "p9" },
      ] } },
      { subQuestionId: "q2", raw: { facts: [{ claim: "Same quote", quote: "the fee was 30 euros in 2025", page_id: "p1" }] } },
    ],
    pages,
  );
  assert.deepEqual(facts.map((f) => [f.id, f.quote]), [["F1", "The fee was 30 euros in 2025"]], "invented, unknown-page, and repeated quotes dropped");
  console.log("ok fact extraction check");
}

function testCitationCheck() {
  const facts = new Map([["F1", { id: "F1", quote: "Subscriptions grew 23% in 2025 and cost 1,200 euros" }]]);
  assert.ok(sentenceSupported("They grew 23% [F1].", facts));
  assert.ok(sentenceSupported("A year cost 1200 euros [F1].", facts), "commas in numbers do not matter");
  assert.ok(!sentenceSupported("They grew 45% [F1].", facts), "invented number");
  // A year of the source page is allowed (change research-report-topics); another year is not.
  assert.ok(sentenceSupported("They grew in Q3 2026 [F1].", facts, [], new Set(["2026"])));
  assert.ok(!sentenceSupported("They grew in 2024 [F1].", facts, [], new Set(["2026"])));
  // An abbreviation does not end a sentence, so a dropped sentence leaves no broken half behind.
  assert.deepEqual(sentences("A survey of 1,000 U.S. adults ran Oct. 7 [F1]. The bill (H.R. 10210) failed. Done."), ["A survey of 1,000 U.S. adults ran Oct. 7 [F1].", "The bill (H.R. 10210) failed.", "Done."]);
  assert.ok(!sentenceSupported("They grew [F9].", facts), "unknown citation");
  assert.ok(!sentenceSupported("They grew 23% this year.", facts), "number without a citation");
  assert.ok(sentenceSupported("Three companies lead [F1].", facts), "small numbers in words are fine");
  const dropped = [];
  const out = verifyText("They grew 23% [F1]. They grew 45% [F1].\n\nNo facts here [F9].", facts, dropped);
  assert.equal(out, "They grew 23% [F1].");
  assert.equal(dropped.length, 2);
  const decimals = new Map([["F2", { id: "F2", quote: "The market was USD 4.57 billion in 2026 and USD 8.01 billion by 2034" }]]);
  assert.equal(verifyText("It was USD 4.57 billion in 2026 [F2]. It may reach USD 8.01 billion by 2034 [F2].", decimals, []), "It was USD 4.57 billion in 2026 [F2]. It may reach USD 8.01 billion by 2034 [F2].", "a decimal point does not end a sentence");
  assert.equal(limitSentences("Sales hit $1.01 billion. Growth was 7.8%. Europe led. Asia was second.", 3), "Sales hit $1.01 billion. Growth was 7.8%. Europe led.");
  console.log("ok citation and number check");
}

async function testPictures() {
  assert.deepEqual(imageInfo(fakePng(640)), { type: "png", width: 640 });
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x00, 0x02, 0x80, 0x03, 0, 0, 0, 0, 0]);
  assert.deepEqual(imageInfo(jpeg), { type: "jpeg", width: 640 });
  const webp = new Uint8Array(40);
  webp.set([...Buffer.from("RIFF")], 0);
  webp.set([...Buffer.from("WEBPVP8X")], 8);
  webp[24] = 0x7f;
  webp[25] = 0x02;
  assert.deepEqual(imageInfo(webp), { type: "webp", width: 640 });
  assert.equal(imageInfo(new Uint8Array([1, 2, 3])), null);
  const page = { image: "https://a.org/site-logo.png", pictures: [{ url: "https://a.org/chart.png", alt: "Chart" }, { url: "https://a.org/x.png", alt: "" }, { url: "https://a.org/f.svg", alt: "svg" }], title: "t" };
  assert.deepEqual(candidates(page).map((c) => c.url), ["https://a.org/chart.png"], "logos, empty alt text, and SVG are skipped");
  const big = async () => ({ ok: true, headers: new Map([["content-length", "2000000"]]), arrayBuffer: async () => new ArrayBuffer(2_000_000) });
  assert.equal(await downloadPicture("https://a.org/big.png", big), null, "over 1 MB");
  console.log("ok pictures: PNG, JPEG, WebP widths, filters, size limit");
}

async function testSocialBox() {
  // The social box of a Research report from a fake content router with the saved replies of the
  // default goals (change content-router, task 3.1). The fake model marks the two posts with the
  // most engagement as off topic.
  const offTopic = ["Silly analysis", "Interesting"];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "research-social-"));
  const home = tempHermesHome();
  try {
    const roots = { desktopRoot: tmp, filesRoot: path.join(tmp, "joshu's files") };
    fs.mkdirSync(roots.filesRoot, { recursive: true });
    const router = fakeRouter();
    const { deps, model } = fakeDeps(roots, { model: { offTopic }, deps: { social: undefined, day: "2026-10-30", socialDeps: { client: router.client, home } } });
    const report = await makeResearchReport("/unused", "humanoid robots", deps);
    const data = JSON.parse(fs.readFileSync(path.join(report.folder, "report.json"), "utf8"));
    // Change research-report-topics: the posts join the pool, the group step leaves out the off-topic ones, and a theme links to the rest.
    assert.equal(data.research.social.length, 0, "no separate box of social posts");
    const group = model.requests.find((r) => r.title.includes("(group)")).body.messages[1].content;
    assert.ok(offTopic.every((t) => group.includes(t)), "the posts reach the group step");
    assert.ok(!data.research.pages.some((p) => offTopic.some((t) => p.title.includes(t))), "popular posts that are off topic are not in the report");
    const links = data.text.themes.flatMap((t) => t.links ?? []);
    assert.ok(links.some((l) => /\d/.test(l.counter ?? "")), "a post shows its engagement in the links of its theme");
    assert.equal(model.requests.filter((r) => r.title.includes("(collect)")).length, 0, "no relevance call");
    assert.equal(model.requests.filter((r) => r.title.includes("(learn)")).length, 0, "no learning call with the seeded caches");
    assert.equal(router.calls.length, 5, "one router call for each default goal");
    assert.ok(data.research.sources.some((s) => s.name === "x" && s.state === "returned items"));
    console.log("ok social posts from the content router join the themes, off-topic posts left out");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
}

async function testHintGoal() {
  // A hint adds a content goal (change content-router, task 3.2): "Polymarket for prediction
  // market odds" gives the goal "prediction market odds" with the odds of each market.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "research-hint-"));
  const home = tempHermesHome();
  try {
    const roots = { desktopRoot: tmp, filesRoot: path.join(tmp, "joshu's files") };
    fs.mkdirSync(roots.filesRoot, { recursive: true });
    const router = fakeRouter();
    const extraGoals = [{ goal: "prediction market odds", query: "2028 primaries", prefer: "Polymarket" }];
    const { deps, model } = fakeDeps(roots, {
      model: { extraGoals },
      deps: { social: undefined, day: "2026-10-30", socialDeps: { client: router.client, home }, request: { hints: ["Polymarket for prediction market odds"] } },
    });
    const report = await makeResearchReport("/unused", "2028 primaries", deps);
    const plan = model.requests.find((r) => r.title.includes("(plan)"));
    assert.match(plan.body.messages[1].content, /Hints:\n- Polymarket for prediction market odds/, "the hint reaches the plan");
    const data = JSON.parse(fs.readFileSync(path.join(report.folder, "report.json"), "utf8"));
    assert.deepEqual(data.research.plan.extraGoals, [{ kind: "prediction market odds", query: "2028 primaries", prefer: "Polymarket" }]);
    assert.deepEqual(data.research.request.hints, ["Polymarket for prediction market odds"]);
    const call = router.calls.find((c) => c.endpoint === POLY_ENDPOINT.id);
    assert.ok(call, "the box calls a Polymarket provider endpoint");
    assert.equal(call.params.q, "2028 primaries");
    const group = model.requests.find((r) => r.title.includes("(group)")).body.messages[1].content;
    assert.match(group, /odds/i, "the items of the goal join the pool of the report");
    const row = data.research.sources.find((s) => s.name === "goal:prediction market odds");
    assert.deepEqual([row.label, row.state], ["Prediction market odds", "returned items"]);
    const odds = data.text.themes.flatMap((t) => t.links ?? []).filter((l) => /odds 0\.\d+/.test(l.counter ?? ""));
    if (odds.length) assert.match(fs.readFileSync(path.join(report.folder, "report.html"), "utf8"), /odds 0\.\d+/, "the odds are shown as they are");
    console.log("ok hint 'Polymarket for prediction market odds' adds a goal with odds");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
}

async function testComposioClient() {
  const calls = [];
  let active = 0;
  let maxActive = 0;
  const fixtureOf = { COMPOSIO_SEARCH_NEWS: "news", COMPOSIO_SEARCH_SCHOLAR: "scholar", COMPOSIO_SEARCH_FINANCE: "finance", COMPOSIO_SEARCH_SEC_FILINGS: "sec-filings" };
  const fetchImpl = async (url, init) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 10));
    active -= 1;
    const slug = url.split("/").at(-1);
    calls.push({ slug, body: JSON.parse(init.body), key: init.headers["x-api-key"] });
    if (slug === "COMPOSIO_SEARCH_NEWS" && JSON.parse(init.body).arguments.query === "rate limited") return { ok: true, status: 200, json: async () => composioFixture("failed") };
    if (slug === "COMPOSIO_SEARCH_NEWS" && JSON.parse(init.body).arguments.query === "down") return { ok: false, status: 503, json: async () => ({}) };
    if (slug === "COMPOSIO_SEARCH_NEWS" && JSON.parse(init.body).arguments.query === "slow") {
      // The timer of AbortSignal.timeout does not keep Node running, so the fake holds a timer of its own.
      const hold = setTimeout(() => {}, 5000);
      return new Promise((_r, reject) => init.signal.addEventListener("abort", () => (clearTimeout(hold), reject(new Error("aborted")))));
    }
    return { ok: true, status: 200, json: async () => composioFixture(fixtureOf[slug]) };
  };
  const c = makeComposioSearchClient("cmp-key", "box-user", fetchImpl);
  const deadline = Date.now() + 10_000;
  const news = await Promise.all(Array.from({ length: 6 }, (_, i) => c.news(`ebike ${i}`, deadline)));
  assert.ok(maxActive <= 4, `at most four Composio calls at once, saw ${maxActive}`);
  assert.equal(news[0].length, 5);
  assert.deepEqual(news[0][1], {
    url: "https://www.bike-eu.com/53420/germanys-shared-bike-fleet-grows-to-102550-as-subscriptions-slip-2",
    title: "Germany's shared bike fleet grows to 102,550 as subscriptions slip 2%",
    publishedDate: "2026-10-20T13:14:00.000Z",
    highlights: ["Germany's bike-sharing fleet grew 1.5% year-on-year to 102550 bikes, while private bike subscriptions fell 2% to 98000. That is the finding of the second..."],
  });
  const first = calls[0];
  assert.equal(first.key, "cmp-key");
  assert.equal(first.body.user_id, "box-user");
  assert.equal(first.body.version, "20260903_00", "the pinned toolkit version");
  assert.deepEqual(first.body.arguments, { query: "ebike 0", when: "m", hl: "en" });

  const papers = await c.scholar("ebike study", deadline);
  assert.equal(papers.length, 3);
  assert.equal(papers[1].highlights.at(-1), "Authors: R Julio, A Monzon. Year: 2022. Cited by 48.");
  const prices = await c.prices("NVDA:NASDAQ", deadline);
  assert.equal(prices.name, "NVIDIA Corp");
  assert.equal(prices.points.filter((p) => p.close).length, 22, "22 trading days closed");
  assert.equal(prices.points.at(-1).close, false, "the price of today is not a close");
  assert.deepEqual(calls.at(-1).body.arguments, { query: "NVDA:NASDAQ", window: "1M" });
  const filings = await c.filings("NVDA", deadline);
  assert.equal(filings.companyName, "NVIDIA CORP");
  assert.deepEqual(filings.filings.map((f) => f.form), ["8-K", "10-Q", "8-K"], "newest first");
  assert.deepEqual(calls.at(-1).body.arguments.form_types, ["10-K", "10-Q", "8-K"]);

  await assert.rejects(c.news("rate limited", deadline), /Rate limit exceeded/, "an unsuccessful answer is a failed call");
  await assert.rejects(c.news("down", deadline), (e) => e.status === 503);
  const started = Date.now();
  await assert.rejects(c.news("slow", Date.now() + 200));
  assert.ok(Date.now() - started < 2000, "a call ends at the deadline");
  const before = calls.length;
  await assert.rejects(c.news("ebike", Date.now() - 1), /out of time/);
  assert.equal(calls.length, before, "no call after the deadline");

  const saved = process.env.COMPOSIO_API_KEY;
  delete process.env.COMPOSIO_API_KEY;
  assert.equal(composioSearchClient("/unused"), null, "no client without a Composio key");
  if (saved !== undefined) process.env.COMPOSIO_API_KEY = saved;
  console.log("ok Composio Search client: request bodies, pin, four at once, parsing, failures, no key");
}

async function testPlanSources() {
  const q = (i, scholar) => ({ question: `q${i}`, recent_query: `r${i}`, evergreen_query: `e${i}`, scholar_query: scholar ? `s${i}` : "" });
  const withAll = checkPlan({ brief: "b", sub_questions: [q(1, true), q(2, false), q(3, true), q(4, true)], company: { name: "NVIDIA", ticker: "nvda", exchange: "nasdaq" } }, "t");
  assert.deepEqual(withAll.company, { name: "NVIDIA", ticker: "NVDA", exchange: "NASDAQ" });
  assert.deepEqual(withAll.subQuestions.map((s) => s.scholarQuery), ["s1", undefined, "s3", undefined], "at most two Google Scholar queries");
  const without = checkPlan({ brief: "b", sub_questions: [1, 2, 3, 4].map((i) => ({ question: `q${i}` })) }, "t");
  assert.equal(without.company, undefined);
  assert.ok(without.subQuestions.every((s) => s.scholarQuery === undefined));
  assert.equal(checkPlan({ sub_questions: [1, 2, 3, 4].map((i) => q(i)), company: { name: "Acme", ticker: "not a ticker", exchange: "NYSE" } }, "t").company, undefined, "an invalid ticker gives no company");
  const fallback = fallbackPlan("nvidia");
  assert.ok(!fallback.company && fallback.subQuestions.every((s) => !s.scholarQuery), "the fallback plan has no company and no Google Scholar query");
  console.log("ok plan: Google Scholar queries and the company");
}

function testRankSources() {
  const exaHit = (url) => ({ url, title: "E", highlights: ["exa passage"], highlightScores: [0.5] });
  const newsHit = (url) => ({ url, title: "N", publishedDate: "2026-10-20T13:14:00.000Z", highlights: ["news snippet"] });
  const pages = rankPages([
    { subQuestionId: "q1", results: [exaHit("https://pub.org/a"), exaHit("https://other.org/b")] },
    { subQuestionId: "q1", via: "news", results: [newsHit("https://pub.org/a/"), newsHit("https://news.org/only"), newsHit("https://www.youtube.com/watch?v=1"), newsHit("https://news.org/2"), newsHit("https://news.org/3")] },
  ]);
  const both = pages.find((p) => p.url === "https://pub.org/a");
  assert.deepEqual(both.foundVia, ["web", "news"], "a page from Exa and the news search is kept once with both sources");
  assert.equal(pages[0], both, "and it ranks first");
  assert.equal(both.publishedAt, "2026-10-20", "the date of the news hit fills a missing date");
  assert.deepEqual(both.highlights, ["exa passage", "news snippet"]);
  assert.ok(!pages.some((p) => p.site === "youtube.com"), "excluded sites apply to news hits");
  assert.equal(pages.filter((p) => p.site === "news.org").length, 2, "two pages for each site apply to news hits");
  assert.equal(pages.find((p) => p.url === "https://news.org/only").score, 1 / 2 + FIXED_PASSAGE_SCORE, "a news hit gets the fixed passage score");
  console.log("ok rank: news hits merge with Exa pages under the same rules");
}

/** Replay the saved runs of 2026-10-21 (URLs, titles, and dates only) through the search step. */
async function testSavedRuns() {
  const runs = JSON.parse(fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "..", "test", "fixtures", "research", "composio", "ranking-runs.json"), "utf8"));
  const replayExa = (web) => {
    let n = 0;
    return { async search() { return web[n++]?.results ?? []; }, async contents(urls) { return urls.map((url) => ({ url, text: "x".repeat(2000) })); } };
  };
  for (const [topic, run] of Object.entries(runs)) {
    const plan = fallbackPlan(topic);
    const scholar = run.found.filter((f) => f.via === "scholar");
    for (const f of scholar) plan.subQuestions.find((q) => q.id === f.subQuestionId).scholarQuery = `study ${f.subQuestionId}`;
    const web = run.found.filter((f) => !f.via);
    const news = run.found.filter((f) => f.via === "news");
    const composio = {
      news: async (query) => news[plan.subQuestions.findIndex((q) => q.recentQuery === query)]?.results ?? [],
      scholar: async (query) => scholar.find((f) => `study ${f.subQuestionId}` === query)?.results ?? [],
    };
    const alone = await searchWeb(replayExa(web), plan, "2026-10-21", Date.now() + 5000, null);
    const both = await searchWeb(replayExa(web), plan, "2026-10-21", Date.now() + 5000, composio);
    const aloneUrls = new Set(alone.pages.map((p) => p.url));
    assert.ok([...aloneUrls].every((u) => both.pages.some((p) => p.url === u)), `${topic}: news and papers never take the place of an Exa page`);
    const added = both.pages.filter((p) => !aloneUrls.has(p.url));
    const addedNews = added.filter((p) => p.foundVia.includes("news"));
    const addedPapers = added.filter((p) => !p.foundVia.includes("news"));
    assert.ok(addedNews.length >= 1 && addedNews.length <= NEWS_PAGES_KEPT, `${topic}: at most ${NEWS_PAGES_KEPT} news pages added`);
    assert.ok(addedNews.filter((p) => p.text).length <= NEWS_PAGES_READ_IN_FULL, `${topic}: at most ${NEWS_PAGES_READ_IN_FULL} added news pages read in full`);
    assert.ok(addedPapers.every((p) => p.foundVia.includes("scholar")) && addedPapers.length <= scholar.length, `${topic}: only the top paper of each Google Scholar search`);
  }
  console.log("ok saved runs: Exa pages unchanged, news and papers added on top");
}

function testShortText() {
  const page = { id: "p1", url: "u", title: "t", site: "s", highlights: ["Private bike subscriptions fell 2% to 98000 in Germany, the survey found."], text: "Germany's shared bike fleet grows", pictures: [], foundBy: ["q1"], foundVia: ["news"], score: 1 };
  const facts = checkFacts([{ subQuestionId: "q1", raw: { facts: [{ claim: "Fell", quote: "Private bike subscriptions fell 2% to 98000 in Germany", page_id: "p1" }] } }], [page]);
  assert.equal(facts.length, 1, "a quote from the snippet of a paywalled page passes the check");
  const long = { ...page, text: "x".repeat(1200) };
  assert.equal(checkFacts([{ subQuestionId: "q1", raw: { facts: [{ claim: "Fell", quote: "Private bike subscriptions fell 2% to 98000 in Germany", page_id: "p1" }] } }], [long]).length, 0, "a long full text is read alone");
  console.log("ok fact extraction reads the passages of a page with a short text");
}

async function testCompany() {
  const nvidia = { name: "NVIDIA", ticker: "NVDA", exchange: "NASDAQ" };
  const composio = fakeComposio();
  const prices = await composio.prices("NVDA:NASDAQ");
  const page = pricePage(nvidia, prices);
  assert.equal(page.url, "https://www.google.com/finance/quote/NVDA:NASDAQ");
  assert.equal(page.title, "NVIDIA (NVDA) stock price, last month");
  assert.equal(page.site, "google.com");
  const [line1, line2, line3] = page.text.split("\n");
  assert.equal(line1, "NVIDIA (NVDA) closed at 227.38 USD on 2026-09-21 and at 216.47 USD on 2026-10-20, a change of -4.8%.");
  assert.equal(line2, "The highest close of the period was 239.24 USD on 2026-10-06, and the lowest close was 214.13 USD on 2026-10-16.");
  assert.equal(line3, "The latest price was 220.40 USD on 2026-10-21 at 12:10 PM, before the close.");
  const facts = new Map([["F1", { id: "F1", quote: line1 }]]);
  assert.ok(sentenceSupported("NVIDIA closed at 216.47 USD on October 20 [F1].", facts), "the last close passes the number check");
  assert.ok(!sentenceSupported("NVIDIA closed at 231.10 USD [F1].", facts), "another price is dropped");

  assert.ok(sameCompany("NVIDIA", "NVIDIA CORP"));
  assert.ok(sameCompany("Apple", "APPLE HOSPITALITY REIT INC"), "one shared word is enough, so the check only catches a clearly wrong ticker");
  assert.ok(!sameCompany("Meta Platforms", "Microsoft Corp"));
  const filings = await composio.filings("NVDA");
  const passages = new Map([[filings.filings[1].url, ["Revenue was $46.7 billion."]]]);
  const fp = filingPages("NVIDIA CORP", filings, passages);
  assert.deepEqual(fp.map((p) => [p.title, p.site, p.text]), [["NVIDIA CORP 10-Q filed 2026-08-26", "sec.gov", "Revenue was $46.7 billion."]], "a filing without passages gives no page");

  const read = async (urls) => new Map(urls.map((u) => [u, [`Passage of ${u}`]]));
  const ok = await collectCompany(composio, nvidia, read, Date.now() + 5000);
  assert.deepEqual(ok.pages.map((p) => p.foundVia[0]), ["prices", "filings", "filings", "filings"]);
  assert.deepEqual(ok.sources.map((s) => [s.name, s.state]), [["prices", "returned items"], ["filings", "returned items"]]);
  const wrong = await collectCompany(composio, { name: "Nintendo", ticker: "NVDA", exchange: "NASDAQ" }, read, Date.now() + 5000);
  assert.equal(wrong.pages.length, 0, "a wrong ticker gives no company pages");
  assert.match(wrong.sources[0].engineStatus, /does not match/);
  const noFilings = await collectCompany(fakeComposio({ noFilings: true }), nvidia, read, Date.now() + 5000);
  assert.deepEqual(noFilings.pages.map((p) => p.foundVia[0]), ["prices"], "the price page without filings");
  assert.deepEqual(noFilings.sources.map((s) => s.state), ["returned items", "returned no items"]);
  const down = await collectCompany(fakeComposio({ fail: ["prices", "filings"] }), nvidia, read, Date.now() + 5000);
  assert.deepEqual(down.sources.map((s) => s.state), ["could not be reached", "could not be reached"]);
  console.log("ok company: price page, number check, filings, name check, no filings, failures");
}

async function testSearchWithComposio() {
  const plan = { ...fallbackPlan("nvidia"), company: { name: "NVIDIA", ticker: "NVDA", exchange: "NASDAQ" } };
  plan.subQuestions[0].scholarQuery = "nvidia study";
  const exa = fakeExa();
  const composio = fakeComposio();
  const web = await searchWeb(exa, plan, "2026-11-02", Date.now() + 5000, composio);
  assert.equal(composio.calls.news.length, plan.subQuestions.length, "one news search for each sub-question");
  assert.deepEqual(composio.calls.news, plan.subQuestions.map((q) => q.recentQuery));
  assert.deepEqual(composio.calls.scholar, ["nvidia study"], "Google Scholar only for the marked sub-question");
  assert.deepEqual(web.pages.slice(0, 4).map((p) => p.foundVia[0]), ["prices", "filings", "filings", "filings"], "the company pages come first");
  assert.ok(web.pages.slice(0, 4).every((p) => p.foundBy.length === plan.subQuestions.length), "every sub-question reads the company pages");
  assert.ok(web.pages.slice(4).length <= 24, "the company pages do not count toward the 24 ranked pages");
  assert.deepEqual(web.pages.map((p) => p.id).slice(0, 2), ["p1", "p2"]);
  assert.ok(web.pages.some((p) => p.foundVia.includes("news")), "news pages are ranked");
  assert.ok(web.pages.some((p) => p.foundVia.includes("scholar")), "paper pages are ranked");
  const topPaper = composioFixture("scholar").data.articles[0].link;
  assert.ok(exa.calls.contents.some((c) => Array.isArray(c) && c.includes(topPaper)), "the top paper of the Google Scholar search is read in full");
  assert.equal(web.pages[4].url, topPaper, "the top paper comes right after the company pages");
  const filingCall = exa.calls.contents.find((c) => c.highlightsQuery);
  assert.equal(filingCall.highlightsQuery, plan.brief, "the filings are read for passages that match the brief");
  assert.deepEqual(web.extraSources.map((s) => [s.name, s.state]), [["news", "returned items"], ["scholar", "returned items"], ["prices", "returned items"], ["filings", "returned items"]]);

  const started = Date.now();
  const hung = await searchWeb(fakeExa(), plan, "2026-11-02", Date.now() + 300, fakeComposio({ hang: ["news"] }));
  assert.ok(Date.now() - started < 3000, "a Composio call that never answers does not hold up the search step");
  assert.ok(hung.pages.some((p) => p.foundVia.includes("web")), "the Exa pages are kept");

  const none = await searchWeb(fakeExa(), fallbackPlan("ebikes"), "2026-11-02", Date.now() + 5000, null);
  assert.deepEqual(none.extraSources, [], "no extra source without a Composio key");
  console.log("ok search with Composio Search: news, papers, company pages, sources, a call that hangs");
}

/** The You.com client (change research-web-provider): request params, reply mapping, Exa for the text. */
async function testYouClient() {
  const req = { query: "e-bike subscriptions", numResults: 5, startPublishedDate: "2026-10-03T00:00:00.000Z", excludeDomains: EXCLUDED_DOMAINS, highlightsQuery: "Who offers them?" };
  const params = youSearchParams(req, new Date("2026-11-02T15:00:00Z"));
  assert.deepEqual(params, {
    query: "e-bike subscriptions",
    count: 5,
    freshness: "2026-10-03to2026-11-02",
    exclude_domains: EXCLUDED_DOMAINS,
    extraction: { extraction_mode: "highlights" },
  }, "query, count, date range, excluded sites as a list, highlights extraction");
  assert.deepEqual(youSearchParams({ query: "q" }), { query: "q", count: 10, extraction: { extraction_mode: "highlights" } }, "no freshness and no exclude_domains when not asked");

  const reply = JSON.parse(fs.readFileSync(new URL("../test/fixtures/research/you/web-search-highlights.json", import.meta.url), "utf8"));
  const results = youResults(reply);
  assert.equal(results.length, 3, "a result without a URL is left out");
  assert.deepEqual(results[0], {
    url: "https://upway.co/blogs/news/what-is-an-electric-bike-subscription",
    title: "What Is An Electric Bike Subscription?",
    publishedDate: "2026-01-24T00:00:00",
    image: "https://imgs.search.brave.com/upway-thumb.jpg",
    favicon: "https://upway.co/favicon.ico",
    highlights: reply.results.web[0].contents.highlights,
  });
  assert.deepEqual(results[1].highlights, ["Several cities started e-bike voucher programs in October 2026."], "snippets are highlights");
  assert.equal(results[1].publishedDate, "2026-11-05T21:24:23");
  assert.deepEqual(results[2].highlights, ["Ride a new e-bike for a monthly fee, with repairs included."], "the description when there are no highlights");
  assert.equal(results[2].image, undefined);
  assert.deepEqual(youResults(null), []);
  assert.deepEqual(youResults({ results: {} }), []);

  let n = 0;
  const router = fakeRouter({
    replies: { [YOU_SEARCH_ENDPOINT]: () => reply },
    fail: { [YOU_SEARCH_ENDPOINT]: () => (n++ === 0 ? "rate limited" : undefined) },
  });
  const exa = fakeExa();
  const you = makeYouClient(router.client, exa, () => new Date("2026-11-02T15:00:00Z"));
  const found = await you.search(req, Date.now() + 10_000);
  assert.equal(found.length, 3);
  assert.equal(router.calls.length, 2, "one retry after a rate limit");
  assert.equal(router.calls[1].endpoint, "you.web.search.highlights");
  assert.equal(exa.calls.search.length, 0, "the search does not call Exa");
  await you.contents([FAKE_PAGES[0].url], Date.now() + 5000);
  assert.deepEqual(exa.calls.contents, [[FAKE_PAGES[0].url]], "the full text stays on Exa");
  assert.deepEqual(await makeYouClient(router.client, null).contents(["https://a.org"], Date.now() + 5000), [], "no full text without an Exa key");

  const down = makeYouClient(fakeRouter({ failAll: "usage wallet empty" }).client, exa);
  await assert.rejects(down.search(req, Date.now() + 5000), (e) => e instanceof RouterError && e.kind === "usage wallet empty");

  // searchWeb takes the You.com client in place of the Exa client.
  const web = await searchWeb(makeYouClient(fakeRouter({ replies: { [YOU_SEARCH_ENDPOINT]: () => reply } }).client, exa), fallbackPlan("ebikes"), "2026-11-02", Date.now() + 5000);
  assert.ok(web.pages.some((p) => p.url === "https://wombi.us/" && p.foundVia.includes("web")), "You.com pages are web pages");

  assert.equal(parseWebProvider(undefined), "exa", "default Exa");
  assert.equal(parseWebProvider(""), "exa");
  assert.equal(parseWebProvider("You.com"), "you.com");
  assert.equal(parseWebProvider("bing"), null);
  assert.deepEqual([webSourceLabel("exa"), webSourceLabel("you.com")], ["Web (Exa)", "Web (You.com)"]);
  console.log("ok You.com client: params, reply mapping, retry, Exa for the full text");
}

async function testWholeRun() {
  const desktopRoot = fs.mkdtempSync(path.join(os.tmpdir(), "research-pipeline-"));
  const roots = { desktopRoot, filesRoot: path.join(desktopRoot, "joshu's files") };
  fs.mkdirSync(roots.filesRoot, { recursive: true });
  try {
    const { deps, model } = fakeDeps(roots);
    const report = await makeResearchReport("/unused", "the market for electric bike subscriptions", deps);
    const data = JSON.parse(fs.readFileSync(path.join(report.folder, "report.json"), "utf8"));
    // Each theme section is one stored story with its cited pages (change recurring-research-reports, task 3.7).
    const stored = JSON.parse(fs.readFileSync(path.join(report.folder, "stories.json"), "utf8"));
    assert.equal(stored.stories.length, data.text.themes.length, "one story for each theme");
    assert.ok(stored.stories.every((st) => st.items.length && st.items.every((it) => data.research.pages.some((p) => p.url === it.url))), "the items are cited pages");
    assert.equal(stored.nextNumber, stored.stories.length + 1);
    assert.equal(data.schemaVersion, 2);
    assert.ok(data.research.facts.length >= 8, "enough facts for themes");
    assert.ok(data.research.facts.every((f) => !/not on any page/.test(f.quote)), "invented quotes never reach the report");
    assert.ok(data.text.themes.some((t) => t.kind === "background") && data.text.themes.some((t) => t.kind === "news"), "background themes and news themes");
    assert.ok(data.text.themes.every((t) => t.links?.length), "each theme has its links");
    assert.ok(data.text.dropped.some((s) => /99%/.test(s)), "the sentence with an invented number is dropped");
    assert.ok(data.text.dropped.some((s) => /F999/.test(s)), "the sentence with an unknown citation is dropped");
    assert.ok(data.pictures.length >= 1, "a theme has a picture");
    assert.ok(!data.pictures.some((p) => p.site === "site3.example.org"), "the 120 px picture is too small");
    assert.equal(data.research.social.length, 0, "no separate box of social posts");
    assert.ok(data.text.themes.some((t) => (t.links ?? []).some((l) => l.url === "https://reddit.com/r/ebikes/1")), "the post is a link of its theme");
    assert.ok(model.requests.every((r) => r.body.provider.data_collection === "deny"));
    const html = fs.readFileSync(path.join(report.folder, "report.html"), "utf8");
    assert.match(html, /<img src="data:image\/png;base64,/, "the picture is embedded");
    assert.match(html, /Picture: <a href="https:\/\/site\d\.example\.org/);
    assert.match(html, /<span class="cite"><a href="https:\/\/site\d\.example\.org\/article-\d">\d+<\/a><\/span>/, "citations link to pages");
    assert.doesNotMatch(html, /\[F\d+\]/, "no raw citation markers");
    assert.doesNotMatch(html, /What people are saying|Key Findings/, "no box of social posts and no key findings");
    assert.doesNotMatch(html, /Main sites|class="theme-no"|<div class="posts-title">Sources<\/div>/, "a theme has no side column of counts and no list of sources");
    assert.equal((html.match(/<div class="posts-title">Pages and posts<\/div>/g) ?? []).length, 1, "the sources are in one list at the end");
    const order = ['id="summary"', 'id="background"', 'id="themes"', "Pages and posts"].map((m) => html.indexOf(m));
    assert.ok(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1])), "parts in order");
    assert.doesNotMatch(html, /<(link|script|img[^>]+src="https?:)/i, "nothing loads from the internet");

    for (const [step, override] of [
      ["search", { deps: { exa: null } }],
      ["search", { exa: { failSearch: true } }],
    ]) {
      const before = fs.readdirSync(researchDir(roots)).length;
      await assert.rejects(makeResearchReport("/unused", "failing topic", fakeDeps(roots, override).deps), (e) => e.step === step);
      assert.equal(fs.readdirSync(researchDir(roots)).length, before, "no folder after a failure");
    }
    const noSocial = fakeDeps(roots, { deps: { social: async () => { throw new Error("engine missing"); } } }).deps;
    const r2 = await makeResearchReport("/unused", "no social topic", noSocial);
    const d2 = JSON.parse(fs.readFileSync(path.join(r2.folder, "report.json"), "utf8"));
    assert.ok(d2.text.themes.length >= 1, "the report is complete when the social collection fails");
    assert.ok(d2.research.sources.some((s) => s.state === "could not be reached"));
    assert.ok(!d2.research.sources.some((s) => ["news", "scholar", "prices", "filings"].includes(s.name)), "no extra source without a Composio key");
    console.log("ok whole run with fakes: themes, facts, dropped sentences, picture, posts in themes, failures");

    const company = { name: "NVIDIA", ticker: "NVDA", exchange: "NASDAQ" };
    const full = fakeDeps(roots, { model: { company, scholar: true }, composio: fakeComposio() }).deps;
    const r3 = await makeResearchReport("/unused", "nvidia", full);
    const d3 = JSON.parse(fs.readFileSync(path.join(r3.folder, "report.json"), "utf8"));
    assert.deepEqual(d3.research.sources.map((s) => s.name).slice(0, 5), ["web", "news", "scholar", "prices", "filings"], "each extra source has a source state");
    assert.ok(d3.research.pages.every((p) => Array.isArray(p.foundVia)), "report.json keeps the sources of each page");
    assert.match(fs.readFileSync(path.join(r3.folder, "report.html"), "utf8"), /SEC filings/);

    const newsDown = fakeDeps(roots, { composio: fakeComposio({ fail: ["news"] }) }).deps;
    const r4 = await makeResearchReport("/unused", "ebikes news down", newsDown);
    const d4 = JSON.parse(fs.readFileSync(path.join(r4.folder, "report.json"), "utf8"));
    assert.equal(d4.research.sources.find((s) => s.name === "news").state, "could not be reached");
    assert.ok(!d4.research.sources.some((s) => s.name === "prices" || s.name === "scholar"), "sources that the box did not try are not listed");
    assert.ok(d4.text.themes.length >= 1, "the Research report is complete");
    console.log("ok whole run with Composio Search: source states, failed news, sources not tried");

    // A Research report from the Research app with the sources Web and news and Reddit (change
    // recurring-research-reports, spec research-report-sources).
    const composio = fakeComposio();
    const chosen = fakeDeps(roots, { model: { company, scholar: true }, composio, deps: { sources: ["web", "reddit"], social: undefined, socialDeps: { client: null, unavailable: "content router off" } } }).deps;
    const r5 = await makeResearchReport("/unused", "nvidia chosen", chosen);
    const d5 = JSON.parse(fs.readFileSync(path.join(r5.folder, "report.json"), "utf8"));
    assert.equal(composio.calls.scholar.length, 0, "no Google Scholar search");
    assert.equal(composio.calls.prices.length + composio.calls.filings.length, 0, "no stock prices or SEC filings");
    assert.ok(composio.calls.news.length > 0, "Google News is part of Web and news");
    const socialSources = d5.research.sources.filter((s) => ["reddit", "x", "youtube", "tiktok", "instagram"].includes(s.name)).map((s) => s.name);
    assert.deepEqual(socialSources, ["reddit"], "only the chosen social source");
    console.log("ok Research report with chosen sources");

    // The web search provider of a report (change research-web-provider): Exa by default, You.com when chosen.
    assert.equal(data.research.sources.find((x) => x.name === "web").label, "Web (Exa)", "Exa by default");
    const youReply = JSON.parse(fs.readFileSync(new URL("../test/fixtures/research/you/web-search-highlights.json", import.meta.url), "utf8"));
    const youRouter = fakeRouter({ replies: { [YOU_SEARCH_ENDPOINT]: () => ({ results: { web: FAKE_PAGES.slice(0, 5).map((pg) => ({ url: pg.url, title: pg.title, page_age: pg.publishedDate, contents: { highlights: [pg.text.split(". ")[0] + "."] } })).concat(youReply.results.web.slice(0, 1)) } }) } });
    const withYou = fakeDeps(roots, { deps: { webProvider: "you.com" } });
    const r6 = await makeResearchReport("/unused", "ebikes with you", { ...withYou.deps, you: makeYouClient(youRouter.client, withYou.exa) });
    const d6 = JSON.parse(fs.readFileSync(path.join(r6.folder, "report.json"), "utf8"));
    assert.equal(d6.research.sources.find((x) => x.name === "web").label, "Web (You.com)");
    assert.ok(youRouter.calls.length > 0 && youRouter.calls.every((c) => c.endpoint === "you.web.search.highlights"));
    assert.equal(withYou.exa.calls.search.length, 0, "no Exa search with You.com");
    assert.ok(withYou.exa.calls.contents.length > 0, "Exa reads the full text");
    await assert.rejects(
      makeResearchReport("/unused", "no router", fakeDeps(roots, { deps: { webProvider: "you.com", you: null } }).deps),
      (e) => e.step === "search" && /You\.com web search needs the content router/.test(e.message),
    );
    console.log("ok Research report with You.com web search");
  } finally {
    fs.rmSync(desktopRoot, { recursive: true, force: true });
  }
}

await testCallJson();
await testExaClient();
await testYouClient();
await testPlan();
await testOwnerRequest();
await testSearchAndRank();
await testComposioClient();
await testPlanSources();
testRankSources();
await testSavedRuns();
testShortText();
await testCompany();
await testSearchWithComposio();
testFacts();
testCitationCheck();
await testPictures();
await testSocialBox();
await testHintGoal();
await testWholeRun();
console.log("all research pipeline checks passed");
