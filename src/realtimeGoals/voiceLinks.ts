import { ownerSmsPhone, sendSms, twilioSmsGatewayEnabled } from "../twilioSmsSend.js";

/**
 * Links cannot be delivered by voice: read aloud they are useless, and a
 * spoken "I sent you the link" is a lie unless something actually texted it.
 * Voice surfaces split results into speakable text + links, and text the links
 * to the owner's phone (the only side channel a caller has).
 */

const URL_PATTERN = /https?:\/\/[^\s<>"'`)\]]+/gi;
/** Trailing punctuation that belongs to the sentence, not the URL. */
const URL_TRAILING_PUNCTUATION = /[.,;:!?]+$/;
/** Label-only lines left behind once their URL is removed ("Finish and pay here:"). */
const DANGLING_LINK_LABEL = /^[^\n]{0,80}\b(here|link|url|below)\s*:?\s*$/i;

export function extractLinks(text: string): string[] {
  const seen = new Set<string>();
  for (const match of text.matchAll(URL_PATTERN)) {
    // Workers' prose auto-capitalizes line starts ("Https://…"); the scheme is
    // case-insensitive, so normalize it before de-duplicating.
    const url = match[0]
      .replace(URL_TRAILING_PUNCTUATION, "")
      .replace(/^https?/i, (scheme) => scheme.toLowerCase());
    if (url) seen.add(url);
  }
  return [...seen];
}

/**
 * Remove URLs (and label lines that only introduced them) so the text can be
 * spoken. `note` is appended once when anything was removed.
 */
export function speakableWithoutLinks(text: string, note: string): string {
  if (extractLinks(text).length === 0) return text.trim();
  const lines = text
    .replace(URL_PATTERN, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+([.,;:!?])/g, "$1").trimEnd())
    .filter((line) => line.trim() && !DANGLING_LINK_LABEL.test(line.trim()));
  const body = lines.join("\n").trim();
  return note ? `${body}\n\n${note}`.trim() : body;
}

/** One-line context for the SMS so the owner knows what the link is for. */
function linkSmsBody(links: string[], context?: string): string {
  const label = context?.replace(/\s+/g, " ").trim().slice(0, 120);
  const intro = label ? `Link for “${label}”:` : links.length > 1 ? "Here are the links:" : "Here's the link:";
  return [intro, ...links].join("\n");
}

export type OwnerTextResult = { texted: boolean; error?: string };

/** Text links to the owner's phone. Never throws; returns whether it went out. */
export async function textLinksToOwner(
  projectRoot: string,
  links: string[],
  context?: string,
): Promise<OwnerTextResult> {
  if (links.length === 0) return { texted: false, error: "no links" };
  return textOwner(projectRoot, linkSmsBody(links, context));
}

/** Text arbitrary content to the owner (e.g. an answer finished after hang-up). */
export async function textOwner(projectRoot: string, body: string): Promise<OwnerTextResult> {
  if (!body.trim()) return { texted: false, error: "empty body" };
  if (!twilioSmsGatewayEnabled(projectRoot)) return { texted: false, error: "SMS not configured" };
  try {
    await sendSms(ownerSmsPhone(projectRoot), body.trim());
    return { texted: true };
  } catch (error) {
    const message = (error as Error).message;
    console.warn(`[realtime-goals] owner SMS failed: ${message}`);
    return { texted: false, error: message };
  }
}

/** Spoken note for the caller, honest about whether the text actually went out. */
export function linkDeliveryNote(result: OwnerTextResult, count: number): string {
  const noun = count > 1 ? "links" : "link";
  return result.texted
    ? `I just texted you the ${noun}.`
    : `I couldn't text you the ${noun} just now — ask me to email it instead.`;
}
