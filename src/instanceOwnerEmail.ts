/**
 * Control-plane–initiated owner email via the box Nylas agent mailbox.
 * Localhost-only so instance-agent can bypass the action guard without exposing
 * a public forgeable header on /api/nylas/messages/send.
 */

import type { Request, Response, Router } from "express";

import { buildJoshuSignedEmailHtml } from "./email/joshuEmailSignature.js";
import { isDirectLocalhostRequest } from "./httpLocalhost.js";
import { resolveJoshuIdentity } from "./joshuIdentity.js";
import { sendMessage } from "./nylas/client.js";
import { readAgentGrant } from "./nylas/store.js";
import { substituteTelephonePlaceholders } from "./telephoneSettings/emailPlaceholders.js";

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * POST /api/instance/send-owner-email
 * Body: { to, subject, body, sendId?, flowKey? }
 */
export function registerInstanceOwnerEmailRoutes(
  router: Router,
  opts: { projectRoot: string },
): void {
  router.post("/api/instance/send-owner-email", async (req: Request, res: Response) => {
    if (!isDirectLocalhostRequest(req)) {
      res.status(403).json({ error: "send-owner-email is localhost-only" });
      return;
    }

    const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
    const to = readString(body.to);
    const subject = readString(body.subject);
    const text = readString(body.body);
    const sendId = readString(body.sendId) || undefined;
    const flowKey = readString(body.flowKey) || undefined;

    if (!to || !subject || !text) {
      res.status(400).json({ error: "to, subject, and body are required" });
      return;
    }

    const identity = resolveJoshuIdentity(opts.projectRoot);
    const ownerEmail = identity.owner.email?.trim();
    if (!ownerEmail) {
      res.status(400).json({ error: "box owner email is not configured" });
      return;
    }
    if (normalizeEmail(to) !== normalizeEmail(ownerEmail)) {
      res.status(403).json({
        error: "recipient_not_owner",
        hint: "CP-initiated sends may only go to the box owner email",
      });
      return;
    }

    const agent = readAgentGrant(opts.projectRoot);
    if (!agent) {
      res.status(404).json({ error: "No agent mailbox provisioned" });
      return;
    }

    // Fill in live box facts (phone number, unlock passphrase) the CP cannot know.
    const filled = substituteTelephonePlaceholders([subject, text], opts.projectRoot);
    if (filled.unresolved.length > 0) {
      console.warn(
        `[instance] send-owner-email refused: unresolved placeholders ${filled.unresolved.join(", ")}`,
      );
      res.status(422).json({
        error: "unresolved_placeholders",
        placeholders: filled.unresolved,
        hint: "Placeholder is unknown or unset on this box; refusing to send incorrect copy",
      });
      return;
    }
    const [finalSubject, finalText] = filled.texts as [string, string];

    try {
      // Intentionally skip gateNylasSendRequest — CP ops bypass owner approval.
      const bodyHtml = buildJoshuSignedEmailHtml(finalText, {
        name: identity.name,
        portraitImageUrl: identity.imageUrl ?? undefined,
        ownerDisplayName: identity.owner.displayName,
      });
      const messageId = await sendMessage(agent.grantId, {
        from: agent.email,
        to: [{ email: ownerEmail }],
        subject: finalSubject,
        body: bodyHtml,
      });
      console.info(
        `[instance] send-owner-email ok from=${agent.email} to=${ownerEmail}` +
          (sendId ? ` sendId=${sendId}` : "") +
          (flowKey ? ` flowKey=${flowKey}` : "") +
          (filled.substituted.length > 0 ? ` filled=${filled.substituted.join(",")}` : "") +
          ` messageId=${messageId}`,
      );
      res.json({
        ok: true,
        messageId,
        from: agent.email,
        to: ownerEmail,
        sendId: sendId ?? null,
        flowKey: flowKey ?? null,
        placeholders: filled.substituted,
      });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });
}
