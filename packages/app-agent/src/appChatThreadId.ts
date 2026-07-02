/** CopilotKit + Hermes thread ids for embedded app chat (distinct from voice session ids). */

export type AppAgentChatThreadIdInput = {
  appId: string;
  /** Mailbox, project slug, or other stable scope segment (default `default`). */
  scope?: string;
  /** Revision segment — bump to start a fresh CopilotKit thread + Hermes session. */
  rev?: string;
};

const DEFAULT_REV = "1";

function readRev(storageKey: string): string {
  try {
    return sessionStorage.getItem(storageKey) ?? DEFAULT_REV;
  } catch {
    return DEFAULT_REV;
  }
}

/** Stable per app + scope + revision — Langfuse/Hermes session resets when revision bumps. */
export function buildAppAgentChatThreadId(input: AppAgentChatThreadIdInput): string {
  const appId = input.appId.trim() || "app";
  const scope = (input.scope ?? "default").trim() || "default";
  const rev = input.rev ?? DEFAULT_REV;
  return `${appId}:${scope}:chat:${rev}`;
}

export function appAgentChatThreadStorageKey(appId: string): string {
  return `${appId.trim() || "app"}-agent-chat-rev`;
}

/** Bump chat revision (new CopilotKit thread + Hermes session on next mount). */
export function rotateAppAgentChatThread(storageKey: string): string {
  const rev = String(Date.now());
  try {
    sessionStorage.setItem(storageKey, rev);
  } catch {
    /* ignore */
  }
  return rev;
}

export function readAppAgentChatThreadRev(storageKey: string): string {
  return readRev(storageKey);
}

/** Best-effort server session delete before rotating chat revision. */
export async function deleteAppAgentChatSession(
  threadId: string,
  apiBase = "/joshu/api",
): Promise<void> {
  try {
    await fetch(`${apiBase}/ag-ui/session?threadId=${encodeURIComponent(threadId)}`, {
      method: "DELETE",
    });
  } catch {
    /* best-effort */
  }
}
