/**
 * The company step of the research pipeline (change research-report-sources, design decisions D4
 * and D5): when the plan names one public company, the box writes one page with the stock prices
 * of the last month and one page for each of the newest SEC filings, with the passages of the
 * filing that match the research brief. The box drops both when the company name from SEC or
 * Google Finance shares no word with the company of the plan.
 */

import type { PlanCompany, SourceState, WebPage } from "../types.js";
import type { CompanyFilings, ComposioSearchClient, StockPrices } from "./composioSearch.js";
import { withDeadline } from "./llm.js";

const FILING_TEXT = 3000;
const NAME_FILLER = new Set(["the", "inc", "corp", "corporation", "co", "company", "ltd", "plc", "group", "holdings", "sa", "ag", "nv", "class"]);

function words(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !NAME_FILLER.has(w));
}

/** True when the two company names share a word other than "Inc", "Corp", and the like. */
export function sameCompany(planName: string, otherName: string): boolean {
  const mine = new Set(words(planName));
  return words(otherName).some((w) => mine.has(w));
}

function money(value: number, currency: string): string {
  return `${value.toFixed(2)} ${currency}`.trim();
}

function volume(value: number | undefined): string {
  return value === undefined ? "" : `, volume ${value.toLocaleString("en-US")}`;
}

/** The price page of D4: computed lines first, then one line for each price. */
export function pricePage(company: PlanCompany, prices: StockPrices): WebPage | null {
  const closes = prices.points.filter((p) => p.close);
  if (!closes.length) return null;
  const c = prices.currency;
  const first = closes[0]!;
  const last = closes.at(-1)!;
  const high = closes.reduce((a, b) => (b.price > a.price ? b : a));
  const low = closes.reduce((a, b) => (b.price < a.price ? b : a));
  const change = ((last.price - first.price) / first.price) * 100;
  const latest = prices.points.at(-1)!;
  const lines = [
    `${company.name} (${company.ticker}) closed at ${money(first.price, c)} on ${first.day} and at ${money(last.price, c)} on ${last.day}, a change of ${change >= 0 ? "+" : ""}${change.toFixed(1)}%.`,
    `The highest close of the period was ${money(high.price, c)} on ${high.day}, and the lowest close was ${money(low.price, c)} on ${low.day}.`,
    ...(latest.close ? [] : [`The latest price was ${money(latest.price, c)} on ${latest.day} at ${latest.time}, before the close.`]),
    ...closes.map((p) => `${p.day}: closing price ${money(p.price, c)}${volume(p.volume)}.`),
  ];
  return {
    id: "",
    url: `https://www.google.com/finance/quote/${prices.symbol}`,
    title: `${company.name} (${company.ticker}) stock price, last month`,
    site: "google.com",
    publishedAt: latest.day,
    highlights: [],
    text: lines.join("\n"),
    pictures: [],
    foundBy: [],
    foundVia: ["prices"],
    score: 0,
  };
}

/** One page for each filing, with the passages of the filing that match the research brief. */
export function filingPages(companyName: string, filings: CompanyFilings, passages: Map<string, string[]>): WebPage[] {
  return filings.filings.flatMap((f) => {
    const text = (passages.get(f.url) ?? []).join("\n").slice(0, FILING_TEXT);
    if (!text) return [];
    return [
      {
        id: "",
        url: f.url,
        title: `${companyName} ${f.form} filed ${f.filedAt}`,
        site: "sec.gov",
        publishedAt: f.filedAt || undefined,
        highlights: [],
        text,
        pictures: [],
        foundBy: [],
        foundVia: ["filings" as const],
        score: 0,
      },
    ];
  });
}

type Outcome<T> = { value?: T; error?: string };

async function attempt<T>(fn: () => Promise<T>, deadline: number): Promise<Outcome<T>> {
  try {
    return { value: await withDeadline(fn(), deadline) };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

function state(name: string, label: string, outcome: Outcome<unknown>, found: number, note?: string): SourceState {
  if (outcome.error) return { name, label, state: "could not be reached", engineStatus: outcome.error };
  return { name, label, state: found ? "returned items" : "returned no items", engineStatus: note ?? "ok" };
}

/**
 * The price page and the filing pages for the company of the plan, and the source states of the
 * stock prices and the SEC filings. The two Composio calls run at the same time, and the Exa call
 * for the passages of the filings runs after the SEC call.
 */
export async function collectCompany(
  composio: ComposioSearchClient,
  company: PlanCompany,
  /** The passages of each filing URL that match the research brief (one Exa call). */
  readPassages: (urls: string[]) => Promise<Map<string, string[]>>,
  deadline: number,
): Promise<{ pages: WebPage[]; sources: SourceState[] }> {
  const symbol = `${company.ticker}:${company.exchange}`;
  const [prices, filings] = await Promise.all([
    attempt(() => composio.prices(symbol, deadline), deadline),
    attempt(async () => {
      const found = await composio.filings(company.ticker, deadline);
      const passages = found.filings.length ? await readPassages(found.filings.map((f) => f.url)) : new Map<string, string[]>();
      return { found, passages };
    }, deadline),
  ]);

  const secName = filings.value?.found.companyName ?? "";
  const priceName = prices.value?.name ?? "";
  const otherName = secName || priceName;
  const mismatch = Boolean(otherName) && !sameCompany(company.name, otherName);
  const note = mismatch ? `the company name "${otherName}" does not match` : undefined;

  const price = !mismatch && prices.value ? pricePage(company, prices.value) : null;
  const filed =
    !mismatch && filings.value ? filingPages(secName || company.name, filings.value.found, filings.value.passages) : [];
  return {
    pages: [...(price ? [price] : []), ...filed],
    sources: [
      state("prices", "Stock prices (Google Finance)", prices, price ? 1 : 0, note),
      state("filings", "SEC filings", filings, filed.length, note),
    ],
  };
}
