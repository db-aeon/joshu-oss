/**
 * CopilotKit frontend tools from AG-UI RunAgentInput — convert for LLM + client routing.
 */

export type AgUiClientTool = {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
};

export type OpenAiChatTool = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Parse AG-UI / CopilotKit tools array from RunAgentInput. */
export function parseAgUiClientTools(raw: unknown): AgUiClientTool[] {
  if (!Array.isArray(raw)) return [];
  const tools: AgUiClientTool[] = [];
  for (const item of raw) {
    const doc = asRecord(item);
    const name = readString(doc.name);
    if (!name) continue;
    const description = readString(doc.description) || `Frontend tool ${name}`;
    const parameters = doc.parameters && typeof doc.parameters === "object"
      ? (doc.parameters as Record<string, unknown>)
      : { type: "object", properties: {} };
    tools.push({ name, description, parameters });
  }
  return tools;
}

/** OpenAI chat/completions tool definitions for Hermes / OpenRouter. */
export function toOpenAiChatTools(tools: AgUiClientTool[]): OpenAiChatTool[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters ?? { type: "object", properties: {} },
    },
  }));
}

export function buildClientToolNameSet(tools: AgUiClientTool[]): Set<string> {
  return new Set(tools.map((t) => t.name));
}

export function isClientToolName(name: string, clientTools: Set<string>): boolean {
  return clientTools.has(name);
}
