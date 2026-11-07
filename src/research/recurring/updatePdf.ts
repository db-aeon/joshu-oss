/**
 * The full update as a PDF, attached in email and on request (design decision D9). A report update
 * with themes (change research-report-topics, D10) has the summary, each theme with its picture,
 * paragraphs, citations, and links, and a chart of the new items of each lane over the earlier report
 * updates of the same folder. A report update from before that change has its digest and a card for
 * each new and developing story, by lane. The page uses the design, fonts, and Chromium
 * render of the Research report (`reportCss` of `template.ts`), runs no script, and loads nothing
 * from the internet.
 */

import fs from "node:fs";
import path from "node:path";
import { itemsByDaySvg, type DayCount } from "../charts.js";
import { counterLabel, preferredCounter } from "../engagement.js";
import { ResearchStepError } from "../errors.js";
import { embeddedFontCss } from "../fonts.js";
import { formatJoshuSignatureRoleLine } from "@joshu/email-signature";
import { escapeHtml } from "../html.js";
import { renderPdf } from "../pdf.js";
import { isUpdateId } from "../reportLinks.js";
import { researchDir, type ReportRoots } from "../store.js";
import type { Picture } from "../pipeline/pictures.js";
import type { ReportSection } from "../pipeline/write.js";
import { reportIdentity, type ReportIdentity } from "../identity.js";
import { longDay, paragraphs, portraitHtml, reportCss, sourceListHtml, sourceRow, THEME_LINKS_CSS, themeLinksHtml, type Cites } from "../template.js";
import { readUpdates } from "./store.js";
import type { StoryItem, UpdateFile, UpdateStory } from "./types.js";

/** The folder of a report update identifier, or null when the identifier is not valid. */
export function updateFolder(roots: ReportRoots, id: string): string | null {
  if (!isUpdateId(id)) return null;
  const dir = path.resolve(researchDir(roots));
  const folder = path.resolve(dir, id);
  return folder.startsWith(`${dir}${path.sep}`) ? folder : null;
}

/** The number of new items of each lane in each report update, the oldest first. Exported for the tests. */
export function laneHistory(updates: UpdateFile[]): { laneId: string; topic: string; days: DayCount[] }[] {
  const ordered = [...updates].sort((a, b) => a.run.localeCompare(b.run));
  const lanes = new Map<string, string>();
  for (const u of ordered) for (const l of u.lanes) lanes.set(l.id, l.topic);
  return [...lanes.entries()].map(([laneId, topic]) => {
    // One bar for each day; two runs on one day add up.
    const perDay = new Map<string, number>();
    for (const u of ordered) {
      const day = u.run.slice(0, 10);
      const count = u.stories.filter((s) => s.laneId === laneId && s.status !== "quiet").reduce((n, s) => n + s.newItems.length, 0);
      perDay.set(day, (perDay.get(day) ?? 0) + count);
    }
    return { laneId, topic, days: [...perDay.entries()].map(([day, count]) => ({ day, count })) };
  });
}

/** "October 29" from a run identifier, which is already in the owner timezone. */
export function runDay(run: string): string {
  return new Date(`${run.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", month: "long", day: "numeric" });
}

/** A lane topic as a heading: the owner often types it in lower case ("humanoid robots"). */
function heading(topic: string): string {
  return topic.charAt(0).toUpperCase() + topic.slice(1);
}

export type UpdatePageIdentity = ReportIdentity;

/** The companion of the page, with its portrait (`reportIdentity`). */
export const updateIdentity = reportIdentity;

/** The site of a link, for example "reuters.com"; "Google News" for a Google News redirect. */
function siteOf(url: string): string {
  if (/^https?:\/\/(www\.)?google\.com\/(goto|url)\b/.test(url)) return "Google News";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** The pages and posts of the shown stories, numbered in story order, for the citations and the list at the end. */
function numberItems(stories: UpdateStory[]): { list: StoryItem[]; no: Map<string, number> } {
  const list: StoryItem[] = [];
  const no = new Map<string, number>();
  for (const story of stories) {
    for (const item of story.items) {
      if (no.has(item.url)) continue;
      list.push(item);
      no.set(item.url, list.length);
    }
  }
  return { list, no };
}

function cites(urls: string[], no: Map<string, number>): string {
  const nos = [...new Set(urls.map((u) => no.get(u)).filter((n): n is number => n !== undefined))];
  return nos.length ? `<span class="cite">${nos.map((n, i) => `<a href="#p${n}">${n}</a>${i < nos.length - 1 ? "," : ""}`).join("")}</span>` : "";
}

const LINK = /https?:\/\/[^\s<>()"']+[^\s<>()"'.,;:!?]/g;
/** The links after one sentence, with the spaces before them. */
const LINK_RUN = new RegExp(`(?:\\s*${LINK.source})+`, "g");

/**
 * The digest of the email as the summary: topic lines become headings, and the links after each
 * sentence become the citations of that sentence.
 */
export function digestHtml(text: string, topics: string[], no: Map<string, number>): string {
  const wanted = new Set(topics.map((t) => t.trim().toLowerCase()));
  return text
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      if (wanted.has(block.replace(/:$/, "").toLowerCase())) return `<h4 class="lane-label">${escapeHtml(heading(block.replace(/:$/, "")))}</h4>`;
      let html = "";
      let at = 0;
      for (const run of block.matchAll(LINK_RUN)) {
        const urls = [...run[0].matchAll(LINK)].map((m) => m[0]);
        const other = urls.filter((u) => !no.has(u)).map((u) => ` <a href="${escapeHtml(u)}">${escapeHtml(siteOf(u))}</a>`).join("");
        html += `${escapeHtml(block.slice(at, run.index))}${cites(urls.filter((u) => no.has(u)), no)}${other}`;
        at = run.index + run[0].length;
      }
      return `<p>${html}${escapeHtml(block.slice(at))}</p>`;
    })
    .join("");
}

function storyCard(story: UpdateStory, index: number, no: Map<string, number>): string {
  const fresh = new Set(story.newItems);
  const items = [...story.items].sort((a, b) => Number(fresh.has(b.url)) - Number(fresh.has(a.url)));
  // One chip for each site, like the evidence chips of a key finding; a post keeps its own chip for its counter.
  const seen = new Set<string>();
  const chips = items
    .map((i) => {
      const counter = counterLabel(preferredCounter(i.source, i.engagement));
      const label = i.source === "web" || i.source === "news" ? siteOf(i.url) : i.sourceLabel;
      const key = counter ? i.url : label;
      if (seen.has(key)) return "";
      seen.add(key);
      return `<a class="chip" href="${escapeHtml(i.url)}">${escapeHtml(label)}${counter ? ` · <b>${escapeHtml(counter)}</b>` : ""}</a>`;
    })
    .filter(Boolean)
    .slice(0, 4)
    .join("");
  const status = story.status === "developing" ? "Developing" : "New";
  return `<article class="finding wide"><div class="shell"><div class="core"><div class="story-top"><div class="num">${String(index + 1).padStart(2, "0")}</div><span class="eyebrow">${
    story.status === "new" ? `<span class="dot"></span>` : ""
  }${status}</span></div><h3>${escapeHtml(story.title)}</h3>${story.summary ? `<p>${escapeHtml(story.summary)}${cites(story.items.map((i) => i.url), no)}</p>` : ""}<div class="evidence">${chips}</div></div></div></article>`;
}

function itemRow(item: StoryItem, n: number): string {
  const counter = counterLabel(preferredCounter(item.source, item.engagement));
  const site = item.source === "web" || item.source === "news" ? siteOf(item.url) : item.sourceLabel;
  const meta = [site, item.publishedAt ? longDay(item.publishedAt.slice(0, 10)) : "", counter].filter(Boolean).join(" · ");
  return `<a class="src-row" id="p${n}" href="${escapeHtml(item.url)}"><div class="no">${n}</div><div class="t">${escapeHtml(item.title || item.url)}<span>${escapeHtml(meta)}</span></div><div></div></a>`;
}

/** The parts of a report update page that the report design does not have. */
const UPDATE_CSS = `
.story-top{display:flex;align-items:center;justify-content:space-between;gap:12px}
.chip{text-decoration:none}
.summary .body .lane-label{font-family:var(--sans);font-size:11px;font-weight:500;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-3);margin:1.6em 0 .6em}
.summary .body .lane-label:first-child{margin-top:0}
.none{font-family:var(--serif);font-size:19px;color:var(--ink-2)}
@media print{.lane{break-before:page}.summary .body p:first-child::first-letter{font-size:inherit;float:none;padding:0}}`;

/** "New" or "Developing" for a theme: developing when one of its stories is. */
function themeStatus(theme: ReportSection, update: UpdateFile): string {
  const ids = new Set(theme.storyIds ?? []);
  return update.stories.some((s) => ids.has(s.id) && s.status === "developing") ? "Developing" : "New";
}

/** The page of a report update with themes (version 2 of `update.json`). */
function renderThemesUpdateHtml(
  update: UpdateFile,
  history: UpdateFile[],
  dateText: string,
  fontCss: string,
  timezone: string,
  identity: UpdatePageIdentity,
  pictures: Map<number, Picture>,
): string {
  const since = new Date(update.period.from).toLocaleDateString("en-US", { timeZone: timezone, month: "long", day: "numeric" });
  const themes = update.themes ?? [];
  const c: Cites = { facts: new Map((update.facts ?? []).map((f) => [f.id, f])), pages: new Map((update.pages ?? []).map((p) => [p.id, p])) };
  const links = new Set(themes.flatMap((t) => (t.links ?? []).map((l) => l.url)));
  const sites = new Set([...(update.pages ?? []).map((p) => p.site), ...themes.flatMap((t) => (t.links ?? []).map((l) => l.site))]);
  const owner = identity.ownerDisplayName?.trim();
  const footer = `${update.name} · Report update`;
  const starting = update.lanes.every((l) => l.starting);
  const contents: [string, string][] = [
    ["summary", "Summary"],
    ...themes.map((t, i) => [`theme-${i + 1}`, t.title] as [string, string]),
    ["about", "About this update"],
  ];
  const out: string[] = [];
  out.push(`<header class="cover"><div class="cover-grid"><div>
<span class="eyebrow"><span class="dot"></span>Report update</span>
<h1>${escapeHtml(update.name)}<br><em>${escapeHtml(dateText)}</em></h1>
<p class="deck">${themes.length} ${themes.length === 1 ? "theme" : "themes"} ${starting ? "from the last week" : `since ${escapeHtml(since)}`}.</p>
</div><dl class="meta">
<div><dt>Date</dt><dd>${escapeHtml(dateText)}</dd></div>
<div><dt>Period</dt><dd>Since ${escapeHtml(since)}</dd></div>
<div><dt>Evidence</dt><dd>${new Set([...links, ...(update.pages ?? []).map((p) => p.url)]).size} pages and posts on ${sites.size} sites</dd></div>
<div><dt>Prepared by</dt><dd>${escapeHtml(identity.companionName)}${owner ? `, for ${escapeHtml(owner)}` : ""}</dd></div>
</dl></div>
<nav class="contents" aria-label="Contents">${contents.slice(0, 8).map(([id, name], i) => `<a href="#${id}">${String(i + 1).padStart(2, "0")}<b>${escapeHtml(name)}</b></a>`).join("")}</nav></header>`);
  out.push(`<section id="summary"><div class="summary"><div class="aside-note"><strong>${starting ? "Starting update" : "Since the last update"}</strong>${escapeHtml(
    update.chat ?? "",
  )}</div><div class="body">${paragraphs(update.summary ?? "", c)}</div></div></section>`);
  out.push(
    `<section id="themes"><div class="sec-head"><div class="label">02 · Themes</div><h2>What is new</h2></div>${themes
      .map((theme, i) => {
        const pic = pictures.get(theme.index);
        const picHtml = pic
          ? `<figure class="pic"><img src="${pic.dataUri}" alt="${escapeHtml(pic.alt)}"><figcaption>Picture: <a href="${escapeHtml(pic.pageUrl)}">${escapeHtml(pic.site)}</a></figcaption></figure>`
          : "";
        return `<article class="theme" id="theme-${i + 1}"><aside class="theme-side"></aside><div><span class="theme-kind">${themeStatus(theme, update)}</span><h3>${escapeHtml(theme.title)}</h3>${picHtml}<div class="prose">${paragraphs(
          theme.body,
          c,
        )}</div>${themeLinksHtml(theme.links)}</div></article>`;
      })
      .join("")}</section>`,
  );
  const charts = laneHistory(history).filter((h) => h.days.length > 1);
  if (charts.length) {
    out.push(
      `<section id="coverage"><div class="sec-head"><div class="label">03 · Coverage</div><h2>Coverage over time</h2></div>${charts
        .map(
          (h) =>
            `<div class="figure shell"><div class="core"><h4>${escapeHtml(heading(h.topic))}</h4>${itemsByDaySvg({ days: h.days, busyDays: [] }, `New pages and posts of ${h.topic} in each report update`)}<p class="caption">New pages and posts in each report update.</p></div></div>`,
        )
        .join("")}</section>`,
    );
  }
  const cited = [...(update.pages ?? [])].sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
  out.push(`<footer class="sig-wrap" id="about"><div class="sig shell"><div class="core">${portraitHtml(identity.companionName, identity.portrait)}<div><div class="name">${escapeHtml(identity.companionName)}</div><div class="role">${escapeHtml(formatJoshuSignatureRoleLine(owner))}</div><div class="ask">Want more on a theme? Reply to this message and ask me to dig into it.</div></div><div class="cta">joshu.me</div></div></div>
<div class="colophon"><div><b>About this update</b>Collected and written by ${escapeHtml(identity.companionName)} from public web pages and posts. Each number links to the page or post that it comes from.</div><div><b>Date</b>${escapeHtml(dateText)}</div><div><b>Sources searched</b>${sourceListHtml(update.sources) || "none"}</div><div><b>Update</b>${escapeHtml(update.run)}</div></div>
${cited.length ? `<div class="pages srcs shell"><div class="core"><div class="posts-title">Pages and posts cited</div>${cited.map(sourceRow).join("")}</div></div>` : ""}</footer>`);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(update.name)}: ${escapeHtml(dateText)}</title>
<style>${reportCss(fontCss, footer)}${UPDATE_CSS}${THEME_LINKS_CSS}</style>
</head>
<body>
<main class="wrap">
${out.join("\n")}
</main>
</body>
</html>
`;
}

/**
 * The HTML page of a report update, in the design of the Research report (`template.ts`). A report
 * update with themes gets the page of `renderThemesUpdateHtml`. An older one gets a cover with the
 * contents, the digest as the summary, one section for each lane with its chart and a card for each
 * new and developing story, and the signature with the pages and posts at the end.
 */
export function renderUpdateHtml(
  update: UpdateFile,
  history: UpdateFile[],
  dateText: string,
  fontCss: string,
  timezone = "UTC",
  identity: UpdatePageIdentity = { companionName: "Joshu" },
  pictures: Map<number, Picture> = new Map(),
): string {
  if (update.themes?.length) return renderThemesUpdateHtml(update, history, dateText, fontCss, timezone, identity, pictures);
  // The period starts at an instant; the owner reads its day in the owner timezone, like the run identifier.
  const since = new Date(update.period.from).toLocaleDateString("en-US", { timeZone: timezone, month: "long", day: "numeric" });
  const charts = new Map(laneHistory(history).map((h) => [h.laneId, h]));
  const shown = update.stories.filter((s) => s.status !== "quiet");
  const ordered = update.lanes.flatMap((lane) => shown.filter((s) => s.laneId === lane.id));
  const { list, no } = numberItems(ordered);
  const sites = new Set(list.map((i) => (i.source === "web" || i.source === "news" ? siteOf(i.url) : i.sourceLabel)));
  const owner = identity.ownerDisplayName?.trim();
  const footer = `${update.name} · Report update`;

  const contents: [string, string][] = [
    ...(update.digest ? ([["summary", "Summary"]] as [string, string][]) : []),
    ...update.lanes.map((l) => [`lane-${l.id}`, heading(l.topic)] as [string, string]),
    ["about", "About this update"],
  ];
  const out: string[] = [];
  out.push(`<header class="cover"><div class="cover-grid"><div>
<span class="eyebrow"><span class="dot"></span>Report update</span>
<h1>${escapeHtml(update.name)}<br><em>${escapeHtml(dateText)}</em></h1>
<p class="deck">${shown.length} new and developing ${shown.length === 1 ? "story" : "stories"} since ${escapeHtml(since)}.</p>
</div><dl class="meta">
<div><dt>Date</dt><dd>${escapeHtml(dateText)}</dd></div>
<div><dt>Period</dt><dd>Since ${escapeHtml(since)}</dd></div>
<div><dt>Evidence</dt><dd>${list.length} pages and posts on ${sites.size} sites</dd></div>
<div><dt>Prepared by</dt><dd>${escapeHtml(identity.companionName)}${owner ? `, for ${escapeHtml(owner)}` : ""}</dd></div>
</dl></div>
<nav class="contents" aria-label="Contents">${contents.map(([id, name], i) => `<a href="#${id}">${String(i + 1).padStart(2, "0")}<b>${escapeHtml(name)}</b></a>`).join("")}</nav></header>`);

  if (update.digest) {
    out.push(`<section id="summary"><div class="summary"><div class="aside-note"><strong>What is new</strong>The update as it was sent, with a number for each page or post at the end.</div><div class="body">${digestHtml(
      update.digest.text,
      update.lanes.map((l) => l.topic),
      no,
    )}</div></div></section>`);
  }

  let n = update.digest ? 2 : 1;
  for (const lane of update.lanes) {
    const stories = shown.filter((s) => s.laneId === lane.id);
    const chart = charts.get(lane.id);
    const chartHtml =
      chart && chart.days.length > 1
        ? `<div class="figure shell"><div class="core"><h4>Coverage over time</h4>${itemsByDaySvg({ days: chart.days, busyDays: [] }, `New pages and posts of ${lane.topic} in each report update`)}<p class="caption">New pages and posts in each report update.</p></div></div>`
        : "";
    out.push(`<section class="lane" id="lane-${escapeHtml(lane.id)}"><div class="sec-head"><div class="label">${String(n++).padStart(2, "0")} · ${
      lane.starting ? "Starting update" : "Since the last update"
    }</div><h2>${escapeHtml(heading(lane.topic))}</h2></div>${chartHtml}${
      stories.length ? `<div class="findings">${stories.map((s, i) => storyCard(s, i, no)).join("")}</div>` : `<p class="none">Nothing new since ${escapeHtml(since)}.</p>`
    }</section>`);
  }

  const sourceList = sourceListHtml(update.sources);
  out.push(`<footer class="sig-wrap" id="about"><div class="sig shell"><div class="core">${portraitHtml(identity.companionName, identity.portrait)}<div><div class="name">${escapeHtml(identity.companionName)}</div><div class="role">${escapeHtml(formatJoshuSignatureRoleLine(owner))}</div><div class="ask">Want more on a story? Reply to this message and ask me to dig into it.</div></div><div class="cta">joshu.me</div></div></div>
<div class="colophon"><div><b>About this update</b>Collected and written by ${escapeHtml(identity.companionName)} from public web pages and posts. Each number links to its page or post.</div><div><b>Date</b>${escapeHtml(dateText)}</div><div><b>Sources searched</b>${sourceList || "none"}</div><div><b>Update</b>${escapeHtml(update.run)}</div></div>
${list.length ? `<div class="pages srcs shell"><div class="core"><div class="posts-title">Pages and posts</div>${list.map((item, i) => itemRow(item, i + 1)).join("")}</div></div>` : ""}</footer>`);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(update.name)}: ${escapeHtml(dateText)}</title>
<style>${reportCss(fontCss, footer)}${UPDATE_CSS}${THEME_LINKS_CSS}</style>
</head>
<body>
<main class="wrap">
${out.join("\n")}
</main>
</body>
</html>
`;
}

/**
 * Render `update.pdf` of one report update and return its path. A PDF that is already there is
 * used again. Throws `ResearchStepError` ("store" or "render").
 */
export async function renderUpdatePdf(
  roots: ReportRoots,
  id: string,
  opts: { dateText?: string; timezone?: string; identity?: UpdatePageIdentity; writePdf?: (htmlPath: string, pdfPath: string) => Promise<void> } = {},
): Promise<{ pdfPath: string; pdfDesktopPath: string; pdfFilesPath: string }> {
  const folder = updateFolder(roots, id);
  if (!folder || !fs.existsSync(path.join(folder, "update.json"))) throw new ResearchStepError("store", `unknown report update ${id}`);
  const pdfPath = path.join(folder, "update.pdf");
  if (!fs.existsSync(pdfPath)) {
    const update = JSON.parse(fs.readFileSync(path.join(folder, "update.json"), "utf8")) as UpdateFile;
    // The earlier report updates of the same folder, for the charts.
    const history = readUpdates(path.dirname(path.dirname(folder))).filter((u) => u.run <= update.run);
    const htmlPath = path.join(folder, "update.html");
    const picturesPath = path.join(folder, "pictures.json");
    const pictures = fs.existsSync(picturesPath)
      ? new Map(Object.entries(JSON.parse(fs.readFileSync(picturesPath, "utf8")) as Record<string, Picture>).map(([k, v]) => [Number(k), v]))
      : new Map<number, Picture>();
    fs.writeFileSync(htmlPath, renderUpdateHtml(update, history, opts.dateText ?? runDay(update.run), embeddedFontCss(), opts.timezone, opts.identity, pictures));
    try {
      await (opts.writePdf ?? ((h, p) => renderPdf(h, p)))(htmlPath, pdfPath);
    } finally {
      fs.rmSync(htmlPath, { force: true });
    }
  }
  return {
    pdfPath,
    pdfDesktopPath: path.relative(roots.desktopRoot, pdfPath).split(path.sep).join("/"),
    pdfFilesPath: path.relative(roots.filesRoot, pdfPath).split(path.sep).join("/"),
  };
}
