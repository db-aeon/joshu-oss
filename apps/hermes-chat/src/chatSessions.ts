/** jChat client helpers for Hermes session history. */

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

export function formatSessionWhen(unixSec: number): string {
  if (!unixSec) return "";
  const date = new Date(unixSec * 1000);
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) {
    return `Today, ${date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday =
    date.getFullYear() === yesterday.getFullYear() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getDate() === yesterday.getDate();
  if (isYesterday) {
    return `Yesterday, ${date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  }
  return date.toLocaleString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

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
