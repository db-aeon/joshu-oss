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
import { gateRedirectTwiml, voiceGateUrl } from "../voiceGate.js";
import type { RealtimeGoalBroker } from "./broker.js";
import {
  describeCallbackTime,
  nextRealtimeGoalCallbackWindow,
  realtimeGoalCallbackWindow,
} from "./callbackWindow.js";
import type { OwnerCallBatch } from "./outbox.js";
import { realtimeGoalDeliveryContentKey } from "./store.js";
import type {
  OwnerHeardEvidence,
  OwnerOutboxItem,
  OwnerPresence,
  RealtimeGoalRecord,
  RealtimeGoalVoiceCallbackOutcome,
} from "./types.js";
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

/** Batch tokens sign `batch:<id>` so they can never be confused with a goal token. */
export function realtimeGoalBatchToken(batchId: string): string {
  return `${batchId}.${signGoalId(`batch:${batchId}`, "result")}`;
}

function verifyToken(expected: string, token: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function verifyRealtimeGoalBatchToken(batchId: string, token: string): boolean {
  if (!callbackSecret()) return false;
  return verifyToken(realtimeGoalBatchToken(batchId), token);
}

function batchStatusToken(batchId: string): string {
  return `${batchId}.${signGoalId(`batch:${batchId}`, "status")}`;
}

function verifyBatchStatusToken(batchId: string, token: string): boolean {
  if (!callbackSecret()) return false;
  return verifyToken(batchStatusToken(batchId), token);
}

function callbackStatusUrl(batchId: string, token?: string): string | undefined {
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
    url.searchParams.set("batchId", batchId);
    url.searchParams.set("token", token ?? batchStatusToken(batchId));
    return url.toString();
  } catch {
    return undefined;
  }
}

/** Request comes from the co-located voice service (localhost + shared key). */
export function voiceLocalServiceAuthorized(req: Request): boolean {
  if (!isDirectLocalhostRequest(req)) return false;
  const expected = envTrim("HERMES_API_KEY");
  return Boolean(expected && String(req.headers.authorization ?? "") === `Bearer ${expected}`);
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
    sent = await textLinksToOwner(broker.projectRoot, links, goal.title, async () => {
      // A carrier rejected the SMS: the goal no longer says that the links were texted.
      await broker.store.update(goal.id, (item) => {
        if (item.linksTextedKey !== contentKey) return;
        delete item.linksTextedKey;
        delete item.linksTextedAt;
      });
    });
    if (sent.texted) {
      await broker.store.update(goal.id, (item) => {
        item.linksTextedKey = contentKey;
        item.linksTextedAt = new Date().toISOString();
      });
    }
  }
  return speakableWithoutLinks(text, linkDeliveryNote(sent, links.length));
}

type CallbackTwilioConfig = {
  accountSid: string;
  authToken: string;
  from: string;
  to: string;
  wssUrl: string;
};

function callbackTwilioConfig(projectRoot: string): CallbackTwilioConfig | undefined {
  const accountSid = envTrim("TWILIO_ACCOUNT_SID");
  const authToken = envTrim("TWILIO_AUTH_TOKEN");
  const from = envTrim("TWILIO_PHONE_NUMBER");
  const to = ownerSmsPhone(projectRoot);
  const wssUrl = twilioMediaStreamWssUrl(envTrim("TWILIO_MEDIA_STREAM_SECRET"));
  if (!accountSid || !authToken || !from || !to || !wssUrl || !callbackSecret()) return undefined;
  if (!envTrim("TWILIO_VOICE_WEBHOOK_URL")) return undefined;
  return { accountSid, authToken, from, to, wssUrl };
}

/** Outbound owner callbacks can be placed on this box. */
export function ownerCallbackConfigured(projectRoot: string): boolean {
  return Boolean(callbackTwilioConfig(projectRoot));
}

/** Twilio `calls.create` parameters for an owner callback (answered at the voice-realtime gate). */
export function ownerCallbackCallRequest(
  config: Pick<CallbackTwilioConfig, "from" | "to" | "wssUrl">,
  batch: OwnerCallBatch,
  statusCallback: string,
): {
  from: string;
  to: string;
  twiml: string;
  statusCallback: string;
  statusCallbackMethod: "POST";
  statusCallbackEvent: string[];
  machineDetection?: string;
  asyncAmd?: string;
  asyncAmdStatusCallback?: string;
  asyncAmdStatusCallbackMethod?: "POST";
} | { error: string } {
  // Call gate: the passphrase / PIN is checked by Twilio <Gather> before any model joins.
  const gateUrl = voiceGateUrl("start", {
    mode: "callback",
    batch: batch.id,
    bt: realtimeGoalBatchToken(batch.id),
    req: batch.ownerRequested ? "1" : undefined,
  });
  if (!gateUrl) return { error: "call gate URL is not configured" };
  const twiml = gateRedirectTwiml(gateUrl);
  return {
    from: config.from,
    to: config.to,
    twiml,
    statusCallback,
    statusCallbackMethod: "POST",
    statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
    ...(callbackAmdEnabled()
      ? {
          // Wait for the greeting to end (the beep) so the voicemail notice lands on the recording.
          machineDetection: "DetectMessageEnd",
          asyncAmd: "true",
          asyncAmdStatusCallback: statusCallback,
          asyncAmdStatusCallbackMethod: "POST" as const,
        }
      : {}),
  };
}

/**
 * Answering machine detected on a callback: leave the voicemail
 * notice only while the call is still at the gate — never cut off an owner who
 * already got through, and never leave a second notice after the gate heard
 * the greeting itself.
 */
export function gateAmdLeavesNotice(
  call: OwnerPresence["callInFlight"],
  batchId: string,
  callSid: string,
): boolean {
  if (!call || call.batchId !== batchId) return false;
  if (call.callSid && call.callSid !== callSid) return false;
  return !call.unlockedAt && call.outcome !== "voicemail";
}

/**
 * Owner outbox callback: one call for every result in the batch (possibly none,
 * when the owner asked "call me back"). The call window was already checked by
 * the delivery policy. The passphrase still gates the content.
 */
export async function startOwnerCallback(
  projectRoot: string,
  batch: OwnerCallBatch,
): Promise<{ ok: boolean; callSid?: string; error?: string }> {
  const config = callbackTwilioConfig(projectRoot);
  if (!config) return { ok: false, error: "Twilio callback is not fully configured" };
  const statusCallback = callbackStatusUrl(batch.id);
  if (!statusCallback) {
    return { ok: false, error: "Twilio voice webhook URL cannot derive callback status URL" };
  }
  const request = ownerCallbackCallRequest(config, batch, statusCallback);
  if ("error" in request) return { ok: false, error: request.error };
  const call = await twilio(config.accountSid, config.authToken).calls.create(request);
  return { ok: true, callSid: call.sid };
}

/**
 * Callback batch text as it should be spoken: blocked questions first, links
 * texted (never read out). One item reads as itself; several are numbered.
 */
async function speakableBatchText(
  broker: RealtimeGoalBroker,
  batchItems: OwnerOutboxItem[],
): Promise<{
  text: string;
  kind: "blocked" | "completed";
  items: Array<{ id: string; kind: string; title: string; text: string }>;
}> {
  const ordered = [...batchItems].sort((a, b) => {
    if (a.kind === "blocked" && b.kind !== "blocked") return -1;
    if (b.kind === "blocked" && a.kind !== "blocked") return 1;
    return a.createdAt.localeCompare(b.createdAt);
  });
  const items: Array<{ id: string; kind: string; title: string; text: string }> = [];
  for (const item of ordered) {
    const goal = item.goalId ? await broker.store.get(item.goalId) : undefined;
    const kind = item.kind === "blocked" ? "blocked" : "completed";
    const spoken = goal
      ? await speakableCallbackText(broker, goal, kind, item.text)
      : await speakableTextWithoutGoal(broker.projectRoot, item);
    items.push({ id: item.id, kind: item.kind, title: item.title, text: spoken });
  }
  const intro = items.length > 1 ? `I have ${items.length} updates.\n\n` : "";
  const body = items
    .map((entry) => (items.length === 1 ? entry.text : `About “${entry.title}”: ${entry.text}`))
    .join("\n\n");
  return {
    text: `${intro}${body}`,
    kind: ordered[0]?.kind === "blocked" ? "blocked" : "completed",
    items,
  };
}

async function speakableTextWithoutGoal(projectRoot: string, item: OwnerOutboxItem): Promise<string> {
  const links = extractLinks(item.text);
  if (links.length === 0) return item.text;
  const sent = await textLinksToOwner(projectRoot, links, item.title);
  return speakableWithoutLinks(item.text, linkDeliveryNote(sent, links.length));
}

/**
 * Unheard phone results to offer on this live call, marked offered on it.
 * Always renews the call's presence lease (the gateway restart guard reads it).
 */
async function offerPendingItems(
  broker: RealtimeGoalBroker,
  callSid: string,
): Promise<Array<{ id: string; kind: string; title: string; text: string }>> {
  const pending = await broker.ownerOutbox.pendingForCall(callSid);
  const offered = (await speakableBatchText(broker, pending)).items.map((item) => ({
    ...item,
    text: item.text.slice(0, 4_000),
  }));
  if (offered.length > 0) {
    await broker.ownerOutbox.markOffered(offered.map((item) => item.id), callSid);
  }
  return offered;
}

const HEARD_EVIDENCE = new Set<OwnerHeardEvidence>([
  "transcript_coverage",
  "owner_reply",
  "playback_complete",
]);

export function registerRealtimeGoalVoiceRoutes(
  router: Router,
  broker: RealtimeGoalBroker,
  _publicBasePath = envTrim("PUBLIC_BASE_PATH"),
): void {
  router.post(
    "/api/realtime-goals/voice/status",
    express.urlencoded({ extended: false }),
    async (req: Request, res: Response) => {
      const batchId = typeof req.query.batchId === "string" ? req.query.batchId : "";
      const token = typeof req.query.token === "string" ? req.query.token : "";
      if (!batchId || !verifyBatchStatusToken(batchId, token)) {
        res.status(403).send("bad batch token");
        return;
      }
      const signature = req.headers["x-twilio-signature"];
      const signedUrl = callbackStatusUrl(batchId, token);
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
        // Never cut off an owner who already got through, and do not
        // leave a second notice when the gate already heard the greeting.
        const call = (await broker.ownerOutbox.snapshot()).presence.callInFlight;
        if (gateAmdLeavesNotice(call, batchId, callSid)) {
          console.info(`[realtime-goals] callback batch=${batchId} call=${callSid} AnsweredBy=${answeredBy} — leaving a voicemail notice`);
          await broker.recordBatchCallOutcome(batchId, callSid, "voicemail");
          await redirectCallToGate(callSid, batchId);
        } else {
          console.info(`[realtime-goals] callback batch=${batchId} call=${callSid} AnsweredBy=${answeredBy} — ignored (unlocked or already handled)`);
        }
      }
      await broker.recordBatchCallStatus(batchId, status, callSid);
      res.sendStatus(204);
    },
  );

  /** Voice service request from the callback call placed for this batch. */
  const batchCallAuthorized = async (req: Request, batchId: string): Promise<boolean> => {
    const token = typeof req.query.token === "string" ? req.query.token : "";
    if (!verifyRealtimeGoalBatchToken(batchId, token)) return false;
    if (!voiceLocalServiceAuthorized(req)) return false;
    const callSid = String(req.headers["x-joshu-voice-call-sid"] ?? "").trim();
    const batch = await broker.ownerOutbox.batch(batchId);
    return Boolean(callSid && batch && batch.callSid === callSid);
  };

  /** Callback batch content, spoken right after unlock. Marks the items offered on this call. */
  router.get("/api/realtime-goals/voice/batch/:batchId", async (req, res) => {
    const batchId = req.params.batchId;
    if (!(await batchCallAuthorized(req, batchId))) {
      res.status(403).json({ error: "authenticated callback call required" });
      return;
    }
    const batch = await broker.ownerOutbox.batch(batchId);
    if (!batch) {
      res.status(404).json({ error: "batch unavailable" });
      return;
    }
    const spoken = await speakableBatchText(broker, batch.items);
    await broker.ownerOutbox.markOffered(
      batch.items.map((item) => item.id),
      batch.callSid,
    );
    res.json({
      batchId,
      kind: spoken.kind,
      text: spoken.text.slice(0, 6_000),
      ownerRequested: batch.ownerRequested,
      items: spoken.items,
    });
  });

  router.post(
    "/api/realtime-goals/voice/batch/:batchId/outcome",
    express.json({ limit: "4kb" }),
    async (req, res) => {
      const batchId = req.params.batchId;
      if (!(await batchCallAuthorized(req, batchId))) {
        res.status(403).json({ error: "authenticated callback call required" });
        return;
      }
      const outcome = String(req.body?.outcome ?? "") as RealtimeGoalVoiceCallbackOutcome;
      if (!CALLBACK_OUTCOMES.has(outcome)) {
        res.status(400).json({ error: "unknown outcome" });
        return;
      }
      const callSid = String(req.headers["x-joshu-voice-call-sid"] ?? "").trim();
      await broker.recordBatchCallOutcome(batchId, callSid, outcome);
      res.json({ ok: true });
    },
  );

  /** The whole batch played out (Twilio drained the audio) — counts as heard. */
  router.post("/api/realtime-goals/voice/batch/:batchId/ack", async (req, res) => {
    const batchId = req.params.batchId;
    if (!(await batchCallAuthorized(req, batchId))) {
      res.status(403).json({ error: "authenticated callback call required" });
      return;
    }
    const batch = await broker.ownerOutbox.batch(batchId);
    const callSid = String(req.headers["x-joshu-voice-call-sid"] ?? "").trim();
    await broker.ownerOutbox.markHeard(
      (batch?.items ?? []).filter((item) => item.state === "offered").map((item) => item.id),
      "voice",
      "playback_complete",
      callSid,
    );
    res.json({ ok: true });
  });

  router.post(
    "/api/realtime-goals/voice/batch/:batchId/reply",
    express.json({ limit: "32kb" }),
    async (req, res) => {
      const batchId = req.params.batchId;
      if (!(await batchCallAuthorized(req, batchId))) {
        res.status(403).json({ error: "authenticated callback call required" });
        return;
      }
      const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
      const sourceId = typeof req.body?.sourceId === "string" ? req.body.sourceId.trim() : "";
      if (!text || !sourceId) {
        res.status(400).json({ error: "text and sourceId are required" });
        return;
      }
      const result = await broker.answerFromBatch(batchId, text, sourceId);
      res.json({ ok: true, ...result });
    },
  );

  /**
   * Owner outbox, live call: what to offer now (unheard phone results). Marks
   * them offered on this call and renews the call's presence lease — the voice
   * service polls it while the owner is on an unlocked call.
   */
  router.get("/api/realtime-goals/voice/pending", async (req, res) => {
    if (!voiceLocalServiceAuthorized(req)) {
      res.status(403).json({ error: "voice service auth required" });
      return;
    }
    const callSid = typeof req.query.callSid === "string" ? req.query.callSid.trim() : "";
    if (!callSid) {
      res.status(400).json({ error: "callSid is required" });
      return;
    }
    res.json({ items: await offerPendingItems(broker, callSid) });
  });

  /**
   * Gated call, right after the gate let the owner in:
   * record the unlock (no callbacks while they are on the line) and hand the
   * voice service what it needs for the opening turn — the owner context and,
   * on inbound calls, results they have not heard (now offered on this call).
   */
  router.post(
    "/api/realtime-goals/voice/opener",
    express.json({ limit: "4kb" }),
    async (req, res) => {
      if (!voiceLocalServiceAuthorized(req)) {
        res.status(403).json({ error: "voice service auth required" });
        return;
      }
      const callSid = typeof req.body?.callSid === "string" ? req.body.callSid.trim() : "";
      const mode = req.body?.mode === "callback" ? "callback" : "inbound";
      if (!callSid) {
        res.status(400).json({ error: "callSid is required" });
        return;
      }
      await broker.recordVoicePresence(callSid, "unlocked");
      const context = await broker
        .buildHermesContextSnapshot({
          channel: "pstn_voice",
          sessionKey: "pstn:owner",
          sessionId: callSid,
          messageId: `opener:${callSid}`,
        })
        .catch(() => undefined);
      // A callback's own batch is fetched by the voice service; only inbound calls offer more.
      const items = mode === "inbound" ? await offerPendingItems(broker, callSid) : [];
      console.info(`[owner-outbox] call opened call=${callSid} mode=${mode} unheard=${items.length}`);
      res.json({ context: context ?? null, items });
    },
  );

  /** The owner unlocked a call / the call ended (voice service → owner presence). */
  router.post(
    "/api/realtime-goals/voice/presence",
    express.json({ limit: "4kb" }),
    async (req, res) => {
      if (!voiceLocalServiceAuthorized(req)) {
        res.status(403).json({ error: "voice service auth required" });
        return;
      }
      const callSid = typeof req.body?.callSid === "string" ? req.body.callSid.trim() : "";
      const event = req.body?.event;
      if (!callSid || (event !== "unlocked" && event !== "ended")) {
        res.status(400).json({ error: "callSid and event (unlocked|ended) are required" });
        return;
      }
      await broker.recordVoicePresence(callSid, event);
      res.json({ ok: true });
    },
  );

  /** The owner heard these items (transcript coverage or reply, per the voice service). */
  router.post(
    "/api/realtime-goals/outbox/heard",
    express.json({ limit: "16kb" }),
    async (req, res) => {
      if (!voiceLocalServiceAuthorized(req)) {
        res.status(403).json({ error: "voice service auth required" });
        return;
      }
      const itemIds = Array.isArray(req.body?.itemIds)
        ? (req.body.itemIds as unknown[]).filter((id): id is string => typeof id === "string").slice(0, 50)
        : [];
      const evidence = req.body?.evidence as OwnerHeardEvidence;
      const callSid = typeof req.body?.callSid === "string" ? req.body.callSid.trim() : undefined;
      if (itemIds.length === 0 || !HEARD_EVIDENCE.has(evidence)) {
        res.status(400).json({ error: "itemIds and evidence are required" });
        return;
      }
      const heard = await broker.ownerOutbox.markHeard(itemIds, "voice", evidence, callSid);
      if (heard.length > 0) {
        console.info(`[owner-outbox] heard on call=${callSid ?? "-"} items=${heard.join(",")} evidence=${evidence}`);
      }
      res.json({ ok: true, heard });
    },
  );

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

}

/** Answering machine on a gated callback: play the voicemail notice, then hang up. */
async function redirectCallToGate(callSid: string, batchId: string): Promise<void> {
  const accountSid = envTrim("TWILIO_ACCOUNT_SID");
  const authToken = envTrim("TWILIO_AUTH_TOKEN");
  const url = voiceGateUrl("voicemail", { mode: "callback", batch: batchId });
  if (!accountSid || !authToken || !url) {
    await hangUpCall(callSid);
    return;
  }
  await twilio(accountSid, authToken)
    .calls(callSid)
    .update({ url, method: "POST" })
    .catch(async (error: Error) => {
      console.warn(`[realtime-goals] voicemail notice call=${callSid} failed: ${error.message}`);
      await hangUpCall(callSid);
    });
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

