const PORTRAIT_FALLBACK = "/img/joshu/chat-portrait.jpg";

/** Companion portrait for chat heads and bubbles (prefers avatar over full portrait). */
export function resolvePortraitUrl(
  imageUrl: string | null | undefined,
  avatarUrl?: string | null | undefined,
): string {
  if (avatarUrl?.trim()) return avatarUrl.trim();
  if (imageUrl?.trim()) return imageUrl.trim();
  if (typeof window !== "undefined") {
    try {
      return new URL(PORTRAIT_FALLBACK, window.location.origin).href;
    } catch {
      /* fall through */
    }
  }
  return PORTRAIT_FALLBACK;
}
