/**
 * Pictures of a Research report (design decision D13): for each theme section, the first cited
 * page with a suitable picture. The box downloads it, checks the type, the width (from the file
 * header), and the size, and embeds it as a data URI with the site name and a link to the page.
 */

import type { Fact, WebPage } from "../types.js";
import { mapLimit } from "./llm.js";

export const MIN_WIDTH = 300;
export const MAX_BYTES = 1_000_000;
export const MAX_PICTURES = 6;
const DOWNLOAD_TIMEOUT_MS = 8000;
const SKIP = /logo|icon|avatar|sprite|favicon|badge|banner-ad|placeholder|1x1|pixel/i;

export type Picture = { dataUri: string; alt: string; site: string; pageUrl: string; width: number };

/** Width of a JPEG, PNG, or WebP from its header, or 0 when the bytes are not one of those. */
export function imageInfo(bytes: Uint8Array): { type: "png" | "jpeg" | "webp"; width: number } | null {
  if (bytes.length > 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { type: "png", width: ((bytes[16]! << 24) | (bytes[17]! << 16) | (bytes[18]! << 8) | bytes[19]!) >>> 0 };
  }
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) {
        i += 1;
        continue;
      }
      const marker = bytes[i + 1]!;
      const len = (bytes[i + 2]! << 8) | bytes[i + 3]!;
      // Start-of-frame markers carry the size (not DHT 0xC4, JPG 0xC8, DAC 0xCC).
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { type: "jpeg", width: (bytes[i + 7]! << 8) | bytes[i + 8]! };
      }
      i += 2 + len;
    }
    return { type: "jpeg", width: 0 };
  }
  if (bytes.length > 30 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") {
    const chunk = String.fromCharCode(...bytes.slice(12, 16));
    if (chunk === "VP8 ") return { type: "webp", width: ((bytes[26]! | (bytes[27]! << 8)) & 0x3fff) };
    if (chunk === "VP8L") return { type: "webp", width: 1 + (((bytes[22]! << 8) | bytes[21]!) & 0x3fff) };
    if (chunk === "VP8X") return { type: "webp", width: 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16)) };
    return { type: "webp", width: 0 };
  }
  return null;
}

/** Picture candidates of a page: the page image first, then images with alt text. */
export function candidates(page: WebPage): { url: string; alt: string }[] {
  const out: { url: string; alt: string }[] = [];
  if (page.image) out.push({ url: page.image, alt: page.title });
  for (const p of page.pictures) if (p.alt && !out.some((o) => o.url === p.url)) out.push(p);
  return out.filter((c) => /^https:\/\//i.test(c.url) && !SKIP.test(c.url) && !SKIP.test(c.alt) && !/\.svg(\?|$)/i.test(c.url));
}

export async function downloadPicture(url: string, fetchImpl: typeof fetch = fetch, minWidth = MIN_WIDTH): Promise<{ dataUri: string; width: number } | null> {
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS), redirect: "follow" });
    if (!res.ok) return null;
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > MAX_BYTES) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > MAX_BYTES) return null;
    const info = imageInfo(bytes);
    if (!info || info.width < minWidth) return null;
    return { dataUri: `data:image/${info.type};base64,${Buffer.from(bytes).toString("base64")}`, width: info.width };
  } catch {
    return null;
  }
}

/**
 * One picture for each theme section, from its cited pages in order, at most `MAX_PICTURES` in
 * all, and never the same picture twice. Returns a map from section index to picture.
 */
export async function pickPictures(
  sections: { index: number; factIds: string[] }[],
  facts: Fact[],
  pages: WebPage[],
  fetchImpl: typeof fetch = fetch,
): Promise<Map<number, Picture>> {
  const factById = new Map(facts.map((f) => [f.id, f]));
  const pageById = new Map(pages.map((p) => [p.id, p]));
  const used = new Set<string>();
  const result = new Map<number, Picture>();
  const plans = sections.map((s) => {
    const pageIds = [...new Set(s.factIds.map((id) => factById.get(id)?.pageId).filter((id): id is string => !!id))];
    return { index: s.index, pages: pageIds.map((id) => pageById.get(id)!).filter(Boolean) };
  });
  await mapLimit(plans, 3, async (plan) => {
    for (const page of plan.pages) {
      for (const c of candidates(page).slice(0, 3)) {
        if (result.size >= MAX_PICTURES) return;
        if (used.has(c.url)) continue;
        used.add(c.url);
        const got = await downloadPicture(c.url, fetchImpl);
        if (got) {
          result.set(plan.index, { ...got, alt: c.alt, site: page.site, pageUrl: page.url });
          return;
        }
      }
    }
  });
  return result;
}
