/**
 * The companion of a report page: its name, the owner it works for, and its portrait. The portrait
 * is the same image as in the email signature (`imageUrl` of the Joshu identity). A report page
 * loads nothing from the internet, so the box downloads the portrait and embeds it as a data URI.
 * Without a portrait, the page shows the first letter of the name.
 */

import { resolveJoshuIdentity } from "../joshuIdentity.js";
import { downloadPicture } from "./pipeline/pictures.js";

export type ReportIdentity = { companionName: string; ownerDisplayName?: string; portrait?: string };

/** A portrait is small: a narrower picture than the theme pictures is fine. */
const PORTRAIT_MIN_WIDTH = 64;
const portraits = new Map<string, string>();

/** The portrait at `url` as a data URI, downloaded once for each URL; undefined when it cannot be read. */
export async function portraitDataUri(url: string | null | undefined, fetchImpl: typeof fetch = fetch): Promise<string | undefined> {
  const clean = url?.trim();
  if (!clean || !/^https:\/\//i.test(clean)) return undefined;
  const known = portraits.get(clean);
  if (known) return known;
  const picture = await downloadPicture(clean, fetchImpl, PORTRAIT_MIN_WIDTH);
  if (!picture) return undefined;
  portraits.set(clean, picture.dataUri);
  return picture.dataUri;
}

/** The companion of this box for a report page; "Joshu" without a portrait when the identity cannot be read. */
export async function reportIdentity(projectRoot: string, fetchImpl: typeof fetch = fetch): Promise<ReportIdentity> {
  try {
    const who = resolveJoshuIdentity(projectRoot);
    const portrait = await portraitDataUri(who.imageUrl, fetchImpl);
    return { companionName: who.name, ...(who.owner.displayName ? { ownerDisplayName: who.owner.displayName } : {}), ...(portrait ? { portrait } : {}) };
  } catch {
    return { companionName: "Joshu" };
  }
}
