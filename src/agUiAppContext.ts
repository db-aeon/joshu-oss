/**
 * App-scoped AG-UI context — trimmed prompts from joshu.app.json agent block.
 */

import { createHash } from "node:crypto";

import type { HermesChatMessage } from "./hermesApi.js";
import { getAppManifest, type JoshuAppManifest } from "./appRegistry.js";

export type JoshuAppAgentRunState = {
  appId?: string;
  mode?: "embedded" | "standalone";
  gui?: Record<string, unknown>;
};

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function parseAppAgentState(raw: unknown): JoshuAppAgentRunState {
  if (!raw || typeof raw !== "object") return {};
  const doc = raw as Record<string, unknown>;
  const appId = readString(doc.appId);
  const mode = doc.mode === "standalone" ? "standalone" : doc.mode === "embedded" ? "embedded" : undefined;
  const gui = doc.gui && typeof doc.gui === "object" ? (doc.gui as Record<string, unknown>) : undefined;
  return { appId: appId || undefined, mode, gui };
}

export function resolveAppIdFromRequest(
  queryAppId: unknown,
  state: JoshuAppAgentRunState,
): string | undefined {
  return readString(queryAppId) || state.appId;
}

function collectSkillNames(manifest: JoshuAppManifest): string[] {
  const skills = new Set<string>();
  if (manifest.agent?.skill) skills.add(manifest.agent.skill);
  for (const name of manifest.agent?.usesSkills ?? []) {
    const trimmed = readString(name);
    if (trimmed) skills.add(trimmed);
  }
  return [...skills];
}

function formatGuiActionsForPrompt(manifest: JoshuAppManifest): string[] {
  return (manifest.agent?.guiActions ?? []).map((action) => {
    const params = (action.parameters ?? []).map((p) => p.name).filter(Boolean);
    if (params.length === 0) return action.name;
    return `${action.name}(${params.join(", ")})`;
  });
}

/** Hermes session key for embedded app agents (distinct from jChat). */
export function buildAppAgentSessionId(appId: string, threadId: string): string {
  return `joshu-app:${appId}:${threadId}`;
}

/** Hermes `X-Hermes-Session-Id` length cap (api_server `_MAX_SESSION_HEADER_LEN`). */
const HERMES_SESSION_ID_MAX = 256;

/** Mirrors Hermes `gateway.session._is_path_unsafe` plus the header control-char check. */
function isUnsafeHermesSessionId(value: string): boolean {
  return (
    value.includes("..") ||
    value.includes("/") ||
    value.includes("\\") ||
    /[\r\n\0]/.test(value) ||
    /^[A-Za-z]:/.test(value) ||
    value.length > HERMES_SESSION_ID_MAX
  );
}

/**
 * Hermes session id for an AG-UI thread. Hermes names files on disk after the session id and
 * answers 400 when it holds a path separator, so a jNotes thread for `Notes/plan.md` must be
 * encoded. Safe thread ids pass through unchanged, which keeps existing sessions.
 */
export function toHermesSessionId(threadId: string): string {
  if (!isUnsafeHermesSessionId(threadId)) return threadId;
  let id = threadId
    .replace(/%/g, "%25")
    .replace(/\//g, "%2F")
    .replace(/\\/g, "%5C")
    .replace(/\.\./g, ".%2E")
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A")
    .replace(/\0/g, "%00");
  if (/^[A-Za-z]:/.test(id)) id = `t-${id}`;
  if (id.length > HERMES_SESSION_ID_MAX) {
    const hash = createHash("sha256").update(threadId).digest("hex").slice(0, 16);
    id = `${id.slice(0, HERMES_SESSION_ID_MAX - hash.length - 1)}~${hash}`;
  }
  return id;
}

/** Short owner-facing text for a failed run; keeps the Hermes error message, drops the raw body. */
export function describeRunError(message: string): string {
  const match = /^Hermes chat request failed: (\d+) ?([\s\S]*)$/.exec(message);
  if (!match) return message;
  const [, status, body = ""] = match;
  let detail = body.trim();
  try {
    const parsed = JSON.parse(detail) as { error?: { message?: unknown } | string };
    const inner = typeof parsed.error === "string" ? parsed.error : parsed.error?.message;
    if (typeof inner === "string" && inner.trim()) detail = inner.trim();
  } catch {
    /* not JSON; keep the raw text */
  }
  detail = detail.slice(0, 200);
  return detail ? `Hermes returned ${status}: ${detail}` : `Hermes returned ${status}.`;
}

/** Compact system messages injected before the user turn for app-scoped AG-UI runs. */
export function buildAppAgentSystemMessages(
  manifest: JoshuAppManifest | undefined,
  state: JoshuAppAgentRunState,
): HermesChatMessage[] {
  if (!manifest) return [];

  const skills = collectSkillNames(manifest);
  const guiActions = formatGuiActionsForPrompt(manifest);
  const mode = state.mode ?? "embedded";
  const lines: string[] = [
    `You are assisting inside the Joshu desktop app "${manifest.name}" (id: ${manifest.id}).`,
    `Mode: ${mode}.`,
  ];

  if (skills.length > 0) {
    lines.push(`Load these skills via skill_view when needed: ${skills.join(", ")}.`);
  }

  if (mode === "embedded") {
    const guiSkill = manifest.agent?.skill;
    lines.push(
      "Embedded mode — the user is looking at this app. Prefer the GUI over external MCP/platform tools.",
      "READ (list, summarize, what's open): answer from Current GUI snapshot (activeView + listPreview/detail fields). Do NOT call agent.usesSkills or MCP for data already in the snapshot.",
      "If list preview is missing or stale, call the app's refresh guiAction (if declared), then use the tool result.",
      "NAVIGATE / EDIT IN UI: app_gui_action only — see guiActions below and the app's bundled GUI skill. Never auto-submit sends or destructive actions.",
      `app_gui_action appId="${manifest.id}" action=<guiAction> for UI changes.`,
      guiSkill
        ? `Load skill_view('${guiSkill}') for app-specific GUI-first vs headless escalation rules.`
        : "Follow the app's bundled GUI skill for GUI-first vs headless escalation.",
      "ESCALATE to agent.usesSkills (MCP, gbrain, deep search) ONLY when:",
      "  - the user asks for data not present in the loaded GUI state,",
      "  - refresh guiAction + snapshot still cannot answer, or",
      "  - the user explicitly asks for headless/live/deep search or automation.",
    );
    if (guiActions.length > 0) {
      lines.push(`Available guiActions for app_gui_action: ${guiActions.join(", ")}.`);
      lines.push(
        "Only call declared guiActions. Unknown names (for example refreshBoard) are rejected.",
      );
    }
    if (manifest.id === "excalidraw") {
      lines.push(
        "CORE TENET (AG-UI): embedded jWhiteboard chat must interact with the open board. Chat-only reviews are a protocol failure.",
        "jWhiteboard board writes require proposeTransaction/stageOpening/recallToBoard via app_gui_action.",
        "NEVER mutate the open board with write_file, patch, terminal edits, or skill_view('excalidraw').",
        "Those edit the .excalidraw file on disk; the open canvas does not auto-reload, so the user sees nothing.",
        "proposeTransaction args.transaction must include rationale plus operations[] of UPSERT_OBJECT (etc).",
        "Each UPSERT_OBJECT needs nested object:{kind,title,body,provenance} with kind note|open_question|decision.",
        "One UPSERT_OBJECT per sticky note. All kinds apply immediately; a small action note appears under each target.",
        "If gui.selectedItems is set, update ONLY those selected notes — never substitute other board items from chat memory.",
        "When gui.cwmReady is true: any review/orient/capture/empty-board turn MUST call proposeTransaction, recallToBoard, or stageOpening in the same turn before finishing.",
        "If scenePreview is empty, the canvas is empty — stage stickies now; do not invent that prior chats left content visible.",
        "Never claim items are on the board unless this turn successfully queued one of those board-write guiActions.",
        "If app_gui_action returns ok:false, report the error; do not fall back to file edits.",
      );
    }
  } else {
    lines.push(
      "Headless mode: use platform MCP tools and POST /joshu/api/apps/:id/invoke actions documented in the app skill.",
    );
  }

  if (state.gui && Object.keys(state.gui).length > 0) {
    const selectedItems = Array.isArray((state.gui as { selectedItems?: unknown }).selectedItems)
      ? ((state.gui as { selectedItems: unknown[] }).selectedItems)
      : [];
    if (selectedItems.length > 0) {
      // Put selection first so deixis cannot be buried under scenePreview / chat bias.
      lines.push(
        `REQUIRED CANVAS SELECTION (authoritative for "these"/"those"/"both of these"/"this"): ${JSON.stringify(selectedItems)}`,
        "Operate on these selectedItems only. Do not replace them with entities mentioned earlier in the conversation.",
      );
    }
    lines.push(
      `Current GUI snapshot (authoritative for what the user sees now): ${JSON.stringify(state.gui)}`,
      "When the user asks what is open or visible, answer from activeView and list/detail preview fields in the snapshot — not from chat history or hidden background state.",
      "DEIXIS: if gui.selectedItems is non-empty (selectionSource live or anchored), phrases like 'these'/'those'/'both of these'/'this' refer to selectedItems (use their text). Selection outranks prior chat entities and other board items.",
    );
  }

  return [{ role: "system", content: lines.join("\n") }];
}

/** Compact selection list for prompts — keep short so deixis survives log truncation. */
export function formatSelectedItemsGrounding(
  gui: Record<string, unknown> | undefined,
): string | null {
  if (!gui) return null;
  const selectedItems = Array.isArray(gui.selectedItems) ? gui.selectedItems : [];
  if (selectedItems.length === 0) return null;
  const compact = selectedItems
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const row = item as Record<string, unknown>;
      const text = readString(row.text);
      const id = readString(row.id);
      if (!text && !id) return null;
      return text || id;
    })
    .filter((value): value is string => Boolean(value));
  if (compact.length === 0) return null;
  const source = readString(gui.selectionSource) || "unknown";
  return (
    `[Canvas selection (${source}): ${compact.map((text) => JSON.stringify(text)).join("; ")}. ` +
    `Phrases like "these"/"those"/"both" refer ONLY to these items.]`
  );
}

/**
 * Prefix the latest user turn with canvas selection so demonstratives cannot be
 * resolved from chat memory when the GUI snapshot is empty or buried in system text.
 */
export function groundUserMessagesWithSelection(
  messages: readonly HermesChatMessage[],
  gui: Record<string, unknown> | undefined,
): HermesChatMessage[] {
  const grounding = formatSelectedItemsGrounding(gui);
  if (!grounding) return [...messages];
  let lastUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      lastUserIndex = index;
      break;
    }
  }
  if (lastUserIndex < 0) return [...messages];
  const target = messages[lastUserIndex]!;
  const content = typeof target.content === "string" ? target.content : "";
  if (content.includes("[Canvas selection (")) return [...messages];
  return messages.map((message, index) =>
    index === lastUserIndex
      ? { ...message, content: `${grounding}\n${content}` }
      : message,
  );
}

export function getManifestForAppId(appId: string | undefined): JoshuAppManifest | undefined {
  if (!appId) return undefined;
  return getAppManifest(appId);
}

/** Board-mutating guiActions — chat text alone does not satisfy the AG-UI whiteboard tenet. */
export const EXCALIDRAW_BOARD_MUTATING_ACTIONS = new Set([
  "proposeTransaction",
  "recallToBoard",
  "stageOpening",
]);

const TRIVIAL_WHITEBOARD_ACK =
  /^(thanks|thank you|thx|ok|okay|k|got it|cool|great|sure|yes|yep|yeah|no|nope|nm|👍|🙏)[.!]*$/i;

const WHITEBOARD_MUST_WRITE =
  /\b(review|action items?|what'?s open|whats open|next steps?|capture|put (?:it |them )?on|add (?:a |the )?note|stage|orient|start session|summarize|dump|inventory|todo|to-?dos?)\b/i;

export function isExcalidrawBoardMutatingAction(action: string | undefined): boolean {
  return Boolean(action && EXCALIDRAW_BOARD_MUTATING_ACTIONS.has(action));
}

export function latestUserText(messages: readonly HermesChatMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    return typeof message.content === "string" ? message.content.trim() : "";
  }
  return "";
}

/**
 * When true, an embedded jWhiteboard turn that emits no board-write guiAction is incomplete.
 * Snapshot-only Q&A on a populated board is allowed; empty boards and review/orient turns are not.
 */
export function requiresExcalidrawBoardMutation(
  gui: Record<string, unknown> | undefined,
  userText: string,
): boolean {
  if (!gui || gui.cwmReady !== true) return false;
  const text = userText
    .replace(/^\[Canvas selection \([^\]]*\)[^\]]*\]\s*/i, "")
    .trim();
  if (!text || TRIVIAL_WHITEBOARD_ACK.test(text)) return false;
  const scenePreview = Array.isArray(gui.scenePreview) ? gui.scenePreview : [];
  if (scenePreview.length === 0) return true;
  return WHITEBOARD_MUST_WRITE.test(text);
}

/** System nudge injected for the one-shot AG-UI board-mutation retry. */
export function buildWhiteboardBoardMutationNudge(): string {
  return [
    "PROTOCOL VIOLATION: this jWhiteboard turn finished without a board-write guiAction.",
    "Embedded AG-UI chats must change the open canvas — chat-only inventories are forbidden.",
    "Immediately call app_gui_action with proposeTransaction, recallToBoard, or stageOpening",
    "(appId=excalidraw) and put concrete stickies on the board. Do not answer with a chat-only list.",
  ].join(" ");
}
