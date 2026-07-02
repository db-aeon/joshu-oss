/** jChat client helpers for Hermes session history. */

export { formatSessionWhen } from "@joshu/jchat-ui";

export type ChatSessionRow = {
  id: string;
  title: string;
  preview: string | null;
  lastActive: number;
  messageCount: number;
  isActive: boolean;
};

export type ChatTranscriptMessage = {
  role: "user" | "assistant";
  content: string;
};

export async function fetchChatSessions(apiBase: string): Promise<ChatSessionRow[]> {
  const res = await fetch(`${apiBase}/sessions`, { cache: "no-store" });
  if (!res.ok) throw new Error(await res.text());
  const json = (await res.json()) as { ok?: boolean; sessions?: ChatSessionRow[]; error?: string };
  if (!json.ok) throw new Error(json.error || "Failed to load sessions");
  return json.sessions ?? [];
}

export async function fetchChatSessionMessages(
  apiBase: string,
  sessionId: string,
): Promise<{ sessionId: string; messages: ChatTranscriptMessage[] }> {
  const res = await fetch(`${apiBase}/sessions/${encodeURIComponent(sessionId)}/messages`, {
    cache: "no-store",
  });
  if (!res.ok) throw new Error(await res.text());
  const json = (await res.json()) as {
    ok?: boolean;
    sessionId?: string;
    messages?: ChatTranscriptMessage[];
    error?: string;
  };
  if (!json.ok) throw new Error(json.error || "Failed to load messages");
  return {
    sessionId: json.sessionId ?? sessionId,
    messages: json.messages ?? [],
  };
}
