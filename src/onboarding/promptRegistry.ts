/**
 * Load ship-with-release onboarding prompt definitions from factory/onboarding-prompts.yaml.
 */
import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

import { readDistProvenance } from "../distProvenance.js";

/** Named predicate ids — resolved in promptPredicates.ts (no eval). */
export type OnboardingPredicateId = "workGmailConnected" | "ownerMobileConfigured";

export type OnboardingPromptDefinition = {
  id: string;
  title: string;
  introducedIn: string;
  required: boolean;
  nudgeEligible: boolean;
  deepLink: string;
  completeWhen: OnboardingPredicateId;
  idempotencyKey: string;
};

export type OnboardingPromptRegistry = {
  schemaVersion: number;
  prompts: OnboardingPromptDefinition[];
};

const PREDICATE_IDS = new Set<string>(["workGmailConnected", "ownerMobileConfigured"]);

function registryPath(projectRoot: string): string {
  return path.join(projectRoot, "factory", "onboarding-prompts.yaml");
}

function parsePrompt(raw: unknown): OnboardingPromptDefinition | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === "string" ? o.id.trim() : "";
  const title = typeof o.title === "string" ? o.title.trim() : "";
  const introducedIn = typeof o.introducedIn === "string" ? o.introducedIn.trim() : "";
  const deepLink = typeof o.deepLink === "string" ? o.deepLink.trim() : "";
  const completeWhen = typeof o.completeWhen === "string" ? o.completeWhen.trim() : "";
  const idempotencyKey =
    typeof o.idempotencyKey === "string" ? o.idempotencyKey.trim() : `onboarding:${id}`;
  if (!id || !title || !introducedIn || !deepLink) return null;
  if (!PREDICATE_IDS.has(completeWhen)) return null;
  return {
    id,
    title,
    introducedIn,
    required: o.required === true,
    nudgeEligible: o.nudgeEligible !== false,
    deepLink,
    completeWhen: completeWhen as OnboardingPredicateId,
    idempotencyKey,
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
