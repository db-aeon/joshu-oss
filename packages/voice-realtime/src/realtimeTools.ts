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
    name: "start_dictation",
    description:
      "Begin a multi-turn voice dictation session ONLY when the user explicitly asks you to wait/listen until they finish a dump — e.g. \"I am about to tell you a bunch of things, just wait for me to finish\", \"don't interrupt\", \"start dictation\", \"take this down\". Do NOT infer dictation from a task (calendar reminders, make a list, add notes) — use think for those. Joshu buffers every subsequent utterance until finish_dictation. Call with zero spoken preamble.",
    parameters: {
      type: "object",
      properties: {
        destination: {
          type: "string",
          description:
            "Where to store when finished — e.g. Websites.md on Desktop, meeting notes, journal entry",
        },
        format: {
          type: "string",
          description:
            "cleanup = light edit / lists; reformulate = rewrite clear notes from rambling; auto = choose from content (default)",
        },
        title: {
          type: "string",
          description: "Optional document title or heading",
        },
      },
      required: ["destination"],
    },
  },
  {
    type: "function" as const,
    name: "finish_dictation",
    description:
      "End the active dictation session and hand the full buffered speech to Hermes to format and save. Call when the user says they are done, finished, that's all, or similar — even if some chunks already arrived. Do NOT call if no start_dictation is active.",
    parameters: {
      type: "object",
      properties: {
        note: {
          type: "string",
          description: "Optional one-line context for Hermes (e.g. user wants bullets)",
        },
      },
      required: [],
    },
  },
  {
    type: "function" as const,
    name: "cancel_dictation",
    description: "Abort the active dictation session without saving. Discard the buffer.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    type: "function" as const,
    name: "think",
    description:
      "Use your full brain (Hermes, files, memory, tools) for anything about THIS user: saved files, journals, notes, desktop, past conversations, or tasks that read/write/browse. Call this tool FIRST with zero spoken preamble — do not say you lack access; this tool IS your access. Returns immediately; speak the result when ready. Do NOT use for general world knowledge you already know. Do NOT use for simple app opens — use open_desktop instead. Do NOT use think for mid-dictation chunks — use start_dictation / finish_dictation instead.",
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
          description:
            "Verbatim latest user utterance (required whenever you heard them speak). Prefer exact words over paraphrase — Joshu logs this into Hermes/Langfuse.",
        },
      },
      required: ["intent", "summary", "user_quote"],
    },
  },
];

/**
 * Native async path (Gemini 3.8 Live): `think` runs in the background and its result comes back
 * as a function response the model speaks, so a brief natural ack is fine — inventing the answer
 * is not.
 */
const NATIVE_THINK_DESCRIPTION =
  "Ask your brain (Hermes: files, calendar, email, memory, desktop, past work) for ANY information about the owner, or a quick personal action that finishes in about a minute. You know nothing about the owner without this tool — never guess personal data. Runs in the background: you may say one short natural line like \"Let me check\", but never state owner facts until the result arrives. Also call it for follow-ups on queued work (status, answers to its questions, changes, \"never mind\"). Do NOT use for general world knowledge, or for long multi-step work — use start_task for that.";

/** Native async path only — long work goes straight to a durable background job. */
const START_TASK_TOOL = {
  type: "function" as const,
  name: "start_task",
  description:
    "Start a long background task for the owner: multi-site browsing, travel search or booking, multi-step research, anything that will take more than about a minute. Joshu queues it as a background job and reports back later (phone: a callback; chat: a message). Returns right away with a confirmation to relay. Do NOT use for quick lookups about the owner (use think) or for follow-ups on a job that is already running (use think).",
  parameters: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "Short task title, e.g. \"Flights to Austin next week\"",
      },
      objective: {
        type: "string",
        description:
          "Self-contained objective with every detail the owner gave (dates, places, budget, preferences) — the background worker cannot hear this call.",
      },
      user_quote: {
        type: "string",
        description: "Verbatim latest owner utterance that asked for this task.",
      },
    },
    required: ["title", "objective", "user_quote"],
  },
};

/**
 * Native phone only — the model ends the call itself after its goodbye (replaces Joshu's
 * transcript-based wrap-up detection). Declared only when a surface names it.
 */
const END_CALL_TOOL = {
  type: "function" as const,
  name: "end_call",
  description:
    "Hang up the phone call. Call this only after the owner is clearly done (\"that's all\", \"no thanks\", \"bye\") and you have said a brief goodbye. Unfinished background answers are texted to them.",
  parameters: { type: "object", properties: {}, required: [] },
};

/** Legacy definitions with native descriptions, plus native-only tools. */
const NATIVE_TOOL_DEFINITIONS: Array<Record<string, unknown> & { name: string }> = [
  ...REALTIME_TOOL_DEFINITIONS.map((tool) =>
    tool.name === "think" ? { ...tool, description: NATIVE_THINK_DESCRIPTION } : tool,
  ),
  START_TASK_TOOL,
];

/**
 * Tools a surface actually implements. Declaring a tool the handler cannot execute makes the
 * model call it and narrate fake success ("I've opened the Welcome app"), so surfaces opt in.
 * PSTN: think + dictation (+ start_task on the native path); no open_desktop — desktop opens
 * are browser/desktop-session work. Names without a definition for the active path are skipped.
 */
export const PHONE_TOOL_NAMES = [
  "think",
  "start_task",
  "end_call",
  "start_dictation",
  "finish_dictation",
  "cancel_dictation",
] as const;

export type RealtimeToolOptions = {
  /** Native async path: native `think` description + `start_task`. */
  nativeAsyncTools?: boolean;
};

/** Base tool definitions filtered to `names` (all when omitted), plus app-specific extras. */
export function selectRealtimeTools(
  names?: readonly string[],
  extraTools: Array<Record<string, unknown>> = [],
  options: RealtimeToolOptions = {},
): Array<Record<string, unknown>> {
  const defs: Array<Record<string, unknown> & { name: string }> = options.nativeAsyncTools
    ? NATIVE_TOOL_DEFINITIONS
    : REALTIME_TOOL_DEFINITIONS;
  const base = names ? defs.filter((tool) => names.includes(tool.name)) : defs;
  // Opt-in only: a surface that implements hang-up has to name it.
  const endCall = options.nativeAsyncTools && names?.includes("end_call") ? [END_CALL_TOOL] : [];
  return [...base, ...endCall, ...extraTools];
}

/** Legacy tool names from older Realtime sessions / prompts. */
export const LEGACY_THINK_TOOL_NAMES = new Set(["ask_joshu", "delegate_to_joshu"]);

export function normalizeThinkToolName(name: string): string {
  if (LEGACY_THINK_TOOL_NAMES.has(name)) return "think";
  return name;
}

/**
 * Gemini Live API tool declarations (function calling). On the native async path every
 * declaration is `NON_BLOCKING` — 3.8 Live Extended Thinking rejects blocking tools outright.
 */
export function geminiToolDefinitions(
  extraTools: Array<Record<string, unknown>> = [],
  toolNames?: readonly string[],
  options: RealtimeToolOptions = {},
): Array<{ functionDeclarations: Array<Record<string, unknown>> }> {
  const allTools = selectRealtimeTools(toolNames, extraTools, options);
  return [
    {
      functionDeclarations: allTools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        ...(options.nativeAsyncTools ? { behavior: "NON_BLOCKING" } : {}),
      })),
    },
  ];
}
