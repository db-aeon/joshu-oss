import type { JoshuAppAgentManifest } from "@joshu/app-agent";

/** jMail manifest slice used by the embedded app agent (full manifest lives in arozos/subservice). */
export const JMAIL_MANIFEST: JoshuAppAgentManifest = {
  id: "jmail",
  name: "jMail",
  agent: {
    skill: "jmail-gui",
    usesSkills: ["joshu-mail"],
    headless: false,
    guiActions: [
      {
        name: "openCompose",
        description: "Open compose pane with optional draft fields",
        parameters: [
          { name: "to", type: "string", description: "Recipient email" },
          { name: "subject", type: "string", description: "Subject line" },
          { name: "body", type: "string", description: "Message body draft" },
        ],
        voice: {
          shortcut: "compose",
          phrases: ["new email", "compose", "write an email", "put in the draft", "dictate"],
        },
      },
      {
        name: "openThread",
        description: "Focus a message/thread by id",
        parameters: [{ name: "messageId", type: "string", required: true }],
      },
      {
        name: "searchMail",
        description: "Run inbox search and update the message list",
        parameters: [{ name: "query", type: "string", required: true }],
        voice: {
          shortcut: "search",
          phrases: ["search mail", "find email", "search for"],
        },
      },
      { name: "switchInbox", description: "Switch active mailbox tab (nylas agent or gmail account id)" },
      { name: "startReply", description: "Open reply compose for the currently selected thread" },
      { name: "refreshInbox", description: "Reload the inbox message list" },
      { name: "syncMirror", description: "Sync local mail mirror (cache tier)" },
      { name: "openSetup", description: "Open the setup pane" },
    ],
    actions: [
      { name: "connectorsStatus", description: "Mail connector registry and mirror health" },
      { name: "syncMirror", description: "Sync local mail mirror (cache tier)" },
    ],
  },
};
