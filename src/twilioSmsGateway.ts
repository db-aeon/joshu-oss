/**
 * Twilio PSTN SMS gateway: inbound Messaging webhook → Hermes chat → SMS reply.
 * Owner-only (Telephone owner mobile or TWILIO_OWNER_CALLER). Uses the box subaccount credentials.
 * Action-guard Y/N replies are handled before routing to Hermes chat.
 */

import type { Request, Router } from "express";
import express from "express";
import twilio from "twilio";

import { handleSmsApprovalIngress } from "./actionGuard/smsIngress.js";
import type { HermesApiRunner, HermesChatMessage } from "./hermesApi.js";
import { buildOwnerTimeSystemMessage } from "./ownerLocalTime.js";
import { markdownSpeechPlaintext } from "./markdownSpeechPlaintext.js";
import { recordProactiveFeedback, parseFeedbackKeyword, parseTaskActionKeyword } from "./proactive/feedback.js";
import { parseProactiveTaskRef } from "./proactive/blockReason.js";
import { handleProactiveTaskAction } from "./proactive/replyRouter.js";
import { composeProactiveMessage } from "./proactive/composeMessage.js";
import { resolveProactiveOwnerReply } from "./proactive/resolveOwnerReply.js";
import { readProactiveState } from "./proactive/state.js";
import { resolveJoshuFilesPaths } from "./joshuFilesPaths.js";
import {
  envTrim,
  ownerSmsPhone,
  phonesMatch,
  sendSms,
  twilioSmsAccountReady,
} from "./twilioSmsSend.js";
import { resolveOwnerSmsSessionKey } from "./twilioSmsSession.js";

export { twilioSmsGatewayEnabled } from "./twilioSmsSend.js";

function normalizePublicBasePath(raw: string): string {
  if (!raw) return "";
  const p = raw.startsWith("/") ? raw : `/${raw}`;
  return p.replace(/\/+$/, "") || "";
}

function smsInboundWebhookUrl(): string | undefined {
  const explicit = envTrim("TWILIO_SMS_WEBHOOK_URL");
  if (explicit) return explicit;
  const voice = envTrim("TWILIO_VOICE_WEBHOOK_URL");
  if (!voice) return undefined;
  return voice.replace(/\/voice\/inbound\/?$/, "/sms/inbound");
}

function signatureValidationUrls(req: Request, publicBasePath: string): string[] {
  const out = new Set<string>();
  const add = (raw?: string) => {
    const u = raw?.trim();
    if (!u) return;
    out.add(u);
    if (u.endsWith("/")) out.add(u.replace(/\/+$/, ""));
    else out.add(`${u}/`);
  };

  add(smsInboundWebhookUrl());

  const proto =
    (typeof req.headers["x-forwarded-proto"] === "string"
      ? req.headers["x-forwarded-proto"].split(",")[0]?.trim()
      : undefined) || "https";
  const host =
    (typeof req.headers["x-forwarded-host"] === "string"
      ? req.headers["x-forwarded-host"].split(",")[0]?.trim()
      : undefined) ||
    (typeof req.headers.host === "string" ? req.headers.host : "");
  if (host) {
    const base = normalizePublicBasePath(publicBasePath);
    add(`${proto}://${host}${base}/api/twilio/sms/inbound`);
  }

  return [...out];
}

function validateTwilioSmsSignature(
  authToken: string,
  signature: string,
  req: Request,
  publicBasePath: string,
): boolean {
  const params = req.body as Record<string, string>;
  for (const url of signatureValidationUrls(req, publicBasePath)) {
    if (twilio.validateRequest(authToken, signature, url, params)) return true;
  }
  return false;
}

function keywordBody(body: string): string {
  return body.trim().replace(/\s+/g, " ").toUpperCase();
}

export function registerTwilioSmsRoutes(
  router: Router,
  runner: HermesApiRunner,
  publicBasePath = envTrim("PUBLIC_BASE_PATH"),
): void {
  if (!twilioSmsAccountReady()) {
    console.info(
      "[twilio-sms] disabled (set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER, TWILIO_SMS_WEBHOOK_URL or TWILIO_VOICE_WEBHOOK_URL)",
    );
    return;
  }

  const authToken = envTrim("TWILIO_AUTH_TOKEN");
  const webhookUrl = smsInboundWebhookUrl()!;
  const systemPrompt =
    envTrim("TWILIO_SMS_SYSTEM_PROMPT") ||
    "You are Joshu on SMS with the box owner. Reply in concise plain text - no markdown, tables, or long URLs. Keep replies under 500 characters so the carrier will deliver them.";

  router.post("/api/twilio/sms/inbound", express.urlencoded({ extended: false }), (req, res) => {
    const sig = req.headers["x-twilio-signature"];
    if (typeof sig !== "string") {
      res.status(403).send("missing signature");
      return;
    }
    if (!validateTwilioSmsSignature(authToken, sig, req, publicBasePath)) {
      console.warn("[twilio-sms] invalid Twilio signature");
      res.status(403).send("bad signature");
      return;
    }

    const from = typeof req.body?.From === "string" ? req.body.From : "";
    const body = typeof req.body?.Body === "string" ? req.body.Body : "";
    const messageSid = typeof req.body?.MessageSid === "string" ? req.body.MessageSid : "";
    console.info(`[twilio-sms] inbound from=${from} sid=${messageSid} body=${body.slice(0, 120)}`);

    // Ack immediately; reply via REST (long Hermes turn or approval handling).
    res.type("text/xml").send("<Response></Response>");

    void (async () => {
      try {
        const ownerCaller = ownerSmsPhone();
        if (!ownerCaller) {
          console.warn(
            "[twilio-sms] inbound ignored — set owner mobile in Telephone (or TWILIO_OWNER_CALLER)",
          );
          return;
        }
        if (!phonesMatch(from, ownerCaller)) {
          await sendSms(
            from,
            "Joshu SMS is owner-only. This number does not accept texts from unknown senders.",
          );
          return;
        }

        // Action-guard Y/N takes priority over keyword handlers and Hermes chat.
        if (await handleSmsApprovalIngress(from, body, process.cwd())) {
          return;
        }

        const kw = keywordBody(body);
        if (kw === "STOP" || kw === "STOPALL" || kw === "UNSUBSCRIBE" || kw === "CANCEL" || kw === "END" || kw === "QUIT") {
          await sendSms(from, "You are unsubscribed from Joshu SMS. Reply START to opt back in.");
          return;
        }
        if (kw === "HELP" || kw === "INFO") {
          await sendSms(
            from,
            "Joshu owner-only SMS with your box. Msg frequency varies. Reply STOP to cancel. Support: info@joshu.me",
          );
          return;
        }
        if (kw === "START" || kw === "UNSTOP") {
          await sendSms(from, "Joshu SMS enabled for this number. Text your box anytime.");
          return;
        }
        if (!body.trim()) return;

        const projectRoot = process.cwd();
        const taskAction = parseTaskActionKeyword(body);
        if (taskAction) {
          const paths = resolveJoshuFilesPaths(projectRoot);
          if (paths?.filesRoot) {
            const acted = await handleProactiveTaskAction({
              action: taskAction,
              body: body.trim(),
              filesRoot: paths.filesRoot,
              projectRoot,
            });
            if (acted.action === "completed" || acted.action === "kept") {
              const ack = await composeProactiveMessage({
                kind: "reply_ack",
                projectRoot,
                ownerReplySnippet: body.trim(),
              });
              await sendSms(from, ack);
              return;
            }
          }
        }

        const feedbackKeyword = parseFeedbackKeyword(body);
        if (feedbackKeyword) {
          const fb = await recordProactiveFeedback(body, projectRoot);
          if (fb.ok) {
            await sendSms(from, fb.message);
          }
          return;
        }

        const paths = resolveJoshuFilesPaths(projectRoot);
        const state = readProactiveState(projectRoot);
        const hasProactiveRef =
          Boolean(parseProactiveTaskRef(body)) ||
          Boolean(state.lastNudge && state.feedbackPending);
        // SMS rides api_server (no Hermes platform idle-reset — that would hit jChat).
        // Rotate the session key after the same idle window as Slack/Telegram.
        const sessionKey = resolveOwnerSmsSessionKey(from, projectRoot);

        if (hasProactiveRef && paths?.filesRoot) {
          const resolved = await resolveProactiveOwnerReply({
            body: body.trim(),
            filesRoot: paths.filesRoot,
            projectRoot,
            sessionKey,
            baseSystemPrompt: systemPrompt,
            runner,
          });
          if (resolved.action === "resolved" && resolved.replyText) {
            await sendSms(from, resolved.replyText);
            return;
          }
          if (resolved.action === "fallback_routed") {
            let ack = await composeProactiveMessage({
              kind: "reply_ack",
              projectRoot,
              ownerReplySnippet: body.trim(),
            });
            if (resolved.schedulingWokenTaskIds?.length) {
              ack = `${ack} I'm also picking up the scheduling follow-up now.`;
            }
            await sendSms(from, ack);
            return;
          }
          if (resolved.action === "error") {
            console.warn("[twilio-sms] proactive resolve failed:", resolved.reason);
          }
          // ignored → fall through to normal SMS chat
        }

        await runner.ensureGatewayReady();
        const messages: HermesChatMessage[] = [
          buildOwnerTimeSystemMessage(process.cwd()),
          { role: "system", content: systemPrompt },
          { role: "user", content: body.trim() },
        ];
        const { finalText } = await runner.streamHermesChat(
          {
            sessionId: sessionKey,
            sessionKey,
            messages,
            signal: AbortSignal.timeout(180_000),
          },
          {},
        );
        const reply = markdownSpeechPlaintext(finalText).trim();
        if (!reply) {
          await sendSms(from, "I didn't have a reply for that — try again or reply HELP.");
          return;
        }
        await sendSms(from, reply);
      } catch (err) {
        console.warn("[twilio-sms] inbound handler error:", err);
        try {
          await sendSms(from, "Joshu hit an error processing that text. Please try again shortly.");
        } catch {
          /* ignore secondary failure */
        }
      }
    })();
  });

  router.get("/api/twilio/sms/health", (_req, res) => {
    res.json({
      ok: true,
      gateway: "twilio-sms",
      webhookUrlConfigured: Boolean(webhookUrl),
      ownerConfigured: Boolean(ownerSmsPhone()),
      messagingServiceConfigured: Boolean(envTrim("TWILIO_MESSAGING_SERVICE_SID")),
    });
  });

  console.info("[twilio-sms] webhook expects POST URL:", webhookUrl);
}
