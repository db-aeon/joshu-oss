import type { DataTier, MailProvider } from "./types.js";

/** Resolve mail read URL for cache vs live tier. Live Gmail uses connectors search with live flag when available. */
export function resolveMailSearchPath(
  apiBase: string,
  provider: MailProvider,
  params: URLSearchParams,
  tier: DataTier,
): string {
  if (tier === "sync") {
    throw new Error("Use mail.sync() for tier sync, not search");
  }
  const base = `${apiBase}/connectors/mail/${provider}/search`;
  if (tier === "live" && provider === "gmail") {
    params.set("live", "true");
  }
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

export function resolveMailSyncPath(apiBase: string, provider: MailProvider): string {
  return `${apiBase}/connectors/mail/${provider}/sync`;
}

export function resolveMailMirrorPath(apiBase: string, provider: MailProvider): string {
  return `${apiBase}/connectors/mail/${provider}/mirror`;
}
