import React, { useCallback, useMemo, useState } from "react";
import { useAgent, useCopilotKit, UseAgentUpdate } from "@copilotkit/react-core/v2";
import { JChatThread } from "@joshu/jchat-ui";

import { mapAgUiMessagesToJChat } from "./mapAgUiMessagesToJChat.js";

export type JChatCopilotThreadProps = {
  agentId: string;
  emptyText?: string;
  placeholder?: string;
  disabled?: boolean;
  companionAvatarUrl?: string;
  companionName?: string;
  userAvatarUrl?: string | null;
  userName?: string;
};

/** CopilotKit agent run wired to the shared jChat thread UI. */
export function JChatCopilotThread({
  agentId,
  emptyText,
  placeholder,
  disabled = false,
  companionAvatarUrl,
  companionName,
  userAvatarUrl,
  userName,
}: JChatCopilotThreadProps): React.ReactElement {
  const { copilotkit } = useCopilotKit();
  const { agent } = useAgent({
    agentId,
    updates: [UseAgentUpdate.OnMessagesChanged, UseAgentUpdate.OnRunStatusChanged],
  });
  const [draft, setDraft] = useState("");

  const messages = useMemo(
    () => mapAgUiMessagesToJChat(agent.messages, agent.isRunning),
    [agent.isRunning, agent.messages],
  );

  const sendMessage = useCallback(async () => {
    const text = draft.trim();
    if (!text || agent.isRunning || disabled) return;
    setDraft("");
    agent.addMessage({
      id: crypto.randomUUID(),
      role: "user",
      content: text,
    });
    try {
      await copilotkit.runAgent({ agent });
    } catch (error) {
      console.error("[JChatCopilotThread] runAgent failed", error);
    }
  }, [agent, copilotkit, disabled, draft]);

  return (
    <JChatThread
      messages={messages}
      draft={draft}
      onDraftChange={setDraft}
      onSend={() => void sendMessage()}
      busy={agent.isRunning}
      disabled={disabled}
      emptyText={emptyText}
      placeholder={placeholder}
      companionAvatarUrl={companionAvatarUrl}
      companionName={companionName}
      userAvatarUrl={userAvatarUrl}
      userName={userName}
    />
  );
}
