/**
 * App-scoped AG-UI context — trimmed prompts from joshu.app.json agent block.
 */

import type { HermesChatMessage } from "./hermesApi.js";
import { getAppManifest, type JoshuAppManifest } from "./appRegistry.js";

export type JoshuAppAgentRunState = {
  appId?: string;
  mode?: "embedded" | "standalone";
  gui?: Record<string, unknown>;
};

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function parseAppAgentState(raw: unknown): JoshuAppAgentRunState {
  if (!raw || typeof raw !== "object") return {};
  const doc = raw as Record<string, unknown>;
  const appId = readString(doc.appId);
  const mode = doc.mode === "standalone" ? "standalone" : doc.mode === "embedded" ? "embedded" : undefined;
  const gui = doc.gui && typeof doc.gui === "object" ? (doc.gui as Record<string, unknown>) : undefined;
  return { appId: appId || undefined, mode, gui };
}

export function resolveAppIdFromRequest(
  queryAppId: unknown,
  state: JoshuAppAgentRunState,
): string | undefined {
  return readString(queryAppId) || state.appId;
}

function collectSkillNames(manifest: JoshuAppManifest): string[] {
  const skills = new Set<string>();
  if (manifest.agent?.skill) skills.add(manifest.agent.skill);
  for (const name of manifest.agent?.usesSkills ?? []) {
    const trimmed = readString(name);
    if (trimmed) skills.add(trimmed);
  }
  return [...skills];
}

function formatGuiActionsForPrompt(manifest: JoshuAppManifest): string[] {
  return (manifest.agent?.guiActions ?? []).map((action) => {
    const params = (action.parameters ?? []).map((p) => p.name).filter(Boolean);
    if (params.length === 0) return action.name;
    return `${action.name}(${params.join(", ")})`;
  });
}

/** Hermes session key for embedded app agents (distinct from jChat). */
export function buildAppAgentSessionId(appId: string, threadId: string): string {
  return `joshu-app:${appId}:${threadId}`;
}

/** Compact system messages injected before the user turn for app-scoped AG-UI runs. */
export function buildAppAgentSystemMessages(
  manifest: JoshuAppManifest | undefined,
  state: JoshuAppAgentRunState,
): HermesChatMessage[] {
  if (!manifest) return [];

  const skills = collectSkillNames(manifest);
  const guiActions = formatGuiActionsForPrompt(manifest);
  const mode = state.mode ?? "embedded";
  const lines: string[] = [
    `You are assisting inside the Joshu desktop app "${manifest.name}" (id: ${manifest.id}).`,
    `Mode: ${mode}.`,
  ];

  if (skills.length > 0) {
    lines.push(`Load these skills via skill_view when needed: ${skills.join(", ")}.`);
  }

  if (mode === "embedded") {
    const guiSkill = manifest.agent?.skill;
    lines.push(
      "Embedded mode — the user is looking at this app. Prefer the GUI over external MCP/platform tools.",
      "READ (list, summarize, what's open): answer from Current GUI snapshot (activeView + listPreview/detail fields). Do NOT call agent.usesSkills or MCP for data already in the snapshot.",
      "If list preview is missing or stale, call the app's refresh guiAction (if declared), then use the tool result.",
      "NAVIGATE / EDIT IN UI: app_gui_action only — see guiActions below and the app's bundled GUI skill. Never auto-submit sends or destructive actions.",
      `app_gui_action appId="${manifest.id}" action=<guiAction> for UI changes.`,
      guiSkill
        ? `Load skill_view('${guiSkill}') for app-specific GUI-first vs headless escalation rules.`
        : "Follow the app's bundled GUI skill for GUI-first vs headless escalation.",
      "ESCALATE to agent.usesSkills (MCP, gbrain, deep search) ONLY when:",
      "  - the user asks for data not present in the loaded GUI state,",
      "  - refresh guiAction + snapshot still cannot answer, or",
      "  - the user explicitly asks for headless/live/deep search or automation.",
    );
    if (guiActions.length > 0) {
      lines.push(`Available guiActions for app_gui_action: ${guiActions.join(", ")}.`);
    }
  } else {
    lines.push(
      "Headless mode: use platform MCP tools and POST /joshu/api/apps/:id/invoke actions documented in the app skill.",
    );
  }

  if (state.gui && Object.keys(state.gui).length > 0) {
    lines.push(
      `Current GUI snapshot (authoritative for what the user sees now): ${JSON.stringify(state.gui)}`,
      "When the user asks what is open or visible, answer from activeView and list/detail preview fields in the snapshot — not from chat history or hidden background state.",
    );
  }

  return [{ role: "system", content: lines.join("\n") }];
}

export function getManifestForAppId(appId: string | undefined): JoshuAppManifest | undefined {
  if (!appId) return undefined;
  return getAppManifest(appId);
}
