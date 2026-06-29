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
      { name: "openCompose", description: "Open compose pane with optional draft fields" },
      { name: "openThread", description: "Focus a message/thread by id" },
      { name: "searchMail", description: "Run inbox search and update the message list" },
      { name: "switchInbox", description: "Switch active mailbox tab (nylas agent or gmail account id)" },
      { name: "startReply", description: "Open reply compose for the currently selected thread" },
      { name: "refreshInbox", description: "Reload the inbox message list" },
      { name: "syncMirror", description: "Sync local mail mirror (cache tier)" },
      { name: "openSetup", description: "Open the setup pane" },
    ],
    voiceCommands: [
      { name: "compose", phrases: ["new email", "compose", "write an email"], action: "openCompose" },
      {
        name: "search",
        phrases: ["search mail", "find email", "search for"],
        action: "searchMail",
        params: ["query"],
      },
    ],
    actions: [
      { name: "connectorsStatus", description: "Mail connector registry and mirror health" },
      { name: "syncMirror", description: "Sync local mail mirror (cache tier)" },
    ],
  },
};
