import fs from "node:fs";
import path from "node:path";

import type { HermesApiRunner, HermesChatMessage } from "../hermesApi.js";
import { hermesSoulFilePath } from "../hermesSoulFile.js";
import { resolveJoshuIdentity } from "../joshuIdentity.js";
import { readAgentProfile } from "../nylas/profile.js";
import { buildOwnerTimeSystemMessage } from "../ownerLocalTime.js";
import { markdownSpeechPlaintext } from "../markdownSpeechPlaintext.js";
import type { FeedbackKeyword } from "./feedback.js";
import type { ProactiveCandidate } from "./types.js";

export type ProactiveComposeKind = "nudge" | "stale_review" | "feedback_ack" | "reply_ack";

export type ProactiveComposeInput = {
  kind: ProactiveComposeKind;
  projectRoot?: string;
  candidate?: ProactiveCandidate;
  feedbackKeyword?: FeedbackKeyword;
  ownerReplySnippet?: string;
  dailyCap?: number;
};

let hermesRunner: HermesApiRunner | null = null;

/** Wire Hermes runner from server bootstrap (inherits SOUL.md on chat). */
export function setProactiveHermesRunner(runner: HermesApiRunner): void {
  hermesRunner = runner;
}

export function getProactiveHermesRunner(): HermesApiRunner | null {
  return hermesRunner;
}

function readSoulSnippet(maxChars = 800): string {
  try {
    const file = hermesSoulFilePath();
    if (!fs.existsSync(file)) return "";
    return fs.readFileSync(file, "utf8").trim().slice(0, maxChars);
  } catch {
    return "";
  }
}

function readHighLevelSnippet(projectRoot: string, maxChars = 600): string {
  const file = path.join(projectRoot, "templates", "joshu-info", "highlevel-info.md");
  if (!fs.existsSync(file)) return "";
  try {
    return fs.readFileSync(file, "utf8").replace(/\s+/g, " ").trim().slice(0, maxChars);
  } catch {
    return "";
  }
}

function buildComposeUserPrompt(input: ProactiveComposeInput): string {
  const identity = resolveJoshuIdentity(input.projectRoot ?? process.cwd());
  const profile = readAgentProfile(input.projectRoot);
  const owner = profile?.ownerName?.trim() || identity.owner.displayName || "the owner";
  const c = input.candidate;

  const lines = [
    "Compose an outbound SMS to the box owner for proactive Joshu.",
    `Compose kind: ${input.kind}`,
    `Owner first name or display: ${owner}`,
    "Rules: first person as the companion (SOUL.md voice), warm and natural, plain text only, no markdown, no Kanban board slugs.",
    "Weave feedback naturally when kind is nudge or stale_review (MORE/LESS/USEFUL — not a rigid footer).",
    "Include 1–2 specific suggested follow-ups for the task when kind is nudge or stale_review.",
    "Keep SMS to about 2–4 sentences unless stale_review needs one more.",
  ];

  if (c) {
    lines.push(`Task title: ${c.title}`);
    lines.push(`Block reason: ${c.blockReason ?? "waiting on owner"}`);
    if (c.body?.trim()) {
      lines.push(`Task context (trimmed): ${c.body.trim().slice(0, 400)}`);
    }
    lines.push(`Append final line exactly: Ref: pj/${c.taskId}`);
  }

  if (input.kind === "feedback_ack" && input.feedbackKeyword) {
    lines.push(`Owner sent feedback keyword: ${input.feedbackKeyword}`);
    if (input.dailyCap !== undefined) {
      lines.push(`New daily nudge cap after apply: ${input.dailyCap}`);
    }
    lines.push("Reply in one short warm sentence acknowledging the preference change.");
  }

  if (input.kind === "reply_ack") {
    lines.push("Owner replied to a proactive nudge; their task is being picked up by a worker.");
    if (input.ownerReplySnippet?.trim()) {
      lines.push(`Owner said: ${input.ownerReplySnippet.trim().slice(0, 200)}`);
    }
    lines.push("One short warm confirmation — no Ref line needed.");
  }

  if (input.kind === "stale_review" && c) {
    lines.push(
      "This card may be stale (old dates). Ask if owner wants it closed. Mention DONE to close or KEEP to leave blocked.",
    );
    lines.push(`Append final line exactly: Ref: pj/${c.taskId}`);
  }

  lines.push("Output ONLY the SMS body text.");
  return lines.join("\n");
}

function ensureRefLine(text: string, taskId: string | undefined): string {
  if (!taskId) return text.trim();
  const ref = `Ref: pj/${taskId}`;
  if (new RegExp(`Ref:\\s*pj/${taskId}`, "i").test(text)) return text.trim();
  return `${text.trim()}\n${ref}`;
}

function fallbackCompose(input: ProactiveComposeInput): string {
  const identity = resolveJoshuIdentity(input.projectRoot ?? process.cwd());
  const profile = readAgentProfile(input.projectRoot);
  const owner = profile?.ownerName?.trim() || identity.owner.displayName || "there";
  const c = input.candidate;

  if (input.kind === "feedback_ack" && input.feedbackKeyword) {
    switch (input.feedbackKeyword) {
      case "MORE":
        return `Got it, ${owner} — I'll check in a bit more often (up to ${input.dailyCap ?? 2}/day).`;
      case "LESS":
        return `Understood — I'll stick to one nudge a day unless you ask otherwise.`;
      case "USEFUL":
        return `Thanks, ${owner} — glad that helped.`;
      case "NOT_USEFUL":
        return `Sorry that wasn't useful — I'll keep it to once a day unless you say MORE.`;
      default:
        return `Noted, ${owner}.`;
    }
  }

  if (input.kind === "reply_ack") {
    return `On it, ${owner} — I'll update that task now.`;
  }

  if (c) {
    const title = c.title.length > 80 ? `${c.title.slice(0, 77)}…` : c.title;
    const base =
      input.kind === "stale_review"
        ? `Hey ${owner} — "${title}" might be done. Reply DONE to close it or KEEP if it's still live.`
        : `Hey ${owner} — quick one on "${title}". I'm blocked and need your call. Reply here with what you want me to do. Was this useful? MORE for more check-ins, LESS for once a day.`;
    return ensureRefLine(base, c.taskId);
  }

  return `Let me know if you need anything, ${owner}.`;
}

async function composeViaHermes(runner: HermesApiRunner, input: ProactiveComposeInput): Promise<string> {
  const projectRoot = input.projectRoot ?? process.cwd();
  await runner.ensureGatewayReady();

  const soul = readSoulSnippet();
  const highLevel = readHighLevelSnippet(projectRoot);
  const systemParts = [
    "You compose outbound owner SMS for proactive Joshu. Use your SOUL.md personality — not a system alert.",
    "Plain text only. No markdown. No board slugs.",
  ];
  if (soul) systemParts.push(`Persona reminder (SOUL): ${soul}`);
  if (highLevel) systemParts.push(`Context: ${highLevel}`);

  const sessionKey = `proactive:compose:${input.kind}:${new Date().toISOString().slice(0, 10)}`;
  const messages: HermesChatMessage[] = [
    buildOwnerTimeSystemMessage(projectRoot),
    { role: "system", content: systemParts.join("\n\n") },
    { role: "user", content: buildComposeUserPrompt(input) },
  ];

  const { finalText } = await runner.streamHermesChat(
    {
      sessionId: sessionKey,
      sessionKey,
      messages,
      signal: AbortSignal.timeout(120_000),
    },
    {},
  );

  const plain = markdownSpeechPlaintext(finalText).trim();
  if (!plain) throw new Error("empty_compose_response");
  if (input.candidate?.taskId && (input.kind === "nudge" || input.kind === "stale_review")) {
    return ensureRefLine(plain, input.candidate.taskId);
  }
  return plain;
}

/** Owner-facing proactive text — Hermes + SOUL.md when available, warm fallback otherwise. */
export async function composeProactiveMessage(input: ProactiveComposeInput): Promise<string> {
  try {
    if (hermesRunner) {
      return await composeViaHermes(hermesRunner, input);
    }
  } catch (err) {
    console.warn("[proactive-compose] Hermes compose failed:", (err as Error).message);
  }
  return fallbackCompose(input);
}

/** Short email subject from nudge body or task title. */
export function proactiveEmailSubject(candidate: ProactiveCandidate, body: string): string {
  const firstLine = body.split("\n").find((l) => l.trim() && !/^Ref:\s*pj\//i.test(l))?.trim();
  if (firstLine && firstLine.length <= 90) return firstLine;
  const title = candidate.title.length > 70 ? `${candidate.title.slice(0, 67)}…` : candidate.title;
  return `Quick one — ${title}`;
}
