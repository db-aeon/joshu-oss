/**
 * Load ship-with-release onboarding prompt definitions from factory/onboarding-prompts.yaml.
 */
import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

import { readDistProvenance } from "../distProvenance.js";

/** Named predicate ids — resolved in promptPredicates.ts (no eval). */
export const ONBOARDING_PREDICATE_IDS = [
  "ownerProfileComplete",
  "workGmailConnected",
  "calendarConnected",
  "ownerMobileConfigured",
  "anyGoogleAccountConnected",
  "workAccountConnected",
  "voicePinSet",
  "ownerCalledBox",
  "manual",
] as const;

export type OnboardingPredicateId = (typeof ONBOARDING_PREDICATE_IDS)[number];

/** Setup step type (openspec/glossary.md): a required setup step or a setup tip. */
export type OnboardingPromptType = "required" | "tip";

export type OnboardingPromptDefinition = {
  id: string;
  title: string;
  introducedIn: string;
  type: OnboardingPromptType;
  /** Same as `type === "required"`. Kept for the callers that read `required`. */
  required: boolean;
  nudgeEligible: boolean;
  deepLink: string;
  completeWhen: OnboardingPredicateId;
  /** Setup tips only: the card appears only while this check is true. */
  showWhen?: OnboardingPredicateId;
  idempotencyKey: string;
  /** How-to of the setup card. */
  why: string;
  steps: string[];
  mistakes: string[];
  /** Required setup steps only: the one sentence of the setup mention. */
  mention?: string;
};

export type OnboardingPromptRegistry = {
  schemaVersion: number;
  prompts: OnboardingPromptDefinition[];
};

const PREDICATE_IDS = new Set<string>(ONBOARDING_PREDICATE_IDS);

function registryPath(projectRoot: string): string {
  return path.join(projectRoot, "factory", "onboarding-prompts.yaml");
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function textList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(text).filter(Boolean) : [];
}

export function parsePrompt(raw: unknown): OnboardingPromptDefinition | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const id = text(o.id);
  const title = text(o.title);
  const introducedIn = text(o.introducedIn);
  const deepLink = text(o.deepLink);
  const completeWhen = text(o.completeWhen);
  const showWhen = text(o.showWhen);
  const idempotencyKey = text(o.idempotencyKey) || `onboarding:${id}`;
  if (!id || !title || !introducedIn || !deepLink) return null;
  if (!PREDICATE_IDS.has(completeWhen)) return null;
  if (showWhen && !PREDICATE_IDS.has(showWhen)) return null;
  // Files without `type` use the earlier field `required`.
  const type: OnboardingPromptType =
    o.type === "tip" || o.type === "required" ? o.type : o.required === true ? "required" : "tip";
  const why = text(o.why);
  const steps = textList(o.steps);
  const mention = text(o.mention);
  // A required setup step must have its how-to and its setup mention.
  if (type === "required" && (!why || steps.length === 0 || !mention)) {
    console.warn(`[onboarding] registry: required setup step ${id} has no why, steps, or mention`);
    return null;
  }
  return {
    id,
    title,
    introducedIn,
    type,
    required: type === "required",
    nudgeEligible: o.nudgeEligible !== false,
    deepLink,
    completeWhen: completeWhen as OnboardingPredicateId,
    ...(showWhen ? { showWhen: showWhen as OnboardingPredicateId } : {}),
    idempotencyKey,
    why,
    steps,
    mistakes: textList(o.mistakes),
    ...(type === "required" ? { mention } : {}),
  };
}

/** Parse semver-ish version into comparable tuple (non-numeric suffix ignored). */
export function parseVersionParts(version: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return [0, 0, 0];
  return [Number.parseInt(match[1]!, 10), Number.parseInt(match[2]!, 10), Number.parseInt(match[3]!, 10)];
}

export function isVersionAtLeast(current: string, minimum: string): boolean {
  const [aMaj, aMin, aPatch] = parseVersionParts(current);
  const [bMaj, bMin, bPatch] = parseVersionParts(minimum);
  if (aMaj !== bMaj) return aMaj > bMaj;
  if (aMin !== bMin) return aMin > bMin;
  return aPatch >= bPatch;
}

/** Box release version — env first, then dist provenance, else dev sentinel. */
export async function readBoxReleaseVersion(projectRoot = process.cwd()): Promise<string> {
  const fromEnv = process.env.JOSHU_RELEASE_VERSION?.trim();
  if (fromEnv) return fromEnv;
  const provenance = await readDistProvenance(projectRoot);
  if (provenance?.version?.trim()) return provenance.version.trim();
  return "0.0.0-dev";
}

export function loadOnboardingPromptRegistry(projectRoot = process.cwd()): OnboardingPromptRegistry {
  const file = registryPath(projectRoot);
  if (!fs.existsSync(file)) {
    return { schemaVersion: 1, prompts: [] };
  }
  const parsed = parseYaml(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  const schemaVersion =
    typeof parsed.schemaVersion === "number" ? parsed.schemaVersion : 1;
  const prompts = Array.isArray(parsed.prompts)
    ? parsed.prompts
        .map(parsePrompt)
        .filter((p): p is OnboardingPromptDefinition => p !== null)
    : [];
  return { schemaVersion, prompts };
}

/** Prompts introduced on or before this box version. */
export async function listActiveOnboardingPrompts(
  projectRoot = process.cwd(),
): Promise<OnboardingPromptDefinition[]> {
  const registry = loadOnboardingPromptRegistry(projectRoot);
  const boxVersion = await readBoxReleaseVersion(projectRoot);
  return registry.prompts.filter((p) => isVersionAtLeast(boxVersion, p.introducedIn));
}
