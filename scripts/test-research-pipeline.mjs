/**
 * Unit tests of the research pipeline of Research reports (change research-reports, promise change
 * P7, tasks 11.1 to 11.8 and 11.10): the model call, the Exa client, plan, search and rank, fact
 * extraction, the citation check, pictures, and the whole run with fakes. Also the sources of
 * source search (changes research-report-sources and research-router-sources). No network.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { callJson } from "../src/research/pipeline/llm.ts";
import { makeExaClient, searchAll } from "../src/research/pipeline/exa.ts";
import { boxWebClient, capHighlights, makeYouApiClient, makeYouClient, markdownPictures, parseWebProvider, webSourceLabel, youAccess, youDirectPost, youExtractBody, youPage, youRelayPost, youResults, youSearchParams, YouError, YOU_SEARCH_ENDPOINT } from "../src/research/pipeline/you.ts";
import { checkPlan, fallbackPlan, ownerSections, planResearch, clipWords } from "../src/research/pipeline/plan.ts";
import { rankPages, searchWeb, EXCLUDED_DOMAINS, FIXED_PASSAGE_SCORE, NEWS_PAGES_KEPT, NEWS_PAGES_READ_IN_FULL } from "../src/research/pipeline/search.ts";
import { checkFacts, pagesForQuestion } from "../src/research/pipeline/extract.ts";
import {
  COMPANY_NAME_ENDPOINT,
  FILINGS_GOAL,
  NEWS_GOAL,
  PAPERS_GOAL,
  PRICES_ENDPOINT,
  filingsOf,
  makeSourceSearchClient,
  sourceSearchClient,
  stockPrices,
} from "../src/research/pipeline/sourceSearch.ts";
import { dayOf, relativeDate } from "../src/contentRouter/recipe.ts";
import { collectCompany, filingPages, pricePage, sameCompany } from "../src/research/pipeline/company.ts";
import { limitSentences, sentences, sentenceSupported, verifyText } from "../src/research/pipeline/write.ts";
import { candidates, downloadPicture, imageInfo } from "../src/research/pipeline/pictures.ts";
import { makeResearchReport } from "../src/research/make.ts";
import { fakeRouter, POLY_ENDPOINT, tempHermesHome } from "./lib/content-router-fakes.mjs";
import { RouterError } from "../src/contentRouter/client.ts";
import { itemCounter } from "../src/research/engagement.ts";
import { researchDir } from "../src/research/store.ts";
import { sourceFixture, fakeSourceSearch, fakeDeps, fakeExa, fakeModel, fakePng, FAKE_PAGES } from "./lib/research-test-fakes.mjs";

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

async function testSourceSearchClient() {
  const today = new Date("2026-10-21T16:00:00.000Z");
  const deadline = Date.now() + 10_000;
  const item = (title, url, publishedAt, summary = "") => ({ title, url, summary, source: "x", sourceLabel: "x", publishedAt, engagement: {} });
  const ok = (goal, items) => ({ items, state: { name: goal.id, label: goal.label, state: items.length ? "returned items" : "returned no items", engineStatus: "ok" } });
  const down = (goal, reason) => ({ items: [], state: { name: goal.id, label: goal.label, state: "could not be reached", engineStatus: reason } });

  // News, research papers, and SEC filings are content goals: the client names what the report
  // needs, and the box finds the provider endpoint. No provider name is in these calls.
  const goals = [];
  let learning = 0;
  let maxLearning = 0;
  let active = 0;
  let maxActive = 0;
  // The route cache of the fake box: a goal kind gets a route only when a reply has items.
  const routes = new Set();
  const resolve = async (goal, search) => {
    goals.push({ ...goal, sinceDay: search.sinceDay });
    active += 1;
    maxActive = Math.max(maxActive, active);
    // A goal kind with no cached route finds its provider endpoint in this call.
    const cold = !routes.has(goal.kind);
    if (cold) {
      learning += 1;
      maxLearning = Math.max(maxLearning, learning);
    }
    await new Promise((r) => setTimeout(r, goal.query === "slow" ? 400 : cold ? 30 : 5));
    if (cold) learning -= 1;
    active -= 1;
    if (goal.query === "down") return down(goal, "provider error");
    if (goal.query === "wallet") return down(goal, "usage wallet empty");
    if (goal.query === "nothing") return ok(goal, []);
    routes.add(goal.kind);
    if (goal.kind === FILINGS_GOAL.kind) {
      return ok(goal, [
        item("144", "https://www.sec.gov/a/144.htm", "2026-10-19"),
        item("Form 8-K", "https://www.sec.gov/a/8k-2.htm", "2026-09-03"),
        item("10-Q", "https://www.sec.gov/a/10q.htm", "2026-08-26"),
        item("8-K/A", "https://www.sec.gov/a/8k-1.htm", "2026-08-26"),
        item("10-K", "https://www.sec.gov/a/10k.htm", "2026-02-20"),
        item("8-K", "", "2026-10-01"),
        item("8-K", "https://www.sec.gov/a/no-date.htm", undefined),
      ]);
    }
    if (goal.kind === PAPERS_GOAL.kind) return ok(goal, [item("A paper", "https://arxiv.org/abs/1", "2019-05-01", "R Julio, A Monzon: An abstract.")]);
    return ok(goal, [item(`News about ${goal.query}`, "https://news.example/a", "2026-10-20", "A snippet."), item("No link", "", "2026-10-20")]);
  };
  const routeKnown = (kind) => routes.has(kind);

  const calls = [];
  const fixtureOf = { [PRICES_ENDPOINT]: "prices", [COMPANY_NAME_ENDPOINT]: "company-name" };
  const router = {
    async call(request, _deadline, opts) {
      calls.push({ ...request, timeoutMs: opts?.timeoutMs });
      if (request.endpoint === COMPANY_NAME_ENDPOINT && request.params.ticker === "NONAME") throw new RouterError("provider error", "not found", 404);
      if (request.endpoint === PRICES_ENDPOINT && request.params.ticker === "EMPTY") return { body: [] };
      if (request.endpoint === PRICES_ENDPOINT && request.params.ticker === "BROKE") throw new RouterError("usage wallet empty", "router call prices: the usage wallet is empty");
      return { call_id: "rc_test", endpoint: request.endpoint, capability: "", channel: "treg", cost_usd: 0, body: sourceFixture(fixtureOf[request.endpoint]) };
    },
  };
  const client = () => makeSourceSearchClient(router, resolve, { now: () => today, routeKnown });
  const reset = () => {
    routes.clear();
    goals.length = 0;
    maxLearning = 0;
    maxActive = 0;
  };
  const c = client();

  // Six news searches at once on a box with no route: one call at a time finds the provider
  // endpoint, and when it left a route the others run at the same time.
  const news = await Promise.all(Array.from({ length: 6 }, (_, i) => c.news(`ebike ${i}`, deadline)));
  assert.equal(maxLearning, 1, "one call finds the provider endpoint of a goal kind, not six at once");
  assert.ok(maxActive > 1, "with a route the other searches run at the same time");
  assert.deepEqual(news[0], [{ url: "https://news.example/a", title: "News about ebike 0", publishedDate: "2026-10-20", highlights: ["A snippet."] }], "an item with no link is left out");
  assert.deepEqual(goals[0], { id: "news", kind: "News articles", label: "News", query: "ebike 0", sinceDay: "2026-09-20" }, "the news of the last 31 days");
  assert.ok(!JSON.stringify(goals).match(/serper|tiingo|financialdatasets|composio/i), "no provider name in a goal");
  await c.news("ebike week", deadline, "w");
  assert.equal(goals.at(-1).sinceDay, "2026-10-14", "the news of the last week");
  await c.news("ebike day", deadline, "d");
  assert.equal(goals.at(-1).sinceDay, "2026-10-20");

  // The first search returns no items, so it leaves no route: the next search finds the route,
  // still one at a time.
  reset();
  await Promise.all([client()].flatMap((x) => ["nothing", "ebike 1", "ebike 2", "ebike 3"].map((q) => x.news(q, deadline))));
  assert.equal(maxLearning, 1, "a first search with no items does not make the others find a route at the same time");

  // An empty usage wallet holds for every query of the goal kind: one call, and the others get the reason.
  reset();
  const broke = await Promise.allSettled([client()].flatMap((x) => ["wallet", "ebike 1", "ebike 2"].map((q) => x.news(q, deadline))));
  assert.deepEqual(broke.map((r) => r.reason?.message), ["usage wallet empty", "usage wallet empty", "usage wallet empty"]);
  assert.equal(goals.length, 1, "no more calls after the usage wallet is empty");

  // A provider error of one query does not fail the other queries.
  reset();
  const mixed = await Promise.allSettled([client()].flatMap((x) => ["down", "ebike 1"].map((q) => x.news(q, deadline))));
  assert.deepEqual(mixed.map((r) => r.status), ["rejected", "fulfilled"]);

  // A route in the route cache: every search runs at once, with no wait for a first call.
  reset();
  routes.add(NEWS_GOAL.kind);
  await Promise.all([client()].flatMap((x) => ["a", "b", "c", "d"].map((q) => x.news(q, deadline))));
  assert.equal(maxActive, 4, "no first call alone when the route cache has the route");

  // A search whose deadline passes while it waits makes no call.
  reset();
  const waiting = client();
  const slow = waiting.news("slow", deadline);
  const late = waiting.news("late", Date.now() + 100);
  await assert.rejects(late, /out of time/);
  await slow;
  assert.ok(!goals.some((g) => g.query === "late"), "no call after the deadline of a search that waited");
  reset();
  routes.add(NEWS_GOAL.kind);

  const papers = await c.scholar("ebike study", deadline);
  assert.deepEqual(goals.at(-1), { id: "scholar", kind: "Research papers", label: "Research papers", query: "ebike study", sinceDay: "1900-01-01" }, "a paper of any year counts");
  assert.deepEqual(papers, [{ url: "https://arxiv.org/abs/1", title: "A paper", publishedDate: "2019-05-01", highlights: ["R Julio, A Monzon: An abstract."] }]);

  const filings = await c.filings("nvda", deadline);
  assert.deepEqual(goals.at(-1), { id: "filings", kind: "SEC filings", label: "SEC filings", query: "NVDA", sinceDay: "2025-10-21" });
  assert.equal(filings.companyName, "NVIDIA Corp", "the company name comes from the name lookup");
  assert.deepEqual(filings.filings.map((f) => [f.form, f.filedAt]), [["8-K", "2026-09-03"], ["10-Q", "2026-08-26"], ["8-K", "2026-08-26"]], "the three newest of forms 10-K, 10-Q, and 8-K with a link and a date; `Form 8-K` and `8-K/A` count");
  // A company with only other forms in the reply has no filing page.
  const onlyOther = filingsOf(ok(FILINGS_GOAL, [item("4", "https://www.sec.gov/4", "2026-10-01"), item("144", "https://www.sec.gov/144", "2026-10-02"), item("SC 13G", "https://www.sec.gov/13g", "2026-10-03")]), "");
  assert.deepEqual(onlyOther.filings, [], "forms 4, 144, and SC 13G are not the forms of a report");
  // A provider endpoint that names its items with words: the newest items count.
  const other = filingsOf(ok(FILINGS_GOAL, [item("Quarterly report", "https://www.sec.gov/q", "2026-08-26"), item("Current report", "https://www.sec.gov/c", "2026-09-03")]), "");
  assert.deepEqual(other.filings.map((f) => f.form), ["Current report", "Quarterly report"]);

  // A goal that fails gives its reason to the caller. The source list links to the usage billing
  // page for the exact reason "usage wallet empty".
  await assert.rejects(c.news("down", deadline), /^Error: provider error$/);
  await assert.rejects(c.news("wallet", deadline), (e) => e.message === "usage wallet empty");
  const count = goals.length;
  await assert.rejects(c.news("ebike", Date.now() - 1), /out of time/);
  assert.equal(goals.length, count, "no goal after the deadline");

  // Stock prices are the one source with a fixed provider endpoint.
  const prices = await c.prices("NVDA:NASDAQ", deadline);
  assert.equal(prices.name, "NVIDIA Corp");
  assert.equal(prices.currency, "USD");
  assert.equal(prices.points.length, 22);
  assert.ok(prices.points.every((p) => p.close), "the price source has only closes");
  assert.deepEqual([prices.points[0].day, prices.points.at(-1).day], ["2026-09-21", "2026-10-20"], "oldest first");
  assert.deepEqual(calls.find((x) => x.endpoint === PRICES_ENDPOINT), { endpoint: PRICES_ENDPOINT, params: { ticker: "NVDA", startDate: "2026-09-20", endDate: "2026-10-21" }, timeoutMs: 40_000 }, "the last 31 days");
  assert.equal(calls.filter((x) => x.endpoint === COMPANY_NAME_ENDPOINT && x.params.ticker === "NVDA").length, 1, "one name lookup serves the prices and the filings");
  assert.equal((await c.prices("NONAME:NYSE", deadline)).name, "", "a failed name lookup does not fail the prices");
  assert.equal((await c.filings("NONAME", deadline)).companyName, "", "a failed name lookup does not fail the filings");
  assert.equal(await c.prices("EMPTY:NYSE", deadline), null, "no prices in the answer");
  await assert.rejects(c.prices("BROKE:NYSE", deadline), (e) => e.kind === "usage wallet empty" && e.message === "usage wallet empty");

  // The same ticker on an exchange outside the United States is another listing: no price call.
  const beforeForeign = calls.length;
  await assert.rejects(c.prices("SHOP:TSE", deadline), /no stock prices for exchange TSE/);
  assert.equal(calls.length, beforeForeign, "no router call for an exchange that the price source does not have");

  // A stock split inside the period: the closes before the split are divided by the split factor.
  const split = stockPrices(
    [
      { date: "2026-10-01T00:00:00.000Z", close: 1000, volume: 10, splitFactor: 1 },
      { date: "2026-10-02T00:00:00.000Z", close: 1010, volume: 10, splitFactor: 1 },
      { date: "2026-10-05T00:00:00.000Z", close: 102, volume: 100, splitFactor: 10 },
      { date: "2026-10-06T00:00:00.000Z", close: 103, volume: 100, splitFactor: 1 },
    ],
    "ACME:NYSE",
    "Acme Corp",
  );
  assert.deepEqual(split.points.map((p) => p.price), [100, 101, 102, 103], "a 10-for-1 split does not show as a fall of 90%");
  // One entry of the price reply of 2026-11-20.
  const livePrices = stockPrices([{ date: "2026-11-19T00:00:00.000Z", close: 145.98, high: 150.2, low: 144.9, open: 149.5, volume: 322940099, adjClose: 145.98, divCash: 0, splitFactor: 1 }], "NVDA:NASDAQ", "NVIDIA Corp");
  assert.deepEqual(livePrices.points, [{ day: "2026-11-19", time: "4:00 PM", price: 145.98, volume: 322940099, close: true }]);

  // The reader of the content goals reads a relative date, which search results of news often have.
  assert.equal(relativeDate("4 days ago", today).toISOString(), "2026-10-17T16:00:00.000Z");
  assert.equal(dayOf("2 weeks ago", "text", today), "2026-10-07");
  assert.equal(dayOf("22 mins ago", "text", today), "2026-10-21");
  assert.equal(dayOf("3 hrs ago", "iso", today), "2026-10-21");
  assert.equal(dayOf("3h ago", "text", today), "2026-10-21");
  assert.equal(dayOf("an hour ago", "text", today), "2026-10-21");
  assert.equal(dayOf("a day ago", "text", today), "2026-10-20");
  assert.equal(dayOf("45 seconds ago", "text", today), "2026-10-21");
  assert.equal(dayOf("2 mo ago", "text", today), "2026-08-22");
  assert.equal(dayOf("Yesterday", "text", today), "2026-10-20");
  assert.equal(dayOf("2026-10-20T13:14:00.000Z", "iso", today), "2026-10-20");
  assert.equal(dayOf("soon", "iso", today), undefined);
  assert.equal(relativeDate("3 apples ago", today), null);
  assert.equal(relativeDate("a while ago", today), null);

  // A box with no router access has no source search client.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "no-router-"));
  const savedEnv = {};
  for (const key of ["JOSHU_INSTANCE_ENV_PATH", "INSTANCE_AGENT_TOKEN", "JOSHU_INSTANCE_ID", "INSTANCE_ID", "JOSHU_TREG_MODE", "JOSHU_ROUTER_MODE", "JOSHU_ROUTER_API_KEY", "TREG_TOKEN"]) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  try {
    assert.equal(sourceSearchClient(home), null, "no client without router access");
  } finally {
    for (const [key, value] of Object.entries(savedEnv)) if (value !== undefined) process.env[key] = value;
    fs.rmSync(home, { recursive: true, force: true });
  }
  console.log("ok source search client: goals with no provider name, one call finds a route, periods, filings, failures, prices, split, exchange, dates, no router access");
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
  const runs = JSON.parse(fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "..", "test", "fixtures", "research", "sources", "ranking-runs.json"), "utf8"));
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
    const sourceSearch = {
      news: async (query) => news[plan.subQuestions.findIndex((q) => q.recentQuery === query)]?.results ?? [],
      scholar: async (query) => scholar.find((f) => `study ${f.subQuestionId}` === query)?.results ?? [],
    };
    const alone = await searchWeb(replayExa(web), plan, "2026-10-21", Date.now() + 5000, null);
    const both = await searchWeb(replayExa(web), plan, "2026-10-21", Date.now() + 5000, sourceSearch);
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
  const sourceSearch = fakeSourceSearch();
  const prices = await sourceSearch.prices("NVDA:NASDAQ");
  const page = pricePage(nvidia, prices);
  assert.equal(page.url, "https://www.google.com/finance/quote/NVDA:NASDAQ");
  assert.equal(page.title, "NVIDIA (NVDA) stock price, last month");
  assert.equal(page.site, "google.com");
  const [line1, line2, line3] = page.text.split("\n");
  assert.equal(line1, "NVIDIA (NVDA) closed at 227.38 USD on 2026-09-21 and at 216.47 USD on 2026-10-20, a change of -4.8%.");
  assert.equal(line2, "The highest close of the period was 239.24 USD on 2026-10-06, and the lowest close was 214.13 USD on 2026-10-16.");
  assert.equal(line3, "2026-09-21: closing price 227.38 USD, volume 109,806,068.", "the price source has only closes, so no line for a price before the close");
  const facts = new Map([["F1", { id: "F1", quote: line1 }]]);
  assert.ok(sentenceSupported("NVIDIA closed at 216.47 USD on October 20 [F1].", facts), "the last close passes the number check");
  assert.ok(!sentenceSupported("NVIDIA closed at 231.10 USD [F1].", facts), "another price is dropped");

  assert.ok(sameCompany("NVIDIA", "NVIDIA CORP"));
  assert.ok(sameCompany("Apple", "APPLE HOSPITALITY REIT INC"), "one shared word is enough, so the check only catches a clearly wrong ticker");
  assert.ok(!sameCompany("Meta Platforms", "Microsoft Corp"));
  const filings = await sourceSearch.filings("NVDA");
  const passages = new Map([[filings.filings[1].url, ["Revenue was $46.7 billion."]]]);
  assert.equal(filings.companyName, "NVIDIA Corp");
  const fp = filingPages(filings.companyName, filings, passages);
  assert.deepEqual(fp.map((p) => [p.title, p.site, p.text]), [["NVIDIA Corp 10-Q filed 2026-08-26", "sec.gov", "Revenue was $46.7 billion."]], "a filing without passages gives no page");

  const read = async (urls) => new Map(urls.map((u) => [u, [`Passage of ${u}`]]));
  const ok = await collectCompany(sourceSearch, nvidia, read, Date.now() + 5000);
  assert.deepEqual(ok.pages.map((p) => p.foundVia[0]), ["prices", "filings", "filings", "filings"]);
  assert.deepEqual(ok.sources.map((s) => [s.name, s.state]), [["prices", "returned items"], ["filings", "returned items"]]);
  const wrong = await collectCompany(sourceSearch, { name: "Nintendo", ticker: "NVDA", exchange: "NASDAQ" }, read, Date.now() + 5000);
  assert.equal(wrong.pages.length, 0, "a wrong ticker gives no company pages");
  assert.match(wrong.sources[0].engineStatus, /does not match/);
  const noFilings = await collectCompany(fakeSourceSearch({ noFilings: true }), nvidia, read, Date.now() + 5000);
  assert.deepEqual(noFilings.pages.map((p) => p.foundVia[0]), ["prices"], "the price page without filings");
  assert.deepEqual(noFilings.sources.map((s) => s.state), ["returned items", "returned no items"]);
  const down = await collectCompany(fakeSourceSearch({ fail: ["prices", "filings"] }), nvidia, read, Date.now() + 5000);
  assert.deepEqual(down.sources.map((s) => s.state), ["could not be reached", "could not be reached"]);
  console.log("ok company: price page, number check, filings, name check, no filings, failures");
}

async function testSearchWithSourceSearch() {
  const plan = { ...fallbackPlan("nvidia"), company: { name: "NVIDIA", ticker: "NVDA", exchange: "NASDAQ" } };
  plan.subQuestions[0].scholarQuery = "nvidia study";
  const exa = fakeExa();
  const sourceSearch = fakeSourceSearch();
  const web = await searchWeb(exa, plan, "2026-11-02", Date.now() + 5000, sourceSearch);
  assert.equal(sourceSearch.calls.news.length, plan.subQuestions.length, "one news search for each sub-question");
  assert.deepEqual(sourceSearch.calls.news, plan.subQuestions.map((q) => q.recentQuery));
  assert.deepEqual(sourceSearch.calls.scholar, ["nvidia study"], "Google Scholar only for the marked sub-question");
  assert.deepEqual(web.pages.slice(0, 4).map((p) => p.foundVia[0]), ["prices", "filings", "filings", "filings"], "the company pages come first");
  assert.ok(web.pages.slice(0, 4).every((p) => p.foundBy.length === plan.subQuestions.length), "every sub-question reads the company pages");
  assert.ok(web.pages.slice(4).length <= 24, "the company pages do not count toward the 24 ranked pages");
  assert.deepEqual(web.pages.map((p) => p.id).slice(0, 2), ["p1", "p2"]);
  assert.ok(web.pages.some((p) => p.foundVia.includes("news")), "news pages are ranked");
  assert.ok(web.pages.some((p) => p.foundVia.includes("scholar")), "paper pages are ranked");
  const topPaper = sourceFixture("scholar").organic[0].link;
  assert.ok(exa.calls.contents.some((c) => Array.isArray(c) && c.includes(topPaper)), "the top paper of the Google Scholar search is read in full");
  assert.equal(web.pages[4].url, topPaper, "the top paper comes right after the company pages");
  const filingCall = exa.calls.contents.find((c) => c.highlightsQuery);
  assert.equal(filingCall.highlightsQuery, plan.brief, "the filings are read for passages that match the brief");
  assert.deepEqual(web.extraSources.map((s) => [s.name, s.state]), [["news", "returned items"], ["scholar", "returned items"], ["prices", "returned items"], ["filings", "returned items"]]);

  const started = Date.now();
  const hung = await searchWeb(fakeExa(), plan, "2026-11-02", Date.now() + 300, fakeSourceSearch({ hang: ["news"] }));
  assert.ok(Date.now() - started < 3000, "a source search call that never answers does not hold up the search step");
  assert.ok(hung.pages.some((p) => p.foundVia.includes("web")), "the Exa pages are kept");

  // An empty usage wallet: the source state has the exact reason that the source list links to the billing page for.
  const broke = await searchWeb(fakeExa(), plan, "2026-11-02", Date.now() + 5000, fakeSourceSearch({ fail: ["news", "scholar"], failReason: "usage wallet empty" }));
  assert.deepEqual(broke.extraSources.filter((s) => ["news", "scholar"].includes(s.name)).map((s) => [s.state, s.engineStatus]), [["could not be reached", "usage wallet empty"], ["could not be reached", "usage wallet empty"]]);
  const none = await searchWeb(fakeExa(), fallbackPlan("ebikes"), "2026-11-02", Date.now() + 5000, null);
  assert.deepEqual(none.extraSources, [], "no extra source without router access");
  console.log("ok search with source search: news, papers, company pages, sources, a call that hangs");
}

/**
 * The You.com client and the web client of the box (change you-web-provider): the search and the
 * full text, through the proxy of the control plane or with an own key, Exa as the fallback, and
 * the choice of the box.
 */
async function testYouDirectClient() {
  for (const name of ["YDC_API_KEY", "JOSHU_YOU_MODE", "JOSHU_YOU_RELAY_URL", "CONTROL_PLANE_URL", "JOSHU_INSTANCE_ID", "INSTANCE_AGENT_TOKEN"]) delete process.env[name];
  const reply = JSON.parse(fs.readFileSync(new URL("../test/fixtures/research/you/web-search-highlights.json", import.meta.url), "utf8"));
  const req = { query: "ebike subscriptions", numResults: 5, startPublishedDate: "2026-10-03T00:00:00.000Z", excludeDomains: ["reddit.com"] };
  const calls = [];
  let mode = "ok";
  let rateLimited = true;
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body, key: init.headers["X-API-Key"] });
    const answer = (status, data) => ({ ok: status === 200, status, headers: new Map([["retry-after", "0"]]), json: async () => data });
    if (mode === "down") return answer(500, {});
    if (url.endsWith("/v1/search")) {
      if (rateLimited) {
        rateLimited = false;
        return answer(429, {});
      }
      return answer(200, reply);
    }
    if (body.url.includes("blocked")) return answer(502, { error: { code: "site_blocked" } });
    if (body.url.includes("empty")) return answer(200, {});
    return answer(200, { url: body.url, title: "Page", contents: { full_page: { markdown: `# Page\n\n![A bike](https://img.org/bike.jpg) text of ${body.url}\n![same](https://img.org/bike.jpg)` } } });
  };
  const exa = fakeExa();
  const you = makeYouApiClient(youDirectPost("you-key", fetchImpl), exa, () => new Date("2026-11-02T15:00:00Z"));
  const deadline = () => Date.now() + 10_000;

  // Search: the same params as through the content router, the key in X-API-Key, one retry after HTTP 429.
  const found = await you.search(req, deadline());
  assert.equal(found.length, 3);
  assert.equal(calls.length, 2, "one retry after a rate limit");
  assert.equal(calls[1].url, "https://ydc-index.io/v1/search");
  assert.equal(calls[1].key, "you-key");
  assert.deepEqual(calls[1].body, youSearchParams(req, new Date("2026-11-02T15:00:00Z")));
  assert.equal(exa.calls.search.length, 0, "a search that You.com answers does not call Exa");

  // Full text: one extract call for each page, the text and the pictures of the Markdown.
  calls.length = 0;
  const pages = await you.contents(["https://a.org/1", "https://a.org/2"], deadline());
  assert.deepEqual(calls.map((c) => [c.url, c.body]), [
    ["https://ydc-index.io/v1/extract", { url: "https://a.org/1", full_page: { extraction_formats: ["markdown"] } }],
    ["https://ydc-index.io/v1/extract", { url: "https://a.org/2", full_page: { extraction_formats: ["markdown"] } }],
  ]);
  assert.equal(pages.length, 2);
  assert.ok(pages[0].text.includes("text of https://a.org/1"));
  assert.deepEqual(pages[0].extras.richImageLinks, [{ url: "https://img.org/bike.jpg", alt: "A bike" }], "pictures of the Markdown, each one time");
  assert.equal(exa.calls.contents.length, 0, "pages that You.com read do not call Exa");

  // A page that You.com cannot read, or reads as empty, goes to Exa. The other pages stay on You.com.
  const mixed = await you.contents(["https://a.org/1", "https://blocked.org/x", "https://empty.org/y"], deadline());
  assert.deepEqual(exa.calls.contents, [["https://blocked.org/x", "https://empty.org/y"]]);
  assert.ok(mixed.some((p) => p.url === "https://a.org/1"));
  const alone = makeYouApiClient(youDirectPost("you-key", fetchImpl), null);
  assert.deepEqual((await alone.contents(["https://a.org/1", "https://blocked.org/x"], deadline())).map((p) => p.url), ["https://a.org/1"], "no Exa key: the page is left out");

  // The passages of a page for a question stay on Exa, because You.com has no such call.
  calls.length = 0;
  await you.contents(["https://a.org/1"], deadline(), { highlightsQuery: "what changed" });
  assert.equal(calls.length, 0);
  assert.deepEqual(exa.calls.contents.at(-1), { urls: ["https://a.org/1"], highlightsQuery: "what changed" });
  assert.deepEqual(await alone.contents(["https://a.org/1"], deadline(), { highlightsQuery: "q" }), []);

  // You.com is down: Exa answers the search. With no Exa key the search fails.
  mode = "down";
  const viaExa = await you.search(req, deadline());
  assert.equal(exa.calls.search.length, 1, "the failed search went to Exa");
  assert.ok(viaExa.length > 0);
  await assert.rejects(alone.search(req, deadline()), (e) => e instanceof YouError && e.status === 500);
  mode = "ok";

  assert.deepEqual(markdownPictures("no pictures"), []);
  assert.equal(markdownPictures(Array.from({ length: 12 }, (_, i) => `![p](https://img.org/${i}.png)`).join(" ")).length, 8, "at most 8 pictures");
  assert.equal(youPage("https://a.org", {}), null);
  assert.equal(youPage("https://a.org", { contents: { full_page: { markdown: "x".repeat(20_000) } } }).text.length, 12_000, "the text has the same limit as with Exa");

  // The web client of the box. `you` stands for the client that the You.com key gives.
  const root = process.cwd();
  const youFake = fakeExa();
  assert.deepEqual(boxWebClient(root, undefined, { exa, you: youFake }), { client: youFake, provider: "you.com" }, "You.com access: You.com is the default");
  assert.deepEqual(boxWebClient(root, undefined, { exa, you: null }), { client: exa, provider: "exa" }, "no You.com access: Exa");
  assert.deepEqual(boxWebClient(root, "exa", { exa, you: youFake }), { client: exa, provider: "exa" }, "the request names Exa");
  assert.equal(boxWebClient(root, "exa", { exa: null, you: youFake }).client, null);
  assert.match(boxWebClient(root, "you.com", { exa, you: null }).reason, /You\.com access or the content router/);
  assert.match(boxWebClient(root, undefined, { exa: null, you: null }).reason, /no You\.com access and no Exa key/);

  // Relay mode: the box posts the call to the proxy of the control plane with its instance agent
  // token, and holds no You.com key. The proxy answers HTTP 200 with the status of You.com.
  const relayCalls = [];
  let relayMode = "limited-once";
  const relayFetch = async (url, init) => {
    relayCalls.push({ url, auth: init.headers.Authorization, body: JSON.parse(init.body), key: init.headers["X-API-Key"] });
    const answer = (httpStatus, data) => ({ ok: httpStatus === 200, status: httpStatus, headers: new Map(), json: async () => data });
    if (relayMode === "proxy-401") return answer(401, { error: "unauthorized" });
    if (relayMode === "limited-once") {
      relayMode = "ok";
      return answer(200, { ok: true, status: 429, retryAfter: 0.01, json: {} });
    }
    if (relayMode === "blocked") return answer(200, { ok: true, status: 502, raw: "bad gateway" });
    return answer(200, { ok: true, status: 200, json: reply });
  };
  const relayPost = youRelayPost("https://cp.example/api/instances/you/proxy", () => "inst_1.token", relayFetch);
  const viaRelay = makeYouApiClient(relayPost, null, () => new Date("2026-11-02T15:00:00Z"));
  assert.equal((await viaRelay.search(req, deadline())).length, 3);
  assert.equal(relayCalls.length, 2, "one retry after a rate limit of You.com");
  assert.equal(relayCalls[1].url, "https://cp.example/api/instances/you/proxy");
  assert.equal(relayCalls[1].auth, "Bearer inst_1.token");
  assert.equal(relayCalls[1].key, undefined, "the box sends no You.com key");
  assert.deepEqual(relayCalls[1].body, { path: "/v1/search", json: youSearchParams(req, new Date("2026-11-02T15:00:00Z")) });
  relayMode = "blocked";
  await assert.rejects(viaRelay.search(req, deadline()), (e) => e instanceof YouError && e.status === 502);
  relayMode = "proxy-401";
  await assert.rejects(viaRelay.search(req, deadline()), (e) => e instanceof YouError && e.status === 401);
  // The control plane does not answer the box (the proxy refuses the token, or is down): Exa answers.
  const exaBehindRelay = fakeExa();
  assert.ok((await makeYouApiClient(relayPost, exaBehindRelay).search(req, deadline())).length > 0);
  assert.equal(exaBehindRelay.calls.search.length, 1, "the search went to Exa when the proxy failed");
  assert.deepEqual(youExtractBody("https://a.org/1"), { url: "https://a.org/1", full_page: { extraction_formats: ["markdown"] } });

  // How the box reaches You.com: relay mode first, the own key of a self-hosted box, or not at all.
  assert.equal(youAccess(), null, "no mode and no key: no You.com");
  process.env.YDC_API_KEY = "own-key";
  assert.equal(youAccess().via, "key", "a self-hosted box with its own key");
  process.env.JOSHU_YOU_MODE = "off";
  assert.equal(youAccess(), null, "mode off wins over a key");
  process.env.JOSHU_YOU_MODE = "relay";
  assert.equal(youAccess(), null, "relay mode with no proxy URL and no token: no You.com");
  process.env.CONTROL_PLANE_URL = "https://cp.example/";
  assert.equal(youAccess(), null, "relay mode with no instance agent token: no You.com");
  process.env.JOSHU_INSTANCE_ID = "inst_1";
  process.env.INSTANCE_AGENT_TOKEN = "token";
  const relayAccess = youAccess(relayFetch);
  assert.equal(relayAccess.via, "relay", "relay mode wins over a key on the box");
  relayMode = "ok";
  relayCalls.length = 0;
  await relayAccess.post("/v1/extract", { url: "https://a.org/1" }, deadline());
  assert.deepEqual(relayCalls[0], { url: "https://cp.example/api/instances/you/proxy", auth: "Bearer inst_1.token", body: { path: "/v1/extract", json: { url: "https://a.org/1" } }, key: undefined });
  for (const name of ["YDC_API_KEY", "JOSHU_YOU_MODE", "CONTROL_PLANE_URL", "JOSHU_INSTANCE_ID", "INSTANCE_AGENT_TOKEN"]) delete process.env[name];
  console.log("ok You.com client: search, full text, Exa fallback, the proxy of the control plane, the choice of the box");
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
  // You.com returns long passages. A result keeps at most 1,500 characters of them, as with Exa.
  const long = youResults({ results: { web: [{ url: "https://a.org", contents: { highlights: ["a".repeat(1000), "b".repeat(1000), "c".repeat(1000)] } }] } });
  assert.deepEqual(long[0].highlights.map((h) => h.length), [1000, 500]);
  assert.deepEqual(capHighlights(["short", "also short"]), ["short", "also short"]);
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

  assert.equal(parseWebProvider(undefined), "default", "no provider in the request: the box chooses");
  assert.equal(parseWebProvider(""), "default");
  assert.equal(parseWebProvider("Exa"), "exa");
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
    assert.ok(!d2.research.sources.some((s) => ["news", "scholar", "prices", "filings"].includes(s.name)), "no extra source without router access");
    console.log("ok whole run with fakes: themes, facts, dropped sentences, picture, posts in themes, failures");

    const company = { name: "NVIDIA", ticker: "NVDA", exchange: "NASDAQ" };
    const full = fakeDeps(roots, { model: { company, scholar: true }, sourceSearch: fakeSourceSearch() }).deps;
    const r3 = await makeResearchReport("/unused", "nvidia", full);
    const d3 = JSON.parse(fs.readFileSync(path.join(r3.folder, "report.json"), "utf8"));
    assert.deepEqual(d3.research.sources.map((s) => s.name).slice(0, 5), ["web", "news", "scholar", "prices", "filings"], "each extra source has a source state");
    assert.ok(d3.research.pages.every((p) => Array.isArray(p.foundVia)), "report.json keeps the sources of each page");
    assert.match(fs.readFileSync(path.join(r3.folder, "report.html"), "utf8"), /SEC filings/);

    const newsDown = fakeDeps(roots, { sourceSearch: fakeSourceSearch({ fail: ["news"] }) }).deps;
    const r4 = await makeResearchReport("/unused", "ebikes news down", newsDown);
    const d4 = JSON.parse(fs.readFileSync(path.join(r4.folder, "report.json"), "utf8"));
    assert.equal(d4.research.sources.find((s) => s.name === "news").state, "could not be reached");
    assert.ok(!d4.research.sources.some((s) => s.name === "prices" || s.name === "scholar"), "sources that the box did not try are not listed");
    assert.ok(d4.text.themes.length >= 1, "the Research report is complete");
    console.log("ok whole run with source search: source states, failed news, sources not tried");

    // A Research report from the Research app with the sources Web and news and Reddit (change
    // recurring-research-reports, spec research-report-sources).
    const sourceSearch = fakeSourceSearch();
    const chosen = fakeDeps(roots, { model: { company, scholar: true }, sourceSearch, deps: { sources: ["web", "reddit"], social: undefined, socialDeps: { client: null, unavailable: "content router off" } } }).deps;
    const r5 = await makeResearchReport("/unused", "nvidia chosen", chosen);
    const d5 = JSON.parse(fs.readFileSync(path.join(r5.folder, "report.json"), "utf8"));
    assert.equal(sourceSearch.calls.scholar.length, 0, "no Google Scholar search");
    assert.equal(sourceSearch.calls.prices.length + sourceSearch.calls.filings.length, 0, "no stock prices or SEC filings");
    assert.ok(sourceSearch.calls.news.length > 0, "Google News is part of Web and news");
    const socialSources = d5.research.sources.filter((s) => ["reddit", "x", "youtube", "tiktok", "instagram"].includes(s.name)).map((s) => s.name);
    assert.deepEqual(socialSources, ["reddit"], "only the chosen social source");
    console.log("ok Research report with chosen sources");

    // The web provider of a report (changes research-web-provider and you-web-provider): Exa on a box that cannot reach You.com.
    assert.equal(data.research.sources.find((x) => x.name === "web").label, "Web (Exa)", "Exa on a box that cannot reach You.com");
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
      (e) => e.step === "search" && /You\.com web search needs You\.com access or the content router/.test(e.message),
    );
    // A box that can reach You.com uses You.com when the request names no provider (change you-web-provider).
    const boxYou = fakeDeps(roots);
    const youOfBox = fakeExa();
    const r7 = await makeResearchReport("/unused", "ebikes by default", { ...boxYou.deps, you: youOfBox });
    const d7 = JSON.parse(fs.readFileSync(path.join(r7.folder, "report.json"), "utf8"));
    assert.equal(d7.research.sources.find((x) => x.name === "web").label, "Web (You.com)", "You.com is the default on a box that can reach You.com");
    assert.ok(youOfBox.calls.search.length > 0 && boxYou.exa.calls.search.length === 0, "the search goes to You.com, not to Exa");
    console.log("ok Research report with You.com web search");
  } finally {
    fs.rmSync(desktopRoot, { recursive: true, force: true });
  }
}

await testCallJson();
await testExaClient();
await testYouClient();
await testYouDirectClient();
await testPlan();
await testOwnerRequest();
await testSearchAndRank();
await testSourceSearchClient();
await testPlanSources();
testRankSources();
await testSavedRuns();
testShortText();
await testCompany();
await testSearchWithSourceSearch();
testFacts();
testCitationCheck();
await testPictures();
await testSocialBox();
await testHintGoal();
await testWholeRun();
console.log("all research pipeline checks passed");
