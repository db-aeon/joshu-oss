/** GHCR image refs of the release images, aligned with joshu-sandbox release tags. */

/**
 * Image ref of a sibling release image with the same tag as the sandbox image.
 * `joshu-sandbox:X` → `joshu-<name>:X`; OSS `joshu-oss:X` → `joshu-oss-<name>:X`.
 */
function siblingImageRef(sandboxImageRef: string, name: string, explicit?: string | null): string {
  const override = explicit?.trim();
  if (override) return override;

  const trimmed = sandboxImageRef.trim();
  if (trimmed.includes("/joshu-oss:")) {
    return trimmed.replace("/joshu-oss:", `/joshu-oss-${name}:`);
  }
  if (trimmed.includes("/joshu-sandbox:")) {
    return trimmed.replace("/joshu-sandbox:", `/joshu-${name}:`);
  }
  const colon = trimmed.lastIndexOf(":");
  if (colon > 0) {
    return `${trimmed.slice(0, colon)}-${name}${trimmed.slice(colon)}`;
  }
  return `${trimmed}-${name}`;
}

export function voiceImageRefFromSandbox(
  sandboxImageRef: string,
  explicitVoiceImageRef?: string | null,
): string {
  return siblingImageRef(sandboxImageRef, "voice-realtime", explicitVoiceImageRef);
}

/** Agent image of the release (change image-owned-box-runtime). */
export function instanceAgentImageRefFromSandbox(
  sandboxImageRef: string,
  explicitAgentImageRef?: string | null,
): string {
  return siblingImageRef(sandboxImageRef, "instance-agent", explicitAgentImageRef);
}
