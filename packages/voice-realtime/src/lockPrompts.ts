/**
 * Deterministic spoken lines for a passphrase-locked PSTN call.
 *
 * These lines must say exactly what they say. Routing them through the
 * speech-to-speech model does not guarantee that: asked to say "That's not the
 * passphrase. Please try again.", Gemini Live has been observed saying
 * "Thank you." and even "Unlocked. What…" — telling the caller they were let in
 * while the call was still locked, so the caller then talks to a line that
 * cannot answer. The words also carry the security story, so a paraphrase is a
 * correctness bug, not a style one.
 *
 * So each line is pre-rendered to audio in the box's own Joshu voice (see
 * generateLockPromptClips.ts, run at service start) and played straight down
 * the Twilio media stream, bypassing the model. Clips are optional: with none
 * present the session falls back to instructing the model, which sounds natural
 * but can go off-script.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { pcm24kB64ToMulaw8kB64 } from "./audioResample.js";

/**
 * Every line the caller can hear before the passphrase is accepted, plus the
 * transition lines right after it. Keep the text here identical to the clip
 * the generator renders — this object is the generator's input too.
 */
export const LOCK_PROMPTS = {
  greeting: "Hi. Please say your passphrase.",
  greeting_guest:
    "Hello. This phone session is limited to sixty seconds. Please say your passphrase.",
  unclear: "Sorry, I didn't catch that. Please say your passphrase.",
  need_passphrase: "Please say your passphrase.",
  retry: "That's not the passphrase. Please try again.",
  last_try: "That's not the passphrase. One try left.",
  locked_out: "Too many incorrect attempts. Goodbye.",
  unlocked: "Unlocked. Please repeat your request.",
  // Outbound goal callbacks: the result follows immediately — do not invite the
  // owner to restate the original task (that got written onto the card).
  unlocked_callback: "Unlocked. I have an update for you.",
  restate_intent: "Please repeat what you want me to do now that you're unlocked.",
  time_warning: "Heads up — this call is almost out of time. You have about thirty seconds left.",
  time_up: "This call has reached its time limit. I need to hang up now. Goodbye.",
} as const;

export type LockPromptKey = keyof typeof LOCK_PROMPTS;

export const LOCK_PROMPT_KEYS = Object.keys(LOCK_PROMPTS) as LockPromptKey[];

/** Twilio Media Streams play μ-law 8 kHz, so one byte is one sample. */
const MULAW_BYTES_PER_SECOND = 8000;

export type LockPromptClip = {
  /** μ-law 8 kHz, base64 — ready to hand to Twilio as `media.payload`. */
  mulawB64: string;
  /** Playback length, for scheduling a hang-up after the clip drains. */
  durationMs: number;
};

const cache = new Map<LockPromptKey, LockPromptClip | null>();

function envTrim(name: string): string {
  return process.env[name]?.trim() ?? "";
}

/**
 * Clips are voice-realtime's own derived cache, not owner data, and the service
 * mounts the ArozOS volume read-only — so they live in a directory it owns. In
 * the container that is a small dedicated volume; in local dev it falls back
 * inside the package.
 */
export function lockPromptDir(): string {
  const explicit = envTrim("VOICE_LOCK_PROMPT_DIR");
  if (explicit) return explicit;
  if (existsSync("/var/lib/joshu-voice")) return "/var/lib/joshu-voice/lock";
  return join(dirname(fileURLToPath(import.meta.url)), "..", ".cache", "lock-prompts");
}

function clipPath(key: LockPromptKey): string {
  return join(lockPromptDir(), `${key}.pcm.b64`);
}

/** Generated as PCM16 mono @ 24 kHz (same format as the rest of the voice clips). */
function loadClip(key: LockPromptKey): LockPromptClip | null {
  const path = clipPath(key);
  if (!existsSync(path)) return null;
  try {
    const pcmB64 = readFileSync(path, "utf8").replace(/\s/g, "");
    if (!pcmB64) return null;
    const mulawB64 = pcm24kB64ToMulaw8kB64(pcmB64);
    if (!mulawB64) return null;
    const bytes = Buffer.byteLength(mulawB64, "base64");
    return { mulawB64, durationMs: Math.round((bytes / MULAW_BYTES_PER_SECOND) * 1000) };
  } catch {
    return null;
  }
}

/** Cached per process — clips only change when the box regenerates them. */
export function getLockPromptClip(key: LockPromptKey): LockPromptClip | null {
  if (!cache.has(key)) cache.set(key, loadClip(key));
  return cache.get(key) ?? null;
}

/**
 * True when the box has clips for every line that can play while locked, so the
 * session can safely mute the model for the whole locked phase. Partial clip
 * sets stay on the model path rather than risk a silent call.
 */
export function lockPromptsReady(): boolean {
  return LOCK_PROMPT_KEYS.every((key) => getLockPromptClip(key) !== null);
}

/** Clear cache after the box regenerates clips (e.g. voice identity change). */
export function clearLockPromptCache(): void {
  cache.clear();
}
