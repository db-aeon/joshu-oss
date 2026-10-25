import { ownerTextChannelFor, sendOwnerText } from "../ownerTextChannel.js";
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

/**
 * Composed in SOUL.md voice via Hermes; sent on the owner text channel (SMS, then email).
 * When the box has no route to the owner, returns `no_delivery_channel` without a Hermes call.
 */
export async function deliverProactiveNudge(
  opts: DeliverProactiveNudgeOpts | ProactiveCandidate,
  projectRootArg = process.cwd(),
): Promise<ProactiveDeliveryResult> {
  const projectRoot =
    opts && "candidate" in opts ? (opts.projectRoot ?? process.cwd()) : projectRootArg;
  const candidate = opts && "candidate" in opts ? opts.candidate : opts;
  const nudgeKind = opts && "candidate" in opts ? (opts.nudgeKind ?? "nudge") : "nudge";

  const channel = ownerTextChannelFor(projectRoot);
  if (!channel) return { delivered: false, error: "no_delivery_channel" };

  const body = await composeProactiveMessage({
    kind: nudgeKind,
    projectRoot,
    candidate,
    channel,
  });

  const sent = await sendOwnerText(projectRoot, {
    sms: body,
    emailSubject: proactiveEmailSubject(candidate, body),
    emailBody: body,
  });
  return sent.delivered
    ? { delivered: true, channel: sent.channel, body }
    : { delivered: false, error: sent.error, body };
}
