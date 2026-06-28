/** Minimal JSON fetch helper for Joshu REST. */

export class PlatformDataError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "PlatformDataError";
  }
}

export function resolveApiBase(explicit?: string): string {
  if (explicit?.trim()) return explicit.replace(/\/+$/, "");
  if (typeof process !== "undefined" && process.env?.JOSHU_API_BASE_URL?.trim()) {
    return process.env.JOSHU_API_BASE_URL.trim().replace(/\/+$/, "");
  }
  return "/joshu/api";
}

export async function jsonFetch<T>(
  fetchFn: typeof fetch,
  url: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetchFn(url, init);
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = text;
    }
  }
  if (!res.ok) {
    const msg =
      body && typeof body === "object" && body !== null && "error" in body
        ? String((body as { error: unknown }).error)
        : `Request failed: ${res.status}`;
    throw new PlatformDataError(msg, res.status, body);
  }
  return body as T;
}
