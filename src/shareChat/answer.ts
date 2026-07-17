/**
 * Constrained RAG answerer for public share-chat.
 * Uses the same OpenRouter model as Hermes (not Day-0 nano).
 * No Hermes tools — scoped snippets in, synthesized answer out.
 */

import fs from "node:fs";
import path from "node:path";
import { resolveBoxSecret } from "../boxSecrets/resolve.js";
import { getHermesHomeDir } from "../hermesVoiceRuntime.js";
import { JOSHU_OPENROUTER_DEFAULT_MODEL } from "../joshuOpenRouterDefaults.js";
import { withJoshuLlmObservation } from "../observability/langfuse.js";
import { openRouterUsageToLangfuseDetails, type OpenRouterUsage } from "../day0/llm.js";
import type { ShareScope } from "./shareScope.js";
import type { ScopedEvidence } from "./scopedBrain.js";

export interface ShareChatAnswer {
  answer: string;
  citations: Array<{ title: string; slug: string }>;
  refused: boolean;
  assistantName: string;
  model?: string;
}

function readHermesEnvKey(key: string): string {
  const envPath = path.join(getHermesHomeDir(), ".env");
  try {
    const prefix = `${key}=`;
    for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
      if (line.startsWith(prefix)) {
        const value = line.slice(prefix.length).trim();
        if (value) return value;
      }
    }
  } catch {
    /* missing hermes home env is fine */
  }
  return "";
}

/** Same key resolution path Hermes uses for OpenRouter completions. */
function resolveApiKey(projectRoot = process.cwd()): string {
  return (
    process.env.JOSHU_SHARE_CHAT_API_KEY?.trim() ||
    resolveBoxSecret("OPENROUTER_API_KEY", projectRoot) ||
    process.env.OPENROUTER_API_KEY?.trim() ||
    readHermesEnvKey("OPENROUTER_API_KEY") ||
    process.env.JOSHU_DAY0_API_KEY?.trim() ||
    ""
  );
}

/** Prefer Hermes box model, then share-chat override, then Joshu default. */
function resolveModel(): string {
  return (
    process.env.JOSHU_SHARE_CHAT_MODEL?.trim() ||
    process.env.JOSHU_HERMES_MODEL?.trim() ||
    JOSHU_OPENROUTER_DEFAULT_MODEL
  );
}

function assistantName(): string {
  return process.env.JOSHU_NAME?.trim() || "Companion";
}

function buildSystemPrompt(scope: ShareScope, name: string): string {
  return [
    `You are ${name}, answering questions about a shared file set.`,
    "Your job is advanced retrieval + reassembly: read the evidence carefully, connect related passages, and synthesize a clear answer.",
    "Hard rules:",
    "- Use ONLY the provided evidence from the shared files.",
    "- Prefer assembling a useful answer from partial snippets over refusing.",
    "- If several script/call examples appear, pick the best match for the question and quote or paraphrase it clearly.",
    "- If the evidence is related but incomplete, answer with what is available and note what is missing.",
    "- Only say the answer is not in the shared files when the evidence is clearly unrelated or empty.",
    "- Do not invent facts, paths, credentials, or owner details.",
    "- Do not reveal private Desktop paths, usernames, emails, API keys, or anything outside the evidence.",
    "- Cite source filenames in parentheses when you use a snippet (e.g. (notes.md)).",
    "- Structure longer answers with short headings or bullets when helpful.",
    `- Shared item: "${scope.displayName}" (${scope.isFolder ? "folder" : "file"}).`,
  ].join("\n");
}

function formatEvidenceBlock(evidence: ScopedEvidence[]): string {
  if (!evidence.length) return "(no evidence)";
  return evidence
    .map((e, i) => {
      return `[${i + 1}] ${e.title} (${e.slug})\n${e.snippet}`;
    })
    .join("\n\n");
}

function extractiveFallback(
  question: string,
  evidence: ScopedEvidence[],
  name: string,
): ShareChatAnswer {
  if (!evidence.length) {
    return {
      answer:
        "I couldn't find anything about that in the shared files. Try asking about topics that appear in the shared documents.",
      citations: [],
      refused: true,
      assistantName: name,
    };
  }
  const top = evidence.slice(0, 4);
  const bits = top.map((e) => {
    const line = e.snippet.split(/\n/).map((l) => l.trim()).find(Boolean) || e.snippet;
    return `${line.slice(0, 400)}${line.length > 400 ? "…" : ""} (${e.title})`;
  });
  return {
    answer: `Based on the shared files:\n\n${bits.join("\n\n")}`,
    citations: top.map((e) => ({ title: e.title, slug: e.slug })),
    refused: false,
    assistantName: name,
  };
}

async function llmAnswer(
  question: string,
  scope: ShareScope,
  evidence: ScopedEvidence[],
  name: string,
): Promise<{ text: string; model: string } | null> {
  let text = "";
  let model = resolveModel();
  const streamed = await streamLlmAnswer(question, scope, evidence, name, {
    onDelta: (chunk) => {
      text += chunk;
    },
    onModel: (m) => {
      model = m;
    },
  });
  if (!streamed || !text.trim()) return null;
  return { text: text.trim(), model };
}

export type ShareChatStreamHandlers = {
  onDelta: (chunk: string) => void;
  onModel?: (model: string) => void;
};

/** Where the public question came from — Langfuse tag/metadata only. */
export type ShareChatChannel = "web" | "slack";

/** Result of the raw OpenRouter stream, including usage from the final chunk. */
type StreamCoreResult = {
  gotAny: boolean;
  text: string;
  resolvedModel?: string;
  generationId?: string;
  usage?: OpenRouterUsage;
};

async function streamLlmAnswerCore(
  messages: Array<{ role: string; content: string }>,
  model: string,
  apiKey: string,
  handlers: ShareChatStreamHandlers,
  signal?: AbortSignal,
): Promise<StreamCoreResult> {
  const baseUrl = (
    process.env.JOSHU_SHARE_CHAT_BASE_URL?.trim() ||
    process.env.JOSHU_DAY0_BASE_URL?.trim() ||
    "https://openrouter.ai/api/v1"
  ).replace(/\/$/, "");

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://joshu.local",
      "X-Title": "Joshu Share Chat",
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: 1600,
      temperature: 0.25,
      stream: true,
      // Ask OpenRouter to append token/cost usage to the final stream chunk.
      usage: { include: true },
    }),
    signal: signal ?? AbortSignal.timeout(90_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Share chat LLM HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  if (!res.body) {
    throw new Error("Share chat LLM returned no body");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const result: StreamCoreResult = { gotAny: false, text: "" };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const json = JSON.parse(payload) as {
          id?: string;
          model?: string;
          usage?: OpenRouterUsage;
          choices?: Array<{ delta?: { content?: string }; message?: { content?: string } }>;
        };
        if (json.model) {
          result.resolvedModel = json.model;
          handlers.onModel?.(json.model);
        }
        if (json.id) result.generationId = json.id;
        if (json.usage) result.usage = json.usage;
        const chunk = json.choices?.[0]?.delta?.content ?? "";
        if (chunk) {
          result.gotAny = true;
          result.text += chunk;
          handlers.onDelta(chunk);
        }
      } catch {
        /* skip malformed SSE chunks */
      }
    }
  }

  return result;
}

/**
 * Stream OpenRouter chat tokens; returns false when no API key / empty.
 * Traced in Langfuse (trace `joshu-share-chat`) with box user id + tags.
 */
export async function streamLlmAnswer(
  question: string,
  scope: ShareScope,
  evidence: ScopedEvidence[],
  name: string,
  handlers: ShareChatStreamHandlers,
  signal?: AbortSignal,
  channel: ShareChatChannel = "web",
): Promise<boolean> {
  const apiKey = resolveApiKey();
  if (!apiKey) return false;

  const model = resolveModel();
  handlers.onModel?.(model);

  const messages = [
    { role: "system", content: buildSystemPrompt(scope, name) },
    {
      role: "user",
      content: [
        `Question: ${question}`,
        "",
        "Evidence from shared files only (reassemble across snippets if needed):",
        formatEvidenceBlock(evidence),
      ].join("\n"),
    },
  ];

  const result = await withJoshuLlmObservation({
    traceName: "joshu-share-chat",
    generationName: "share-chat-answer",
    tags: ["share-chat", `share-chat:${channel}`],
    metadata: {
      shareUuid: scope.uuid,
      sharedItem: scope.displayName,
      isFolder: scope.isFolder,
      channel,
      evidenceCount: evidence.length,
      evidenceTitles: evidence.slice(0, 6).map((e) => e.title),
    },
    model,
    input: { messages },
    run: () => streamLlmAnswerCore(messages, model, apiKey, handlers, signal),
    formatOutput: (r) => ({ content: r.text }),
    formatGenerationDetails: (r) =>
      openRouterUsageToLangfuseDetails(r.usage, {
        requestedModel: model,
        resolvedModel: r.resolvedModel,
        generationId: r.generationId,
      }),
  });

  return result.gotAny;
}

/** Strip accidental private path leaks from model output. */
export function sanitizeAnswerText(text: string, scope: ShareScope): string {
  let out = text;
  out = out.replace(/\/(?:var\/lib\/arozos|\.local\/arozos-data)\/files\/users\/[^\s)`"']+/gi, "[shared files]");
  out = out.replace(new RegExp(escapeRegExp(scope.fileRealPath), "gi"), scope.displayName);
  if (scope.owner) {
    out = out.replace(new RegExp(`\\b${escapeRegExp(scope.owner)}\\b`, "g"), "the owner");
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function shareChatAssistantName(): string {
  return assistantName();
}

export function citationsFromEvidence(evidence: ScopedEvidence[]): Array<{ title: string; slug: string }> {
  return evidence.slice(0, 6).map((e) => ({
    title: e.title.replace(/\s+§\d+$/, ""),
    slug: e.slug,
  }));
}

/**
 * Stream a share-chat answer: optional status via onStatus, then token deltas.
 * Falls back to extractive (chunked) when the LLM is unavailable.
 */
export async function streamShareChatAnswer(opts: {
  question: string;
  scope: ShareScope;
  evidence: ScopedEvidence[];
  onStatus?: (phase: string, message: string) => void;
  onDelta: (chunk: string) => void;
  signal?: AbortSignal;
  /** Langfuse tag: where the question came from (default web). */
  channel?: ShareChatChannel;
}): Promise<ShareChatAnswer> {
  const name = assistantName();
  const q = opts.question.trim();
  if (!q) {
    const answer = "Please ask a question about the shared files.";
    opts.onDelta(answer);
    return { answer, citations: [], refused: true, assistantName: name };
  }
  if (!opts.evidence.length) {
    const answer =
      "That answer is not available in the shared files. I can only use the documents attached to this share.";
    opts.onDelta(answer);
    return { answer, citations: [], refused: true, assistantName: name };
  }

  opts.onStatus?.("writing", "Writing an answer from the shared files…");
  let answerText = "";
  let model: string | undefined;
  try {
    const ok = await streamLlmAnswer(
      q,
      opts.scope,
      opts.evidence,
      name,
      {
        onDelta: (chunk) => {
          answerText += chunk;
          opts.onDelta(chunk);
        },
        onModel: (m) => {
          model = m;
        },
      },
      opts.signal,
      opts.channel ?? "web",
    );
    if (!ok || !answerText.trim()) {
      const fallback = extractiveFallback(q, opts.evidence, name);
      // Simulate light streaming for extractive path
      for (const part of fallback.answer.match(/.{1,48}/gs) || [fallback.answer]) {
        opts.onDelta(part);
      }
      return fallback;
    }
  } catch (err) {
    console.warn("[share-chat] LLM stream failed:", err instanceof Error ? err.message : err);
    if (!answerText.trim()) {
      const fallback = extractiveFallback(q, opts.evidence, name);
      opts.onDelta(fallback.answer);
      return fallback;
    }
  }

  const sanitized = sanitizeAnswerText(answerText, opts.scope);
  return {
    answer: sanitized,
    citations: citationsFromEvidence(opts.evidence),
    refused: false,
    assistantName: name,
    model,
  };
}

export async function answerShareChatQuestion(
  question: string,
  scope: ShareScope,
  evidence: ScopedEvidence[],
  channel: ShareChatChannel = "web",
): Promise<ShareChatAnswer> {
  let answerText = "";
  const result = await streamShareChatAnswer({
    question,
    scope,
    evidence,
    channel,
    onDelta: (chunk) => {
      answerText += chunk;
    },
  });
  // Prefer sanitized final answer from streamShareChatAnswer
  void answerText;
  return result;
}
