import type { MutableRefObject } from "react";
import type { JoshuGuiActionInput } from "@joshu/app-agent";

export type MailGuiAgentApi = {
  getGuiSnapshot: () => Record<string, unknown>;
  /** Human-readable summary of loaded inbox rows (after refresh). */
  getInboxListSummary: (limit?: number) => string;
  openCompose: (opts?: {
    to?: string;
    subject?: string;
    body?: string;
    replyToMessageId?: string;
    replyThreadId?: string;
  }) => void;
  openThread: (messageId: string) => void;
  searchMail: (query: string) => Promise<void>;
  switchInbox: (inbox: Record<string, unknown>) => void;
  startReply: () => void;
  syncMirror: (opts?: { days?: number }) => Promise<void>;
  loadMessages: () => Promise<void>;
  setPane: (pane: "inbox" | "compose" | "setup") => void;
};

/** jMail GUI action handlers for the embedded agent (names match manifest `guiActions[]`). */
export function createJmailGuiActions(
  guiRef: MutableRefObject<MailGuiAgentApi | null>,
): JoshuGuiActionInput[] {
  return [
    {
      name: "openCompose",
      description: "Open the compose pane with an optional draft. Never send — user confirms in UI.",
      parameters: [
        { name: "to", type: "string", description: "Recipient email" },
        { name: "subject", type: "string", description: "Subject line" },
        { name: "body", type: "string", description: "Message body draft" },
      ],
      handler: async (args) => {
        guiRef.current?.openCompose({
          to: args.to,
          subject: args.subject,
          body: args.body,
        });
        return "Compose pane opened with draft.";
      },
    },
    {
      name: "openThread",
      description: "Select and load a message/thread by id",
      parameters: [{ name: "messageId", type: "string", required: true }],
      handler: async (args) => {
        guiRef.current?.openThread(String(args.messageId ?? ""));
        return "Thread opened.";
      },
    },
    {
      name: "searchMail",
      description: "Search mail and refresh the inbox list",
      parameters: [{ name: "query", type: "string", required: true }],
      handler: async (args) => {
        await guiRef.current?.searchMail(String(args.query ?? ""));
        return "Search applied.";
      },
    },
    {
      name: "switchInbox",
      description: "Switch mailbox tab",
      parameters: [
        { name: "kind", type: "string", description: "nylas or gmail" },
        { name: "connectedAccountId", type: "string", description: "Gmail connected account id when kind=gmail" },
      ],
      handler: async (args) => {
        guiRef.current?.switchInbox(args as Record<string, unknown>);
        return "Inbox switched.";
      },
    },
    {
      name: "startReply",
      description: "Reply to the currently selected thread in compose pane",
      handler: async () => {
        guiRef.current?.startReply();
        return "Reply compose opened.";
      },
    },
    {
      name: "refreshInbox",
      description: "Reload the visible inbox list in jMail (use before listing subjects if snapshot may be stale)",
      handler: async () => {
        await guiRef.current?.loadMessages();
        const summary = guiRef.current?.getInboxListSummary(10) ?? "Inbox refreshed.";
        return summary;
      },
    },
    {
      name: "syncMirror",
      description: "Sync local mail mirror for File Brain",
      parameters: [{ name: "days", type: "number", description: "Days of history (default 7)" }],
      handler: async (args) => {
        await guiRef.current?.syncMirror({ days: typeof args.days === "number" ? args.days : 7 });
        return "Mirror sync started.";
      },
    },
    {
      name: "openSetup",
      description: "Open jMail setup pane",
      handler: async () => {
        guiRef.current?.setPane("setup");
        return "Setup pane opened.";
      },
    },
  ];
}
