/** Release pins that a release update writes to /etc/joshu/instance.env. */

import { instanceAgentImageRefFromSandbox, voiceImageRefFromSandbox } from "./voiceImageRef.js";

function payloadString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  return typeof value === "string" ? value.trim() : "";
}

/**
 * instance.env keys for a release update payload. The voice image and the agent image
 * follow the tag of the sandbox image unless the payload names them.
 */
export function releaseEnvUpdates(payload: Record<string, unknown>): Record<string, string> {
  const updates: Record<string, string> = {};
  const imageRef = payloadString(payload, "imageRef");
  if (imageRef) {
    updates.JOSHU_IMAGE_REF = imageRef;
  }
  const version = payloadString(payload, "version");
  if (version) {
    updates.JOSHU_RELEASE_VERSION = version;
  }
  const hermesRef = payloadString(payload, "hermesRef");
  if (hermesRef) {
    updates.HERMES_AGENT_REF = hermesRef;
  }
  const explicitVoice = payloadString(payload, "voiceImageRef");
  if (explicitVoice || imageRef) {
    updates.JOSHU_VOICE_IMAGE_REF = voiceImageRefFromSandbox(imageRef, explicitVoice);
  }
  const explicitAgent = payloadString(payload, "instanceAgentImageRef");
  if (explicitAgent || imageRef) {
    updates.JOSHU_INSTANCE_AGENT_IMAGE_REF = instanceAgentImageRefFromSandbox(imageRef, explicitAgent);
  }
  return updates;
}

/**
 * Hermes models that the control plane wrote into JOSHU_HERMES_MODEL of instance.env at
 * provision, before the release owned the model (joshu change release-hermes-model).
 * src/joshuOpenRouterDefaults.ts (CONTROL_PLANE_HERMES_MODELS) has the same list;
 * scripts/test-release-hermes-model.mjs compares them.
 */
export const CONTROL_PLANE_HERMES_MODELS: readonly string[] = [
  "deepseek/deepseek-v4-flash",
  "deepseek/deepseek-v4-flash-0731",
  "deepseek/deepseek-v4.1-flash",
];

/**
 * Hindsight models that the control plane wrote into HINDSIGHT_API_LLM_MODEL of instance.env at
 * provision, before the release owned the model (joshu change release-hindsight-model).
 * src/joshuOpenRouterDefaults.ts (CONTROL_PLANE_HINDSIGHT_LLM_MODELS) has the same list;
 * scripts/test-release-hermes-model.mjs compares them.
 */
export const CONTROL_PLANE_HINDSIGHT_LLM_MODELS: readonly string[] = ["google/gemini-3.1-flash-lite"];

/**
 * instance.env keys that a release update removes. JOSHU_HERMES_MODEL and HINDSIGHT_API_LLM_MODEL
 * go when they name a model that the control plane wrote, so the box runs the models of the new
 * release. Another value is a deliberate override and stays.
 */
export function releaseEnvRemovals(current: Record<string, string | undefined>): string[] {
  const removals: string[] = [];
  const hermes = (current.JOSHU_HERMES_MODEL ?? "").trim().toLowerCase();
  if (hermes && CONTROL_PLANE_HERMES_MODELS.includes(hermes)) removals.push("JOSHU_HERMES_MODEL");
  // Only for OpenRouter: the release Hindsight model is an OpenRouter model id, and the start
  // script of Hindsight has a fallback only for that provider.
  const hindsight = (current.HINDSIGHT_API_LLM_MODEL ?? "").trim().toLowerCase();
  const hindsightProvider = (current.HINDSIGHT_API_LLM_PROVIDER ?? "").trim().toLowerCase();
  if (hindsight && hindsightProvider === "openrouter" && CONTROL_PLANE_HINDSIGHT_LLM_MODELS.includes(hindsight)) {
    removals.push("HINDSIGHT_API_LLM_MODEL");
  }
  return removals;
}
