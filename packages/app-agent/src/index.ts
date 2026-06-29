export type {
  AppAgentConfig,
  AppGuiActionEvent,
  JoshuAppAgentManifest,
  JoshuAppAgentState,
  JoshuGuiActionDef,
  JoshuVoiceCommandDef,
} from "./types.js";

export {
  createAppAgentConfig,
  collectManifestSkills,
  type CreateAppAgentConfigInput,
} from "./createAppAgentConfig.js";

export { JoshuHttpAgent, type JoshuHttpAgentConfig } from "./JoshuHttpAgent.js";

export {
  JoshuAppAgentProvider,
  useJoshuAppAgentContext,
  type JoshuAppAgentProviderProps,
} from "./JoshuAppAgentProvider.js";

export { useJoshuGuiReadable, type JoshuGuiReadableInput } from "./useJoshuGuiReadable.js";
export { useJoshuGuiAction, type JoshuGuiActionInput } from "./useJoshuGuiAction.js";
export { JoshuAgentChatPanel, type JoshuAgentChatPanelProps } from "./JoshuAgentChatPanel.js";

export {
  useJoshuVoiceCommands,
  resolveVoiceCommandAction,
  type UseJoshuVoiceCommandsInput,
  type JoshuVoiceClientAppActionHandler,
  type VoiceSocketSend,
} from "./useJoshuVoiceCommands.js";

export {
  DESKTOP_MODULE_NAMES,
  executeDesktopAction,
  matchQuickDesktopOpen,
  normalizeModuleAlias,
  openDesktopFile,
  openDesktopModule,
  parseDesktopActionFromToolPayload,
  type DesktopAction,
  type FilesContext,
} from "./desktopActions.js";
