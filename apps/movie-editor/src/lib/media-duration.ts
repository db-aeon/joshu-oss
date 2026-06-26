/** Cache key for intrinsic media duration (full source URL or path). */
export function getMediaDurationKey(source?: string): string | null {
  if (!source || typeof source !== "string") return null;
  const trimmed = source.trim();
  return trimmed.length > 0 ? trimmed : null;
}
