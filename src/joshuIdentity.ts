/**
 * Per-instance Joshu assistant identity (persona name, owner, portrait, voice).
 * Platform name is always "Joshu"; this module is the named assistant on one instance.
 */

import fs from "node:fs";
import path from "node:path";
import { provisionEnvTrim } from "./provisionInstanceEnv.js";
import { syncHermesContextFile } from "./hermesContextFile.js";
import { joshuConfigDir } from "./nylas/paths.js";

export type JoshuIdentitySource = "bootstrap" | "local" | "control-plane";

export interface JoshuIdentity {
  schemaVersion: 1;
  /** Assistant persona name — not the platform name. */
  name: string;
  /** Full Ideogram portrait URL (email signature, public profile). */
  imageUrl: string | null;
  /** Gravatar-style square avatar URL (chat tray, in-app persona). */
  avatarUrl: string | null;
  /** Voice provider id, e.g. OpenAI Realtime voice (stub). */
  voiceId: string | null;
  owner: {
    displayName: string;
    /** Resolved from env at read time when not stored in file. */
    email?: string;
  };
  updatedAt?: string;
  source?: JoshuIdentitySource;
}

export const DEFAULT_JOSHU_IDENTITY: JoshuIdentity = {
  schemaVersion: 1,
  name: "Companion",
  imageUrl: null,
  avatarUrl: null,
  voiceId: null,
  owner: { displayName: "Owner" },
  source: "bootstrap",
};

function envTrim(name: string): string | undefined {
  return provisionEnvTrim(name);
}

function ownerEmailFromEnv(): string | undefined {
  return envTrim("JOSHU_OWNER_EMAIL") || envTrim("JOSHU_AROZ_USER");
}

/** Path to `.joshu/identity.json` for the resolved ArozOS user, if available. */
export function joshuIdentityPath(projectRoot = process.cwd()): string | null {
  const dir = joshuConfigDir(projectRoot);
  if (!dir) return null;
  return path.join(dir, "identity.json");
}

function normalizeIdentity(raw: unknown): JoshuIdentity | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const ownerRaw = o.owner;
  const ownerObj =
    ownerRaw && typeof ownerRaw === "object" ? (ownerRaw as Record<string, unknown>) : {};
  const displayName =
    typeof ownerObj.displayName === "string" && ownerObj.displayName.trim()
      ? ownerObj.displayName.trim()
      : DEFAULT_JOSHU_IDENTITY.owner.displayName;
  const name =
    typeof o.name === "string" && o.name.trim() ? o.name.trim() : DEFAULT_JOSHU_IDENTITY.name;
  const imageUrl =
    typeof o.imageUrl === "string" && o.imageUrl.trim() ? o.imageUrl.trim() : null;
  const avatarUrl =
    typeof o.avatarUrl === "string" && o.avatarUrl.trim() ? o.avatarUrl.trim() : null;
  const voiceId =
    typeof o.voiceId === "string" && o.voiceId.trim() ? o.voiceId.trim() : null;
  const email =
    typeof ownerObj.email === "string" && ownerObj.email.trim()
      ? ownerObj.email.trim()
      : undefined;
  return {
    schemaVersion: 1,
    name,
    imageUrl,
    avatarUrl,
    voiceId,
    owner: { displayName, email },
    updatedAt: typeof o.updatedAt === "string" ? o.updatedAt : undefined,
    source:
      o.source === "bootstrap" || o.source === "local" || o.source === "control-plane"
        ? o.source
        : undefined,
  };
}

/** Read identity from disk only (no env merge, no bootstrap). */
export function readJoshuIdentity(projectRoot = process.cwd()): JoshuIdentity | null {
  const file = joshuIdentityPath(projectRoot);
  if (!file || !fs.existsSync(file)) return null;
  try {
    return normalizeIdentity(JSON.parse(fs.readFileSync(file, "utf8")) as unknown);
  } catch {
    return null;
  }
}

/** Merge env overrides onto a base identity and attach owner email from env. */
export function applyIdentityEnvOverrides(base: JoshuIdentity): JoshuIdentity {
  const name = envTrim("JOSHU_NAME") ?? base.name;
  const displayName = envTrim("JOSHU_OWNER_NAME") ?? base.owner.displayName;
  const imageUrl = envTrim("JOSHU_IMAGE_URL") ?? base.imageUrl;
  const avatarUrl = envTrim("JOSHU_AVATAR_URL") ?? base.avatarUrl;
  const voiceId = envTrim("JOSHU_VOICE_ID") ?? base.voiceId;
  const email = ownerEmailFromEnv() ?? base.owner.email;
  return {
    ...base,
    name,
    imageUrl: imageUrl ?? null,
    avatarUrl: avatarUrl ?? null,
    voiceId: voiceId ?? null,
    owner: { displayName, email },
  };
}

export function writeJoshuIdentity(
  partial: Partial<Omit<JoshuIdentity, "schemaVersion">>,
  projectRoot = process.cwd(),
): boolean {
  const file = joshuIdentityPath(projectRoot);
  if (!file) return false;
  const existing = readJoshuIdentity(projectRoot) ?? { ...DEFAULT_JOSHU_IDENTITY };
  const merged: JoshuIdentity = {
    schemaVersion: 1,
    name: partial.name?.trim() || existing.name,
    imageUrl: partial.imageUrl !== undefined ? partial.imageUrl : existing.imageUrl,
    avatarUrl: partial.avatarUrl !== undefined ? partial.avatarUrl : existing.avatarUrl,
    voiceId: partial.voiceId !== undefined ? partial.voiceId : existing.voiceId,
    owner: {
      displayName: partial.owner?.displayName?.trim() || existing.owner.displayName,
      email: partial.owner?.email?.trim() || existing.owner.email,
    },
    updatedAt: new Date().toISOString(),
    source: partial.source ?? existing.source ?? "local",
  };
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(merged, null, 2), { mode: 0o600 });
  syncHermesContextFile(projectRoot);
  return true;
}

/**
 * Resolve identity: file → env overrides → defaults; bootstrap identity.json when missing.
 */
export function resolveJoshuIdentity(projectRoot = process.cwd()): JoshuIdentity {
  const fromFile = readJoshuIdentity(projectRoot);
  if (!fromFile) {
    writeJoshuIdentity({ ...DEFAULT_JOSHU_IDENTITY, source: "bootstrap" }, projectRoot);
  }
  const base = readJoshuIdentity(projectRoot) ?? { ...DEFAULT_JOSHU_IDENTITY };
  return applyIdentityEnvOverrides(base);
}

/** Chat/tray persona image — gravatar avatar preferred over full portrait. */
export function resolveJoshuAvatarUrl(identity: Pick<JoshuIdentity, "avatarUrl" | "imageUrl">): string | null {
  return identity.avatarUrl?.trim() || identity.imageUrl?.trim() || null;
}

/** Hermes system prompt when the voice layer invokes `think` (brain / deep work). */
export function buildThinkSystemPrompt(
  identity: JoshuIdentity,
  mode: "screen" | "phone",
): string {
  const { name, owner } = identity;
  const ownerLabel = owner.displayName || "the user";
  if (mode === "screen") {
    return [
      `You are ${name}, ${ownerLabel}'s Joshu assistant.`,
      "The user is speaking through your voice interface; you are now thinking deeply using your full brain (files, memory, tools).",
      "The user sees your full answer in the desktop chat UI — use markdown, lists, and links when helpful.",
      "For mail find/search/recall, load skill joshu-mail (gbrain → mirrors → Composio workbench).",
      "For past chat or preferences: use Hindsight memory.",
      "For writes, browser, shell, or multi-step work: use your tools.",
    ].join(" ");
  }
  return [
    `You are ${name}, ${ownerLabel}'s Joshu assistant on a live phone call.`,
    "The user is speaking through your voice interface; you are now thinking deeply using your full brain.",
    "The user cannot see markdown; reply in plain text suitable to be read aloud.",
    "For mail find/search/recall, load joshu-mail skill; gbrain is step 1 inside it.",
    "For past chat or preferences: use Hindsight memory.",
    "For writes, browser, shell, or multi-step work: use your tools.",
    "Be concise — one or two short paragraphs max for phone.",
  ].join(" ");
}

/** Vocal delivery — Gemini Live defaults upbeat; steer toward executive-assistant calm. */
const VOICE_DELIVERY_GUIDANCE =
  "Delivery: calm, measured, and professional — understated warmth, not giddy or overly enthusiastic. Even pacing and moderate vocal energy; do not raise pitch for emphasis.";

/** Build Realtime voice layer system prompts from identity. */
export function buildVoiceSystemPrompt(identity: JoshuIdentity, surface: "web" | "phone"): string {
  const { name, owner } = identity;
  const ownerLabel = owner.displayName || "the user";
  if (surface === "web") {
    return [
      `You are ${name}, ${ownerLabel}'s Joshu assistant in a desktop app with a chat UI beside you.`,
      "Speak in short, natural sentences. Do not read markdown, lists, code, or URLs aloud.",
      VOICE_DELIVERY_GUIDANCE,
      "Answer general world knowledge yourself out loud when appropriate.",
      "The chat UI shows your complete thoughts from the brain — do not worry about matching on-screen text.",
      "For this user's files, notes, journals, desktop, memory, or any personal task, call think once.",
      "When you call think, you may say one brief phrase (e.g. \"One moment\"); do not repeat after the tool returns. Full results appear in the chat UI.",
    ].join(" ");
  }
  return [
    `You are ${name}, ${ownerLabel}'s Joshu assistant on a phone call.`,
    "Speak in short, natural sentences. No markdown, code blocks, or long URLs.",
    VOICE_DELIVERY_GUIDANCE,
    "Answer general world knowledge yourself — no think tool needed.",
    "For this user's files, notes, journals, desktop, memory, or any personal task: call think IMMEDIATELY with NO spoken words in that same response.",
    "The think tool IS your access to their desktop and files — you have full access through it.",
    "Never say you cannot see files, the desktop, journals, or memory. Never apologize for lacking access. Forbidden: any preamble before think on personal tasks.",
    "After think returns, you will hear a brief \"One moment\" from the handler, then the brain speaks the real answer when ready — never answer personal/file questions yourself on the think path.",
    "If the caller's words were unclear or you did not understand them, ask them to repeat in one short sentence — do not guess or continue the prior topic.",
  ].join(" ");
}
