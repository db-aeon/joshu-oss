import type { StatusReport } from "./types.js";

interface CamofoxHealth {
  ok?: boolean;
  engine?: string;
  browserConnected?: boolean;
  browserRunning?: boolean;
  warming?: boolean;
  activeTabs?: number;
  activeSessions?: number;
}

/** Standalone viewer page (fixed 4:3 host); stock vnc.html scales to the full window. */
export function buildNoVncStandaloneUrl(appBasePath: string): string {
  const base = (appBasePath || "").replace(/\/+$/, "");
  return `${base}/camofox-viewer.html?v=vnc-fill-8`;
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
  novncUrl: string;
  novncClientUrl?: string;
  appBasePath?: string;
  timeoutMs?: number;
}): Promise<Pick<StatusReport, "camofox" | "novnc">> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 2_500);
  let health: CamofoxHealth | null = null;

  try {
    health = await fetchHealth(opts.camofoxUrl, controller.signal);
  } finally {
    clearTimeout(timer);
  }

  const clientBaseUrl = (opts.novncClientUrl ?? opts.novncUrl).replace(/\/+$/, "");

  return {
    camofox: {
      reachable: !!health,
      url: opts.camofoxUrl,
      health: health ?? undefined,
      error: health ? undefined : `Could not reach Camofox at ${opts.camofoxUrl}`,
    },
    novnc: {
      baseUrl: opts.novncUrl,
      embedUrl: buildNoVncStandaloneUrl(opts.appBasePath ?? ""),
      clientBaseUrl,
      websocketPath: `${clientBaseUrl}/websockify`,
    },
  };
}
