import type { StatusReport } from "./types.js";

/** Health of the Chromium supervisor (CAMOFOX_URL, port 9377). The name is older than Chromium. */
interface CamofoxHealth {
  ok?: boolean;
  engine?: string;
  browserConnected?: boolean;
  browserRunning?: boolean;
  warming?: boolean;
  activeTabs?: number;
  activeSessions?: number;
}

async function fetchHealth(camofoxUrl: string, signal: AbortSignal): Promise<CamofoxHealth | null> {
  try {
    const res = await fetch(`${camofoxUrl.replace(/\/+$/, "")}/health`, { signal });
    if (!res.ok && res.status !== 503) return null;
    return (await res.json()) as CamofoxHealth;
  } catch {
    return null;
  }
}

export async function getCamofoxStatus(opts: {
  camofoxUrl: string;
  timeoutMs?: number;
}): Promise<Pick<StatusReport, "camofox">> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 2_500);
  let health: CamofoxHealth | null = null;

  try {
    health = await fetchHealth(opts.camofoxUrl, controller.signal);
  } finally {
    clearTimeout(timer);
  }

  return {
    camofox: {
      reachable: !!health,
      url: opts.camofoxUrl,
      health: health ?? undefined,
      error: health ? undefined : `Could not reach the shared browser at ${opts.camofoxUrl}`,
    },
  };
}
