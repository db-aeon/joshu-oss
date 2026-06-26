import type { HermesChatMessage } from "./hermesApi.js";

export type BrowserSyncLevel = "off" | "light" | "full";
export type BrowserSyncMode = BrowserSyncLevel | "auto";

const BROWSER_INTENT_RE =
  /\b(browser|click|button|page|screen|tab|navigate|snapshot|observe|sign\s*in|log\s*in|what'?s on|look at|scroll|website|novnc|camofox|element|link|fill in|type into|submit)\b/i;
const URL_IN_TEXT_RE = /https?:\/\/\S+/i;

export function browserSyncModeFromEnv(): BrowserSyncMode {
  const raw = process.env.JOSHU_HERMES_CHAT_BROWSER_SYNC?.trim().toLowerCase();
  if (raw === "off" || raw === "light" || raw === "full" || raw === "auto") return raw;
  return "auto";
}

export function extractLastUserMessageText(messages: HermesChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg?.role !== "user") continue;
    const content = msg.content;
    if (typeof content === "string") return content.trim();
    if (Array.isArray(content)) {
      return content
        .filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("\n")
        .trim();
    }
  }
  return "";
}

function urlsDiffer(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  return a.trim() !== b.trim();
}

function userWantsBrowserContext(userText: string): boolean {
  if (!userText) return false;
  if (URL_IN_TEXT_RE.test(userText)) return true;
  return BROWSER_INTENT_RE.test(userText);
}

/** Decide how much Camofox context to inject before a Hermes Chat turn. */
export function resolveBrowserSyncLevel(input: {
  userText: string;
  priorUrl?: string;
  currentUrl?: string;
  hasTab: boolean;
  mode?: BrowserSyncMode;
}): BrowserSyncLevel {
  const mode = input.mode ?? "auto";
  if (mode === "off") return "off";
  if (mode === "light") return input.hasTab ? "light" : "off";
  if (mode === "full") return input.hasTab ? "full" : "off";

  if (!input.hasTab) return "off";
  if (urlsDiffer(input.priorUrl, input.currentUrl)) return "full";
  if (userWantsBrowserContext(input.userText)) return "full";
  return "light";
}
