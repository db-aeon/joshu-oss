/** Checkbox options for Welcome onboarding — shared by API + UI. */

export const BIG_PICTURE_PRIORITIES = [
  "Inbox & email triage",
  "Calendar & scheduling",
  "Meeting prep & follow-ups",
  "Travel & itineraries",
  "Expenses & receipts",
  "Client & customer follow-up",
  "Sales & business development",
  "Hiring & recruiting",
  "Invoices & bookkeeping",
  "Family & school logistics",
  "Home & household errands",
  "Personal appointments & health",
  "Social media & online presence",
  "Content & marketing",
  "Research & staying informed",
] as const;

export type CommunicationChannelDef = {
  id: string;
  label: string;
  contactLabel: string;
  contactPlaceholder: string;
  inputType?: "email" | "tel" | "text";
};

export const COMMUNICATION_CHANNEL_DEFS: CommunicationChannelDef[] = [
  {
    id: "work-email",
    label: "Work email",
    contactLabel: "Work email address",
    contactPlaceholder: "you@company.com",
    inputType: "email",
  },
  {
    id: "personal-email",
    label: "Personal email",
    contactLabel: "Personal email address",
    contactPlaceholder: "you@gmail.com",
    inputType: "email",
  },
  {
    id: "phone",
    label: "Phone call",
    contactLabel: "Phone number",
    contactPlaceholder: "+1 555 555 5555",
    inputType: "tel",
  },
  {
    id: "sms",
    label: "Text message (SMS)",
    contactLabel: "Mobile number",
    contactPlaceholder: "+1 555 555 5555",
    inputType: "tel",
  },
  {
    id: "whatsapp",
    label: "WhatsApp",
    contactLabel: "WhatsApp number",
    contactPlaceholder: "+1 555 555 5555",
    inputType: "tel",
  },
  {
    id: "telegram",
    label: "Telegram",
    contactLabel: "Telegram username",
    contactPlaceholder: "@username",
    inputType: "text",
  },
  {
    id: "slack",
    label: "Slack",
    contactLabel: "Slack member ID or workspace",
    contactPlaceholder: "you@company.com or workspace URL",
    inputType: "text",
  },
  {
    id: "google-chat",
    label: "Google Chat",
    contactLabel: "Google Chat email or space",
    contactPlaceholder: "you@company.com",
    inputType: "text",
  },
];

/** @deprecated Use channel ids from COMMUNICATION_CHANNEL_DEFS. */
export const COMMUNICATION_CHANNELS = COMMUNICATION_CHANNEL_DEFS.map((d) => d.label);

export function communicationChannelLabel(id: string): string {
  return COMMUNICATION_CHANNEL_DEFS.find((d) => d.id === id)?.label ?? id;
}

export type OnlineToolSection = { title: string; options: readonly string[] };

export const ONLINE_TOOL_SECTIONS: OnlineToolSection[] = [
  {
    title: "Email & calendar",
    options: ["Gmail", "Google Calendar", "Microsoft Outlook", "Microsoft Teams"],
  },
  {
    title: "Docs & cloud",
    options: ["Google Drive + Docs", "OneDrive + Office"],
  },
  {
    title: "Social",
    options: ["LinkedIn", "X (Twitter)", "Instagram", "Facebook"],
  },
  {
    title: "Notes & knowledge",
    options: ["Notion", "Apple Notes", "Obsidian", "Evernote", "OneNote"],
  },
  {
    title: "Tasks & projects",
    options: ["Todoist", "Asana", "Trello", "Monday.com", "Apple Reminders"],
  },
];

export const ALL_ONLINE_TOOLS = ONLINE_TOOL_SECTIONS.flatMap((s) => s.options);
