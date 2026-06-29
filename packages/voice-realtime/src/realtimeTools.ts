/** OpenAI Realtime session tools — invoke the brain for personal / file / memory work. */

export const REALTIME_TOOL_DEFINITIONS = [
  {
    type: "function" as const,
    name: "open_desktop",
    description:
      "Open a Joshu desktop app immediately (browser/jWeb, email/jMail, chat, whiteboard, files, connectors, schedules, memory). Use for simple app-open requests with no file lookup. Do NOT use for opening a specific file path or searching files — use think instead.",
    parameters: {
      type: "object",
      properties: {
        app: {
          type: "string",
          description:
            "App alias or name: browser, jWeb, mail, jMail, email, chat, whiteboard, files, connectors, schedules, memory, welcome, settings, trash",
        },
      },
      required: ["app"],
    },
  },
  {
    type: "function" as const,
    name: "think",
    description:
      "Use your full brain (Hermes, files, memory, tools) for anything about THIS user: saved files, journals, notes, desktop, past conversations, or tasks that read/write/browse. Call this tool FIRST with zero spoken preamble — do not say you lack access; this tool IS your access. Returns immediately; speak the result when ready. Do NOT use for general world knowledge you already know. Do NOT use for simple app opens — use open_desktop instead.",
    parameters: {
      type: "object",
      properties: {
        intent: {
          type: "string",
          description: "Short label, e.g. read_journal, save_note, browse",
        },
        summary: {
          type: "string",
          description: "Brief summary of the voice conversation relevant to the request",
        },
        user_quote: {
          type: "string",
          description: "Exact user request if helpful",
        },
      },
      required: ["intent", "summary"],
    },
  },
];

/** Legacy tool names from older Realtime sessions / prompts. */
export const LEGACY_THINK_TOOL_NAMES = new Set(["ask_joshu", "delegate_to_joshu"]);

export function normalizeThinkToolName(name: string): string {
  if (LEGACY_THINK_TOOL_NAMES.has(name)) return "think";
  return name;
}

/** Gemini Live API tool declarations (function calling). */
export function geminiToolDefinitions(
  extraTools: Array<Record<string, unknown>> = [],
): Array<{ functionDeclarations: Array<Record<string, unknown>> }> {
  const allTools = [...REALTIME_TOOL_DEFINITIONS, ...extraTools];
  return [
    {
      functionDeclarations: allTools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })),
    },
  ];
}
