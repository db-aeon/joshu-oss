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

/** First non-empty trimmed quote from Realtime tool args, STT pending, or transcript. */
export function resolveThinkUserQuote(...candidates: Array<string | undefined | null>): string | undefined {
  for (const c of candidates) {
    const t = typeof c === "string" ? c.trim() : "";
    if (t) return t;
  }
  return undefined;
}

/**
 * Hermes user message for a voice `think` turn.
 * Always includes Intent + Conversation summary; includes `User said:` whenever we have a
 * verbatim STT / tool quote so Langfuse trace roots show the owner's words (not only the
 * Realtime paraphrase).
 */
export function buildThinkUserMessage(params: {
  intent: string;
  summary: string;
  userQuote?: string;
}): string {
  const lines = [
    `Intent: ${params.intent}`,
    `Conversation summary: ${params.summary}`,
  ];
  const quote = resolveThinkUserQuote(params.userQuote);
  if (quote) lines.push(`User said: ${quote}`);
  return lines.join("\n");
}

type VoiceThreadOrigin = {
  channel: "browser_voice" | "pstn_voice";
  sessionKey: string;
  sessionId: string;
  messageId: string;
  appId?: string;
};

async function fetchBrokerContext(origin: VoiceThreadOrigin): Promise<string | undefined> {
  try {
    const res = await fetch(`${JOSHU_API_BASE}/api/realtime-goals/context`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${HERMES_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ origin }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return undefined;
    const json = (await res.json()) as { context?: string | null };
    return typeof json.context === "string" && json.context.trim() ? json.context : undefined;
  } catch {
    return undefined;
  }
}

async function recordVoiceThreadBox(origin: VoiceThreadOrigin, text: string): Promise<void> {
  try {
    await fetch(`${JOSHU_API_BASE}/api/realtime-goals/thread/box`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${HERMES_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ origin, text, source: "hermes" }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    /* fail open */
  }
}

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

/** Where a think answer came from: the goal broker's quick routed reply, or Hermes. */
export type ThinkResult = { text: string; source: "broker" | "hermes" };

export async function runJoshuThink(params: ThinkParams): Promise<string> {
  return (await runJoshuThinkDetailed(params)).text;
}

export async function runJoshuThinkDetailed(params: ThinkParams): Promise<ThinkResult> {
  const base = HERMES_API_BASE_URL.replace(/\/+$/, "");
  const appCtx = params.appContext;
  const hermesSessionId = appCtx?.threadId ?? params.callSid;
  const sessionKey = appCtx
    ? buildAppAgentSessionKey(appCtx.appId, appCtx.threadId)
    : `joshu-hermes-chat:${params.callSid}`;
  const voiceThinkKey = `voice-think:${params.callSid}:${params.jobId}`;
  const forScreen = params.presentation === "screen";
  const voiceOrigin: VoiceThreadOrigin = {
    channel: forScreen ? "browser_voice" : "pstn_voice",
    sessionKey: forScreen ? sessionKey : "pstn:owner",
    sessionId: hermesSessionId,
    messageId: params.jobId,
    ...(appCtx?.appId ? { appId: appCtx.appId } : {}),
  };
  const ownerText =
    resolveThinkUserQuote(params.userQuote) ||
    [params.intent, params.summary].filter(Boolean).join("\n");
  // Same structured payload Hermes sees — Realtime paraphrases alone look vague to
  // the goal classifier (canary PSTN flight booking passed at 0.62 vs SMS queue 0.90).
  const brokerText = buildThinkUserMessage({
    intent: params.intent,
    summary: params.summary,
    userQuote: params.userQuote,
  });

  if (brokerText.trim()) {
    try {
      const admission = await fetch(`${JOSHU_API_BASE}/api/realtime-goals/route`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${HERMES_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          origin: voiceOrigin,
          text: brokerText,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (admission.ok) {
        const result = (await admission.json()) as {
          action?: string;
          text?: string;
        };
        if (result.action === "reply" && result.text) {
          if (forScreen) params.onDelta?.(result.text);
          return { text: result.text, source: "broker" };
        }
      }
    } catch (error) {
      console.warn(
        `[voice-think] realtime goal admission failed open: ${(error as Error).message}`,
      );
    }
  }

  const brokerContext = await fetchBrokerContext(voiceOrigin);
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: buildThinkSystemPrompt(identity, forScreen ? "screen" : "phone"),
    },
    ...(brokerContext ? [{ role: "system" as const, content: brokerContext }] : []),
    ...(appCtx ? buildEmbeddedAppThinkMessages(appCtx) : []),
    {
      role: "user",
      content: buildThinkUserMessage({
        intent: params.intent,
        summary: params.summary,
        userQuote: params.userQuote,
      }),
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
  const spoken = finalText.trim() || `(No response from ${name}.)`;
  await recordVoiceThreadBox(voiceOrigin, spoken);
  return { text: spoken, source: "hermes" };
}

async function postOwnerText(
  body: { text: string; mode: "links" | "full" },
): Promise<{ texted?: boolean; spoken?: string } | undefined> {
  try {
    const res = await fetch(`${JOSHU_API_BASE}/api/realtime-goals/voice/owner-text`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${HERMES_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return undefined;
    return (await res.json()) as { texted?: boolean; spoken?: string };
  } catch {
    return undefined;
  }
}

const URL_IN_TEXT = /https?:\/\/\S+/i;

/**
 * Phone answers cannot carry links. Joshu texts them to the owner and returns
 * the answer rewritten for speech (links removed, honest "I texted it" note).
 */
export async function speakableWithLinksTexted(text: string): Promise<string> {
  if (!URL_IN_TEXT.test(text)) return text;
  const result = await postOwnerText({ text, mode: "links" });
  if (result?.spoken?.trim()) return result.spoken;
  // Joshu unreachable: still never read a URL aloud or claim it was sent.
  return `${text.replace(/https?:\/\/\S+/gi, "").trim()}\n\nI couldn't text you the link just now.`;
}

/** Text a finished answer to the owner after they hung up mid-think. */
export async function textAnswerToOwner(text: string): Promise<boolean> {
  const result = await postOwnerText({
    text: `Here's the answer from our call:\n${text}`,
    mode: "full",
  });
  return result?.texted === true;
}
