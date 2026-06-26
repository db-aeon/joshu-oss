/** GHCR image ref for voice-realtime, aligned with joshu-sandbox release tags. */

export function voiceImageRefFromSandbox(
  sandboxImageRef: string,
  explicitVoiceImageRef?: string | null,
): string {
  const explicit = explicitVoiceImageRef?.trim();
  if (explicit) return explicit;

  const trimmed = sandboxImageRef.trim();
  if (trimmed.includes("/joshu-sandbox:")) {
    return trimmed.replace("/joshu-sandbox:", "/joshu-voice-realtime:");
  }
  const colon = trimmed.lastIndexOf(":");
  if (colon > 0) {
    return `${trimmed.slice(0, colon)}-voice-realtime${trimmed.slice(colon)}`;
  }
  return `${trimmed}-voice-realtime`;
}
