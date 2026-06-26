/** Module alias resolution for voice fast-path open_desktop (mirrors hermes-chat desktopActions). */

const DESKTOP_MODULE_NAMES = new Set([
  "jWeb",
  "jChat",
  "jWhiteboard",
  "Memory",
  "File Brain",
  "jMovie",
  "jMail",
  "Connectors",
  "Schedules",
  "Welcome",
  "File Manager",
  "System Setting",
  "Trash Bin",
]);

const MODULE_ALIASES: Record<string, string> = {
  browser: "jWeb",
  web: "jWeb",
  jweb: "jWeb",
  chat: "jChat",
  jchat: "jChat",
  hermes: "jChat",
  whiteboard: "jWhiteboard",
  excalidraw: "jWhiteboard",
  jwhiteboard: "jWhiteboard",
  memory: "Memory",
  hindsight: "Memory",
  "file brain": "File Brain",
  filebrain: "File Brain",
  movie: "jMovie",
  jmovie: "jMovie",
  mail: "jMail",
  email: "jMail",
  jmail: "jMail",
  inbox: "jMail",
  "mail app": "jMail",
  "email app": "jMail",
  connectors: "Connectors",
  connections: "Connectors",
  oauth: "Connectors",
  schedules: "Schedules",
  cron: "Schedules",
  welcome: "Welcome",
  onboarding: "Welcome",
  files: "File Manager",
  "file manager": "File Manager",
  filemanager: "File Manager",
  settings: "System Setting",
  "system setting": "System Setting",
  trash: "Trash Bin",
  "trash bin": "Trash Bin",
};

export function resolveDesktopModule(input: string): string | null {
  let trimmed = input.trim();
  if (!trimmed) return null;
  trimmed = trimmed.replace(/\s+app$/i, "").trim();
  if (DESKTOP_MODULE_NAMES.has(trimmed)) return trimmed;
  const key = trimmed.toLowerCase();
  if (MODULE_ALIASES[key]) return MODULE_ALIASES[key];
  for (const name of DESKTOP_MODULE_NAMES) {
    if (name.toLowerCase() === key) return name;
  }
  return null;
}
