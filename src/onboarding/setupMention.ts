/**
 * Setup mention (openspec/glossary.md): while a required setup step is open, the companion ends
 * one reply each day on each channel with one sentence about the first open required setup step.
 * No LLM: the sentence is field `mention` of the setup step in factory/onboarding-prompts.yaml.
 */
import { getOwnerTimeAnchor } from "../ownerLocalTime.js";
import { evaluateOnboardingPredicate } from "./promptPredicates.js";
import { listActiveOnboardingPrompts } from "./promptRegistry.js";
import { readOnboardingPromptState, shouldSuppressPrompt, writeOnboardingPromptState } from "./promptState.js";

export type SetupMentionChannel = "jchat" | "sms" | "pstn_voice" | "slack" | "telegram" | "email";

const SETUP_MENTION_CHANNELS = new Set<string>(["jchat", "sms", "pstn_voice", "slack", "telegram", "email"]);

export function isSetupMentionChannel(channel: string): channel is SetupMentionChannel {
  return SETUP_MENTION_CHANNELS.has(channel);
}

/** The sentence of the first open required setup step, or null when required setup is done. */
export async function firstOpenSetupMention(projectRoot = process.cwd()): Promise<string | null> {
  const state = readOnboardingPromptState(projectRoot);
  for (const prompt of await listActiveOnboardingPrompts(projectRoot)) {
    if (prompt.type !== "required" || !prompt.mention) continue;
    if (shouldSuppressPrompt(state, prompt.id)) continue;
    if (await evaluateOnboardingPredicate(prompt.completeWhen, projectRoot)) continue;
    return prompt.mention;
  }
  return null;
}

/** The setup mention of `channel` when one is due today; records nothing. */
export async function peekSetupMention(
  projectRoot: string,
  channel: SetupMentionChannel,
  now = new Date(),
): Promise<string | null> {
  const today = getOwnerTimeAnchor(projectRoot, now).localDate;
  if (readOnboardingPromptState(projectRoot).mentions?.[channel] === today) return null;
  return firstOpenSetupMention(projectRoot);
}

/** Record that `channel` got its setup mention today. Returns false when the date was not saved. */
export function recordSetupMention(projectRoot: string, channel: SetupMentionChannel, now = new Date()): boolean {
  const today = getOwnerTimeAnchor(projectRoot, now).localDate;
  const state = readOnboardingPromptState(projectRoot);
  try {
    writeOnboardingPromptState({ ...state, mentions: { ...state.mentions, [channel]: today } }, projectRoot);
    return true;
  } catch (err) {
    console.warn(`[onboarding] setup mention date not saved: ${(err as Error).message}`);
    return false;
  }
}

/**
 * The setup mention for one turn on `channel`, at most once each owner-local day on each channel.
 * Records the date when it returns a sentence, so the next call on the same day and channel returns null.
 */
export async function takeSetupMention(
  projectRoot: string,
  channel: SetupMentionChannel,
  now = new Date(),
): Promise<string | null> {
  const mention = await peekSetupMention(projectRoot, channel, now);
  if (!mention) return null;
  // Without a stored date the mention would repeat on every turn. Skip it.
  return recordSetupMention(projectRoot, channel, now) ? mention : null;
}

/** Context line for the companion. The caller adds it to the turn as a system message. */
export function setupMentionInstruction(mention: string): string {
  return `Setup reminder: end your reply with this one sentence, in your own voice: ${mention}`;
}
