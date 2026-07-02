import { useCallback, useMemo, useState } from "react";

import {
  appAgentChatThreadStorageKey,
  buildAppAgentChatThreadId,
  deleteAppAgentChatSession,
  readAppAgentChatThreadRev,
  rotateAppAgentChatThread,
} from "./appChatThreadId.js";

export type UseAppAgentChatSessionInput = {
  appId: string;
  /** Stable scope for thread id (mailbox, slug, …). */
  scope?: string;
  /** sessionStorage key — defaults to `${appId}-agent-chat-rev`. */
  storageKey?: string;
  apiBase?: string;
};

export type AppAgentChatSession = {
  threadId: string;
  rev: string;
  /** Rotate revision + delete server session (pass to chat panel `onNewChat`). */
  startNewChat: () => Promise<void>;
};

/** Thread id + rotation helpers for embedded app agent chat. */
export function useAppAgentChatSession(input: UseAppAgentChatSessionInput): AppAgentChatSession {
  const storageKey = input.storageKey ?? appAgentChatThreadStorageKey(input.appId);
  const apiBase = input.apiBase ?? "/joshu/api";
  const [rev, setRev] = useState(() => readAppAgentChatThreadRev(storageKey));

  const threadId = useMemo(
    () =>
      buildAppAgentChatThreadId({
        appId: input.appId,
        scope: input.scope,
        rev,
      }),
    [input.appId, input.scope, rev],
  );

  const startNewChat = useCallback(async () => {
    await deleteAppAgentChatSession(threadId, apiBase);
    setRev(rotateAppAgentChatThread(storageKey));
  }, [apiBase, storageKey, threadId]);

  return { threadId, rev, startNewChat };
}
