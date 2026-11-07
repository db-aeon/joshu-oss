/**
 * The HTML page of a Research report, in the design of the approved 2026-10-10 mockup: a cover, the
 * summary, the background themes and the news themes (change research-report-topics, D10), each
 * with a picture from a cited page, numbered citations that link to the pages, its lead link, and
 * its other pages and posts, and a closing card with the pages read. The same page is printed to the
 * PDF. It runs no script and loads nothing from the internet: fonts and pictures are embedded.
 * Decisions D4, D13 of change research-reports.
 */

import { formatJoshuSignatureRoleLine } from "@joshu/email-signature";
import { shortDay } from "./charts.js";
import { escapeHtml } from "./html.js";
import { controlPlaneUsageDashboardUrl } from "../meteredProviders/config.js";
import { USAGE_WALLET_EMPTY } from "../contentRouter/client.js";
import { COULD_NOT_BE_READ } from "../contentRouter/goals.js";
import type { Picture } from "./pipeline/pictures.js";
import type { ReportSection, ReportText, ThemeLink } from "./pipeline/write.js";
import type { Fact, Research, SourceState, WebPage } from "./types.js";

export type ReportPageInput = {
  research: Research;
  text: ReportText;
  /** Picture for each theme section index. */
  pictures: Map<number, Picture>;
  companionName: string;
  ownerDisplayName?: string;
  /** The portrait of the companion as a data URI (`reportIdentity`); without it, the first letter of the name. */
  portrait?: string;
  /** `@font-face` rules from `embeddedFontCss()`. */
  fontCss: string;
  /** Report identifier, for the colophon. */
  reportId?: string;
};


/**
 * The "Sources searched" list at the end of a Research report and of a report update. A source
 * that the content router refused because the usage wallet is empty links to the usage billing
 * page. A social source of a self-hosted box without a router API key says that it needs one
 * (change content-router, spec `content-goals`).
 */
export function sourceListHtml(sources: readonly SourceState[]): string {
  return sources
    .map((s) => {
      if (s.state !== "could not be reached") {
        return `${escapeHtml(s.label)}${s.state === "returned no items" ? ": returned no items" : ""}`;
      }
      if (s.engineStatus === USAGE_WALLET_EMPTY) {
        return `<span class="down">${escapeHtml(s.label)}: could not be reached, the usage wallet is empty (<a href="${escapeHtml(controlPlaneUsageDashboardUrl())}">add money</a>)</span>`;
      }
      if (s.engineStatus === "no router API key") {
        return `<span class="down">${escapeHtml(s.label)}: could not be reached, the social sources need a router API key in Connectors</span>`;
      }
      if (s.engineStatus === COULD_NOT_BE_READ) {
        return `<span class="down">${escapeHtml(s.label)}: could not be read</span>`;
      }
      return `<span class="down">${escapeHtml(s.label)}: could not be reached</span>`;
    })
    .join(", ");
}

export function longDay(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/** The cover title with its emphasis word in italics. */
function titleHtml(title: string, emphasis: string): string {
  const safe = escapeHtml(title);
  const word = emphasis.replace(/[^\p{L}\p{N}-]/gu, "");
  if (!word) return safe;
  return safe.replace(new RegExp(`(^|\\s)(${word})(?=[\\s.,:;!?]|$)`, "iu"), "$1<em>$2</em>");
}

function cssString(value: string): string {
  return `"${value.replace(/["\\]/g, "\\$&").replace(/\n/g, " ")}"`;
}

export type Cites = { facts: Map<string, Fact>; pages: Map<string, Pick<WebPage, "id" | "url" | "title" | "site" | "publishedAt">> };

/** The number of a page in the list of pages read (`p7` is 7). */
function pageNo(page: Pick<WebPage, "id">): number {
  return Number(page.id.slice(1));
}

/** Escape text and turn `[F12]` citations into numbered links to the pages. */
function withCites(text: string, c: Cites): string {
  return escapeHtml(text).replace(/(?:\[F\d+\])+/g, (group) => {
    const nos = [...new Set([...group.matchAll(/F\d+/g)].map((m) => c.facts.get(m[0])?.pageId).filter((id): id is string => !!id))]
      .map((id) => c.pages.get(id)!)
      .filter(Boolean);
    return nos.length
      ? `<span class="cite">${nos.map((p) => `<a href="${escapeHtml(p.url)}">${pageNo(p)}</a>`).join(",")}</span>`
      : "";
  });
}

export function paragraphs(text: string, c: Cites): string {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${withCites(p, c)}</p>`)
    .join("");
}

/** The pages behind a list of facts, in order, each once. */
function pagesOf(factIds: string[], c: Cites): Pick<WebPage, "id" | "url" | "title" | "site" | "publishedAt">[] {
  const ids = [...new Set(factIds.map((id) => c.facts.get(id)?.pageId).filter((id): id is string => !!id))];
  return ids.map((id) => c.pages.get(id)!).filter(Boolean);
}

export function sourceRow(page: Pick<WebPage, "id" | "url" | "title" | "site" | "publishedAt">): string {
  const meta = [page.site, page.publishedAt ? longDay(page.publishedAt) : ""].filter(Boolean).join(" · ");
  return `<a class="src-row" href="${escapeHtml(page.url)}"><div class="no">${pageNo(page)}</div><div class="t">${escapeHtml(page.title)}<span>${escapeHtml(meta)}</span></div><div></div></a>`;
}

/** The portrait of the companion in the closing card: the embedded picture, or the first letter of its name. */
export function portraitHtml(companionName: string, portrait?: string): string {
  return portrait
    ? `<div class="portrait"><img src="${escapeHtml(portrait)}" alt="${escapeHtml(companionName)}"></div>`
    : `<div class="portrait" aria-hidden="true">${escapeHtml(companionName.charAt(0).toUpperCase())}</div>`;
}

/** The CSS of the links of a theme, for the Research report and the PDF of a report update. */
export const THEME_LINKS_CSS = `
.theme-links{margin-top:26px;max-width:700px;font-family:var(--sans)}
.theme-links .lead{display:block;text-decoration:none;color:var(--ink);padding:14px 16px;border-radius:14px;background:var(--card);box-shadow:0 0 0 1px var(--hair)}
.theme-links .lead b{display:block;font-family:var(--serif);font-weight:400;font-size:18px;line-height:1.3}
.theme-links .lead span{display:block;margin-top:4px;font-size:12px;color:var(--ink-3)}
.theme-links .more{margin-top:12px;display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:12px;color:var(--ink-3)}
.theme-links .more a{text-decoration:none}
.portrait{overflow:hidden}.portrait img{width:100%;height:100%;object-fit:cover;display:block}
.theme-kind{font-family:var(--pixel);font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-3);display:block;margin-bottom:10px}
@media print{.theme-links{break-inside:avoid}.theme-links .lead b{font-size:13pt}.theme-kind{break-after:avoid}.theme-kind+h3{break-before:avoid}}`;

/** The lead link of a theme, then its other pages and posts as chips. */
export function themeLinksHtml(links: readonly ThemeLink[] = []): string {
  const [lead, ...more] = links;
  if (!lead) return "";
  const meta = [lead.site, lead.publishedAt ? longDay(lead.publishedAt) : "", lead.counter ?? ""].filter(Boolean).join(" · ");
  return `<div class="theme-links"><a class="lead" href="${escapeHtml(lead.url)}"><b>${escapeHtml(lead.title)}</b><span>${escapeHtml(meta)}</span></a>${
    more.length
      ? `<div class="more">More:${more
          .map((l) => `<a class="chip" href="${escapeHtml(l.url)}">${escapeHtml(l.site)}${l.counter ? ` · <b>${escapeHtml(l.counter)}</b>` : ""}</a>`)
          .join("")}</div>`
      : ""
  }</div>`;
}

/** The small label above a theme: background, news, or the section of the owner in the owner's words. */
export function themeKind(theme: Pick<ReportSection, "kind" | "label">): string {
  return theme.kind === "background" ? "Background" : theme.kind === "news" ? "In the news" : theme.kind === "section" ? theme.label : "";
}

/**
 * The CSS of the approved report design, for the Research report and the PDF of a report update
 * (`recurring/updatePdf.ts`), so that both look the same.
 */
export function reportCss(fontCss: string, footer: string): string {
  return `${fontCss}
:root{--paper:#fbf8f3;--paper-2:#f5f0eb;--card:#fffdfa;--ink:#0d0d0d;--ink-2:#4a4540;--ink-3:#8a817a;--rose:#c8a2a6;--rose-soft:rgba(200,162,166,.35);--hair:rgba(13,13,13,.09);--peach:#f2cbae;--sky:#b7c0e0;--action:#0057ff;--serif:"Newsreader","Iowan Old Style",Georgia,serif;--sans:"Work Sans",ui-sans-serif,system-ui,sans-serif;--pixel:"Silkscreen",ui-monospace,monospace}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--paper);color:var(--ink);font-family:var(--sans);font-size:15px;line-height:1.55;-webkit-font-smoothing:antialiased;-webkit-print-color-adjust:exact;print-color-adjust:exact}
a{color:inherit;text-decoration-color:var(--rose);text-underline-offset:3px}
.wrap{max-width:1120px;margin:0 auto;padding:0 40px}
.eyebrow{display:inline-flex;align-items:center;gap:8px;font-family:var(--pixel);font-size:10px;letter-spacing:.14em;text-transform:uppercase;padding:5px 12px;border-radius:999px;background:rgba(13,13,13,.04);box-shadow:inset 0 0 0 1px var(--hair);color:var(--ink-2)}
.eyebrow .dot{width:6px;height:6px;border-radius:99px;background:var(--rose)}
.cover{padding:120px 0 96px}
.cover-grid{display:grid;grid-template-columns:1fr 300px;gap:72px;align-items:end}
h1{font-family:var(--serif);font-optical-sizing:auto;font-weight:400;font-size:clamp(56px,8.2vw,112px);line-height:.94;letter-spacing:-.035em;margin:28px 0 32px}
h1 em{font-style:italic;color:var(--ink-2)}
.deck{font-family:var(--serif);font-size:24px;line-height:1.35;color:var(--ink-2);max-width:640px;margin:0;font-weight:350}
.meta{display:grid;gap:18px;font-size:13px;margin:0}
.meta div{padding-top:14px;border-top:1px solid var(--rose-soft)}
.meta dt{color:var(--ink-3);font-size:11px;letter-spacing:.08em;text-transform:uppercase;margin-bottom:2px}
.meta dd{margin:0;font-weight:500}
.contents{margin-top:72px;display:grid;grid-template-columns:repeat(5,1fr)}
.contents a{display:block;padding:18px 20px 18px 0;margin-right:20px;text-decoration:none;border-top:1px solid var(--ink);font-size:13px;color:var(--ink-2)}
.contents b{display:block;font-family:var(--serif);font-weight:400;font-size:20px;color:var(--ink);margin-top:4px}
section{padding:96px 0}
.sec-head{display:grid;grid-template-columns:220px 1fr;gap:56px;margin-bottom:48px}
.sec-head .label{font-family:var(--pixel);font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-3);padding-top:14px}
h2{font-family:var(--serif);font-weight:400;font-size:clamp(36px,4.4vw,54px);line-height:1.02;letter-spacing:-.025em;margin:0}
.summary{display:grid;grid-template-columns:220px 1fr;gap:56px}
.summary .body{font-family:var(--serif);font-size:21px;line-height:1.6;max-width:720px;font-weight:350}
.summary .body p{margin:0 0 1.1em}
.summary .body p:first-child::first-letter{float:left;font-size:92px;line-height:.82;padding:8px 12px 0 0;font-weight:400;color:var(--ink)}
.aside-note{font-size:13px;color:var(--ink-3);line-height:1.5}
.aside-note strong{display:block;color:var(--ink);font-weight:500;margin-bottom:4px}
.shell{padding:6px;border-radius:26px;background:rgba(13,13,13,.03);box-shadow:inset 0 0 0 1px rgba(13,13,13,.05)}
.core{border-radius:20px;background:var(--card);box-shadow:inset 0 1px 0 rgba(255,255,255,.9),0 24px 48px -32px rgba(70,45,30,.22)}
.findings{display:grid;grid-template-columns:repeat(6,1fr);gap:20px}
.finding{grid-column:span 2;break-inside:avoid}
.finding.wide{grid-column:span 3}
.finding .core{padding:28px 28px 24px;height:100%;display:flex;flex-direction:column}
.finding .num{font-family:var(--serif);font-size:44px;line-height:1;color:var(--rose);font-weight:300}
.finding h3{font-family:var(--serif);font-weight:500;font-size:23px;line-height:1.2;letter-spacing:-.01em;margin:18px 0 10px}
.finding p{margin:0 0 20px;color:var(--ink-2);font-size:14.5px}
.evidence{margin-top:auto;display:flex;flex-wrap:wrap;gap:6px}
.chip{font-size:11.5px;padding:4px 10px;border-radius:999px;background:var(--paper-2);color:var(--ink-2);white-space:nowrap}
.chip b{font-weight:600;color:var(--ink)}
.theme{display:grid;grid-template-columns:220px 1fr;gap:56px;padding:72px 0;border-top:1px solid var(--hair)}
.theme:first-of-type{border-top:0;padding-top:0}
.share{margin:18px 0 8px;height:6px;border-radius:99px;background:rgba(13,13,13,.06);overflow:hidden}
.share i{display:block;height:100%;border-radius:99px;background:var(--ink)}
.share-label{font-size:13px;color:var(--ink-2)}
.share-label b{font-family:var(--serif);font-size:30px;font-weight:400;color:var(--ink);display:block;letter-spacing:-.02em}
.spark{display:block;width:100%;max-width:160px;height:auto;margin-top:4px}
.theme h3{font-family:var(--serif);font-weight:400;font-size:38px;line-height:1.08;letter-spacing:-.02em;margin:0 0 22px;max-width:760px}
.prose{font-family:var(--serif);font-size:19px;line-height:1.62;max-width:700px;font-weight:350}
.prose p{margin:0 0 1em}
.pull{margin:30px 0 34px;padding-left:22px;border-left:2px solid var(--rose);font-family:var(--serif);font-style:italic;font-size:24px;line-height:1.38;color:var(--ink);max-width:640px}
.pull cite{display:block;margin-top:10px;font-family:var(--sans);font-style:normal;font-size:12px;color:var(--ink-3)}
.posts .core,.items .core{padding:8px 24px}
.posts-title{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-3);padding:16px 0 6px}
.post{display:grid;grid-template-columns:88px 1fr auto;gap:18px;align-items:baseline;padding:16px 0;border-top:1px solid var(--hair);text-decoration:none}
.post:first-of-type{border-top:0}
.post .src{font-size:12px;font-weight:600}
.post .src span{display:block;font-weight:400;color:var(--ink-3)}
.post .t{font-family:var(--serif);font-size:18px;line-height:1.3}
.post .n{font-size:12.5px;color:var(--ink-2);text-align:right;white-space:nowrap}
.post .n b{display:block;font-size:15px;color:var(--ink);font-weight:600}
.minor{margin-top:40px;display:grid;grid-template-columns:1fr 1fr;gap:20px}
.minor .core{padding:22px 24px}
.minor h4{font-family:var(--serif);font-weight:500;font-size:20px;margin:6px 0 6px}
.minor p{margin:0;font-size:14px;color:var(--ink-2)}
.figure{margin-bottom:32px;break-inside:avoid}
.figure .core{padding:24px 28px}
.figure h4{font-family:var(--serif);font-weight:400;font-size:24px;letter-spacing:-.01em;margin:0 0 4px}
.chart{width:100%;height:auto;display:block;margin:12px 0 4px}
.chart .axis,.chart .label{font-family:var(--sans);font-size:10px;fill:var(--ink-3)}
.chart .label{fill:var(--ink);font-size:11px}
.chart .busy{font-family:var(--sans);font-size:10.5px;font-weight:600;fill:var(--ink)}
.chart .cell{font-family:var(--sans);font-size:11px;fill:var(--ink)}
.chart .cell-dark{font-family:var(--sans);font-size:11px;fill:#fff;font-weight:600}
.caption{font-size:12px;color:var(--ink-3);margin:6px 0 0}
.cite{font-family:var(--sans);font-size:.62em;vertical-align:super;line-height:0;margin-left:1px}
.cite a{text-decoration:none;color:var(--action)}
.pic{margin:6px 0 26px;max-width:700px;break-inside:avoid}
.pic img{display:block;max-width:100%;max-height:360px;width:auto;height:auto;border-radius:16px;box-shadow:0 0 0 1px var(--hair)}
.pic figcaption{font-size:12px;color:var(--ink-3);margin-top:8px}
.srcs .core{padding:8px 24px}
.src-row{display:grid;grid-template-columns:28px 1fr auto;gap:14px;align-items:baseline;padding:12px 0;border-top:1px solid var(--hair);text-decoration:none}
.src-row:first-of-type{border-top:0}
.src-row .no{font-size:12px;color:var(--ink-3)}
.src-row .t{font-family:var(--serif);font-size:16px;line-height:1.3}
.src-row .t span{display:block;font-family:var(--sans);font-size:12px;color:var(--ink-3);margin-top:2px}
.facts-list{font-family:var(--serif);font-size:18px;line-height:1.55;max-width:720px;padding-left:22px}
.facts-list li{margin-bottom:10px}
.pages{margin-top:36px}
.pages h4{font-family:var(--serif);font-weight:400;font-size:22px;margin:0 0 6px}
.sig-wrap{padding:72px 0 120px}
.sig .core{padding:36px;display:grid;grid-template-columns:auto 1fr auto;gap:28px;align-items:center}
.portrait{width:84px;height:84px;border:1px solid var(--rose);background:linear-gradient(140deg,var(--peach),var(--rose) 55%,var(--sky));display:grid;place-items:center;font-family:var(--serif);font-size:40px;color:rgba(13,13,13,.75)}
.sig .name{font-family:var(--serif);font-size:28px;line-height:1.1}
.sig .role{color:var(--ink-2);font-size:14px;margin-top:4px}
.sig .ask{font-size:14px;color:var(--ink-2);margin-top:14px;max-width:520px}
.sig .cta{text-align:right;font-size:13px;color:var(--action)}
.colophon{margin-top:28px;display:grid;grid-template-columns:repeat(4,1fr);gap:24px;font-size:12px;color:var(--ink-3)}
.colophon b{display:block;color:var(--ink-2);font-weight:500;margin-bottom:2px}
.colophon .down{color:#b3412a}
@media (max-width:860px){.wrap{padding:0 16px}.cover{padding:72px 0 64px}.cover-grid,.sec-head,.summary,.theme{grid-template-columns:1fr;gap:28px}.contents{grid-template-columns:1fr 1fr}.findings{grid-template-columns:1fr}.finding,.finding.wide{grid-column:span 1}.post{grid-template-columns:1fr;gap:4px}.post .n{text-align:left}.post .n b{display:inline;margin-right:6px}.minor{grid-template-columns:1fr}.sig .core{grid-template-columns:1fr}.sig .cta{text-align:left}.colophon{grid-template-columns:1fr 1fr}section{padding:64px 0}}
@page{size:Letter;margin:.7in .75in .8in;@bottom-left{content:${cssString(footer)};font-family:"Work Sans",sans-serif;font-size:8pt;color:#8a817a}@bottom-right{content:counter(page);font-family:"Work Sans",sans-serif;font-size:8pt;color:#8a817a}}
@page :first{@bottom-left{content:none}@bottom-right{content:none}}
@media print{body{font-size:10pt;background:#fff}.wrap{max-width:none;padding:0}.cover{padding:1.2in 0 0;min-height:9.2in;break-after:page}.cover-grid{grid-template-columns:1fr 2.2in;gap:.5in}h1{font-size:60pt}.deck{font-size:15pt}section{padding:0}.sec-head,.summary,.theme{grid-template-columns:1.5in 1fr;gap:.35in}.summary .body{font-size:12.5pt}.summary .body p:first-child::first-letter{font-size:52pt}#findings,#themes,#social,#items{break-before:page}.findings{grid-template-columns:1fr 1fr;gap:12px}.finding,.finding.wide{grid-column:span 1}.finding.wide:last-child{grid-column:span 2}.finding .core{padding:18px}.finding h3{font-size:14pt;margin:10px 0 6px}.finding p{font-size:9.5pt;margin-bottom:12px}.finding .num{font-size:26pt}.theme{padding:.3in 0;break-inside:auto}.theme h3{font-size:22pt;break-inside:avoid;break-after:avoid}.prose{font-size:11pt}.pull{font-size:14pt;break-inside:avoid}.posts,.minor .shell,.sig,.finding,.figure{break-inside:avoid}.post .t{font-size:11pt}h2{font-size:30pt}.core{box-shadow:inset 0 1px 0 rgba(255,255,255,.9),0 0 0 .5px rgba(13,13,13,.06)}.sig-wrap{padding:.3in 0 0;break-before:page}a{text-decoration:none}}`;
}

/** Render the HTML page of one Research report. */
export function renderReportHtml(input: ReportPageInput): string {
  const { research, text } = input;
  const c: Cites = { facts: new Map(research.facts.map((f) => [f.id, f])), pages: new Map(research.pages.map((p) => [p.id, p])) };
  const owner = input.ownerDisplayName?.trim();
  const roleLine = formatJoshuSignatureRoleLine(owner);
  const footer = `${text.title} · Research report`;
  const cited = pagesOf(research.facts.map((f) => f.id), c);
  const sites = new Set(cited.map((p) => p.site));
  const background = text.themes.filter((t) => t.kind === "background");
  const news = text.themes.filter((t) => t.kind !== "background");
  const contents: [string, string][] = [
    ["summary", "Summary"],
    ...(background.length ? ([["background", "Background"]] as [string, string][]) : []),
    ...(news.length ? ([["themes", news.some((t) => t.kind === "section") ? "Sections" : "In the news"]] as [string, string][]) : []),
    ["about", "About this report"],
  ];
  // The list at the end: the pages that a fact cites or a theme links to, in the order of their numbers.
  const listed = new Set([...cited.map((p) => p.url), ...text.themes.flatMap((t) => (t.links ?? []).map((l) => l.url))]);
  const pagesRead = research.pages.filter((p) => listed.has(p.url)).sort((a, b) => pageNo(a) - pageNo(b));

  const out: string[] = [];
  out.push(`<header class="cover"><div class="cover-grid"><div>
<span class="eyebrow"><span class="dot"></span>Research report</span>
<h1>${titleHtml(text.title, text.titleEmphasis)}</h1>
<p class="deck">${escapeHtml(text.deck)}</p>
</div><dl class="meta">
<div><dt>Date</dt><dd>${escapeHtml(longDay(research.day))}</dd></div>
<div><dt>Evidence</dt><dd>${research.facts.length} facts from ${cited.length} pages and posts on ${sites.size} sites</dd></div>
<div><dt>Depth</dt><dd>${text.quiet ? "Little was found" : `Thorough · ${text.themes.length} themes`}</dd></div>
<div><dt>Prepared by</dt><dd>${escapeHtml(input.companionName)}${owner ? `, for ${escapeHtml(owner)}` : ""}</dd></div>
</dl></div>
<nav class="contents" aria-label="Contents">${contents
    .map(([id, name], i) => `<a href="#${id}">${String(i + 1).padStart(2, "0")}<b>${escapeHtml(name)}</b></a>`)
    .join("")}</nav></header>`);

  out.push(`<section id="summary"><div class="summary"><div class="aside-note"><strong>In one sentence</strong>${escapeHtml(text.oneSentence)}</div><div class="body">${paragraphs(text.overview, c)}</div></div></section>`);

  let n = 2;
  const themeHtml = (theme: ReportSection) => {
    const pic = input.pictures.get(theme.index);
    const picHtml = pic
      ? `<figure class="pic"><img src="${pic.dataUri}" alt="${escapeHtml(pic.alt)}"><figcaption>Picture: <a href="${escapeHtml(pic.pageUrl)}">${escapeHtml(pic.site)}</a></figcaption></figure>`
      : "";
    const kind = themeKind(theme);
    // The empty side column keeps the text in line with the section headings.
    return `<article class="theme"><aside class="theme-side"></aside><div>${kind ? `<span class="theme-kind">${escapeHtml(kind)}</span>` : ""}<h3>${escapeHtml(theme.title)}</h3>${picHtml}<div class="prose">${paragraphs(
      theme.body,
      c,
    )}</div>${themeLinksHtml(theme.links)}</div></article>`;
  };
  if (background.length) {
    out.push(`<section id="background"><div class="sec-head"><div class="label">${String(n++).padStart(2, "0")} · Background</div><h2>What to know first</h2></div>${background.map(themeHtml).join("")}</section>`);
  }
  if (news.length) {
    const sectionsOfOwner = news.some((t) => t.kind === "section");
    out.push(`<section id="themes"><div class="sec-head"><div class="label">${String(n++).padStart(2, "0")} · ${sectionsOfOwner ? "Sections" : "In the news"}</div><h2>${
      sectionsOfOwner ? "What the research says" : text.quiet ? "Little was found in the last 30 days" : "What happened in the last 30 days"
    }</h2></div>${news.map(themeHtml).join("")}</section>`);
  }

  const ideas = text.followUps.length
    ? `Want to go deeper? Reply to this message and ask me to ${
        text.followUps.length > 1
          ? `${text.followUps.slice(0, -1).map(escapeHtml).join(", ")}, or ${escapeHtml(text.followUps.at(-1)!)}`
          : escapeHtml(text.followUps[0]!)
      }.`
    : "Want to go deeper? Reply to this message and ask me for more.";
  const sourceList = sourceListHtml(research.sources);
  out.push(`<footer class="sig-wrap" id="about"><div class="sig shell"><div class="core">${portraitHtml(input.companionName, input.portrait)}<div><div class="name">${escapeHtml(input.companionName)}</div><div class="role">${escapeHtml(roleLine)}</div><div class="ask">${ideas}</div></div><div class="cta">joshu.me</div></div></div>
<div class="colophon"><div><b>About this report</b>Researched and written by ${escapeHtml(input.companionName)} from public web pages. Each number links to the page that it comes from.</div><div><b>Date</b>${escapeHtml(longDay(research.day))}</div><div><b>Sources searched</b>${sourceList}</div><div><b>Generated</b>${escapeHtml(text.model)}${
    input.reportId ? ` · ${escapeHtml(input.reportId)}` : ""
  }</div></div>
<div class="pages srcs shell"><div class="core"><div class="posts-title">Pages and posts</div>${pagesRead.map(sourceRow).join("")}</div></div></footer>`);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(text.title)}: research report</title>
<style>${reportCss(input.fontCss, footer)}${THEME_LINKS_CSS}</style>
</head>
<body>
<main class="wrap">
${out.join("\n")}
</main>
</body>
</html>
`;
}
