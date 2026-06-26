/**
 * jChat session list + transcript load from Hermes SessionDB.
 * Uses a Python bridge (no Hermes dashboard HTTP on :9119 required).
 */
import {
  listJchatSessionsViaBridge,
  loadJchatSessionMessagesViaBridge,
} from "./hermesChatSessionsBridge.js";

export type HermesChatSessionRow = {
  id: string;
  title: string;
  preview: string | null;
  lastActive: number;
  messageCount: number;
  isActive: boolean;
};

export type JchatTranscriptMessage = {
  role: "user" | "assistant";
  content: string;
};

/** Recent jChat Hermes sessions (newest activity first). */
export async function listJchatHermesSessions(limit = 40): Promise<HermesChatSessionRow[]> {
  return listJchatSessionsViaBridge(limit);
}

/** User/assistant turns for jChat UI (Hermes resolves compression continuations). */
export async function loadJchatSessionMessages(sessionId: string): Promise<{
  sessionId: string;
  messages: JchatTranscriptMessage[];
}> {
  return loadJchatSessionMessagesViaBridge(sessionId);
}
