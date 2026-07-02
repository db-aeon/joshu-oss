/** Shared types for Joshu app agent integration (manifest agent block). */

export type JoshuGuiActionParameterDef = {
  name: string;
  type?: "string" | "number" | "boolean" | "object";
  description?: string;
  required?: boolean;
};

export type JoshuGuiActionVoiceDef = {
  shortcut?: string;
  phrases: string[];
  description?: string;
};

export type JoshuGuiActionDef = {
  name: string;
  description?: string;
  parameters?: JoshuGuiActionParameterDef[];
  voice?: JoshuGuiActionVoiceDef;
};

/** @deprecated Prefer guiActions[].voice */
export type JoshuVoiceCommandDef = {
  name: string;
  phrases: string[];
  action: string;
  params?: string[];
  description?: string;
};

export type JoshuAppAgentManifest = {
  id: string;
  name: string;
  agent?: {
    skill?: string;
    usesSkills?: string[];
    headless?: boolean;
    guiActions?: JoshuGuiActionDef[];
    /** @deprecated Prefer guiActions[].voice */
    voiceCommands?: JoshuVoiceCommandDef[];
    actions?: Array<{ name: string; description?: string }>;
  };
};

/** Client state sent to AG-UI / Hermes on each run. */
export type JoshuAppAgentState = {
  appId: string;
  mode?: "embedded" | "standalone";
  gui?: Record<string, unknown>;
};

export type AppAgentConfig = {
  appId: string;
  agentId: string;
  threadId: string;
  apiBase: string;
  manifest?: JoshuAppAgentManifest;
};

export type AppGuiActionEvent = {
  appId: string;
  action: string;
  args?: Record<string, unknown>;
};

/** Normalized voice fast tool derived from manifest guiActions[].voice. */
export type ManifestVoiceTool = {
  name: string;
  phrases: string[];
  action: string;
  params?: string[];
  description?: string;
};

/** Build voice fast tools from guiActions[].voice (+ optional legacy voiceCommands). */
export function resolveManifestVoiceTools(
  guiActions?: JoshuGuiActionDef[],
  legacyVoiceCommands?: JoshuVoiceCommandDef[],
): ManifestVoiceTool[] {
  const tools: ManifestVoiceTool[] = [];
  const seenShortcuts = new Set<string>();
  const actionsByName = new Map((guiActions ?? []).map((a) => [a.name, a]));

  for (const ga of guiActions ?? []) {
    const voice = ga.voice;
    if (!voice?.phrases?.length) continue;
    const shortcut = (voice.shortcut?.trim() || ga.name).trim();
    if (!shortcut || seenShortcuts.has(shortcut)) continue;
    const paramNames = (ga.parameters ?? []).map((p) => p.name).filter(Boolean);
    tools.push({
      name: shortcut,
      phrases: voice.phrases.filter(Boolean),
      action: ga.name,
      params: paramNames.length > 0 ? paramNames : undefined,
      description: voice.description ?? ga.description,
    });
    seenShortcuts.add(shortcut);
  }

  for (const legacy of legacyVoiceCommands ?? []) {
    if (seenShortcuts.has(legacy.name)) continue;
    const linked = actionsByName.get(legacy.action);
    const inheritedParams =
      legacy.params?.length ? legacy.params : linked?.parameters?.map((p) => p.name);
    tools.push({
      name: legacy.name,
      phrases: legacy.phrases,
      action: legacy.action,
      params: inheritedParams?.length ? inheritedParams : undefined,
      description: legacy.description ?? linked?.description,
    });
    seenShortcuts.add(legacy.name);
  }

  return tools;
}
