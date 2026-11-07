/**
 * The counts of a Research report and its two charts as inline SVG: the items found by the day
 * of publication, and the themes by source. No chart library and no script, so the HTML page
 * and the PDF show the same charts. Design decision D3 of change research-reports.
 */

import { escapeHtml } from "./html.js";
import type { CollectedResearch } from "./types.js";

export type DayCount = { day: string; count: number };

export type ThemeCounts = {
  index: number;
  title: string;
  /** Item count for each source, in the order of `ReportCounts.themeSources`. */
  bySource: number[];
  byDay: Record<string, number>;
};

export type ReportCounts = {
  /** One entry for each day from the first day of the window to the day of the collection. */
  days: DayCount[];
  /** Days with many more items than usual (at most three). */
  busyDays: string[];
  /** Items with no known publication date. */
  undated: number;
  /** Sources that returned items, sorted by item count. */
  themeSources: { name: string; label: string }[];
  themes: ThemeCounts[];
};

const DAY_MS = 86_400_000;

function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Count the collected items by day, by source, and by theme. `lastDay` is the day of the request
 * in the time zone of the owner (`YYYY-MM-DD`).
 */
export function computeReportCounts(
  collected: CollectedResearch,
  lastDay = collected.collectedAt.slice(0, 10),
): ReportCounts {
  let firstDay = addDays(lastDay, -(collected.windowDays - 1));
  const dated = collected.items.filter((item) => item.publishedAt && item.publishedAt <= lastDay);
  for (const item of dated) if (item.publishedAt! < firstDay) firstDay = item.publishedAt!;

  const perDay = new Map<string, number>();
  for (const item of dated) perDay.set(item.publishedAt!, (perDay.get(item.publishedAt!) ?? 0) + 1);
  const days: DayCount[] = [];
  for (let day = firstDay; day <= lastDay; day = addDays(day, 1)) {
    days.push({ day, count: perDay.get(day) ?? 0 });
  }

  // A busy day has at least 2 items and at least twice the average of the days with items.
  const active = days.filter((d) => d.count > 0);
  const average = active.reduce((sum, d) => sum + d.count, 0) / Math.max(active.length, 1);
  const busyDays = days
    .filter((d) => d.count >= 2 && d.count >= 2 * average)
    .sort((a, b) => b.count - a.count || a.day.localeCompare(b.day))
    .slice(0, 3)
    .map((d) => d.day)
    .sort();

  const perSource = new Map<string, number>();
  for (const item of collected.items) perSource.set(item.source, (perSource.get(item.source) ?? 0) + 1);
  const themeSources = [...perSource.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name]) => ({
      name,
      label: collected.items.find((item) => item.source === name)?.sourceLabel ?? name,
    }));

  const byId = new Map(collected.items.map((item) => [item.id, item]));
  const themes: ThemeCounts[] = collected.themes.map((theme) => {
    const members = theme.itemIds.map((id) => byId.get(id)!).filter(Boolean);
    const byDay: Record<string, number> = {};
    for (const item of members) if (item.publishedAt) byDay[item.publishedAt] = (byDay[item.publishedAt] ?? 0) + 1;
    return {
      index: theme.index,
      title: theme.title,
      bySource: themeSources.map((s) => members.filter((item) => item.source === s.name).length),
      byDay,
    };
  });

  return {
    days,
    busyDays,
    undated: collected.items.length - dated.length,
    themeSources,
    themes,
  };
}

export function shortDay(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** Colors of the report design (the same tokens as the CSS of the template). */
const C = { ink: "#0d0d0d", ink2: "#4a4540", ink3: "#8a817a", rose: "#c8a2a6", hair: "rgba(13,13,13,0.09)", wash: "rgba(13,13,13,0.06)" };

/**
 * Bar chart of the items found by the day of publication, with each busy day labeled. A report
 * update uses it for the items of each lane by report update, with its own `label`.
 */
export function itemsByDaySvg(counts: Pick<ReportCounts, "days" | "busyDays">, label = "Items found by day of publication"): string {
  const width = 720;
  const height = 230;
  const left = 30;
  const right = 12;
  const top = 40;
  const bottom = 30;
  const plotW = width - left - right;
  const plotH = height - top - bottom;
  const max = Math.max(1, ...counts.days.map((d) => d.count));
  const slot = plotW / Math.max(counts.days.length, 1);
  const barW = Math.max(2, slot * 0.62);
  const busy = new Set(counts.busyDays);

  const parts: string[] = [];
  for (const frac of [0.5, 1]) {
    const y = top + plotH - frac * plotH;
    parts.push(`<line x1="${left}" y1="${y.toFixed(1)}" x2="${width - right}" y2="${y.toFixed(1)}" stroke="${C.hair}" stroke-width="1" stroke-dasharray="2 4"/>`);
  }
  parts.push(`<line x1="${left}" y1="${top + plotH}" x2="${width - right}" y2="${top + plotH}" stroke="${C.ink}" stroke-width="1"/>`);
  parts.push(`<text x="${left - 8}" y="${top + 4}" text-anchor="end" class="axis">${max}</text>`);
  counts.days.forEach((d, i) => {
    if (d.count <= 0) return;
    const h = (d.count / max) * plotH;
    const x = left + i * slot + (slot - barW) / 2;
    const y = top + plotH - h;
    const isBusy = busy.has(d.day);
    parts.push(
      `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="1.5" fill="${isBusy ? C.rose : C.ink}" fill-opacity="${isBusy ? 1 : 0.82}"><title>${escapeHtml(shortDay(d.day))}: ${d.count}</title></rect>`,
    );
    if (isBusy) {
      const cx = x + barW / 2;
      const anchor = cx > width - 70 ? "end" : cx < 70 ? "start" : "middle";
      parts.push(`<line x1="${cx.toFixed(1)}" y1="${(y - 4).toFixed(1)}" x2="${cx.toFixed(1)}" y2="${(y - 12).toFixed(1)}" stroke="${C.rose}" stroke-width="1"/>`);
      parts.push(`<text x="${cx.toFixed(1)}" y="${(y - 16).toFixed(1)}" text-anchor="${anchor}" class="busy">${escapeHtml(shortDay(d.day))} · ${d.count}</text>`);
    }
  });
  const first = counts.days[0];
  const last = counts.days[counts.days.length - 1];
  if (first && last) {
    parts.push(`<text x="${left}" y="${height - 8}" class="axis">${escapeHtml(shortDay(first.day))}</text>`);
    parts.push(`<text x="${width - right}" y="${height - 8}" text-anchor="end" class="axis">${escapeHtml(shortDay(last.day))}</text>`);
  }
  return `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(label)}">${parts.join("")}</svg>`;
}

function clipLabel(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Grid of the themes by source, with the item count in each cell. */
export function themesBySourceSvg(counts: ReportCounts): string {
  const labelW = 200;
  const cellW = Math.min(64, Math.max(44, Math.floor(480 / Math.max(counts.themeSources.length, 1))));
  const cellH = 30;
  const headerH = 70;
  const width = labelW + cellW * counts.themeSources.length + 60;
  const height = headerH + cellH * counts.themes.length + 6;
  const max = Math.max(1, ...counts.themes.flatMap((t) => t.bySource));

  const parts: string[] = [];
  counts.themeSources.forEach((s, j) => {
    const x = labelW + j * cellW + cellW / 2;
    parts.push(`<text transform="translate(${x.toFixed(1)},${headerH - 10}) rotate(-35)" class="axis">${escapeHtml(s.label)}</text>`);
  });
  counts.themes.forEach((t, i) => {
    const y = headerH + i * cellH;
    parts.push(`<text x="0" y="${y + cellH / 2 + 4}" class="label">${escapeHtml(clipLabel(t.title, 30))}</text>`);
    t.bySource.forEach((n, j) => {
      const x = labelW + j * cellW;
      const shade = n === 0 ? 0 : 0.12 + 0.78 * (n / max);
      parts.push(
        `<rect x="${x + 2}" y="${y + 2}" width="${cellW - 4}" height="${cellH - 4}" rx="6" fill="${n === 0 ? C.wash : C.ink}" fill-opacity="${n === 0 ? 0.5 : shade.toFixed(2)}"/>`,
      );
      if (n > 0) {
        parts.push(`<text x="${x + cellW / 2}" y="${y + cellH / 2 + 4}" text-anchor="middle" class="${shade > 0.5 ? "cell-dark" : "cell"}">${n}</text>`);
      }
    });
  });
  return `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Themes by source">${parts.join("")}</svg>`;
}

/** Small line of the items of one theme by day, with its peak day marked (theme side column). */
export function themeSparkSvg(counts: ReportCounts, theme: ThemeCounts): string {
  const width = 160;
  const height = 36;
  const values = counts.days.map((d) => theme.byDay[d.day] ?? 0);
  const max = Math.max(1, ...values);
  const step = width / Math.max(values.length - 1, 1);
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(height - 4 - (v / max) * (height - 10)).toFixed(1)}`);
  const peak = values.indexOf(Math.max(...values));
  const [px, py] = (pts[peak] ?? "0,0").split(",");
  return `<svg class="spark" viewBox="0 0 ${width} ${height}" role="img" aria-label="Items of this theme by day"><polyline points="${pts.join(" ")}" fill="none" stroke="${C.ink}" stroke-width="1.2" stroke-linejoin="round"/>${
    values[peak] ? `<circle cx="${px}" cy="${py}" r="2.6" fill="${C.rose}"/>` : ""
  }</svg>`;
}
