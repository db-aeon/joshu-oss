import {
  day0ChatCompletion,
  isDay0LlmConfigured,
} from "../day0/llm.js";
import { formatSessionThreadForPrompt } from "./sessionThread.js";
import type { OwnerRoute, RealtimeGoalRecord, SessionThreadTurn } from "./types.js";

export type RealtimeGoalRouteDecision = {
  decision: "pass" | "clarify" | "queue" | "update" | "cancel" | "status" | "ack" | "delivery";
  confidence: number;
  goalId?: string;
  title?: string;
  question?: string;
  reply?: string;
  /** `delivery`: call the owner now, or change how results reach them. */
  deliveryAction?: "call_now" | "set_route";
  deliveryRoute?: OwnerRoute;
  reason: string;
};

/** @deprecated Use RealtimeGoalRouteDecision */
export type RealtimeGoalAdmission = RealtimeGoalRouteDecision;

export type RouteRealtimeGoalMessageInput = {
  text: string;
  activeGoals: RealtimeGoalRecord[];
  threadTurns: SessionThreadTurn[];
  queueCapable: boolean;
  /** When set, classify continue-vs-pivot for the open branch (LLM, not phrase lists). */
  activeBranch?: RealtimeGoalRecord;
  /** Owner outbox is on: "call me back" / "don't call, text me" are delivery commands. */
  deliveryCommands?: boolean;
  /** Minimum confidence to queue (default: queueConfidenceThreshold()). */
  queueThreshold?: number;
  /** Files and chat context that came with the latest owner message (intakeRouterNote). */
  messageNote?: string;
};

export type RouteRealtimeGoalMessageOptions = {
  completionOverride?: (messages: Array<{ role: string; content: string }>) => Promise<string>;
};

/**
 * Phone `think` turns: a slow answer is no longer a problem (it moves to the
 * background after ~10 s and is delivered by the owner outbox), while a wrong
 * queue is — "email me the link" became a background goal on the canary box
 * (2026-09-26). Voice has explicit `start_task` for long work.
 */
export function voiceQueueConfidenceThreshold(): number {
  const raw = Number.parseFloat(process.env.JOSHU_REALTIME_GOALS_VOICE_QUEUE_CONFIDENCE ?? "");
  if (Number.isFinite(raw) && raw >= 0.5 && raw <= 1) return raw;
  return 0.85;
}

export function queueConfidenceThreshold(): number {
  const raw = Number.parseFloat(process.env.JOSHU_REALTIME_GOALS_QUEUE_CONFIDENCE ?? "");
  if (Number.isFinite(raw) && raw >= 0.5 && raw <= 1) return raw;
  // Voice PSTN flight/research turns often classify queue at ~0.70–0.78 while
  // still naming background browsing in the reason (canary box 2026-09-24).
  return 0.7;
}

const RELATION_CONFIDENCE = 0.68;
const CANCEL_CONFIDENCE = 0.75;
const CLASSIFIER_TIMEOUT_MS = 8_000;

const EXPLICIT_CANCEL_PATTERN =
  /^(never mind|nevermind|cancel that|stop that|forget it)[.! ]*$/;

/**
 * Channel-neutral delivery commands (how to reach the owner, not what the task
 * is). "No please call back" was routed as `ack` and answered "I'll stop the
 * call request" (canary box 2026-09-26).
 */
const NEGATED_CALL_PATTERN =
  /\b(?:don'?t|do not|dont|no need to|not need to|stop|never)\b[^.!?]{0,24}?\b(?:call|calling|ring|phone)\b/;
const CALL_WHEN_PATTERN =
  /\b(?:call|ring|phone) me (?:back )?(?:when|once|after|as soon as|if)\b/;
const CALL_ME_BACK_PATTERN = /\b(?:call|ring|phone)\s+(?:me\s+)?back\b/;
const CALL_ME_NOW_PATTERN =
  /\b(?:call|ring|phone)\s+me(?:\s+(?:now|again|asap|please|right away|right now))?\s*[.!?]*$/;
const GIVE_ME_A_CALL_PATTERN = /\bgive me a (?:call|ring)\b/;

const DELIVERY_POLICY = `Delivery commands (in addition to the decisions above):
- "delivery": the owner says HOW or WHETHER to reach them — not a new task.
  "call me back", "please call me", "I'm asking you to call back" → delivery_action "call_now".
  "don't call, text me instead", "no need to call me back" → delivery_action "set_route", delivery_route "sms".
  "call me when it's done" → delivery_action "set_route", delivery_route "voice".
  A request to be called is never "ack", and never a reason to stop anything.
Add to the JSON: "delivery_action": "call_now" | "set_route" | null, "delivery_route": "sms" | "voice" | null.`;

const DELIVERY_ROUTES = new Set<OwnerRoute>(["sms", "voice", "slack", "telegram"]);

/** Deterministic delivery commands; everything subtler goes to the model. */
export function deterministicDeliveryCommand(text: string): RealtimeGoalRouteDecision | undefined {
  const normalized = text.trim().toLowerCase().replace(/\s+/g, " ");
  if (!normalized || normalized.split(" ").length > 24) return undefined;
  if (NEGATED_CALL_PATTERN.test(normalized)) {
    return {
      decision: "delivery",
      confidence: 1,
      deliveryAction: "set_route",
      deliveryRoute: "sms",
      reason: "explicit_no_call",
    };
  }
  if (CALL_WHEN_PATTERN.test(normalized)) {
    return {
      decision: "delivery",
      confidence: 1,
      deliveryAction: "set_route",
      deliveryRoute: "voice",
      reason: "explicit_call_when_done",
    };
  }
  if (
    CALL_ME_BACK_PATTERN.test(normalized) ||
    CALL_ME_NOW_PATTERN.test(normalized) ||
    GIVE_ME_A_CALL_PATTERN.test(normalized)
  ) {
    return { decision: "delivery", confidence: 1, deliveryAction: "call_now", reason: "explicit_call_request" };
  }
  return undefined;
}

const UNBOUND_SYSTEM_PROMPT = `You are a lightweight router for a personal AI assistant's realtime channels.
Classify the owner's latest message when there is NO active branch already bound on this trunk.
Output JSON only:
{
  "decision": "pass" | "queue" | "cancel" | "status" | "ack",
  "confidence": 0..1,
  "goal_id": string or null,
  "title": short task title or null,
  "reply": one concise owner-facing reply or null,
  "reason": one short internal reason
}

Policy:
- Read the latest owner message in light of the immediately preceding box turn.
- "ack": the owner is answering a box prompt (e.g. "Anything else?" → "Nope", "No thanks").
  Provide a brief reply in "reply". Do not cancel or queue.
- "pass": casual conversation, a quick answer, or anything plausibly finishable in about 60 seconds.
- "queue": clearly new long goal-oriented work that should run in the background Kanban worker.
  Multi-site browsing, travel search/booking, and multi-step research belong here — return
  confidence >= 0.85 when you choose queue for that kind of work.
- Be LENIENT toward pass on queue-capable channels for quick chat only. False async is
  worse than a missed async for clearly long browser/research jobs.
- "cancel": the owner wants an active goal stopped ("actually, never mind", "cancel that").
  Bare negation answering "Anything else?" is ack, not cancel.
- "status": the owner asks about an active goal, or asks for updates/results in general.
- Never queue a request with no concrete objective (empty, redacted, or only a fragment
  such as a code word or filler) — return "pass".
- Do not create a new goal for follow-ups on the same job — those continue the active branch.
  A question about a listed goal's waiting_on_owner or found details is "pass" (answered from
  context), never "queue".
- Select goal_id only from the listed active goals (for cancel/status).
- When queue_capable is false, always return decision "pass".
- Some channels wrap owner text in structured fields (Intent / Conversation summary / User said).
  Treat User said as the verbatim request when present.`;

const BOUND_SYSTEM_PROMPT = `You route messages when ONE active background branch is already open on this trunk.
Read the recent owner↔box thread and the active branch summary.
Output JSON only:
{
  "decision": "pass" | "queue" | "update" | "cancel" | "status" | "ack",
  "confidence": 0..1,
  "goal_id": string or null,
  "title": short task title or null,
  "reply": one concise owner-facing reply or null,
  "reason": one short internal reason
}

Policy:
- "update": the latest message continues the SAME background job (answers a blocked question,
  picks an option, adds detail, changes an instruction for that job).
- A question about details of what this job found or is asking about — times, prices, stops,
  which option, a narrower constraint ("nonstop only"), where its link is — is "update": the
  job's worker has that context. NEVER queue a new goal to look up details of this job.
- "status": the owner asks how the job is going or what it found ("did you find it?",
  "any luck?", "were you able to…?", "is it done?"). A progress question is NOT an update,
  even when the job is waiting on the owner.
- A bare "no", "no thanks", "I'm waiting", "okay" is "ack" — never "update" — unless it
  directly answers the branch's waiting_on_owner question (e.g. "Book it?" → "No").
- "queue": the owner asked for clearly NEW unrelated long work — a different task than the
  active branch (even if they say "something new" or pivot mid-thread).
- "pass": casual conversation or anything plausibly finishable in about 60 seconds.
- "ack": owner answering a box prompt ("Anything else?" → "Nope"). Provide brief "reply".
- "cancel" / "status": same as usual; goal_id must be the active branch unless ambiguous.
- When uncertain between update and queue, prefer update only if the message plainly continues
  the active branch objective; otherwise queue the new work.
- Be lenient toward pass for borderline quick chat on queue-capable channels.
- When queue_capable is false, always return decision "pass".`;

function clampConfidence(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : 0;
}

function short(value: unknown, max: number): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text.slice(0, max) : undefined;
}

function normalizeAdmissionText(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

export function isExplicitCancelPhrase(text: string): boolean {
  return EXPLICIT_CANCEL_PATTERN.test(normalizeAdmissionText(text));
}

function latestActive(activeGoals: RealtimeGoalRecord[]): RealtimeGoalRecord | undefined {
  return [...activeGoals].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
}

/**
 * One goal as the router sees it. Includes what the worker is asking and what
 * it found, so a follow-up about those details ("when does the United flight
 * leave?") is recognizably about this goal rather than new work.
 */
function goalPromptLine(goal: RealtimeGoalRecord): string {
  const lastOwner = [...goal.messages].reverse().find((message) => message.role === "owner");
  return [
    `- id=${goal.id}`,
    `status=${goal.status}`,
    `title=${JSON.stringify(goal.title)}`,
    `objective=${JSON.stringify(goal.objective.slice(0, 500))}`,
    lastOwner ? `latest=${JSON.stringify(lastOwner.text.slice(0, 300))}` : "",
    goal.status === "blocked" && goal.lastBlockReason
      ? `waiting_on_owner=${JSON.stringify(goal.lastBlockReason.slice(0, 500))}`
      : "",
    goal.resultSummary ? `found=${JSON.stringify(goal.resultSummary.slice(0, 500))}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function activeGoalsPrompt(activeGoals: RealtimeGoalRecord[]): string {
  if (activeGoals.length === 0) return "(none)";
  return activeGoals.slice(0, 8).map(goalPromptLine).join("\n");
}

function normalize(
  parsed: Record<string, unknown>,
  activeGoals: RealtimeGoalRecord[],
  queueCapable: boolean,
  bound = false,
  deliveryCommands = false,
  queueThresholdOverride?: number,
): RealtimeGoalRouteDecision {
  if (!queueCapable) {
    return { decision: "pass", confidence: 1, reason: "sync_only_channel" };
  }

  const raw = String(parsed.decision ?? "pass").trim().toLowerCase();
  if (deliveryCommands && raw === "delivery") {
    const confidence = clampConfidence(parsed.confidence);
    const action = String(parsed.delivery_action ?? "").trim().toLowerCase();
    const rawRoute = String(parsed.delivery_route ?? "").trim().toLowerCase();
    const route = (rawRoute === "email" ? "sms" : rawRoute) as OwnerRoute;
    if (confidence < RELATION_CONFIDENCE || (action !== "call_now" && action !== "set_route")) {
      return { decision: "pass", confidence, reason: short(parsed.reason, 200) ?? "delivery_unclear" };
    }
    const goalId = short(parsed.goal_id, 100) ?? (bound ? activeGoals[0]?.id : undefined);
    const knownGoal = goalId ? activeGoals.some((goal) => goal.id === goalId) : false;
    return {
      decision: "delivery",
      confidence,
      deliveryAction: action as "call_now" | "set_route",
      ...(action === "set_route" ? { deliveryRoute: DELIVERY_ROUTES.has(route) ? route : "sms" } : {}),
      ...(knownGoal && goalId ? { goalId } : {}),
      reason: short(parsed.reason, 200) ?? "classified",
    };
  }
  const allowed = bound
    ? new Set(["pass", "queue", "update", "cancel", "status", "ack"])
    : new Set(["pass", "queue", "cancel", "status", "ack"]);
  let decision = (allowed.has(raw) ? raw : "pass") as RealtimeGoalRouteDecision["decision"];
  const confidence = clampConfidence(parsed.confidence);
  // Bound routing: the active branch is listed first and is the implied target
  // when the model omits goal_id.
  const goalId = short(parsed.goal_id, 100) ?? (bound ? activeGoals[0]?.id : undefined);
  const knownGoal = goalId ? activeGoals.some((goal) => goal.id === goalId) : false;

  const queueThreshold = queueThresholdOverride ?? queueConfidenceThreshold();

  // Legacy classifier outputs — fold into the slim router.
  if (!bound && (raw === "clarify" || raw === "update")) {
    decision = raw === "clarify" && confidence >= queueThreshold ? "queue" : "pass";
  }
  if (bound && raw === "clarify") {
    decision = confidence >= RELATION_CONFIDENCE ? "update" : "pass";
  }

  if (decision === "queue" && confidence < queueThreshold) {
    decision = "pass";
  }
  if (
    decision === "update" &&
    (confidence < RELATION_CONFIDENCE || (goalId && !knownGoal))
  ) {
    decision = "pass";
  }
  if (decision === "status" && (confidence < RELATION_CONFIDENCE || !knownGoal)) {
    decision = "pass";
  }
  // A cancel changes a goal, so it needs the goal the model chose. Without one the
  // message is not about a known goal: pass it on (nudge reply / SMS turn) rather
  // than text a cancel that does not happen.
  if (decision === "cancel" && (confidence < CANCEL_CONFIDENCE || !knownGoal)) {
    decision = "pass";
  }

  const reply = short(parsed.reply, 320);
  if (decision === "ack" && !reply) {
    decision = "pass";
  }

  return {
    decision,
    confidence,
    ...(knownGoal && goalId ? { goalId } : {}),
    ...(short(parsed.title, 120) ? { title: short(parsed.title, 120) } : {}),
    ...(reply ? { reply } : {}),
    reason: short(parsed.reason, 200) ?? "classified",
  };
}

function deterministicRoute(
  text: string,
  activeGoals: RealtimeGoalRecord[],
  queueCapable: boolean,
  deliveryCommands = false,
): RealtimeGoalRouteDecision | undefined {
  if (!queueCapable) {
    return { decision: "pass", confidence: 1, reason: "sync_only_channel" };
  }
  if (deliveryCommands) {
    const delivery = deterministicDeliveryCommand(text);
    if (delivery) return delivery;
  }

  const normalized = normalizeAdmissionText(text);
  const latest = activeGoals.length === 1 ? latestActive(activeGoals) : undefined;

  if (latest && EXPLICIT_CANCEL_PATTERN.test(normalized)) {
    return {
      decision: "cancel",
      confidence: 1,
      goalId: latest.id,
      reason: "explicit_latest_goal_cancel",
    };
  }
  if (
    latest &&
    /^(status|update|how(?:'s| is) that going|is it done|what's the status)[?!. ]*$/.test(
      normalized,
    )
  ) {
    return {
      decision: "status",
      confidence: 1,
      goalId: latest.id,
      reason: "explicit_latest_goal_status",
    };
  }
  if (/^(hi|hello|hey|good morning|good night)[!,. ]*$/.test(normalized)) {
    return { decision: "pass", confidence: 1, reason: "quick_conversation" };
  }
  return undefined;
}

async function runRouterCompletion(
  input: RouteRealtimeGoalMessageInput,
  options: RouteRealtimeGoalMessageOptions | undefined,
  systemPrompt: string,
  userContent: string,
  bound: boolean,
): Promise<RealtimeGoalRouteDecision> {
  const goalsForCancel = input.activeBranch
    ? [input.activeBranch, ...input.activeGoals.filter((goal) => goal.id !== input.activeBranch!.id)]
    : input.activeGoals;

  const deterministic = deterministicRoute(
    input.text,
    goalsForCancel,
    input.queueCapable,
    input.deliveryCommands,
  );
  if (deterministic) return deterministic;

  if (!isDay0LlmConfigured() && !options?.completionOverride) {
    return { decision: "pass", confidence: 0, reason: "router_unconfigured_fail_open" };
  }

  const messages = [
    {
      role: "system",
      content: input.deliveryCommands ? `${systemPrompt}\n\n${DELIVERY_POLICY}` : systemPrompt,
    },
    { role: "user", content: userContent },
  ];

  const runCompletion = options?.completionOverride
    ? () => options.completionOverride!(messages)
    : () =>
        day0ChatCompletion(messages as Array<{ role: "system" | "user"; content: string }>, {
          json: true,
          maxTokens: 350,
          model:
            process.env.JOSHU_REALTIME_GOALS_CLASSIFIER_MODEL?.trim() ||
            process.env.JOSHU_EA_CLASSIFIER_MODEL?.trim() ||
            "openai/gpt-5.4-nano",
          traceName: bound ? "realtime-goal-bound-router" : "realtime-goal-router",
          generationName: bound ? "route-bound-realtime-goal" : "route-realtime-goal",
          tags: ["realtime", "goal", "router", ...(bound ? ["bound"] : [])],
          metadata: {
            activeGoalCount: input.activeGoals.length,
            threadTurnCount: input.threadTurns.length,
            boundBranchId: input.activeBranch?.id,
          },
        });

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const raw = await Promise.race([
      runCompletion(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("router timeout")),
          CLASSIFIER_TIMEOUT_MS,
        );
        timeout.unref?.();
      }),
    ]);
    return normalize(
      JSON.parse(raw) as Record<string, unknown>,
      goalsForCancel,
      input.queueCapable,
      bound,
      input.deliveryCommands,
      input.queueThreshold,
    );
  } catch (error) {
    console.warn(`[realtime-goals] router failed open: ${(error as Error).message}`);
    return { decision: "pass", confidence: 0, reason: "router_error_fail_open" };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/** Lines after the latest owner message about its files and chat context. */
function latestMessageNote(input: RouteRealtimeGoalMessageInput): string[] {
  return input.messageNote ? ["", "With the latest owner message:", input.messageNote] : [];
}

export async function routeRealtimeGoalMessage(
  input: RouteRealtimeGoalMessageInput,
  options?: RouteRealtimeGoalMessageOptions,
): Promise<RealtimeGoalRouteDecision> {
  const threadPrompt = formatSessionThreadForPrompt(input.threadTurns);

  if (input.activeBranch) {
    const branch = input.activeBranch;
    const userContent = [
      `queue_capable: ${input.queueCapable}`,
      "",
      "Active branch (bound):",
      goalPromptLine(branch),
      "",
      "Other active goals:",
      activeGoalsPrompt(
        input.activeGoals.filter((goal) => goal.id !== branch.id),
      ),
      "",
      "Recent owner↔box thread:",
      threadPrompt,
      "",
      "Latest owner message:",
      input.text.slice(0, 4000),
      ...latestMessageNote(input),
    ].join("\n");
    return runRouterCompletion(
      input,
      options,
      BOUND_SYSTEM_PROMPT,
      userContent,
      true,
    );
  }

  const userContent = [
    `queue_capable: ${input.queueCapable}`,
    "",
    "Active goals:",
    activeGoalsPrompt(input.activeGoals),
    "",
    "Recent owner↔box thread:",
    threadPrompt,
    "",
    "Latest owner message:",
    input.text.slice(0, 4000),
    ...latestMessageNote(input),
  ].join("\n");

  return runRouterCompletion(
    input,
    options,
    UNBOUND_SYSTEM_PROMPT,
    userContent,
    false,
  );
}

/** Back-compat alias for older imports and tests. */
export async function classifyRealtimeGoalMessage(
  text: string,
  activeGoals: RealtimeGoalRecord[],
  options?: RouteRealtimeGoalMessageOptions & {
    threadTurns?: SessionThreadTurn[];
    queueCapable?: boolean;
  },
): Promise<RealtimeGoalRouteDecision> {
  return routeRealtimeGoalMessage(
    {
      text,
      activeGoals,
      threadTurns: options?.threadTurns ?? [],
      queueCapable: options?.queueCapable ?? true,
    },
    options,
  );
}
