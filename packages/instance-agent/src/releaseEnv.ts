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
