import { readAgentProfile } from "../nylas/profile.js";
import { readAgentGrant } from "../nylas/store.js";
import { sendMessage } from "../nylas/client.js";
import { ownerSmsPhone, sendSms, twilioSmsGatewayEnabled } from "../twilioSmsSend.js";
import { composeProactiveMessage, proactiveEmailSubject } from "./composeMessage.js";
import type { ProactiveCandidate } from "./types.js";

export type ProactiveDeliveryResult = {
  delivered: boolean;
  channel?: "sms" | "email";
  error?: string;
  body?: string;
};

export type DeliverProactiveNudgeOpts = {
  candidate: ProactiveCandidate;
  projectRoot?: string;
  nudgeKind?: "nudge" | "stale_review";
};

/** SMS → email fallback; composed in SOUL.md voice via Hermes. */
export async function deliverProactiveNudge(
  opts: DeliverProactiveNudgeOpts | ProactiveCandidate,
  projectRootArg = process.cwd(),
): Promise<ProactiveDeliveryResult> {
  const projectRoot =
    opts && "candidate" in opts ? (opts.projectRoot ?? process.cwd()) : projectRootArg;
  const candidate = opts && "candidate" in opts ? opts.candidate : opts;
  const nudgeKind = opts && "candidate" in opts ? (opts.nudgeKind ?? "nudge") : "nudge";

  const body = await composeProactiveMessage({
    kind: nudgeKind,
    projectRoot,
    candidate,
  });

  if (twilioSmsGatewayEnabled(projectRoot)) {
    const phone = ownerSmsPhone(projectRoot);
    if (phone) {
      try {
        await sendSms(phone, body);
        return { delivered: true, channel: "sms", body };
      } catch (err) {
        console.warn("[proactive] SMS send failed:", err);
      }
    }
  }

  const profile = readAgentProfile(projectRoot);
  const email = profile?.primaryWorkEmail?.trim();
  const grant = readAgentGrant(projectRoot);
  if (email && grant?.grantId && grant.email) {
    try {
      await sendMessage(grant.grantId, {
        to: [{ email, name: profile?.ownerName?.trim() || undefined }],
        subject: proactiveEmailSubject(candidate, body),
        body,
        from: grant.email,
      });
      return { delivered: true, channel: "email", body };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { delivered: false, error: `email_failed:${msg}`, body };
    }
  }

  return { delivered: false, error: "no_delivery_channel", body };
}
