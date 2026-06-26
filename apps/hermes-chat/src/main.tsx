import "@joshu/design-system/typography.css";
import "@joshu/design-system/tokens.css";
import "@joshu/design-system/base.css";
import "./styles.css";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { fetchVoiceStatus, startJoshuVoiceSession } from "./joshuVoice";
import { executeDesktopAction, matchQuickDesktopOpen, openDesktopModule, type DesktopAction } from "./desktopActions";
import {
  fetchChatSessionMessages,
  fetchChatSessions,
  formatSessionWhen,
  type ChatSessionRow,
} from "./chatSessions";
import { ToolPixelIcon } from "./toolIcons";
import { syncJChatTray } from "./traySync";
import { resolvePortraitUrl, useIdentity } from "./useIdentity";

type HermesContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

type HermesMessage = {
  role: "system" | "user" | "assistant";
  content: string | HermesContentPart[];
};

type Attachment = {
  id: string;
  name: string;
  mimeType: string;
  dataUrl: string;
};

type ToolEvent = {
  id: string;
  tool: string;
  emoji?: string;
  label?: string;
  status: "running" | "completed";
  raw?: unknown;
};

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  attachments?: Attachment[];
  reasoning?: string;
  tools?: ToolEvent[];
  status?: "streaming" | "done" | "error";
};

type SseEvent = {
  event: string;
  data: string;
};

const API_BASE = (import.meta.env.VITE_HERMES_CHAT_API_BASE || "/joshu/api/hermes-chat").replace(/\/+$/, "");
const VOICE_API_BASE = API_BASE.replace(/\/hermes-chat\/?$/, "/voice");
const SYSTEM_PROMPT =
  "You are Hermes Agent running inside Joshu's ArozOS desktop. Use markdown, concise explanations, and tools when useful. " +
  "For outbound email, send from the agent Nylas mailbox via mcp_joshu_connectors_nylas_send_message (joshu-connectors MCP) — not Composio Gmail send, not browser Gmail login, not execute_code or curl to the Joshu REST API. " +
    "For mail find/search/recall, load joshu-mail skill (gbrain → mirrors → Composio workbench). " +
    "For meeting follow-up status (blocked meetings, outreach sent?, scheduling threads), load ea-scheduling via skill_view and call scheduling_list_meeting_tasks before claiming mail was not sent. " +
  "Use Composio MCP for Slack, GitHub, Notion, and other connected apps without local mirrors. " +
  "To open a desktop app or file on screen, use desktop_open (module name or path under joshu's files). " +
  "If a tool needs authentication, ask them to open the Connectors desktop app or complete the OAuth link you receive.";

function openConnectorsApp(): void {
  if (!openDesktopModule("Connectors")) {
    window.open("/connectors/index.html", "_blank", "noopener,noreferrer");
  }
}

function newId(prefix: string): string {
  if ("crypto" in window && "randomUUID" in window.crypto) {
    return `${prefix}-${window.crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result ?? "")));
    reader.addEventListener("error", () => reject(reader.error ?? new Error("Failed to read file")));
    reader.readAsDataURL(file);
  });
}

async function parseSseStream(response: Response, onEvent: (event: SseEvent) => void): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Response did not include a stream");

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const event = parseSseEvent(raw);
      if (event.data) onEvent(event);
      boundary = buffer.indexOf("\n\n");
    }
  }
}

function parseSseEvent(raw: string): SseEvent {
  let event = "message";
  const data: string[] = [];

  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("event:")) {
      event = line.slice(6).trim() || "message";
    } else if (line.startsWith("data:")) {
      data.push(line.slice(5).trim());
    }
  }

  return { event, data: data.join("\n") };
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/** Plain text for Hermes Edge/OpenAI TTS via Joshu `/tts`. */
function textForSpeechOutput(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^#{1,6}\s?/gm, "")
    .replace(/\n{2,}/g, ". ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 32000);
}

/** Remove invisible / format chars; Hermes/Python trim can leave falsy payloads if only these remain. */
function normalizeSpeakableText(text: string): string {
  return text.replace(/[\u200B-\u200D\u2060\uFEFF]/g, "").trim();
}

const LS_SPEECH_OUT = "hermes-chat.speechOutput";

function readBoolLs(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    if (raw === "1" || raw === "true") return true;
    if (raw === "0" || raw === "false") return false;
  } catch {
    /* ignore */
  }
  return fallback;
}

function buildUserContent(text: string, attachments: Attachment[]): string | HermesContentPart[] {
  if (attachments.length === 0) return text;
  const parts: HermesContentPart[] = [
    { type: "text", text: text.trim() || "Please review the attached image." },
    ...attachments.map((attachment) => ({
      type: "image_url" as const,
      image_url: { url: attachment.dataUrl },
    })),
  ];
  return parts;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function MarkdownMessage({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ href, children }) => (
          <a href={href} target="_blank" rel="noreferrer">
            {children}
          </a>
        ),
        img: ({ src, alt }) => (
          <a className="markdown-image-link" href={src} target="_blank" rel="noreferrer">
            <img src={src} alt={alt ?? ""} loading="lazy" />
          </a>
        ),
        code: ({ className, children }) => {
          const code = String(children).replace(/\n$/, "");
          return (
            <code className={className} title={code.length > 120 ? code : undefined}>
              {children}
            </code>
          );
        },
      }}
    >
      {content || ""}
    </ReactMarkdown>
  );
}

function ToolCard({ tool }: { tool: ToolEvent }) {
  const [open, setOpen] = useState(false);
  const isDone = tool.status === "completed";
  const raw = tool.raw ? JSON.stringify(tool.raw, null, 2) : "";

  return (
    <article className={`tool-card ${isDone ? "tool-card-done" : "tool-card-running"}`}>
      <button type="button" className="tool-summary" onClick={() => setOpen((value) => !value)}>
        <span className="tool-icon" aria-hidden>
          <ToolPixelIcon tool={tool.tool} emoji={tool.emoji} />
        </span>
        <span>
          <strong>{tool.label || tool.tool}</strong>
          <small>{tool.tool}</small>
        </span>
        <span className="tool-state">{isDone ? "completed" : "running"}</span>
      </button>
      {open && raw && <pre className="tool-raw">{raw}</pre>}
    </article>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const hasBody =
    Boolean(message.content.trim()) ||
    Boolean(message.attachments?.length) ||
    Boolean(message.tools?.length);

  if (!hasBody && message.status === "streaming") {
    return (
      <div className={`jchat-bubble-row jchat-bubble-row-${message.role}`}>
        <div className={`jchat-bubble jchat-bubble-${message.role}`}>
          <span className="jchat-streaming">…</span>
        </div>
      </div>
    );
  }

  if (!hasBody) return null;

  return (
    <div className={`jchat-bubble-row jchat-bubble-row-${message.role}`}>
      <article className={`jchat-bubble jchat-bubble-${message.role}`}>
        {message.attachments && message.attachments.length > 0 && (
          <div className="attachment-grid">
            {message.attachments.map((attachment) => (
              <a href={attachment.dataUrl} target="_blank" rel="noreferrer" key={attachment.id}>
                <img src={attachment.dataUrl} alt={attachment.name} />
              </a>
            ))}
          </div>
        )}

        {message.reasoning && (
          <details className="reasoning">
            <summary>Reasoning</summary>
            <p>{message.reasoning}</p>
          </details>
        )}

        {message.tools && message.tools.length > 0 && (
          <div className="tool-list">
            {message.tools.map((tool) => (
              <ToolCard key={tool.id} tool={tool} />
            ))}
          </div>
        )}

        <div className="markdown-body">
          <MarkdownMessage content={message.content} />
          {message.status === "streaming" && <span className="jchat-streaming"> …</span>}
        </div>
      </article>
    </div>
  );
}

function App() {
  const identity = useIdentity();
  const portraitUrl = resolvePortraitUrl(identity.imageUrl, identity.avatarUrl);

  const [sessionId, setSessionId] = useState(() => newId("hermes-chat"));
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [status, setStatus] = useState<"checking" | "ready" | "error">("checking");
  const [statusText, setStatusText] = useState("Starting Hermes gateway if needed...");
  const [busy, setBusy] = useState(false);
  const [videoOn, setVideoOn] = useState(true);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [chatSessions, setChatSessions] = useState<ChatSessionRow[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionsError, setSessionsError] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [voiceInputOn, setVoiceInputOn] = useState(false);
  const [speechOutputOn, setSpeechOutputOn] = useState(() => readBoolLs(LS_SPEECH_OUT, false));
  const [s2sVoiceAvailable, setS2sVoiceAvailable] = useState(false);
  const [voiceSessionState, setVoiceSessionState] = useState("idle");
  const [voiceHint, setVoiceHint] = useState("");
  const [composioEnabled, setComposioEnabled] = useState(false);

  const s2sVoiceRef = useRef<{ stop: () => Promise<void> } | null>(null);
  const s2sAssistantIdRef = useRef<string | null>(null);

  const sessionIdRef = useRef(sessionId);
  const busyRef = useRef(busy);
  const voiceInputOnRef = useRef(false);
  const pauseVoiceCaptureRef = useRef(false);
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null);
  const ttsAbortRef = useRef<AbortController | null>(null);
  /** At most one auto-retry per assistant utterance (avoids spinning on persistent 5xx). */
  const lastAutoTtsRetryKeyRef = useRef<string | null>(null);
  /** Bumped after transient TTS failures so the effect can retry the same assistant text. */
  const [ttsRetryEpoch, setTtsRetryEpoch] = useState(0);
  /** Tray toast fires once per completed assistant message (shell hides it when chat is open). */
  const lastTrayNotifiedIdRef = useRef<string | null>(null);
  const trayAudioLevelRef = useRef(0);
  const traySyncRafRef = useRef<number | null>(null);

  const transcriptForHermes = useMemo<HermesMessage[]>(
    () => [{ role: "system", content: SYSTEM_PROMPT }],
    [],
  );

  sessionIdRef.current = sessionId;
  busyRef.current = busy;
  voiceInputOnRef.current = voiceInputOn;

  const updateAssistant = useCallback((assistantId: string, apply: (message: ChatMessage) => ChatMessage) => {
    setMessages((current) => current.map((message) => (message.id === assistantId ? apply(message) : message)));
  }, []);

  const handleDesktopAction = useCallback(async (action: DesktopAction) => {
    await executeDesktopAction(action);
  }, []);

  const refreshChatSessions = useCallback(async () => {
    setSessionsLoading(true);
    setSessionsError("");
    try {
      const rows = await fetchChatSessions(API_BASE);
      setChatSessions(rows);
    } catch (error) {
      setSessionsError(error instanceof Error ? error.message : String(error));
    } finally {
      setSessionsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!historyOpen) return;
    void refreshChatSessions();
  }, [historyOpen, refreshChatSessions]);

  const startNewChat = useCallback(() => {
    if (busy) return;
    setSessionId(newId("hermes-chat"));
    setMessages([]);
    setDraft("");
    setAttachments([]);
  }, [busy]);

  const resumeSession = useCallback(
    async (targetSessionId: string) => {
      if (busy || targetSessionId === sessionId) return;
      setSessionsLoading(true);
      setSessionsError("");
      try {
        const { sessionId: resolvedId, messages: transcript } = await fetchChatSessionMessages(
          API_BASE,
          targetSessionId,
        );
        setSessionId(resolvedId);
        setMessages(
          transcript.map((message) => ({
            id: newId(message.role),
            role: message.role,
            content: message.content,
            status: "done" as const,
          })),
        );
        setDraft("");
        setAttachments([]);
      } catch (error) {
        setSessionsError(error instanceof Error ? error.message : String(error));
      } finally {
        setSessionsLoading(false);
      }
    },
    [busy, sessionId],
  );

  const executeTurn = useCallback(
    async (text: string, userAttachments: Attachment[]) => {
      const trimmed = text.trim();
      if (!trimmed && userAttachments.length === 0) return;

      const quickOpen = userAttachments.length === 0 ? matchQuickDesktopOpen(trimmed) : null;
      if (quickOpen) {
        const userMessage: ChatMessage = {
          id: newId("user"),
          role: "user",
          content: trimmed,
        };
        const assistantMessage: ChatMessage = {
          id: newId("assistant"),
          role: "assistant",
          content: `Opened ${quickOpen.target}.`,
          status: "done",
        };
        setMessages((current) => [...current, userMessage, assistantMessage]);
        void executeDesktopAction(quickOpen);
        return;
      }

      const userMessage: ChatMessage = {
        id: newId("user"),
        role: "user",
        content: trimmed,
        attachments: userAttachments.length > 0 ? userAttachments : undefined,
      };
      const assistantId = newId("assistant");
      const assistantMessage: ChatMessage = {
        id: assistantId,
        role: "assistant",
        content: "",
        tools: [],
        status: "streaming",
      };

      setMessages((current) => [...current, userMessage, assistantMessage]);
      setBusy(true);

      const payloadMessages: HermesMessage[] = [
        ...transcriptForHermes,
        { role: "user", content: buildUserContent(trimmed, userAttachments) },
      ];

      try {
        const response = await fetch(`${API_BASE}/stream`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: sessionIdRef.current, messages: payloadMessages }),
        });

        if (!response.ok) throw new Error(await response.text());

        await parseSseStream(response, (event) => {
          const parsed = safeJson(event.data) as Record<string, unknown> | undefined;
          if (event.event === "session" && typeof parsed?.sessionId === "string") {
            setSessionId(parsed.sessionId);
            return;
          }
          if (event.event === "delta" && typeof parsed?.text === "string") {
            updateAssistant(assistantId, (message) => ({ ...message, content: message.content + parsed.text }));
            return;
          }
          if (event.event === "reasoning" && typeof parsed?.text === "string") {
            updateAssistant(assistantId, (message) => ({
              ...message,
              reasoning: (message.reasoning || "") + parsed.text,
            }));
            return;
          }
          if (event.event === "tool" && parsed) {
            const toolCallId =
              typeof parsed.toolCallId === "string"
                ? parsed.toolCallId
                : typeof parsed.tool === "string"
                  ? parsed.tool
                  : newId("tool");
            const statusValue = parsed.status === "completed" ? "completed" : "running";
            updateAssistant(assistantId, (message) => {
              const existing = message.tools ?? [];
              const nextTool: ToolEvent = {
                id: toolCallId,
                tool: typeof parsed.tool === "string" ? parsed.tool : "tool",
                emoji: typeof parsed.emoji === "string" ? parsed.emoji : undefined,
                label: typeof parsed.label === "string" ? parsed.label : undefined,
                status: statusValue,
                raw: parsed.raw ?? parsed,
              };
              const found = existing.some((tool) => tool.id === toolCallId);
              return {
                ...message,
                tools: found
                  ? existing.map((tool) => (tool.id === toolCallId ? { ...tool, ...nextTool } : tool))
                  : [...existing, nextTool],
              };
            });
            return;
          }
          if (event.event === "desktop_action" && parsed?.action) {
            const action = parsed.action as DesktopAction;
            if (
              action &&
              (action.kind === "module" || action.kind === "file") &&
              typeof action.target === "string"
            ) {
              void handleDesktopAction(action);
            }
            return;
          }
          if (event.event === "error") {
            updateAssistant(assistantId, (message) => ({
              ...message,
              content: message.content || String(parsed?.error || "Hermes stream failed"),
              status: "error",
            }));
          }
        });

        updateAssistant(assistantId, (message) => ({ ...message, status: "done" }));
        if (historyOpen) void refreshChatSessions();
      } catch (error) {
        updateAssistant(assistantId, (message) => ({
          ...message,
          content: message.content || (error instanceof Error ? error.message : String(error)),
          status: "error",
        }));
      } finally {
        setBusy(false);
      }
    },
    [transcriptForHermes, updateAssistant, historyOpen, refreshChatSessions, handleDesktopAction],
  );

  const sendMessage = useCallback(async () => {
    const text = draft.trim();
    if (busy || (!text && attachments.length === 0)) return;

    const userAttachments = attachments;
    setDraft("");
    setAttachments([]);
    await executeTurn(text, userAttachments);
  }, [attachments, busy, draft, executeTurn]);

  const toggleVoiceInput = useCallback(() => {
    setVoiceInputOn((prev) => !prev);
  }, []);

  const pushTrayVoiceState = useCallback(
    (overrides?: { audioLevel?: number }) => {
      syncJChatTray({
        assistantName: identity.name,
        portraitUrl,
        voiceInputOn,
        voiceAvailable: s2sVoiceAvailable,
        audioLevel: overrides?.audioLevel ?? trayAudioLevelRef.current,
      });
    },
    [identity.name, portraitUrl, voiceInputOn, s2sVoiceAvailable],
  );

  const scheduleTrayVoiceSync = useCallback(
    (level: number) => {
      trayAudioLevelRef.current = level;
      if (traySyncRafRef.current != null) return;
      traySyncRafRef.current = window.requestAnimationFrame(() => {
        traySyncRafRef.current = null;
        pushTrayVoiceState({ audioLevel: trayAudioLevelRef.current });
      });
    },
    [pushTrayVoiceState],
  );

  const toggleSpeechOutput = useCallback(() => {
    setSpeechOutputOn((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(LS_SPEECH_OUT, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      if (!next) {
        ttsAbortRef.current?.abort();
        ttsAbortRef.current = null;
        if (ttsAudioRef.current) {
          ttsAudioRef.current.pause();
          ttsAudioRef.current.src = "";
          ttsAudioRef.current = null;
        }
        pauseVoiceCaptureRef.current = false;
      }
      return next;
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch(`${API_BASE}/status`, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(await response.text());
        const json = (await response.json()) as {
          ok?: boolean;
          composio?: { enabled?: boolean };
        };
        if (!cancelled) {
          setComposioEnabled(Boolean(json.composio?.enabled));
          setStatus("ready");
          setStatusText(
            json.composio?.enabled ? "Hermes ready · Composio apps" : "Gateway ready",
          );
        }
      })
      .catch((error: Error) => {
        if (!cancelled) {
          setStatus("error");
          setStatusText(error.message);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetchVoiceStatus(VOICE_API_BASE).then((status) => {
      if (cancelled) return;
      setS2sVoiceAvailable(Boolean(status.available));
      if (status.available) {
        setVoiceHint("");
      } else if (status.reason) {
        setVoiceHint(status.reason);
      } else {
        setVoiceHint("Voice unavailable — start voice-realtime (npm run dev:arozos)");
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /** Re-check voice-realtime when user enables mic (service may have started after page load). */
  useEffect(() => {
    if (!voiceInputOn) return;
    let cancelled = false;
    void fetchVoiceStatus(VOICE_API_BASE).then((status) => {
      if (cancelled) return;
      setS2sVoiceAvailable(Boolean(status.available));
      if (status.available) setVoiceHint("");
      else if (status.reason) setVoiceHint(status.reason);
    });
    return () => {
      cancelled = true;
    };
  }, [voiceInputOn]);

  /** OpenAI Realtime S2S via voice-realtime. */
  useEffect(() => {
    if (!voiceInputOn || !s2sVoiceAvailable) {
      void s2sVoiceRef.current?.stop();
      s2sVoiceRef.current = null;
      s2sAssistantIdRef.current = null;
      if (!voiceInputOn) setVoiceSessionState("idle");
      return;
    }

    let cancelled = false;
    setSpeechOutputOn(true);

    void (async () => {
      try {
        const session = await startJoshuVoiceSession({
          voiceApiBase: VOICE_API_BASE,
          sessionId: sessionIdRef.current,
          onState: (state) => setVoiceSessionState(state),
          onUserTranscript: (text, partial) => {
            if (partial) return;
            const trimmed = text.trim();
            if (!trimmed) return;

            const userMessage: ChatMessage = {
              id: newId("user"),
              role: "user",
              content: trimmed,
            };
            const assistantId = newId("assistant");
            s2sAssistantIdRef.current = assistantId;
            const assistantMessage: ChatMessage = {
              id: assistantId,
              role: "assistant",
              content: "",
              tools: [],
              status: "streaming",
            };
            setMessages((current) => [...current, userMessage, assistantMessage]);
            setBusy(true);
          },
          onAssistantDelta: (delta) => {
            const assistantId = s2sAssistantIdRef.current;
            if (!assistantId) return;
            updateAssistant(assistantId, (message) => ({ ...message, content: message.content + delta }));
          },
          onAssistantDone: (text) => {
            const assistantId = s2sAssistantIdRef.current;
            if (assistantId) {
              updateAssistant(assistantId, (message) => ({
                ...message,
                content: text.trim() ? text : message.content,
                status: "done",
              }));
            }
            s2sAssistantIdRef.current = null;
            setBusy(false);
          },
          onThinkJobStart: () => {
            const assistantId = s2sAssistantIdRef.current;
            if (assistantId) {
              updateAssistant(assistantId, (message) => ({
                ...message,
                content: "",
                status: "streaming",
              }));
            }
          },
          onDesktopAction: (action) => {
            void handleDesktopAction(action);
          },
          onBargeIn: () => {
            const assistantId = s2sAssistantIdRef.current;
            if (assistantId) {
              updateAssistant(assistantId, (message) => ({
                ...message,
                status: message.content.trim() ? "done" : "error",
              }));
            }
            s2sAssistantIdRef.current = null;
            setBusy(false);
          },
          onError: (msg) => {
            console.warn("[hermes-chat] voice:", msg);
            setVoiceHint(msg);
          },
          onAudioLevel: (level) => {
            if (voiceInputOnRef.current) scheduleTrayVoiceSync(level);
          },
        });
        if (cancelled) {
          await session.stop();
          return;
        }
        s2sVoiceRef.current = session;
      } catch (error) {
        if (!cancelled) {
          const msg = error instanceof Error ? error.message : String(error);
          setVoiceHint(`Voice connection failed: ${msg}`);
        }
      }
    })();

    return () => {
      cancelled = true;
      void s2sVoiceRef.current?.stop();
      s2sVoiceRef.current = null;
      s2sAssistantIdRef.current = null;
    };
  }, [voiceInputOn, s2sVoiceAvailable, updateAssistant, scheduleTrayVoiceSync, handleDesktopAction]);

  /** Shell tray mic button → toggle voice mode. */
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string } | null;
      if (!data || data.type !== "jchat:voice-toggle") return;
      toggleVoiceInput();
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [toggleVoiceInput]);

  /** Keep taskbar tray in sync with voice availability + mic state. */
  useEffect(() => {
    if (!voiceInputOn) trayAudioLevelRef.current = 0;
    pushTrayVoiceState({ audioLevel: voiceInputOn ? trayAudioLevelRef.current : 0 });
  }, [voiceInputOn, s2sVoiceAvailable, pushTrayVoiceState]);

  useEffect(() => {
    scrollRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  /** Persona for the desk bubble (name + portrait). */
  useEffect(() => {
    syncJChatTray({ assistantName: identity.name, portraitUrl });
  }, [identity.name, portraitUrl]);

  /** Rectangular toast only when a new assistant reply completes (gateway notification). */
  useEffect(() => {
    const lastAssistant = [...messages]
      .reverse()
      .find((m) => m.role === "assistant" && m.status === "done" && m.content.trim());
    if (!lastAssistant || lastAssistant.id === lastTrayNotifiedIdRef.current) return;
    lastTrayNotifiedIdRef.current = lastAssistant.id;
    syncJChatTray({
      assistantName: identity.name,
      portraitUrl,
      notification: lastAssistant.content.trim().slice(0, 120),
    });
  }, [messages, identity.name, portraitUrl]);

  /**
   * Stable stringify of the current TTS job so the effect does not re-run (and abort in-flight
   * requests) on unrelated `messages` churn. Only changes when Speech is off, assistant id/text
   * changes, or `ttsRetryEpoch` bumps after a retryable failure.
   */
  const hermesChatTtsJobJson = useMemo(() => {
    if (!speechOutputOn || (voiceInputOn && s2sVoiceAvailable) || voiceSessionState !== "idle") {
      return null;
    }

    const last = [...messages].reverse().find((m) => m.role === "assistant");
    if (!last || (last.status !== "done" && last.status !== "error")) return null;

    const plain = normalizeSpeakableText(last.content);
    if (!plain) return null;

    const spoken = normalizeSpeakableText(textForSpeechOutput(plain));
    if (!spoken) return null;

    return JSON.stringify({ id: last.id, spoken, r: ttsRetryEpoch });
  }, [messages, speechOutputOn, ttsRetryEpoch, voiceInputOn, s2sVoiceAvailable, voiceSessionState]);

  /** Hermes-backed TTS — pause mic while audio plays (echo avoidance). */
  useEffect(() => {
    if (!hermesChatTtsJobJson) {
      ttsAbortRef.current?.abort();
      ttsAbortRef.current = null;
      pauseVoiceCaptureRef.current = false;
      return;
    }

    let job: { id: string; spoken: string };
    try {
      job = JSON.parse(hermesChatTtsJobJson) as { id: string; spoken: string };
    } catch {
      return;
    }
    const { spoken } = job;

    ttsAbortRef.current?.abort();
    const controller = new AbortController();
    ttsAbortRef.current = controller;

    pauseVoiceCaptureRef.current = true;

    void (async () => {
      try {
        const response = await fetch(`${API_BASE}/tts`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: spoken }),
          signal: controller.signal,
        });
        if (!response.ok) {
          const errText = await response.text().catch(() => "");
          console.warn("[hermes-chat] TTS failed:", response.status, errText);
          pauseVoiceCaptureRef.current = false;
          if (response.status >= 500 || response.status === 429) {
            const retryKey = `${job.id}::${spoken}`;
            if (lastAutoTtsRetryKeyRef.current !== retryKey) {
              lastAutoTtsRetryKeyRef.current = retryKey;
              setTtsRetryEpoch((e) => e + 1);
            }
          }
          return;
        }
        lastAutoTtsRetryKeyRef.current = null;
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        ttsAudioRef.current = audio;
        audio.onended = () => {
          URL.revokeObjectURL(url);
          pauseVoiceCaptureRef.current = false;
          if (ttsAudioRef.current === audio) ttsAudioRef.current = null;
        };
        audio.onerror = () => {
          URL.revokeObjectURL(url);
          pauseVoiceCaptureRef.current = false;
          if (ttsAudioRef.current === audio) ttsAudioRef.current = null;
        };
        await audio.play().catch(() => {
          URL.revokeObjectURL(url);
          pauseVoiceCaptureRef.current = false;
        });
      } catch {
        pauseVoiceCaptureRef.current = false;
      }
    })();

    return () => {
      controller.abort();
    };
  }, [hermesChatTtsJobJson]);

  const addFiles = useCallback(async (files: FileList | null) => {
    if (!files) return;
    const next: Attachment[] = [];
    for (const file of Array.from(files)) {
      if (!file.type.startsWith("image/")) continue;
      if (file.size > 5 * 1024 * 1024) {
        window.alert(`${file.name} is larger than 5 MB.`);
        continue;
      }
      next.push({
        id: newId("image"),
        name: file.name,
        mimeType: file.type,
        dataUrl: await readDataUrl(file),
      });
    }
    setAttachments((current) => [...current, ...next].slice(0, 6));
  }, []);

  const micSupported = typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia);
  const onAir = voiceInputOn && s2sVoiceAvailable;
  const linkReady = status === "ready";

  const openJWeb = useCallback(() => {
    openDesktopModule("jWeb");
  }, []);

  const hangUp = useCallback(() => {
    setVoiceInputOn(false);
    ttsAbortRef.current?.abort();
    if (ttsAudioRef.current) {
      ttsAudioRef.current.pause();
      ttsAudioRef.current.src = "";
      ttsAudioRef.current = null;
    }
  }, []);

  return (
    <main className="jchat-shell">
      <header className={`jchat-status jchat-status-${status}`}>
        <span className="jchat-status-dot" aria-hidden />
        <span>{statusText}</span>
        <div className="jchat-status-actions">
          <button
            type="button"
            className={`jchat-link-btn ${historyOpen ? "jchat-link-btn-on" : ""}`}
            aria-pressed={historyOpen}
            aria-expanded={historyOpen}
            onClick={() => setHistoryOpen((open) => !open)}
          >
            History
          </button>
          <button
            type="button"
            className="jchat-link-btn"
            disabled={!composioEnabled}
            title={composioEnabled ? "Open Connectors" : "Set COMPOSIO_API_KEY to enable"}
            onClick={openConnectorsApp}
          >
            Connectors
          </button>
          <button
            type="button"
            className={`jchat-link-btn ${speechOutputOn ? "jchat-link-btn-on" : ""}`}
            aria-pressed={speechOutputOn}
            disabled={voiceInputOn && s2sVoiceAvailable}
            onClick={() => toggleSpeechOutput()}
          >
            Speech {speechOutputOn ? "on" : "off"}
          </button>
        </div>
      </header>

      {voiceHint && <p className="voice-hint">{voiceHint}</p>}

      <section className="jchat-stage" aria-label="Video presence">
        {videoOn ? (
          <img src={portraitUrl} alt={`${identity.name} portrait`} />
        ) : (
          <div className="jchat-stage-placeholder">Video off</div>
        )}
        {onAir && <span className="jchat-badge jchat-badge-onair">● ON AIR</span>}
        {linkReady && <span className="jchat-badge jchat-badge-ready">LINK READY</span>}
      </section>

      <div className="jchat-controls" role="toolbar" aria-label="Call controls">
        <button
          type="button"
          className={`jchat-ctrl ${voiceInputOn ? "jchat-ctrl-on" : ""} ${!micSupported || !s2sVoiceAvailable ? "jchat-ctrl-disabled" : ""}`}
          aria-pressed={voiceInputOn}
          aria-disabled={!micSupported || !s2sVoiceAvailable}
          title={
            s2sVoiceAvailable
              ? "Voice mode — Realtime S2S"
              : voiceHint || "Voice unavailable"
          }
          onClick={() => {
            if (!micSupported || !s2sVoiceAvailable) {
              setVoiceHint(
                (prev) =>
                  prev ||
                  "Voice unavailable — ensure voice-realtime is running (npm run dev:arozos)",
              );
              return;
            }
            toggleVoiceInput();
          }}
        >
          <span className="jchat-ctrl-icon" aria-hidden>
            🎙
          </span>
          <span className="jchat-ctrl-label">Mic</span>
        </button>
        <button
          type="button"
          className={`jchat-ctrl ${videoOn ? "jchat-ctrl-on" : ""}`}
          aria-pressed={videoOn}
          onClick={() => setVideoOn((v) => !v)}
        >
          <span className="jchat-ctrl-icon" aria-hidden>
            📹
          </span>
          <span className="jchat-ctrl-label">Video</span>
        </button>
        <button type="button" className="jchat-ctrl" onClick={openJWeb} title="Open jWeb to share your desk">
          <span className="jchat-ctrl-icon" aria-hidden>
            🖥
          </span>
          <span className="jchat-ctrl-label">Share Desk</span>
        </button>
        <button type="button" className="jchat-ctrl jchat-ctrl-hangup" onClick={hangUp} title="End voice session">
          <span className="jchat-ctrl-icon" aria-hidden>
            ✕
          </span>
          <span className="jchat-ctrl-label">Hang Up</span>
        </button>
      </div>

      <div className={`jchat-split ${historyOpen ? "jchat-split-history-open" : ""}`}>
        {historyOpen && (
          <aside className="jchat-history" aria-label={`Recent chats with ${identity.name}`}>
            <div className="jchat-history-head-row">
              <h2 className="jchat-history-head">Recent chats</h2>
              <button type="button" className="jchat-history-new" onClick={startNewChat} disabled={busy}>
                New
              </button>
            </div>
            <div className="jchat-history-list">
              {sessionsLoading && chatSessions.length === 0 ? (
                <p className="jchat-history-status">Loading…</p>
              ) : sessionsError && chatSessions.length === 0 ? (
                <p className="jchat-history-status jchat-history-status-error">{sessionsError}</p>
              ) : chatSessions.length === 0 ? (
                <p className="jchat-history-status">No past chats yet.</p>
              ) : (
                chatSessions.map((item) => (
                  <button
                    type="button"
                    key={item.id}
                    className={`jchat-history-item ${sessionId === item.id ? "jchat-history-item-active" : ""}`}
                    onClick={() => void resumeSession(item.id)}
                    disabled={busy}
                  >
                    <span className="jchat-history-icon" aria-hidden>
                      💬
                    </span>
                    <span>
                      <p className="jchat-history-title">{item.title}</p>
                      <p className="jchat-history-time">{formatSessionWhen(item.lastActive)}</p>
                    </span>
                  </button>
                ))
              )}
            </div>
          </aside>
        )}

        <section className="jchat-thread" aria-label="Chat thread">
          <div className="jchat-messages">
            {messages.length === 0 ? (
              <p className="jchat-empty">
                Start a fresh session with {identity.name}. Ask for research, mail, or attach an image.
              </p>
            ) : (
              <>
                <div className="jchat-day-sep">Today</div>
                {messages.map((message) => (
                  <MessageBubble key={message.id} message={message} />
                ))}
              </>
            )}
            <div ref={scrollRef} />
          </div>

          {attachments.length > 0 && (
            <div className="jchat-attach-row" aria-label="Pending attachments">
              {attachments.map((attachment) => (
                <button
                  type="button"
                  key={attachment.id}
                  className="jchat-attach-chip"
                  onClick={() => setAttachments((current) => current.filter((item) => item.id !== attachment.id))}
                  title="Remove"
                >
                  <img src={attachment.dataUrl} alt={attachment.name} />
                  {attachment.name}
                </button>
              ))}
            </div>
          )}

          <form
            className="jchat-composer"
            onSubmit={(event) => {
              event.preventDefault();
              void sendMessage();
            }}
          >
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Type a message…"
              rows={1}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void sendMessage();
                }
              }}
            />
            <button
              type="submit"
              className="jchat-send"
              disabled={busy || status === "error" || (!draft.trim() && attachments.length === 0)}
            >
              {busy ? "…" : "Send"}
            </button>
          </form>
          <input
            ref={fileInputRef}
            className="jchat-file-input"
            type="file"
            accept="image/*"
            multiple
            onChange={(event) => {
              void addFiles(event.target.files);
              event.currentTarget.value = "";
            }}
          />
        </section>
      </div>
    </main>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
