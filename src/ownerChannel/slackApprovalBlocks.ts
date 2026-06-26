import { resolveJoshuAvatarUrl, resolveJoshuIdentity } from "../joshuIdentity.js";
import { SLACK_APPROVAL_REQUEST_MARKER } from "./slackReplyParse.js";

/** Escape dynamic text embedded in Slack mrkdwn blocks. */
export function escapeSlackMrkdwn(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

type SlackBlock = Record<string, unknown>;

function approvalContextBlock(name: string, avatarUrl: string | null): SlackBlock {
  const label = `*${escapeSlackMrkdwn(name)}* needs your approval`;
  const elements: Record<string, unknown>[] = [];
  if (avatarUrl) {
    elements.push({ type: "image", image_url: avatarUrl, alt_text: name });
  }
  elements.push({ type: "mrkdwn", text: label });
  return { type: "context", elements };
}

export function buildSlackApprovalRequestMessage(
  actionId: string,
  preview: string,
  projectRoot: string,
): { fallbackText: string; blocks: SlackBlock[] } {
  const identity = resolveJoshuIdentity(projectRoot);
  const name = identity.name.trim() || "Joshu";
  const avatarUrl = resolveJoshuAvatarUrl(identity);
  const safeActionId = escapeSlackMrkdwn(actionId);
  const safePreview = escapeSlackMrkdwn(preview.slice(0, 500));

  const fallbackText = `${name} ${SLACK_APPROVAL_REQUEST_MARKER}: ${actionId}`;
  const blocks: SlackBlock[] = [
    approvalContextBlock(name, avatarUrl),
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: [
          `\`${safeActionId}\``,
          safePreview,
          "",
          "_Reply in this channel with *Y* or *N* (also: yes/no, approve/deny)._",
        ].join("\n"),
      },
    },
  ];

  return { fallbackText, blocks };
}

export function buildSlackApprovalConfirmationMessage(
  actionId: string,
  decision: "approved" | "denied",
  projectRoot: string,
): { fallbackText: string; blocks: SlackBlock[] } {
  const identity = resolveJoshuIdentity(projectRoot);
  const name = identity.name.trim() || "Joshu";
  const avatarUrl = resolveJoshuAvatarUrl(identity);
  const label = decision === "approved" ? "Approved" : "Denied";
  const emoji = decision === "approved" ? "✅" : "❌";
  const safeActionId = escapeSlackMrkdwn(actionId);

  const fallbackText = `${emoji} ${label} — ${actionId}`;
  const blocks: SlackBlock[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${emoji} *${label}* — \`${safeActionId}\``,
      },
    },
  ];

  if (avatarUrl) {
    blocks.unshift({
      type: "context",
      elements: [
        { type: "image", image_url: avatarUrl, alt_text: name },
        { type: "mrkdwn", text: escapeSlackMrkdwn(name) },
      ],
    });
  }

  return { fallbackText, blocks };
}
