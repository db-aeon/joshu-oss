/**
 * Unit tests of recurring reports (change recurring-research-reports, tasks 2.1 to 2.4): the store,
 * the schedule, the lane plans and Auto picks, and the service with a fake Hermes cron bridge.
 * Also the source ids and hints of change content-router (tasks 3.3 and 3.4): a saved recurring
 * report with the old source ids runs with a fake content router. No network.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listReports, findReports } from "../src/research/store.ts";
import { RecurringStore, recurringDir } from "../src/research/recurring/store.ts";
import { buildSchedule, checkSchedule, describeSchedule } from "../src/research/recurring/schedule.ts";
import { laneSources, planLanes } from "../src/research/recurring/plan.ts";
import { parseSources, RecurringService } from "../src/research/recurring/service.ts";
import { collectRun } from "../src/research/recurring/collect.ts";
import { withWebAndNews } from "../src/research/recurring/plan.ts";
import { researchSourceLabel } from "../src/research/recurring/types.ts";
import { fakeRouter, POLY_ENDPOINT, tempHermesHome } from "./lib/content-router-fakes.mjs";

function tmpRoots() {
  const desktopRoot = fs.mkdtempSync(path.join(os.tmpdir(), "research-recurring-"));
  const filesRoot = path.join(desktopRoot, "joshu's files");
  fs.mkdirSync(filesRoot, { recursive: true });
  return { desktopRoot, filesRoot };
}

/** A fake OpenRouter for the lane plan: picks every allowed source, records each request. */
export function planModel(requests, opts = {}) {
  return async (_url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    const user = body.messages[1].content;
    const pick = /Pick sources: yes/.test(user);
    const allowed = [...user.match(/Sources you can use: (.*)/)[1].matchAll(/(\w+) \(/g)].map((m) => m[1]);
    const topics = [...user.matchAll(/^\d+\. (.*?)(?: \(hints|$)/gm)].map((m) => m[1]);
    if (opts.fail) return { ok: false, status: 500, json: async () => ({}) };
    const lanes = topics.map((topic) => ({
      topic,
      // The fake also asks for a source that the box cannot use, which the box must drop.
      picks: pick ? [...allowed.filter((s) => s !== "web"), "instagram", "tiktok"] : ["web"],
      reason: pick ? `People talk about ${topic} on these sources.` : "",
      web_queries: [`${topic} news`, `${topic} analysis`],
      news_query: topic,
      social_query: topic,
      scholar_query: "",
      company: null,
      about: `${topic}, the subject.`,
      not_about: [`${topic} the band`, ""],
      ...(opts.extraGoals && /Source hints:/.test(user) ? { extra_goals: opts.extraGoals } : {}),
      ...(opts.terms ? { named_terms: opts.terms.named, expanded_terms: opts.terms.expanded } : {}),
    }));
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify({ lanes }) } }] }) };
  };
}

function fakeCron() {
  const calls = [];
  let n = 0;
  const cron = async (payload) => {
    calls.push(payload);
    if (payload.action === "create") {
      n += 1;
      return { success: true, job_id: `job${n}`, job: { next_run_at: "2026-11-02T07:00:00-08:00" } };
    }
    return { success: true, job: { next_run_at: "2026-11-03T07:00:00-08:00" } };
  };
  return { calls, cron };
}

function service(roots, opts = {}) {
  const cron = opts.cron ?? fakeCron();
  const requests = [];
  const scriptsDir = path.join(roots.desktopRoot, "hermes-scripts");
  const svc = new RecurringService({
    projectRoot: "/unused",
    store: new RecurringStore(roots),
    scriptsDir,
    cron: cron.cron,
    now: () => new Date("2026-10-30T17:00:00.000Z"),
    available: () => opts.available ?? ["web", "reddit", "x", "youtube"],
    llm: { fetchImpl: planModel(requests, opts.model), apiKey: "k", model: "m" },
  });
  return { svc, cron, requests, scriptsDir };
}

function testSchedule() {
  assert.deepEqual(buildSchedule(["mon", "tue", "wed", "thu", "fri"], "7:00"), { ok: true, schedule: "0 7 * * 1-5" }, "every weekday at 7");
  assert.deepEqual(buildSchedule(["Monday"], "07:00"), { ok: true, schedule: "0 7 * * 1" }, "Mondays only");
  assert.deepEqual(buildSchedule([], ["7am", "5pm"]), { ok: true, schedule: "0 7,17 * * *" }, "every day at 7 and 17");
  assert.equal(buildSchedule(["mon"], ["7:00", "17:30"]).ok, false, "times with different minutes");
  assert.equal(buildSchedule(["someday"], "7:00").ok, false);
  assert.equal(checkSchedule("0-30 7 * * *").ok, false, "a minute range is refused");
  assert.equal(checkSchedule("*/5 * * * *").ok, false);
  assert.equal(checkSchedule("0 7 * * 1-5").ok, true);
  assert.equal(describeSchedule("0 7 * * 1-5"), "7:00 am, Monday to Friday");
  assert.equal(describeSchedule("30 7,17 * * *"), "7:30 am and 5:30 pm, every day");
  assert.equal(describeSchedule("0 8 * * 1"), "8:00 am, Mondays");
  console.log("ok schedule: days and times to cron, fixed minute, words");
}

async function testPlan() {
  const requests = [];
  const llm = { fetchImpl: planModel(requests), apiKey: "k", model: "m" };
  const now = new Date("2026-10-30T17:00:00.000Z");
  const [plan] = await planLanes([{ topic: "humanoid robots" }], { available: ["web", "reddit", "x"], pickSources: true, deadline: Date.now() + 5000, now, llm });
  assert.deepEqual(plan.picks, ["web", "reddit", "x"], "a source without a key or relay is never picked");
  const [noCompany] = await planLanes([{ topic: "defense demand" }], { available: ["web", "papers", "company", "reddit"], pickSources: true, deadline: Date.now() + 5000, now, llm });
  assert.deepEqual(noCompany.picks, ["web", "reddit"], "no Company data without a company, no Research papers without a Scholar query");
  assert.ok(plan.reason);
  assert.equal(requests[0].provider.data_collection, "deny", "no-training routing");
  const [fallback] = await planLanes([{ topic: "humanoid robots" }], { available: ["reddit", "youtube"], pickSources: true, deadline: Date.now() + 5000, now, llm: { ...llm, fetchImpl: planModel([], { fail: true }) } });
  assert.equal(fallback.picks[0], "web", "Web and news is always in");
  assert.ok(!fallback.picks.includes("x"));
  assert.deepEqual(laneSources({ plan }, ["reddit"]), ["web", "reddit"], "a list without Web and news gets it");
  assert.deepEqual(parseSources(["Reddit", "news"]), ["web", "reddit"]);
  assert.deepEqual(parseSources("auto"), "auto");
  assert.equal(parseSources(["myspace"]), null);
  // What the topic means and is not, and the notes of the owner (D14).
  assert.equal(plan.about, "humanoid robots, the subject.");
  assert.deepEqual(plan.notAbout, ["humanoid robots the band"]);
  requests.length = 0;
  await planLanes([{ topic: "clara" }], { available: ["web"], pickSources: false, deadline: Date.now() + 5000, now, llm, notes: "CLARA Analytics, not Hippo" });
  assert.match(requests[0].messages[1].content, /Notes of the owner: CLARA Analytics, not Hippo/);
  // The search terms (change research-keyword-expansion).
  assert.match(requests[0].messages[0].content, /named_terms: each company, product, person, or concept that the owner names/);
  assert.match(requests[0].messages[0].content, /expanded_terms: the search terms that the owner most likely wants/);
  assert.equal(fallback.namedTerms, undefined, "the fallback plan has no search terms, so the next run fills them in");
  const named = ["CLARA Analytics", " clara  analytics ", "", ...Array.from({ length: 6 }, (_, i) => `Named ${i}`)];
  const expanded = ["EvolutionIQ", "CLARA ANALYTICS", "claims AI funding", ...Array.from({ length: 12 }, (_, i) => `Expanded ${i}`)];
  const [clara] = await planLanes([{ topic: "CLARA Analytics" }], {
    available: ["web"],
    pickSources: false,
    deadline: Date.now() + 5000,
    now,
    llm: { ...llm, fetchImpl: planModel([], { terms: { named, expanded } }) },
    notes: "this company, competitors, and any movement in the overall space",
  });
  assert.deepEqual(clara.namedTerms, ["CLARA Analytics", "Named 0", "Named 1", "Named 2", "Named 3", "Named 4"], "at most 6 named terms, without empty or repeated ones");
  assert.equal(clara.expandedTerms.length, 10, "at most 10 expanded terms");
  assert.deepEqual(clara.expandedTerms.slice(0, 3), ["EvolutionIQ", "claims AI funding", "Expanded 0"], "an expanded term that repeats a named term is dropped");
  console.log("ok lane plan: picks from available sources, Web and news always in, what the topic means, search terms");
}

async function testServiceAndStore() {
  const roots = tmpRoots();
  try {
    const { svc, cron, requests, scriptsDir } = service(roots);
    const made = await svc.save({ topics: ["humanoid robots", "defense robotics contracts"], days: ["mon", "tue", "wed", "thu", "fri"], times: "07:00", channel: "sms", notes: "at most 8 items" });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const report = made.body.report;
    assert.equal(report.lanes.length, 2);
    assert.deepEqual(report.lanes[0].sources, ["Web and news", "Reddit", "X", "YouTube"]);
    assert.ok(report.lanes[0].reason, "the reason of the Auto picks");
    assert.equal(report.scheduleText, "7:00 am, Monday to Friday");
    assert.equal(report.nextRunAt, "2026-11-02T07:00:00-08:00", "the time of the next report update");
    assert.equal(requests.length, 1, "one plan call for both lanes");

    // Files of the folder (task 2.1).
    const folder = path.join(recurringDir(roots), "humanoid-robots-and-defense-robotics-contracts");
    for (const f of ["setup.json", "stories.json", "README.md", "updates", "migration"]) assert.ok(fs.existsSync(path.join(folder, f)), f);
    const setup = JSON.parse(fs.readFileSync(path.join(folder, "setup.json"), "utf8"));
    assert.equal(setup.cronJobId, "job1");
    assert.match(fs.readFileSync(path.join(folder, "README.md"), "utf8"), /7:00 am, Monday to Friday/);
    const create = cron.calls.find((c) => c.action === "create");
    assert.equal(create.no_agent, true);
    assert.equal(create.schedule, "0 7 * * 1-5");
    assert.equal(create.script, `research-recurring-${setup.id}.sh`);
    assert.match(fs.readFileSync(path.join(scriptsDir, create.script), "utf8"), new RegExp(`/api/research/recurring/${setup.id}/run`));

    // The scan of one-time Research reports ignores the folder Recurring.
    assert.deepEqual(listReports(roots), []);
    assert.deepEqual(findReports(roots, "humanoid"), []);

    // A second run uses the saved plan: a change with no new topic makes no plan call.
    const planBefore = JSON.stringify(setup.lanes.map((l) => l.plan));
    const changed = await svc.save({ id: setup.id, days: ["monday"] });
    assert.equal(changed.status, 200);
    assert.equal(changed.body.report.schedule, "0 7 * * 1", "Mondays only, at the same time");
    assert.equal(requests.length, 1, "no new plan call");
    assert.equal(cron.calls.at(-1).action, "update");
    assert.equal(cron.calls.at(-1).schedule, "0 7 * * 1");
    const afterChange = svc.store.get(setup.id);
    assert.equal(JSON.stringify(afterChange.lanes.map((l) => l.plan)), planBefore);

    // A new lane gets a plan, and the other lanes keep theirs.
    const added = await svc.save({ id: setup.id, topics: ["humanoid robots", "defense robotics contracts", "rare earth supply"] });
    assert.equal(added.status, 200);
    assert.equal(requests.length, 2);
    assert.match(requests[1].messages[1].content, /1\. rare earth supply/);
    assert.doesNotMatch(requests[1].messages[1].content, /humanoid/);
    const three = svc.store.get(setup.id);
    assert.equal(three.lanes[2].id, "l3");
    assert.equal(JSON.stringify(three.lanes.slice(0, 2).map((l) => l.plan)), planBefore);

    // Fixed sources: "only news and Reddit".
    const only = await svc.save({ id: setup.id, sources: ["news", "reddit"] });
    assert.deepEqual(only.body.report.lanes[0].sources, ["Web and news", "Reddit"]);
    assert.equal(only.body.report.lanes[0].reason, undefined);

    // Pause, resume, delete.
    const paused = await svc.setState(setup.id, "pause");
    assert.equal(paused.body.report.state, "paused");
    assert.deepEqual(cron.calls.at(-1), { action: "pause", job_id: "job1" });
    assert.equal(svc.store.get(setup.id).state, "paused");
    await svc.setState(setup.id, "resume");
    assert.equal(cron.calls.at(-1).action, "resume");
    fs.writeFileSync(path.join(folder, "updates", "keep.txt"), "x");
    const deleted = await svc.setState(setup.id, "delete");
    assert.equal(deleted.status, 200);
    assert.deepEqual(cron.calls.at(-1), { action: "remove", job_id: "job1" });
    assert.ok(!fs.existsSync(path.join(scriptsDir, create.script)), "the script is gone");
    assert.ok(fs.existsSync(path.join(folder, "updates", "keep.txt")), "the folder and its report updates stay");
    assert.equal(svc.store.get(setup.id).state, "deleted");
    assert.deepEqual(svc.list(), [], "a deleted recurring report is not listed");
    assert.equal((await svc.save({ id: setup.id, days: ["mon"] })).status, 404);

    // Errors.
    assert.equal((await svc.save({ topics: [], times: "7:00", channel: "sms" })).status, 400);
    assert.equal((await svc.save({ topics: ["a"], times: "7:00", channel: "fax" })).status, 400);
    const noChannel = await svc.save({ topics: ["b"], times: "7:00" });
    assert.equal(noChannel.body.report.channel, "email", "email is the default channel");
    assert.equal((await svc.save({ topics: ["a"], schedule: "0-30 7 * * *", channel: "sms" })).status, 400);
    console.log("ok service and store: files, cron job, saved plans, lanes, sources, pause, delete");
  } finally {
    fs.rmSync(roots.desktopRoot, { recursive: true, force: true });
  }
}

async function testCronFailure() {
  const roots = tmpRoots();
  try {
    const failing = { calls: [], cron: async () => ({ success: false, error: "bridge down" }) };
    const { svc, scriptsDir } = service(roots, { cron: failing });
    const out = await svc.save({ topics: ["a"], times: "7:00", channel: "email" });
    assert.equal(out.status, 502);
    assert.deepEqual(svc.list(), [], "no active recurring report without a Hermes cron job");
    assert.deepEqual(fs.existsSync(scriptsDir) ? fs.readdirSync(scriptsDir) : [], []);
    console.log("ok a failed Hermes cron job leaves no active recurring report");
  } finally {
    fs.rmSync(roots.desktopRoot, { recursive: true, force: true });
  }
}

/**
 * A recurring report saved before change content-router, with the old source ids, runs its collect
 * step with a fake content router (task 3.3). The old ids map to content goals at read time.
 */
async function testOldIds() {
  const roots = tmpRoots();
  const home = tempHermesHome();
  try {
    const at = "2026-10-01T00:00:00.000Z";
    const store = new RecurringStore(roots);
    store.create({
      schemaVersion: 1, id: "rr_0000dddd", slug: "robots", name: "Robots",
      lanes: [{ id: "l1", topic: "humanoid robots", addedAt: at, plan: { picks: ["web", "reddit", "x"], reason: "", webQueries: ["humanoid robots news"], newsQuery: "humanoid robots", socialQuery: "humanoid robots", scholarQuery: "", madeAt: at } }],
      sources: ["web", "reddit", "x", "youtube"], schedule: "0 7 * * 1-5", channel: "sms", notes: "", state: "active",
      scriptName: "research-recurring-rr_0000dddd.sh", createdAt: at, updatedAt: at, nothingNewInARow: 0,
    });
    const saved = store.get("rr_0000dddd");
    const sources = laneSources(saved.lanes[0], saved.sources);
    assert.deepEqual(sources, ["web", "reddit", "x", "youtube"]);
    assert.deepEqual(sources.map(researchSourceLabel), ["Web and news", "Reddit", "X", "YouTube"]);

    const router = fakeRouter();
    const exa = { async search() { return [{ url: "https://news.example/a", title: "Robots news", publishedDate: "2026-10-29T08:00:00.000Z", highlights: ["robots"] }]; }, async contents() { return []; } };
    const period = { from: "2026-01-01T00:00:00.000Z", fromDay: "2026-01-01", to: "2026-10-30T14:00:00.000Z", days: 300 };
    const run = await collectRun([{ lane: saved.lanes[0], sources, period }], Date.now() + 10_000, { exa, composio: null, social: { client: router.client, home } });
    assert.deepEqual(router.calls.map((c) => c.endpoint).sort(), ["anyapi.x.search.posts", "scrapecreators.reddit.search.posts", "scrapecreators.x.v1-youtube-search"]);
    assert.ok(router.calls.every((c) => c.params.query === "humanoid robots"), "the social query of the lane plan");
    for (const id of ["reddit", "x", "youtube"]) {
      assert.equal(run.sources.find((s) => s.name === id)?.state, "returned items", id);
      assert.ok(run.items.some((i) => i.source === id), `${id} items`);
    }

    // A `goal:` source and the extra goals of a lane plan.
    assert.deepEqual(parseSources(["web", "goal:Prediction  market odds"]), ["web", "goal:prediction market odds"]);
    assert.deepEqual(withWebAndNews(["goal:a", "reddit", "goal:a"]), ["web", "reddit", "goal:a"]);
    const lane = { ...saved.lanes[0], plan: { ...saved.lanes[0].plan, extraGoals: [{ kind: "prediction market odds", query: "2028 primaries", prefer: "Polymarket" }] } };
    const withGoal = await collectRun([{ lane, sources: ["web"], period }], Date.now() + 10_000, {
      exa, composio: null,
      social: { client: router.client, home, llm: { fetchImpl: async (_u, init) => {
        const body = JSON.parse(init.body);
        const system = body.messages[0].content;
        const answer = system.startsWith("You pick") ? { endpoint: POLY_ENDPOINT.id, query_input: "q", fixed_inputs: {} } : { list: "events", url: "https://polymarket.com/event/{slug}", title: "title", metrics: { odds: "markets.0.outcomePrices.0" } };
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(answer) } }] }) };
      }, apiKey: "k", model: "m" } },
    });
    assert.ok(router.calls.some((c) => c.endpoint === POLY_ENDPOINT.id && c.params.q === "2028 primaries"));
    assert.equal(withGoal.sources.find((s) => s.name === "goal:prediction market odds")?.state, "returned items");
    assert.ok(withGoal.items.some((i) => i.engagement?.odds > 0));
    console.log("ok old source ids map to content goals at read time, and a lane runs with the fake content router");
  } finally {
    fs.rmSync(roots.desktopRoot, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
}

/** Hints of research_recurring_save reach the lane plan, and its extra goals are saved (task 3.4). */
async function testRecurringHints() {
  const roots = tmpRoots();
  try {
    const extraGoals = [{ goal: "prediction market odds", query: "2028 primaries", prefer: "Polymarket" }];
    const { svc, requests } = service(roots, { model: { extraGoals } });
    const made = await svc.save({ topics: ["2028 primaries"], days: ["mon"], times: "07:00", hints: ["Polymarket for prediction market odds"] });
    assert.equal(made.status, 201);
    assert.match(requests[0].messages[1].content, /Source hints:\n- Polymarket for prediction market odds/, "the hints reach the lane plan");
    const setup = svc.store.get(made.body.report.id);
    assert.deepEqual(setup.hints, ["Polymarket for prediction market odds"]);
    assert.deepEqual(setup.lanes[0].plan.extraGoals, [{ kind: "prediction market odds", query: "2028 primaries", prefer: "Polymarket" }]);
    // New hints plan the lanes again; the same hints do not.
    await svc.save({ id: setup.id, hints: ["Polymarket for prediction market odds"] });
    assert.equal(requests.length, 1);
    await svc.save({ id: setup.id, hints: [] });
    assert.equal(requests.length, 2);
    assert.equal(svc.store.get(setup.id).lanes[0].plan.extraGoals, undefined, "no hints, no extra goals");
    console.log("ok hints of research_recurring_save reach the lane plan");
  } finally {
    fs.rmSync(roots.desktopRoot, { recursive: true, force: true });
  }
}

testSchedule();
await testPlan();
await testOldIds();
await testRecurringHints();
await testServiceAndStore();
await testCronFailure();
console.log("research recurring: all tests passed");
