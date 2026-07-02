/**
 * Embedded app context for voice think — mirrors src/agUiAppContext.ts for voice-realtime.
 */

import type { ChatMessage } from "./brainThink.js";

const JOSHU_API_BASE = (process.env.JOSHU_API_BASE_URL ?? "http://127.0.0.1:8788/joshu").replace(
  /\/+$/,
  "",
);

export type EmbeddedAppSurfaceContext = {
  appId: string;
  threadId: string;
  guiSnapshot?: Record<string, unknown>;
  mode?: "embedded" | "standalone";
  appName?: string;
  guiActions?: string[];
  skills?: string[];
};

export type AgUiAppInfo = {
  appName?: string;
  guiActions: string[];
  guiActionDetails?: Array<{ name: string; parameters?: Array<{ name: string }> }>;
  voiceTools: Array<{
    name: string;
    phrases: string[];
    action: string;
    params?: string[];
    description?: string;
  }>;
  skills: string[];
};

/** Hermes session key for embedded app agents (same as AG-UI / app_gui_action enqueue). */
export function buildAppAgentSessionKey(appId: string, threadId: string): string {
  return `joshu-app:${appId}:${threadId}`;
}

/** Map manifest app id → ArozOS desktop module name (for open_desktop guard). */
export const SURFACE_APP_DESKTOP_MODULE: Record<string, string> = {
  jmail: "jMail",
};

export function surfaceTargetsCurrentApp(surfaceAppId: string, moduleName: string): boolean {
  const expected = SURFACE_APP_DESKTOP_MODULE[surfaceAppId] ?? surfaceAppId;
  return (
    moduleName === expected ||
    moduleName.toLowerCase() === surfaceAppId.toLowerCase() ||
    moduleName.toLowerCase() === `${surfaceAppId.toLowerCase()}`
  );
}

export async function fetchAgUiAppInfo(appId: string): Promise<AgUiAppInfo> {
  const base = (process.env.JOSHU_API_BASE_URL ?? "http://127.0.0.1:8788/joshu").replace(/\/+$/, "");
  try {
    const res = await fetch(`${base}/api/ag-ui/info?appId=${encodeURIComponent(appId)}`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return { guiActions: [], voiceTools: [], skills: [] };
    const json = (await res.json()) as {
      agents?: Array<{
        name?: string;
        guiActions?: string[];
        guiActionDetails?: AgUiAppInfo["guiActionDetails"];
        voiceTools?: AgUiAppInfo["voiceTools"];
        skills?: string[];
      }>;
    };
    const agent = json.agents?.[0];
    return {
      appName: agent?.name?.replace(/ Agent$/, ""),
      guiActions: Array.isArray(agent?.guiActions) ? agent.guiActions : [],
      guiActionDetails: Array.isArray(agent?.guiActionDetails) ? agent.guiActionDetails : undefined,
      voiceTools: Array.isArray(agent?.voiceTools) ? agent.voiceTools : [],
      skills: Array.isArray(agent?.skills) ? agent.skills : [],
    };
  } catch {
    return { guiActions: [], voiceTools: [], skills: [] };
  }
}

/** Compact system messages for voice think inside an embedded app (parity with AG-UI). */
export function buildEmbeddedAppThinkMessages(ctx: EmbeddedAppSurfaceContext): ChatMessage[] {
  const mode = ctx.mode ?? "embedded";
  const appLabel = ctx.appName ?? ctx.appId;
  const lines: string[] = [
    `You are assisting inside the Joshu desktop app "${appLabel}" (id: ${ctx.appId}).`,
    `Mode: ${mode}.`,
  ];

  if (ctx.skills?.length) {
    lines.push(`Load these skills via skill_view when needed: ${ctx.skills.join(", ")}.`);
  }

  if (mode === "embedded") {
    lines.push(
      "Embedded mode — the user is looking at this app. Prefer the GUI over external MCP/platform tools.",
      "READ (list, summarize, what's open): answer from Current GUI snapshot (activeView + listPreview/detail fields). Do NOT call agent.usesSkills or MCP for data already in the snapshot.",
      "If list preview is missing or stale, call the app's refresh guiAction (if declared), then use the tool result.",
      "NAVIGATE / EDIT IN UI: app_gui_action only — never auto-submit sends or destructive actions.",
      `app_gui_action appId="${ctx.appId}" action=<guiAction> for UI changes.`,
      "After dictating email or draft content, call app_gui_action with openCompose and { to, subject, body } — never only paste in chat.",
    );
    if (ctx.guiActions?.length) {
      lines.push(`Available guiActions for app_gui_action: ${ctx.guiActions.join(", ")}.`);
    }
  }

  const gui = ctx.guiSnapshot;
  if (gui && Object.keys(gui).length > 0) {
    lines.push(
      `Current GUI snapshot (authoritative for what the user sees now): ${JSON.stringify(gui)}`,
      "When the user asks what is open or visible, answer from activeView and list/detail preview fields in the snapshot.",
    );
  }

  return [{ role: "system", content: lines.join("\n") }];
}

export type AppGuiActionWire = {
  appId: string;
  action: string;
  args?: Record<string, unknown>;
};

export async function drainAppGuiActionsFromJoshu(sessionKey: string): Promise<AppGuiActionWire[]> {
  try {
    const url = `${JOSHU_API_BASE}/api/app-gui-actions/drain?sessionKey=${encodeURIComponent(sessionKey)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return [];
    const json = (await res.json()) as { actions?: AppGuiActionWire[] };
    return Array.isArray(json.actions) ? json.actions : [];
  } catch {
    return [];
  }
}
