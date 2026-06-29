/** jChat thread message model (Hermes stream + CopilotKit AG-UI). */
export type JChatAttachment = {
  id: string;
  name: string;
  dataUrl: string;
  mimeType?: string;
};

export type JChatToolEvent = {
  id: string;
  tool: string;
  emoji?: string;
  label?: string;
  status: "running" | "completed";
  raw?: unknown;
};

export type JChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  status?: "streaming" | "done" | "error";
  reasoning?: string;
  attachments?: JChatAttachment[];
  tools?: JChatToolEvent[];
};
