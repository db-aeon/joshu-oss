import React, { createContext, useContext, useMemo, useRef, type ReactNode } from "react";
import { CopilotKit, type AbstractAgent } from "@copilotkit/react-core/v2";

import { JoshuHttpAgent } from "./JoshuHttpAgent.js";
import type { AppAgentConfig } from "./types.js";

type JoshuAppAgentContextValue = {
  config: AppAgentConfig;
  getGuiState: () => Record<string, unknown> | undefined;
  setGuiStateGetter: (getter: () => Record<string, unknown> | undefined) => void;
};

const JoshuAppAgentContext = createContext<JoshuAppAgentContextValue | null>(null);

export function useJoshuAppAgentContext(): JoshuAppAgentContextValue {
  const ctx = useContext(JoshuAppAgentContext);
  if (!ctx) {
    throw new Error("useJoshuAppAgentContext must be used within JoshuAppAgentProvider");
  }
  return ctx;
}

export type JoshuAppAgentProviderProps = {
  config: AppAgentConfig;
  children: ReactNode;
  /** Optional initial GUI snapshot getter (ref-backed in app root). */
  getGuiState?: () => Record<string, unknown> | undefined;
  mode?: "embedded" | "standalone";
};

export function JoshuAppAgentProvider({
  config,
  children,
  getGuiState,
  mode = "embedded",
}: JoshuAppAgentProviderProps): React.ReactElement {
  const guiGetterRef = useRef(getGuiState ?? (() => undefined));
  guiGetterRef.current = getGuiState ?? guiGetterRef.current;

  const agent = useMemo(
    () =>
      new JoshuHttpAgent({
        url: `${config.apiBase}/ag-ui/run`,
        agentId: config.agentId,
        threadId: config.threadId,
        appId: config.appId,
        mode,
        getAppState: () => guiGetterRef.current?.(),
      }),
    [config.apiBase, config.agentId, config.appId, config.threadId, mode],
  );

  const contextValue = useMemo<JoshuAppAgentContextValue>(
    () => ({
      config,
      getGuiState: () => guiGetterRef.current?.(),
      setGuiStateGetter: (getter) => {
        guiGetterRef.current = getter;
      },
    }),
    [config],
  );

  return (
    <JoshuAppAgentContext.Provider value={contextValue}>
      <CopilotKit
        agent={config.agentId}
        threadId={config.threadId}
        showDevConsole={false}
        enableInspector={false}
        selfManagedAgents={{ [config.agentId]: agent as unknown as AbstractAgent }}
      >
        {children}
      </CopilotKit>
    </JoshuAppAgentContext.Provider>
  );
}
