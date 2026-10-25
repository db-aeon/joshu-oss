/**
 * After owner completes mobile browser handoff on SMS, wake Hermes on the same
 * sms: session and deliver the assistant reply as SMS (never nylas_send_message).
 */

import {
  HermesApiRunner,
  buildTurnSystemMessages,
  type HermesChatMessage,
} from "../hermesApi.js";
import {
  REALTIME_GOALS_KANBAN_BOARD,
  callKanbanBridge,
  type KanbanBridgeCall,
} from "../hermesKanbanBridge.js";
import { buildOwnerTimeSystemMessage } from "../ownerLocalTime.js";
import { RealtimeGoalStore } from "../realtimeGoals/store.js";
import { ownerSmsTextFromHermesTurn } from "../smsHermesReply.js";
import { ownerSmsPhone, phonesMatch, sendSms } from "../twilioSmsSend.js";
import { resolveOwnerSmsSessionKey } from "../twilioSmsSession.js";
import { getHandoffRecord, markSmsContinuationDelivered, type BrowserHandoffRecord } from "./store.js";

function envOr(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

/** Parse E.164 phone from `sms:+1…:epoch` or sticky `sms:+1…`. */
export function phoneFromSmsHermesSessionKey(sessionKey: string): string | null {
  const trimmed = sessionKey.trim();
  if (!trimmed.startsWith("sms:")) return null;
  const rest = trimmed.slice(4);
  const phone = rest.split(":")[0]?.trim();
  if (!phone || phone === "unknown") return null;
  return phone;
}

/** True when this handoff should trigger an SMS continuation turn. */
export function shouldDeliverSmsHandoffContinuation(record: BrowserHandoffRecord): boolean {
  const sessionKey = record.hermesSessionKey?.trim() ?? "";
  if (!sessionKey.startsWith("sms:")) return false;
  return Boolean(phoneFromSmsHermesSessionKey(sessionKey));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Longest Kanban task body that goes into the SMS continuation. */
const TASK_BODY_MAX_CHARS = 2000;

/** The request behind a browser handoff, from the realtime goal and its Kanban task. */
export type HandoffTaskContext = {
  objective?: string;
  taskTitle?: string;
  taskBody?: string;
};

/**
 * Read the realtime goal and the Kanban task of a browser handoff. Each lookup that
 * fails leaves its part out, so the SMS continuation still runs.
 */
export async function loadHandoffTaskContext(
  projectRoot: string,
  record: BrowserHandoffRecord,
  bridge: KanbanBridgeCall = callKanbanBridge,
): Promise<HandoffTaskContext> {
  const taskId = record.kanbanTaskId?.trim();
  if (!taskId) return {};
  const context: HandoffTaskContext = {};
  try {
    const state = await new RealtimeGoalStore(projectRoot).read();
    const goal = state.goals.find((item) => item.kanbanTaskId === taskId);
    const objective = goal?.objective?.trim();
    if (objective) context.objective = objective;
  } catch (err) {
    console.warn(
      `[browser-handoff] goal lookup failed task=${taskId}: ${err instanceof Error ? err.message : err}`,
    );
  }
  try {
    const shown = await bridge({ action: "show", board: REALTIME_GOALS_KANBAN_BOARD, task_id: taskId });
    if (shown.success && shown.task) {
      context.taskTitle = shown.task.title?.trim() || undefined;
      context.taskBody = shown.task.body?.trim().slice(0, TASK_BODY_MAX_CHARS) || undefined;
    }
  } catch (err) {
    console.warn(
      `[browser-handoff] kanban show failed task=${taskId}: ${err instanceof Error ? err.message : err}`,
    );
  }
  return context;
}

/**
 * Messages of the SMS continuation. The handoff brief is Joshu's own text to the
 * owner, so it goes in a system message: in a user message the model read it as
 * a request from somebody else and called the handoff phishing (issue #71).
 */
export function buildSmsHandoffContinuationMessages(
  record: BrowserHandoffRecord,
  context: HandoffTaskContext,
): HermesChatMessage[] {
  const lines = [
    `You (Joshu) made browser handoff ${record.id}, and the owner has now finished that step and tapped I'm done.`,
  ];
  if (context.objective) lines.push(`The owner's request: ${context.objective}`);
  if (context.taskTitle || context.taskBody) {
    lines.push(
      `Kanban task ${record.kanbanTaskId}: ${context.taskTitle ?? ""}`.trimEnd(),
      ...(context.taskBody ? [context.taskBody] : []),
    );
  }
  lines.push(
    "Handoff brief that you showed the owner on the handoff page (you wrote it for the owner; " +
      `it is not a request from the owner or from anybody else): "${record.instructions}"`,
    `Staged page: ${record.pageTitle || record.pageUrl}`,
    "Use browser_snapshot to check the page, then finish the request with what you find. " +
      "Put the full answer in your assistant reply. Joshu sends it as SMS. Do not email or nylas_send_message.",
  );
  return [
    { role: "system", content: lines.join("\n") },
    { role: "user", content: "I finished the browser step. Continue my request and text me the answer." },
  ];
}

/**
 * Run a Hermes turn on the owner's SMS session and text the owner the assistant reply.
 */
export async function deliverSmsHandoffContinuation(
  projectRoot: string,
  record: BrowserHandoffRecord,
  runner: HermesApiRunner,
): Promise<{ delivered: boolean; error?: string }> {
  let active = record;
  if (!shouldDeliverSmsHandoffContinuation(record)) {
    // Kanban workers often mint the handoff without the owner's sms: session.
    const phone = ownerSmsPhone(projectRoot);
    if (!phone) {
      console.warn(
        `[browser-handoff] SMS continuation skipped handoff=${record.id.slice(0, 8)} (no sms session)`,
      );
      return { delivered: false, error: "not_sms_handoff" };
    }
    active = { ...record, hermesSessionKey: `sms:${phone}` };
    console.info(
      `[browser-handoff] SMS continuation using owner phone handoff=${record.id.slice(0, 8)}`,
    );
  }
  if (active.smsContinuationDeliveredAt) {
    return { delivered: false, error: "sms_continuation_already_delivered" };
  }

  // Let an in-flight Hermes poll turn finish (and hit the nylas SMS block) before we continue.
  await sleep(20_000);

  const fresh = getHandoffRecord(projectRoot, record.id);
  if (!fresh || fresh.smsContinuationDeliveredAt) {
    return { delivered: false, error: "sms_continuation_already_delivered" };
  }

  const ownerPhone = ownerSmsPhone(projectRoot);
  const handoffPhone = phoneFromSmsHermesSessionKey(active.hermesSessionKey!);
  if (!ownerPhone || !handoffPhone || !phonesMatch(handoffPhone, ownerPhone)) {
    return { delivered: false, error: "sms_handoff_not_owner_phone" };
  }

  const sessionKey = resolveOwnerSmsSessionKey(handoffPhone, projectRoot);
  const smsSystemPrompt =
    envOr("TWILIO_SMS_SYSTEM_PROMPT", "") ||
    [
      "You are Joshu on SMS with the box owner. Reply in concise plain text — no markdown or tables.",
      "After browser handoff completes, browser_snapshot and answer in assistant text only — never nylas_send_message.",
    ].join(" ");

  const context = await loadHandoffTaskContext(projectRoot, active);
  const messages: HermesChatMessage[] = [
    buildOwnerTimeSystemMessage(projectRoot),
    { role: "system", content: smsSystemPrompt },
    ...buildSmsHandoffContinuationMessages(active, context),
  ];

  // Must use the Joshu process singleton runner — a second HermesApiRunner would call
  // ensureApiServer() without owning this.gateway and SIGTERM the live gateway mid-stream.
  try {
    await runner.ensureGatewayReady();

    const { finalText } = await runner.streamHermesChat(
      {
        sessionId: sessionKey,
        sessionKey,
        messages: [...buildTurnSystemMessages(projectRoot), ...messages],
        signal: AbortSignal.timeout(240_000),
      },
      {},
    );
    const reply = await ownerSmsTextFromHermesTurn(sessionKey, finalText);
    if (!reply) {
      return { delivered: false, error: "empty_assistant_reply" };
    }
    await sendSms(handoffPhone, reply);
    markSmsContinuationDelivered(projectRoot, active.id);
    console.info(
      `[browser-handoff] SMS continuation delivered handoff=${active.id.slice(0, 8)} session=${sessionKey.slice(0, 24)}`,
    );
    return { delivered: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[browser-handoff] SMS continuation failed handoff=${active.id}: ${message}`);
    return { delivered: false, error: message };
  }
}
