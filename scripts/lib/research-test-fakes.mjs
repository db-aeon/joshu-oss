/**
 * Fakes for the tests of Research reports (change research-reports, promise change P7): an Exa
 * client, a source search client (change research-router-sources), an OpenRouter fetch that
 * answers each pipeline step, social posts, and a PDF writer. No network.
 */
import fs from "node:fs";
import path from "node:path";
import { stockPrices } from "../../src/research/pipeline/sourceSearch.ts";
import { learnAnswer } from "./content-router-fakes.mjs";

const SOURCE_FIXTURES = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "..", "test", "fixtures", "research", "sources");

/**
 * One saved test answer of the source search (`news`, `scholar`, `prices`, `company-name`,
 * `filings`). `prices` and `company-name` have the shape of the replies of the price source. The
 * other three are lists of results that the fake turns into hits.
 */
export function sourceFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(SOURCE_FIXTURES, `${name}.json`), "utf8"));
}

/** The news hits of the saved answer, as the source search returns them. */
export function fixtureNews() {
  return sourceFixture("news").news.map((r) => ({ url: r.link, title: r.title, publishedDate: r.date, highlights: r.snippet ? [r.snippet] : [] }));
}

/** The paper hits of the saved answer. */
export function fixturePapers() {
  return sourceFixture("scholar").organic.map((a) => {
    const about = [`Authors: ${a.publicationInfo.split(" - ")[0]}.`, a.year ? `Year: ${a.year}.` : "", a.citedBy ? `Cited by ${a.citedBy}.` : ""].filter(Boolean).join(" ");
    return { url: a.link, title: a.title, highlights: [a.snippet, about].filter(Boolean) };
  });
}

/** The filings of the saved answer, newest first. */
export function fixtureFilings(companyName) {
  const filings = sourceFixture("filings")
    .filings.map((f) => ({ form: f.filing_type, filedAt: f.filing_date, reportDate: f.report_date || undefined, url: f.url }))
    .sort((a, b) => b.filedAt.localeCompare(a.filedAt));
  return { companyName, filings };
}

/**
 * Eight sites, each with two sentences that facts can quote word for word. Sites 1 to 5 are news of
 * the last 30 days; sites 6 to 8 are older pages, which only background themes use.
 */
export const FAKE_PAGES = Array.from({ length: 8 }, (_, i) => ({
  url: `https://site${i + 1}.example.org/article-${i + 1}`,
  title: `Article ${i + 1} about electric bike subscriptions`,
  publishedDate: i < 5 ? `2026-10-${String(10 + i).padStart(2, "0")}T08:00:00.000Z` : `2024-0${i}-15T08:00:00.000Z`,
  image: i % 2 === 0 ? `https://site${i + 1}.example.org/share-${i + 1}.png` : undefined,
  text:
    `Electric bike subscriptions in city ${i + 1} grew ${20 + i}% in 2025, according to the transport office. ` +
    `The average monthly fee in city ${i + 1} was ${30 + i} euros, and repairs were the largest cost for providers.`,
}));

export function fakeExa(opts = {}) {
  const calls = { search: [], contents: [] };
  return {
    calls,
    async search(req) {
      calls.search.push(req);
      if (opts.failSearch) throw new Error("Exa /search answered 500");
      const n = calls.search.length;
      return FAKE_PAGES.slice(n % 3, (n % 3) + 5).map((p, i) => ({
        url: p.url,
        title: p.title,
        publishedDate: p.publishedDate,
        image: p.image,
        highlights: [p.text.split(". ")[0] + "."],
        highlightScores: [0.9 - i * 0.1],
      }));
    },
    async contents(urls, _deadline, opts = {}) {
      calls.contents.push(opts.highlightsQuery ? { urls, highlightsQuery: opts.highlightsQuery } : urls);
      if (opts.highlightsQuery) {
        return urls.map((url) => ({ url: url.replace(/\.htm$/, ""), highlights: [`Revenue for the quarter was $46.7 billion, up 56% from a year ago, in the filing ${url.split("/").at(-1)}.`] }));
      }
      return urls.map((url) => {
        const p = FAKE_PAGES.find((x) => x.url === url);
        return { url, text: p?.text ?? "", extras: { richImageLinks: [{ url: `${url}/figure.png`, alt: "Chart of subscriptions" }] } };
      });
    },
  };
}

/**
 * A source search client that answers from the saved replies. `opts.fail` lists the calls that
 * throw (`news`, `scholar`, `prices`, `filings`), and `opts.hang` the calls that never answer.
 */
export function fakeSourceSearch(opts = {}) {
  const calls = { news: [], scholar: [], prices: [], filings: [] };
  const name = sourceFixture("company-name").name;
  const answer = (kind, arg, value) => {
    calls[kind].push(arg);
    if (opts.hang?.includes(kind)) return new Promise(() => {});
    if (opts.fail?.includes(kind)) return Promise.reject(new Error(opts.failReason ?? `router call ${kind}: the provider answered 500`));
    return Promise.resolve(value());
  };
  return {
    calls,
    news: (query) => answer("news", query, () => fixtureNews()),
    scholar: (query) => answer("scholar", query, () => fixturePapers()),
    prices: (symbol) => answer("prices", symbol, () => stockPrices(sourceFixture("prices"), symbol, name)),
    filings: (ticker) => answer("filings", ticker, () => (opts.noFilings ? { companyName: "", filings: [] } : fixtureFilings(name))),
  };
}

function reply(content) {
  return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(content) } }] }) };
}

/**
 * A fake OpenRouter: answers plan, group, themes, extract, the theme writer, and the summary by the
 * request title and prompt (change research-report-topics).
 */
export function fakeModel(opts = {}) {
  const requests = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    const title = init.headers["X-Title"] ?? "";
    const system = body.messages[0].content;
    const user = body.messages[1].content;
    requests.push({ title, body });
    // The learning calls of the content goals client (change content-router).
    const learned = title.includes("(learn)") ? learnAnswer(system, user) : null;
    if (learned) return reply(learned);
    if (title.includes("(plan)")) {
      if (opts.failPlan) return { ok: false, status: 500, json: async () => ({}) };
      return reply({
        brief: "What the market for electric bike subscriptions looks like.",
        sub_questions: [1, 2, 3, 4].map((i) => ({
          question: `Question ${i}?`,
          kind: i % 2 === 0 ? "news" : "background",
          recent_query: `ebike subscriptions news ${i}`,
          evergreen_query: `ebike subscriptions report ${i}`,
          scholar_query: opts.scholar && i <= 3 ? `ebike subscription study ${i}` : "",
        })),
        company: opts.company ?? null,
        ...(opts.about ? { about: opts.about, not_about: opts.notAbout ?? [] } : {}),
        ...(opts.extraGoals ? { extra_goals: opts.extraGoals } : {}),
      });
    }
    if (title.includes("(group)")) {
      if (opts.failGroup) return { ok: false, status: 500, json: async () => ({}) };
      // Two stories: the first half of the items and the rest. Items with a text of `opts.offTopic` are left out.
      const keys = [...user.matchAll(/^\[(n\d+)\](.*)$/gm)].filter((m) => !(opts.offTopic ?? []).some((t) => m[2].includes(t))).map((m) => m[1]);
      const half = Math.ceil(keys.length / 2);
      return reply({
        stories: [
          { title: "Subscriptions grow in cities", summary: "Cities report growth.", items: keys.slice(0, half) },
          { title: "Repairs drive the costs", summary: "Repairs are the largest cost.", items: keys.slice(half) },
        ].filter((s) => s.items.length),
      });
    }
    if (title.includes("(themes)")) {
      const ids = [...user.matchAll(/^\[(S\d+)\]/gm)].map((m) => m[1]);
      if (system.includes("sections of the owner")) {
        const n = (user.match(/^\d+\. /gm) ?? []).length;
        return reply({ sections: Array.from({ length: n }, (_, i) => ({ section: i + 1, stories: ids.filter((_, j) => j % n === i) })) });
      }
      return reply({
        themes: [
          { label: "Subscriptions grow in cities", stories: ids.slice(0, 1) },
          { label: "Repairs drive the costs", stories: ids.slice(1) },
        ].filter((t) => t.stories.length),
      });
    }
    if (title.includes("(extract)")) {
      const ids = [...user.matchAll(/^\[(p\d+)\] Article (\d+)/gm)];
      return reply({
        facts: ids.flatMap(([, pageId, n]) => {
          const p = FAKE_PAGES[Number(n) - 1];
          const [first, second] = p.text.split(/(?<=\.) /);
          return [
            { claim: `Subscriptions grew in city ${n}.`, quote: first.replace(/\.$/, ""), page_id: pageId },
            { claim: `Fees in city ${n}.`, quote: second, page_id: pageId },
            { claim: "Invented.", quote: "This sentence is not on any page at all, not even close", page_id: pageId },
          ];
        }),
      });
    }
    if (system.startsWith("You write one theme")) {
      if (opts.failWrite) return { ok: false, status: 500, json: async () => ({}) };
      const facts = [...user.matchAll(/^(F\d+) \([^)]*\): .*?\| quote: "(.*)"$/gm)].map((m) => ({ id: m[1], quote: m[2] }));
      const growth = facts.find((f) => /grew (\d+)%/.test(f.quote)) ?? facts[0];
      const pct = growth?.quote.match(/grew (\d+)%/)?.[1];
      const theme = user.match(/^Theme \([^)]*\): (.*)$/m)?.[1] ?? "Theme";
      return reply({
        headline: theme.replace(/\?$/, ""),
        body: `${pct ? `Subscriptions grew ${pct}% in one city [${growth.id}].` : `Cities report changes [${growth?.id}].`} Some say growth reached 99% everywhere [${growth?.id}].\n\nThis cites a fact that does not exist [F999].`,
      });
    }
    // The summary of the themes.
    if (opts.failSummary) return { ok: false, status: 500, json: async () => ({}) };
    const cite = user.match(/\[(F\d+)\]/)?.[1];
    return reply({
      summary: `Subscriptions are growing, and repairs are the largest cost [${cite}]. Growth reached 99% everywhere [${cite}].`,
      chat: "Subscriptions are growing in many cities. Repairs are the largest cost. Fees are around 30 euros.",
      title: "Electric bike subscriptions",
      title_emphasis: "subscriptions",
      deck: "Subscriptions are growing, and repairs are the main cost.",
      one_sentence: "Growth is real, but repairs eat the margin.",
      follow_ups: ["compare two providers", "check fees in my city"],
    });
  };
  return { fetchImpl, requests };
}

/** A 400 pixel wide PNG header (enough for the width check). */
export function fakePng(width = 400) {
  const b = new Uint8Array(64);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  b[16] = (width >>> 24) & 255;
  b[17] = (width >>> 16) & 255;
  b[18] = (width >>> 8) & 255;
  b[19] = width & 255;
  return b;
}

export function fakePictureFetch() {
  return async (url) => {
    // The share pictures of sites 1 and 5, and the figures inside the pages read in full (but site 3, whose share picture is too small).
    if (/share-[15]\.png/.test(url) || (/\/figure\.png$/.test(url) && !url.includes("site3."))) return { ok: true, headers: new Map([["content-length", "64"]]), arrayBuffer: async () => fakePng(400).buffer };
    if (/share-3\.png/.test(url)) return { ok: true, headers: new Map([["content-length", "64"]]), arrayBuffer: async () => fakePng(120).buffer };
    return { ok: false, headers: new Map(), arrayBuffer: async () => new ArrayBuffer(0) };
  };
}

export const FAKE_SOCIAL = {
  posts: [
    { id: "s1", title: "My ebike subscription is worth it", summary: "", url: "https://reddit.com/r/ebikes/1", source: "reddit", sourceLabel: "Reddit", publishedAt: "2026-10-12", engagement: { score: 812 }, relevance: 0.8 },
  ],
  sources: [{ name: "reddit", label: "Reddit", state: "returned items", engineStatus: "ok" }],
};

/** All fakes for `makeResearchReport`. */
export function fakeDeps(roots, overrides = {}) {
  const model = fakeModel(overrides.model);
  const exa = fakeExa(overrides.exa);
  return {
    model,
    exa,
    deps: {
      roots,
      now: () => new Date("2026-11-02T15:00:00.000Z"),
      day: "2026-11-02",
      identity: { companionName: "Mina", ownerDisplayName: "Maya Ross" },
      exa,
      sourceSearch: overrides.sourceSearch ?? null,
      llm: { fetchImpl: model.fetchImpl, apiKey: "sk-test", model: "test/model" },
      social: async () => FAKE_SOCIAL,
      pictureFetch: fakePictureFetch(),
      writePdf: async (_html, pdfPath) => fs.writeFileSync(pdfPath, "%PDF-1.7 fake"),
      ...overrides.deps,
    },
  };
}
