/** Desktop presentation — open ArozOS modules and files from app chat/voice. */

export type DesktopAction = {
  kind: "module" | "file";
  target: string;
};

export type FilesContext = {
  filesRoot: string;
  desktopRoot: string;
  joshuFilesDirName?: string;
  arozPathPrefix?: string;
  linkScheme?: string;
};

type ArozDesktopWindow = Window & {
  openModule?: (name: string) => void;
  newFloatWindow?: (config: {
    url: string;
    width?: number;
    height?: number;
    appicon?: string;
    title?: string;
  }) => void;
};

/** Canonical module names for openModule() — see docs/arozos-desktop-shortcuts.md */
export const DESKTOP_MODULE_NAMES = new Set([
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

export function normalizeModuleAlias(input: string): string | null {
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

export function matchQuickDesktopOpen(text: string): DesktopAction | null {
  const trimmed = text.trim();
  const match = trimmed.match(/^open\s+(?:the\s+)?(.+?)\.?$/i);
  if (!match) return null;
  const moduleName = normalizeModuleAlias(match[1] ?? "");
  if (!moduleName) return null;
  return { kind: "module", target: moduleName };
}

export function parseDesktopActionFromToolPayload(raw: unknown): DesktopAction | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;

  const tryValue = (value: unknown): DesktopAction | null => {
    if (value && typeof value === "object") {
      const action = value as DesktopAction;
      if ((action.kind === "module" || action.kind === "file") && typeof action.target === "string") {
        return action;
      }
    }
    if (typeof value !== "string") return null;
    try {
      const parsed = JSON.parse(value) as { action?: DesktopAction };
      if (
        parsed?.action &&
        (parsed.action.kind === "module" || parsed.action.kind === "file") &&
        typeof parsed.action.target === "string"
      ) {
        return parsed.action;
      }
    } catch {
      /* ignore */
    }
    return null;
  };

  for (const key of ["action", "result", "output", "tool_result"]) {
    const action = tryValue(record[key]);
    if (action) return action;
  }
  return null;
}

export function validateFilePath(relativePath: string): string | null {
  const clean = relativePath.replace(/^\/+/, "").replace(/\\/g, "/");
  if (!clean || clean.includes("..")) return null;
  return clean;
}

function resolveFilesApiBase(): string {
  const fromEnv = (import.meta as ImportMeta & { env?: Record<string, string> }).env?.VITE_JOSHU_FILES_API_BASE?.trim();
  if (fromEnv) return fromEnv.replace(/\/+$/, "");

  const { hostname, protocol, port } = window.location;
  const joshuBasePath = "/joshu";
  const joshuPort = port === "8787" || !port ? "8788" : port;
  if (port === "8788") return `${joshuBasePath}/api/files`;
  return `${protocol}//${hostname}:${joshuPort}${joshuBasePath}/api/files`;
}

function getArozDesktop(): ArozDesktopWindow | null {
  try {
    const topWin = window.top as ArozDesktopWindow | null;
    if (topWin && (typeof topWin.openModule === "function" || typeof topWin.newFloatWindow === "function")) {
      return topWin;
    }
  } catch {
    /* cross-origin */
  }

  let w: Window | null = window;
  for (let depth = 0; depth < 8 && w; depth += 1) {
    const candidate = w as ArozDesktopWindow;
    if (typeof candidate.newFloatWindow === "function" || typeof candidate.openModule === "function") {
      return candidate;
    }
    if (!w.parent || w.parent === w) break;
    w = w.parent;
  }
  return null;
}

async function fetchFilesContext(): Promise<FilesContext | null> {
  try {
    const res = await fetch(`${resolveFilesApiBase()}/context`, { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as FilesContext;
  } catch {
    return null;
  }
}

export function openDesktopModule(moduleName: string): boolean {
  const resolved = normalizeModuleAlias(moduleName);
  if (!resolved) return false;

  const desktop = getArozDesktop();
  if (typeof desktop?.openModule === "function") {
    desktop.openModule(resolved);
    return true;
  }

  const parent = window.parent as Window & { openModule?: (name: string) => void };
  if (typeof parent.openModule === "function") {
    parent.openModule(resolved);
    return true;
  }

  return false;
}

export async function openDesktopFile(relativePath: string): Promise<boolean> {
  const clean = validateFilePath(relativePath);
  if (!clean) return false;

  const ctx = await fetchFilesContext();
  const desktop = getArozDesktop();
  if (!desktop?.newFloatWindow) return false;

  const filename = clean.split("/").pop() ?? clean;
  const ext = filename.includes(".") ? filename.split(".").pop()?.toLowerCase() : "";
  const dirName = ctx?.joshuFilesDirName ?? "joshu's files";
  const filepath = `${ctx?.arozPathPrefix ?? `user:/Desktop/${dirName}`}/${clean}`;
  const openParam = encodeURIComponent(JSON.stringify([{ filepath, filename }]));

  if (ext === "excalidraw" || ext === "md") {
    desktop.newFloatWindow({
      url: `excalidraw/index.html#${openParam}`,
      width: 1280,
      height: 860,
      appicon: "img/joshu/whiteboard.png",
      title: ext === "md" ? `jWhiteboard — ${filename}` : "jWhiteboard",
    });
    return true;
  }

  desktop.newFloatWindow({
    url: `MDEditor/mde.html#${openParam}`,
    width: 1080,
    height: 580,
    appicon: "MDEditor/img/notebook.png",
    title: `MDEditor — ${filename}`,
  });
  return true;
}

export async function executeDesktopAction(action: DesktopAction): Promise<boolean> {
  if (action.kind === "module") {
    return openDesktopModule(action.target);
  }
  return openDesktopFile(action.target);
}
