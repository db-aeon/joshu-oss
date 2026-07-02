export type {
  AppAgentConfig,
  AppGuiActionEvent,
  JoshuAppAgentManifest,
  JoshuAppAgentState,
  JoshuGuiActionDef,
  JoshuGuiActionParameterDef,
  JoshuGuiActionVoiceDef,
  JoshuVoiceCommandDef,
  ManifestVoiceTool,
  resolveManifestVoiceTools,
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
  useJoshuCompanionIdentity,
  type JoshuCompanionIdentity,
} from "./useJoshuCompanionIdentity.js";
export { JChatCopilotThread, type JChatCopilotThreadProps } from "./JChatCopilotThread.js";
export { mapAgUiMessagesToJChat } from "./mapAgUiMessagesToJChat.js";

export {
  JoshuEmbeddedAppAgent,
  type JoshuEmbeddedAppAgentProps,
  type JoshuGuiAgentRef,
} from "./JoshuEmbeddedAppAgent.js";

export {
  buildAppAgentChatThreadId,
  appAgentChatThreadStorageKey,
  rotateAppAgentChatThread,
  readAppAgentChatThreadRev,
  deleteAppAgentChatSession,
  type AppAgentChatThreadIdInput,
} from "./appChatThreadId.js";

export {
  useAppAgentChatSession,
  type UseAppAgentChatSessionInput,
  type AppAgentChatSession,
} from "./useAppAgentChatSession.js";

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
