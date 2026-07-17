/**
 * Simple in-memory per-share rate limiter for public share-chat.
 */

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSec: number;
  remaining: number;
}

/**
 * Fixed-window limiter keyed by share UUID (+ optional client id).
 * Default: 30 requests / 60s per key.
 */
export function checkShareChatRateLimit(
  key: string,
  opts?: { limit?: number; windowMs?: number },
): RateLimitResult {
  const limit = opts?.limit ?? 30;
  const windowMs = opts?.windowMs ?? 60_000;
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + windowMs };
    buckets.set(key, bucket);
  }
  if (bucket.count >= limit) {
    return {
      allowed: false,
      retryAfterSec: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
      remaining: 0,
    };
  }
  bucket.count += 1;
  return {
    allowed: true,
    retryAfterSec: 0,
    remaining: Math.max(0, limit - bucket.count),
  };
}

/** Test helper */
export function resetShareChatRateLimits(): void {
  buckets.clear();
}
