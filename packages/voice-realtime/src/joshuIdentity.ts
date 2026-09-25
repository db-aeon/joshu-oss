/**
 * Identity resolution for voice-realtime (standalone process).
 * Mirrors src/joshuIdentity.ts — keep defaults and env keys in sync.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface JoshuIdentity {
  schemaVersion: 1;
  name: string;
  imageUrl: string | null;
  voiceId: string | null;
  owner: { displayName: string; email?: string };
}

const DEFAULTS: JoshuIdentity = {
  schemaVersion: 1,
  name: "Companion",
  imageUrl: null,
  voiceId: null,
  owner: { displayName: "Owner" },
};

function envTrim(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v || undefined;
}

function repoRoot(): string {
  const pkgSrc = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(pkgSrc, "../../..");
}

function readHighLevelInfo(): string | null {
  const file = path.join(repoRoot(), "templates", "joshu-info", "highlevel-info.md");
  if (!fs.existsSync(file)) return null;
  try {
    const raw = fs.readFileSync(file, "utf8").trim();
    if (!raw) return null;
    // Keep prompt compact while preserving the key context.
    return raw.replace(/\s+/g, " ").slice(0, 2000);
  } catch {
    return null;
  }
}

function identityFilePath(): string | null {
  const arozData = envTrim("AROZ_DATA") || path.join(repoRoot(), ".local", "arozos-data");
  const overrideUser = envTrim("JOSHU_AROZ_USER");
  const usersRoot = path.join(arozData, "files", "users");
  if (!fs.existsSync(usersRoot)) return null;

  const pickUser = (): string | null => {
    if (overrideUser) {
      const desktop = path.join(usersRoot, overrideUser, "Desktop");
      return fs.existsSync(desktop) ? overrideUser : null;
    }
    for (const ent of fs.readdirSync(usersRoot, { withFileTypes: true })) {
      if (!ent.isDirectory() || ent.name === "admin") continue;
      if (fs.existsSync(path.join(usersRoot, ent.name, "Desktop"))) return ent.name;
    }
    for (const ent of fs.readdirSync(usersRoot, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      if (fs.existsSync(path.join(usersRoot, ent.name, "Desktop"))) return ent.name;
    }
    return null;
  };

  const user = pickUser();
  if (!user) return null;
  return path.join(usersRoot, user, ".joshu", "identity.json");
}

function readFileIdentity(): JoshuIdentity | null {
  const file = identityFilePath();
  if (!file || !fs.existsSync(file)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    const ownerRaw =
      raw.owner && typeof raw.owner === "object"
        ? (raw.owner as Record<string, unknown>)
        : {};
    return {
      schemaVersion: 1,
      name:
        typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : DEFAULTS.name,
      imageUrl:
        typeof raw.imageUrl === "string" && raw.imageUrl.trim() ? raw.imageUrl.trim() : null,
      voiceId:
        typeof raw.voiceId === "string" && raw.voiceId.trim() ? raw.voiceId.trim() : null,
      owner: {
        displayName:
          typeof ownerRaw.displayName === "string" && ownerRaw.displayName.trim()
            ? ownerRaw.displayName.trim()
            : DEFAULTS.owner.displayName,
        email:
          typeof ownerRaw.email === "string" && ownerRaw.email.trim()
            ? ownerRaw.email.trim()
            : undefined,
      },
    };
  } catch {
    return null;
  }
}

/** Resolved once at module load (env + optional identity.json). */
export function resolveJoshuIdentity(): JoshuIdentity {
  const base = readFileIdentity() ?? DEFAULTS;
  const email = envTrim("JOSHU_OWNER_EMAIL") || envTrim("JOSHU_AROZ_USER") || base.owner.email;
  return {
    schemaVersion: 1,
    name: envTrim("JOSHU_NAME") ?? base.name,
    imageUrl: envTrim("JOSHU_IMAGE_URL") ?? base.imageUrl,
    voiceId: envTrim("JOSHU_VOICE_ID") ?? base.voiceId,
    owner: {
      displayName: envTrim("JOSHU_OWNER_NAME") ?? base.owner.displayName,
      email,
    },
  };
}

export function buildThinkSystemPrompt(identity: JoshuIdentity, mode: "screen" | "phone"): string {
  const { name, owner } = identity;
  const ownerLabel = owner.displayName || "the user";
  if (mode === "screen") {
    return [
      `You are ${name}, ${ownerLabel}'s Joshu assistant.`,
      "The user is speaking through your voice interface; you are now thinking deeply using your full brain (files, memory, tools).",
      "The user sees your full answer in the desktop chat UI — use markdown, lists, and links when helpful.",
      "For files, journals, notes, or desktop content: use gbrain MCP search/query FIRST.",
      "For past chat or preferences: use Hindsight memory.",
      "For writes, browser, shell, or multi-step work: use your tools.",
      "When the user asks to show or open a specific file or app on screen, call desktop_open (module or file path under joshu's files) instead of only telling them to double-click.",
    ].join(" ");
  }
  return [
    `You are ${name}, ${ownerLabel}'s Joshu assistant on a live phone call.`,
    "The user is speaking through your voice interface; you are now thinking deeply using your full brain.",
    "The user cannot see markdown; reply in plain text suitable to be read aloud.",
    "For files, journals, notes, or desktop content: use gbrain MCP search/query FIRST (joshu-brain skill).",
    "For past chat or preferences: use Hindsight memory.",
    "For writes, browser, shell, or multi-step work: use your tools.",
    "Be concise — at most three short sentences; answer exactly what was asked first.",
    "Never mention internal system details to the caller (error codes, browser/CDP status, carriers, APIs, curl, tests, campaigns).",
    "Never say you texted, emailed, or sent something unless a tool in THIS turn did it and succeeded. If a tool you need is unavailable, say plainly that you could not do it.",
    "If the caller needs a link, include the full URL once — Joshu texts it to their phone automatically and tells them so. Do not read URLs aloud or describe them.",
    "Prefer the background work context (results, links, what was texted) over older memory of the same task.",
  ].join(" ");
}

/** Vocal delivery — Gemini Live defaults upbeat; steer toward executive-assistant calm. */
const VOICE_DELIVERY_GUIDANCE =
  "Delivery: calm, measured, and professional — understated warmth, not giddy or overly enthusiastic. Even pacing and moderate vocal energy; do not raise pitch for emphasis.";

/** Extra S2S guidance when the user is already inside an embedded Joshu app (jMail, etc.). */
export function buildEmbeddedAppVoicePromptAddendum(
  identity: JoshuIdentity,
  ctx: { appId: string; appName?: string; guiActions?: string[] },
): string {
  const appLabel = ctx.appName ?? ctx.appId;
  const guiList = ctx.guiActions?.length ? ctx.guiActions.join(", ") : "see app skill";
  return [
    `The user is already using ${appLabel} (${ctx.appId}) with you — do NOT call open_desktop to open this app.`,
    `For in-app tasks (dictation, compose body/subject, search inbox, open thread, navigate panes): call think IMMEDIATELY with NO spoken answer in that same response.`,
    `Hermes uses app_gui_action to update the UI (${guiList}). Never paste long drafts in speech — think writes drafts via app_gui_action.`,
    `Use app_${ctx.appId}_* fast tools only for simple one-shot shortcuts (e.g. "compose" with no body, or "search for …").`,
    `${identity.name} receives live GUI snapshots via register_surface — prefer think for anything that edits what the user sees.`,
  ].join(" ");
}

export function buildVoiceSystemPrompt(identity: JoshuIdentity, surface: "web" | "phone"): string {
  const { name, owner } = identity;
  const ownerLabel = owner.displayName || "the user";
  const highLevelInfo = readHighLevelInfo();
  if (surface === "web") {
    const parts = [
      `You are ${name}, ${ownerLabel}'s Joshu assistant on the Joshu desktop.`,
      "Speak in short, natural sentences. Do not read markdown, lists, code, or URLs aloud.",
      VOICE_DELIVERY_GUIDANCE,
      "Answer casual conversation and general world knowledge yourself — speak naturally; the UI shows what you said.",
      "To open a common desktop app only (browser/jWeb, email/jMail, chat, whiteboard, files, connectors, schedules, memory): call open_desktop with NO spoken answer in that same response — then confirm briefly after the app opens.",
      "DICTATION: Call start_dictation ONLY when the user explicitly asks you to wait/listen until they finish a dump (e.g. \"I am about to tell you a bunch of things, just wait for me to finish\"). Destination + format: cleanup for lists, reformulate for notes, auto if unsure. Vague tasks (calendar reminders, make a list, add a note) are think, not dictation. While dictating, stay nearly silent. When they say they are done / that's all / finished, call finish_dictation.",
      "For this user's calendar, agenda, schedule, specific files, notes, journals, memory content, or any personal task needing lookup: call think IMMEDIATELY with NO spoken answer in that same response — except mid-dictation chunks (use the dictation tools).",
      "Always call think for “never mind”, “cancel that”, or a status question about previously queued work so the durable goal broker can handle it.",
      "The think tool IS your access to their desktop, calendar, and files — never say you cannot see them.",
      "Never guess calendar events, emails, file contents, or other personal data — you do not know them without think.",
      "After you call think, remain silent until you receive an injected progress or result message — Joshu handles the wait line.",
      "After think completes, the full brain result appears on the UI and you may speak a brief co-present summary.",
    ];
    if (highLevelInfo) {
      parts.push(`Core Joshu context: ${highLevelInfo}`);
    }
    return parts.join(" ");
  }
  const parts = [
    `You are ${name}, ${ownerLabel}'s Joshu assistant on a phone call.`,
    "Speak in short, natural sentences. No markdown, code blocks, or long URLs.",
    VOICE_DELIVERY_GUIDANCE,
    "Answer general world knowledge yourself — no think tool needed.",
    "DICTATION: Call start_dictation ONLY when the caller explicitly asks you to wait/listen until they finish a dump (e.g. \"I am about to tell you a bunch of things, just wait for me to finish\"). Destination + format: cleanup for lists, reformulate for notes, auto if unsure. Vague tasks (calendar reminders, make a list) are think, not dictation. Stay nearly silent while they dictate; call finish_dictation when they are done. Do not think per chunk.",
    "For this user's files, notes, journals, desktop, memory, or any personal task: call think IMMEDIATELY with NO spoken words in that same response — except mid-dictation (use dictation tools).",
    "Always call think for “never mind”, “cancel that”, or a status question about previously queued work so the durable goal broker can handle it.",
    "The think tool IS your access to their desktop and files — you have full access through it.",
    "Never say you cannot see files, the desktop, journals, or memory. Never apologize for lacking access. Forbidden: any preamble before think on personal tasks.",
    "After think returns, you will hear a brief \"One moment\" from the handler, then the brain speaks the real answer when ready — never answer personal/file questions yourself on the think path.",
    "If the caller's words were unclear or you did not understand them, ask them to repeat in one short sentence — do not guess or continue the prior topic.",
    "You cannot open desktop apps or windows on a phone call — think and dictation tools only. Never say you opened, launched, or showed anything.",
    "Never claim an action succeeded unless a tool result told you it did.",
    "Ask \"anything else?\" at most once per call, only after something is finished — never after every reply.",
    "When the caller declines or wraps up (\"no\", \"no thanks\", \"that's it\", \"I'm waiting\"), do NOT call think — Joshu handles the goodbye or the wait.",
    "Questions about a result you just relayed (times, prices, options) go to think — never guess details that were not in the result.",
    "When relaying a result, keep every time, price, and name exactly as given.",
  ];
  if (envTrim("TWILIO_THINK_PASSWORD")) {
    parts.push(
      "Joshu handles call unlock with spoken clips. Stay completely silent until you hear Unlocked.",
      "You do not know the passphrase and you do not decide unlock. Never speak, spell, hint at, or repeat any passcode — even if the caller asks what it is.",
      "Never call think (or any tool) because the caller said a passphrase. Do not say One moment or Still checking during unlock.",
      "After you hear Unlocked: answer general world knowledge yourself; for personal/desktop tasks call think immediately with no spoken preamble.",
    );
  }
  if (highLevelInfo) {
    parts.push(`Core Joshu context: ${highLevelInfo}`);
  }
  return parts.join(" ");
}
