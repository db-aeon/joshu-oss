import { createHmac, timingSafeEqual } from "node:crypto";

import express, { type Request, type Response, type Router } from "express";
import twilio from "twilio";

import { readAgentProfile, type NylasAgentProfile } from "../nylas/profile.js";
import { resolveOwnerTimezone } from "../ownerLocalTime.js";
import { isDirectLocalhostRequest } from "../httpLocalhost.js";
import { readProactiveState } from "../proactive/state.js";
import {
  twilioMediaStreamWssUrl,
} from "../twilioPhoneGateway.js";
import { envTrim, ownerSmsPhone, sendSms, twilioSmsGatewayEnabled } from "../twilioSmsSend.js";
import type { RealtimeGoalBroker } from "./broker.js";
import {
  describeCallbackTime,
  nextRealtimeGoalCallbackWindow,
  realtimeGoalCallbackWindow,
} from "./callbackWindow.js";
import { realtimeGoalDeliveryContentKey } from "./store.js";
import type { RealtimeGoalRecord, RealtimeGoalVoiceCallbackOutcome } from "./types.js";
import { answeredByOutcome } from "./voiceDeliveryPolicy.js";
import {
  extractLinks,
  linkDeliveryNote,
  speakableWithoutLinks,
  textLinksToOwner,
  textOwner,
  type OwnerTextResult,
} from "./voiceLinks.js";

const CALLBACK_OUTCOMES = new Set<RealtimeGoalVoiceCallbackOutcome>([
  "voicemail",
  "auth_failed",
  "no_unlock",
]);

/** Async answering-machine detection on callbacks (default on; set 0 to disable). */
function callbackAmdEnabled(): boolean {
  return !/^(0|false|no|off)$/i.test(envTrim("JOSHU_REALTIME_GOALS_CALLBACK_AMD"));
}

function callbackSecret(): string {
  return (
    envTrim("JOSHU_REALTIME_GOALS_CALLBACK_SECRET") ||
    envTrim("TWILIO_MEDIA_STREAM_SECRET") ||
    envTrim("TWILIO_AUTH_TOKEN")
  );
}

function signGoalId(goalId: string, purpose: "result" | "status"): string {
  const secret = callbackSecret();
  if (!secret) throw new Error("realtime goal callback secret is not configured");
  return createHmac("sha256", secret).update(`${purpose}:${goalId}`).digest("hex");
}

export function realtimeGoalVoiceToken(goalId: string): string {
  return `${goalId}.${signGoalId(goalId, "result")}`;
}

export function verifyRealtimeGoalVoiceToken(goalId: string, token: string): boolean {
  if (!callbackSecret()) return false;
  const expected = realtimeGoalVoiceToken(goalId);
  const a = Buffer.from(expected);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function realtimeGoalStatusToken(goalId: string): string {
  return `${goalId}.${signGoalId(goalId, "status")}`;
}

function verifyRealtimeGoalStatusToken(goalId: string, token: string): boolean {
  if (!callbackSecret()) return false;
  const expected = realtimeGoalStatusToken(goalId);
  const a = Buffer.from(expected);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function callbackStatusUrl(goalId: string, token = realtimeGoalStatusToken(goalId)): string | undefined {
  const inbound = envTrim("TWILIO_VOICE_WEBHOOK_URL");
  if (!inbound) return undefined;
  try {
    const url = new URL(inbound);
    const statusPath = url.pathname.replace(
      /\/api\/twilio\/voice\/inbound\/?$/,
      "/api/realtime-goals/voice/status",
    );
    if (statusPath === url.pathname) return undefined;
    url.pathname = statusPath;
    url.search = "";
    url.searchParams.set("goalId", goalId);
    url.searchParams.set("token", token);
    return url.toString();
  } catch {
    return undefined;
  }
}

/**
 * One text when a finished callback has to wait for the owner's callback
 * window, so "I'll call you back" is not silently broken. Title and time only —
 * results stay behind the passphrase.
 */
async function textDeferredCallbackNotice(
  projectRoot: string,
  goal: RealtimeGoalRecord,
  retryAt: string | undefined,
  timezone: string,
): Promise<boolean> {
  const when = retryAt ? `I'll call you at ${describeCallbackTime(retryAt, timezone)}` : "I'll call you later";
  const sent = await textOwner(
    projectRoot,
    `Your update on “${goal.title}” is ready. It's outside your call hours, so ${when} — ` +
      `or call me anytime and ask for an update (you'll need your passphrase).`,
  );
  return sent.texted;
}

/** Request comes from the co-located voice service (localhost + shared key). */
function voiceLocalServiceAuthorized(req: Request): boolean {
  if (!isDirectLocalhostRequest(req)) return false;
  const expected = envTrim("HERMES_API_KEY");
  return Boolean(expected && String(req.headers.authorization ?? "") === `Bearer ${expected}`);
}

/** Voice service request made from the callback call placed for this goal. */
function voiceServiceAuthorized(req: Request, goal: RealtimeGoalRecord): boolean {
  const callSid = String(req.headers["x-joshu-voice-call-sid"] ?? "").trim();
  return voiceLocalServiceAuthorized(req) && Boolean(callSid) && goal.delivery.providerId === callSid;
}

/**
 * Callback text as it should be spoken: links are texted to the owner (once
 * per result content — the voice service may re-fetch) and replaced by an
 * honest note about whether the text went out.
 */
async function speakableCallbackText(
  broker: RealtimeGoalBroker,
  goal: RealtimeGoalRecord,
  kind: "blocked" | "completed",
  text: string,
): Promise<string> {
  const links = extractLinks(text);
  if (links.length === 0) return text;
  const contentKey = realtimeGoalDeliveryContentKey(kind, text);
  let sent: OwnerTextResult = { texted: goal.linksTextedKey === contentKey };
  if (!sent.texted) {
    sent = await textLinksToOwner(broker.projectRoot, links, goal.title);
    if (sent.texted) {
      await broker.store.update(goal.id, (item) => {
        item.linksTextedKey = contentKey;
        item.linksTextedAt = new Date().toISOString();
      });
    }
  }
  return speakableWithoutLinks(text, linkDeliveryNote(sent, links.length));
}

export async function startRealtimeGoalCallback(
  projectRoot: string,
  goal: RealtimeGoalRecord,
  _text: string,
): Promise<{
  delivered: boolean;
  pending?: boolean;
  providerId?: string;
  retryAt?: string;
  error?: string;
  deferNoticeSent?: boolean;
}> {
  const savedProfile = readAgentProfile(projectRoot);
  const profile = {
    ...(savedProfile ?? {}),
    timezone: resolveOwnerTimezone(projectRoot),
  } as NylasAgentProfile;
  const preferences = readProactiveState(projectRoot, profile.timezone).preferences;
  const window = realtimeGoalCallbackWindow(goal, profile, preferences);
  if (!window.ok) {
    const retryAt = nextRealtimeGoalCallbackWindow(goal, profile, preferences);
    const deferNoticeSent = goal.delivery.deferNoticeAt
      ? undefined
      : await textDeferredCallbackNotice(projectRoot, goal, retryAt, profile.timezone ?? "");
    return {
      delivered: false,
      pending: true,
      retryAt,
      error: window.reason || "outside owner working hours",
      deferNoticeSent,
    };
  }
  if (window.ownerRequested) {
    console.info(`[realtime-goals] callback goal=${goal.id} outside working hours — owner requested it recently`);
  }

  const accountSid = envTrim("TWILIO_ACCOUNT_SID");
  const authToken = envTrim("TWILIO_AUTH_TOKEN");
  const from = envTrim("TWILIO_PHONE_NUMBER");
  const to = ownerSmsPhone(projectRoot);
  const streamSecret = envTrim("TWILIO_MEDIA_STREAM_SECRET");
  const wssUrl = twilioMediaStreamWssUrl(streamSecret);
  if (!accountSid || !authToken || !from || !to || !wssUrl || !callbackSecret()) {
    return { delivered: false, error: "Twilio callback is not fully configured" };
  }

  const token = realtimeGoalVoiceToken(goal.id);
  const statusCallback = callbackStatusUrl(goal.id);
  if (!statusCallback) {
    return { delivered: false, error: "Twilio voice webhook URL cannot derive callback status URL" };
  }
  const voice = new twilio.twiml.VoiceResponse();
  const stream = voice.connect().stream({ url: wssUrl });
  // The called party is the configured owner; passphrase still gates disclosure.
  stream.parameter({ name: "caller", value: to });
  stream.parameter({ name: "ownerCaller", value: to });
  stream.parameter({ name: "realtimeGoalId", value: goal.id });
  stream.parameter({ name: "realtimeGoalToken", value: token });

  const client = twilio(accountSid, authToken);
  const call = await client.calls.create({
    from,
    to,
    twiml: voice.toString(),
    statusCallback,
    statusCallbackMethod: "POST",
    statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
    // Voicemail must not be treated as a failed unlock and redialed. Async AMD
    // runs beside the media stream; a machine verdict hangs the call up and
    // parks the result (see the status route below).
    ...(callbackAmdEnabled()
      ? {
          machineDetection: "Enable",
          asyncAmd: "true",
          asyncAmdStatusCallback: statusCallback,
          asyncAmdStatusCallbackMethod: "POST",
        }
      : {}),
  });
  console.info(`[realtime-goals] PSTN callback queued goal=${goal.id} call=${call.sid}`);
  return { delivered: false, pending: true, providerId: call.sid };
}

export function registerRealtimeGoalVoiceRoutes(
  router: Router,
  broker: RealtimeGoalBroker,
  _publicBasePath = envTrim("PUBLIC_BASE_PATH"),
): void {
  router.post(
    "/api/realtime-goals/voice/status",
    express.urlencoded({ extended: false }),
    async (req: Request, res: Response) => {
      const goalId = typeof req.query.goalId === "string" ? req.query.goalId : "";
      const token = typeof req.query.token === "string" ? req.query.token : "";
      if (!goalId || !verifyRealtimeGoalStatusToken(goalId, token)) {
        res.status(403).send("bad goal token");
        return;
      }
      const signature = req.headers["x-twilio-signature"];
      const signedUrl = callbackStatusUrl(goalId, token);
      if (
        typeof signature !== "string" ||
        !signedUrl ||
        !twilio.validateRequest(
          envTrim("TWILIO_AUTH_TOKEN"),
          signature,
          signedUrl,
          req.body as Record<string, string>,
        )
      ) {
        res.status(403).send("bad signature");
        return;
      }
      // Same URL receives call-progress events (CallStatus) and the async AMD
      // verdict (AnsweredBy, no CallStatus).
      const status = typeof req.body?.CallStatus === "string" ? req.body.CallStatus : "";
      const callSid = typeof req.body?.CallSid === "string" ? req.body.CallSid : "";
      const answeredBy = typeof req.body?.AnsweredBy === "string" ? req.body.AnsweredBy : "";
      if (callSid && answeredByOutcome(answeredBy)) {
        console.info(`[realtime-goals] callback goal=${goalId} call=${callSid} AnsweredBy=${answeredBy} — hanging up`);
        await hangUpCall(callSid);
      }
      await broker.recordVoiceCallbackStatus(goalId, status, callSid, answeredBy);
      res.sendStatus(204);
    },
  );

  /** voice-realtime reports how a locked callback ended (voicemail, lockout, no unlock). */
  router.post(
    "/api/realtime-goals/voice/result/:goalId/outcome",
    express.json({ limit: "4kb" }),
    async (req, res) => {
      const goalId = req.params.goalId;
      const token = typeof req.query.token === "string" ? req.query.token : "";
      if (!verifyRealtimeGoalVoiceToken(goalId, token)) {
        res.status(403).json({ error: "bad goal token" });
        return;
      }
      const goal = await broker.store.get(goalId);
      if (!goal || !voiceServiceAuthorized(req, goal)) {
        res.status(403).json({ error: "authenticated callback call required" });
        return;
      }
      const outcome = String(req.body?.outcome ?? "") as RealtimeGoalVoiceCallbackOutcome;
      if (!CALLBACK_OUTCOMES.has(outcome)) {
        res.status(400).json({ error: "unknown outcome" });
        return;
      }
      await broker.recordVoiceCallbackOutcome(goalId, goal.delivery.providerId ?? "", outcome);
      res.json({ ok: true });
    },
  );

  router.get("/api/realtime-goals/voice/result/:goalId", async (req, res) => {
    const goalId = req.params.goalId;
    const token = typeof req.query.token === "string" ? req.query.token : "";
    if (!verifyRealtimeGoalVoiceToken(goalId, token)) {
      res.status(403).json({ error: "bad goal token" });
      return;
    }
    const goal = await broker.store.get(goalId);
    if (!goal || !voiceServiceAuthorized(req, goal)) {
      res.status(403).json({ error: "authenticated callback call required" });
      return;
    }
    // A reopened goal may still carry an older resultSummary; speak what it is now.
    const text = goal.status === "blocked" ? goal.lastBlockReason : goal.resultSummary;
    if (!text || goal.status === "cancelled" || goal.delivery.state === "delivered") {
      res.status(404).json({ error: "goal result unavailable" });
      return;
    }
    const kind = goal.status === "blocked" ? "blocked" : "completed";
    res.json({
      goalId,
      text: (await speakableCallbackText(broker, goal, kind, text)).slice(0, 4_000),
      kind,
    });
  });

  /**
   * voice-realtime hands over text a caller cannot receive by voice: links in a
   * live answer (`mode: "links"`), or a whole answer that finished after the
   * caller hung up (`mode: "full"`). Recipient is always the owner's phone.
   */
  router.post(
    "/api/realtime-goals/voice/owner-text",
    express.json({ limit: "32kb" }),
    async (req: Request, res: Response) => {
      if (!voiceLocalServiceAuthorized(req)) {
        res.status(403).json({ error: "voice service auth required" });
        return;
      }
      const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
      const mode = req.body?.mode === "full" ? "full" : "links";
      if (!text) {
        res.status(400).json({ error: "text is required" });
        return;
      }
      if (mode === "full") {
        const sent = await textOwner(broker.projectRoot, text);
        res.json({ ok: true, ...sent });
        return;
      }
      const links = extractLinks(text);
      if (links.length === 0) {
        res.json({ ok: true, texted: false, spoken: text });
        return;
      }
      const sent = await textLinksToOwner(broker.projectRoot, links);
      res.json({
        ok: true,
        ...sent,
        spoken: speakableWithoutLinks(text, linkDeliveryNote(sent, links.length)),
      });
    },
  );

  router.post("/api/realtime-goals/voice/result/:goalId/ack", async (req, res) => {
    const goalId = req.params.goalId;
    const token = typeof req.query.token === "string" ? req.query.token : "";
    if (!verifyRealtimeGoalVoiceToken(goalId, token)) {
      res.status(403).json({ error: "bad goal token" });
      return;
    }
    const goal = await broker.store.get(goalId);
    if (!goal || !voiceServiceAuthorized(req, goal)) {
      res.status(403).json({ error: "authenticated callback call required" });
      return;
    }
    await broker.markVoiceDelivered(goalId);
    res.json({ ok: true });
  });

  router.post(
    "/api/realtime-goals/voice/result/:goalId/reply",
    express.json({ limit: "32kb" }),
    async (req, res) => {
    const goalId = req.params.goalId;
    const token = typeof req.query.token === "string" ? req.query.token : "";
    if (!verifyRealtimeGoalVoiceToken(goalId, token)) {
      res.status(403).json({ error: "bad goal token" });
      return;
    }
    const existing = await broker.store.get(goalId);
    if (!existing || !voiceServiceAuthorized(req, existing)) {
      res.status(403).json({ error: "authenticated callback call required" });
      return;
    }
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    const sourceId =
      typeof req.body?.sourceId === "string" ? req.body.sourceId.trim() : "";
    if (!text || !sourceId) {
      res.status(400).json({ error: "text and sourceId are required" });
      return;
    }
    // Routed, not blindly appended: a status question or a new request must not
    // be written onto the card as the owner's answer.
    const result = await broker.answerFromCallback(goalId, text, sourceId);
    res.json({ ok: true, ...result });
    },
  );
}

async function hangUpCall(callSid: string): Promise<void> {
  const accountSid = envTrim("TWILIO_ACCOUNT_SID");
  const authToken = envTrim("TWILIO_AUTH_TOKEN");
  if (!accountSid || !authToken) return;
  await twilio(accountSid, authToken)
    .calls(callSid)
    .update({ status: "completed" })
    .catch((error: Error) => {
      console.warn(`[realtime-goals] hang up call=${callSid} failed: ${error.message}`);
    });
}

/**
 * One SMS when callbacks are parked because the owner could not be reached by
 * phone. Titles only — results stay behind the passphrase.
 */
export async function sendParkedCallbackNotice(
  projectRoot: string,
  goals: RealtimeGoalRecord[],
  reason: string,
): Promise<void> {
  if (goals.length === 0) return;
  if (!twilioSmsGatewayEnabled(projectRoot)) {
    console.info(`[realtime-goals] parked ${goals.length} callback(s) (${reason}); SMS not configured`);
    return;
  }
  const [first, ...rest] = goals;
  const more = rest.length === 0 ? "" : rest.length === 1 ? " and 1 other update" : ` and ${rest.length} other updates`;
  const body =
    `I tried calling about “${first!.title}”${more} but couldn't reach you, so I'll stop calling for now. ` +
    `Call me when you're free and ask for an update (you'll need your passphrase).`;
  await sendSms(ownerSmsPhone(projectRoot), body);
  console.info(`[realtime-goals] parked ${goals.length} callback(s) (${reason}); SMS notice sent`);
}
