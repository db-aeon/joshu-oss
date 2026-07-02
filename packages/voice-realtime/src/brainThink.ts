import { HERMES_API_BASE_URL, HERMES_API_KEY, HERMES_MODEL } from "./config.js";
import { buildThinkSystemPrompt, resolveJoshuIdentity } from "./joshuIdentity.js";
import type { DesktopSurfaceAction } from "./voiceSurfaceSync.js";
import {
  buildAppAgentSessionKey,
  buildEmbeddedAppThinkMessages,
  drainAppGuiActionsFromJoshu,
  type AppGuiActionWire,
  type EmbeddedAppSurfaceContext,
} from "./voiceAppContext.js";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type ThinkParams = {
  callSid: string;
  jobId: string;
  intent: string;
  summary: string;
  userQuote?: string;
  signal?: AbortSignal;
  /** Stream brain tokens to browser chat UI. */
  onDelta?: (delta: string) => void;
  /** Present app/file on the ArozOS desktop (Hermes desktop_open tool). */
  onDesktopAction?: (action: DesktopSurfaceAction) => void;
  /** Execute app_gui_action results in the embedded app shell. */
  onAppAction?: (action: AppGuiActionWire) => void;
  /** Embedded app context — aligns Hermes session + prompts with AG-UI chat. */
  appContext?: EmbeddedAppSurfaceContext;
  /** screen = rich markdown for UI; phone = plain speakable text. */
  presentation?: "screen" | "phone";
};

const identity = resolveJoshuIdentity();

const JOSHU_API_BASE = (process.env.JOSHU_API_BASE_URL ?? "http://127.0.0.1:8788/joshu").replace(/\/+$/, "");

async function drainDesktopActionsFromJoshu(sessionKey: string): Promise<DesktopSurfaceAction[]> {
  try {
    const url = `${JOSHU_API_BASE}/api/desktop-actions/drain?sessionKey=${encodeURIComponent(sessionKey)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return [];
    const json = (await res.json()) as { actions?: DesktopSurfaceAction[] };
    return Array.isArray(json.actions) ? json.actions : [];
  } catch {
    return [];
  }
}

function parseSseEvent(raw: string): { name: string; data: string } {
  let name = "message";
  let data = "";
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) name = line.slice(6).trim();
    else if (line.startsWith("data:")) data += line.slice(5).trim();
  }
  return { name, data };
}

export async function runJoshuThink(params: ThinkParams): Promise<string> {
  const base = HERMES_API_BASE_URL.replace(/\/+$/, "");
  const appCtx = params.appContext;
  const hermesSessionId = appCtx?.threadId ?? params.callSid;
  const sessionKey = appCtx
    ? buildAppAgentSessionKey(appCtx.appId, appCtx.threadId)
    : `joshu-hermes-chat:${params.callSid}`;
  const voiceThinkKey = `voice-think:${params.callSid}:${params.jobId}`;
  const forScreen = params.presentation === "screen";

  const messages: ChatMessage[] = [
    {
      role: "system",
      content: buildThinkSystemPrompt(identity, forScreen ? "screen" : "phone"),
    },
    ...(appCtx ? buildEmbeddedAppThinkMessages(appCtx) : []),
    {
      role: "user",
      content: [
        `Intent: ${params.intent}`,
        `Conversation summary: ${params.summary}`,
        params.userQuote ? `User said: ${params.userQuote}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    },
  ];

  const res = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${HERMES_API_KEY}`,
      "Content-Type": "application/json",
      "X-Hermes-Session-Id": hermesSessionId,
      "X-Hermes-Session-Key": sessionKey,
    },
    body: JSON.stringify({
      model: HERMES_MODEL,
      messages,
      stream: true,
    }),
    signal: params.signal ?? AbortSignal.timeout(600_000),
  });

  if (!res.ok || !res.body) {
    throw new Error(`Joshu think failed: ${res.status} ${await res.text().catch(() => "")}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalText = "";

  const flushDesktopActions = async (): Promise<void> => {
    if (!params.onDesktopAction) return;
    const keys = [sessionKey, voiceThinkKey];
    if (appCtx) keys.push(`joshu-hermes-chat:${appCtx.threadId}`);
    const seen = new Set<string>();
    for (const key of keys) {
      const actions = await drainDesktopActionsFromJoshu(key);
      for (const action of actions) {
        const sig = `${action.kind}:${action.target}`;
        if (seen.has(sig)) continue;
        seen.add(sig);
        params.onDesktopAction(action);
      }
    }
  };

  const flushAppGuiActions = async (): Promise<void> => {
    if (!params.onAppAction || !appCtx) return;
    const keys = [
      sessionKey,
      `joshu-hermes-chat:${appCtx.threadId}`,
      voiceThinkKey,
      `joshu-hermes-chat:${params.callSid}`,
    ];
    const seen = new Set<string>();
    for (const key of keys) {
      const actions = await drainAppGuiActionsFromJoshu(key);
      for (const action of actions) {
        const sig = `${action.appId}:${action.action}:${JSON.stringify(action.args ?? {})}`;
        if (seen.has(sig)) continue;
        seen.add(sig);
        params.onAppAction(action);
      }
    }
  };

  const flushSurfaceActions = async (): Promise<void> => {
    await flushDesktopActions();
    await flushAppGuiActions();
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";

    for (const raw of parts) {
      const event = parseSseEvent(raw);
      if (!event.data || event.data === "[DONE]") continue;

      if (event.name === "hermes.tool.progress" || event.name === "claude.tool.progress") {
        try {
          const parsed = JSON.parse(event.data) as { tool?: string; status?: string };
          const toolName = parsed.tool?.replace(/^.*\./, "") ?? "";
          if (toolName === "desktop_open" && parsed.status === "completed") {
            await flushSurfaceActions();
          }
          if (toolName === "app_gui_action" && parsed.status === "completed") {
            await flushAppGuiActions();
          }
        } catch {
          /* ignore */
        }
        continue;
      }

      if (!event.data.startsWith("{")) continue;
      try {
        const json = JSON.parse(event.data) as {
          choices?: Array<{ delta?: { content?: string } }>;
        };
        const delta = json.choices?.[0]?.delta?.content ?? "";
        if (delta) {
          finalText += delta;
          params.onDelta?.(delta);
        }
      } catch {
        /* ignore malformed SSE */
      }
    }
  }

  await flushSurfaceActions();

  const name = identity.name;
  return finalText.trim() || `(No response from ${name}.)`;
}
