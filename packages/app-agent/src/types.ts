/** Shared types for Joshu app agent integration (manifest agent block). */

export type JoshuGuiActionDef = {
  name: string;
  description?: string;
};

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
