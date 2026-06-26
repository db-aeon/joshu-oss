/**
 * Runtime copy of src/actionGuard/classify.ts for standalone MCP proxy scripts.
 * Keep in sync with the TypeScript module.
 */

/** @typedef {"allowlist" | "external_writes"} ActionGuardGateMode */

/** @typedef {{ enabled?: boolean; gateMode?: ActionGuardGateMode; guardedActions?: string[]; browserGateWrites?: boolean }} ActionGuardPolicySlice */

const COMPOSIO_GUARDED_TOOLS = new Set(["GMAIL_SEND_EMAIL", "GMAIL_REPLY_TO_THREAD"]);

const COMPOSIO_WRITE_HEURISTICS = [
  /_SEND_/i,
  /_CREATE_/i,
  /_UPDATE_/i,
  /_POST_/i,
  /_REPLY_/i,
];

/** Meta / read tools — never gated even in external_writes mode. */
const COMPOSIO_READ_EXCLUSIONS = [
  /^COMPOSIO_/i,
  /_SEARCH_/i,
  /_LIST_/i,
  /_FETCH_/i,
  /_FIND_/i,
  /_READ_/i,
  /_GET_/i,
];

const BROWSER_WRITE_ACTION_IDS = new Set([
  "browser:click",
  "browser:type",
  "browser:press",
  "browser:evaluate",
  "browser:submit",
]);

const CONNECTORS_WRITE_TOOLS = new Set(["nylas_send_message"]);

/**
 * @param {string} toolName
 * @returns {boolean}
 */
export function isComposioWriteTool(toolName) {
  const name = String(toolName ?? "").trim();
  if (!name) return false;
  if (COMPOSIO_READ_EXCLUSIONS.some((re) => re.test(name))) return false;
  return COMPOSIO_WRITE_HEURISTICS.some((re) => re.test(name));
}

/**
 * @param {string} toolName
 * @param {string[]} guardedActions
 * @returns {boolean}
 */
export function isComposioToolGuarded(toolName, guardedActions) {
  const name = String(toolName ?? "").trim();
  const actionId = `composio:${name}`;
  if (guardedActions.includes(actionId)) return true;
  if (COMPOSIO_GUARDED_TOOLS.has(name)) return true;
  if (guardedActions.some((a) => a === "composio:*" || a === "composio:write")) {
    return isComposioWriteTool(name);
  }
  return false;
}

/**
 * @param {string} toolName
 * @param {string[]} guardedActions
 * @returns {boolean}
 */
export function isConnectorsToolGuarded(toolName, guardedActions) {
  return guardedActions.includes(String(toolName ?? "").trim());
}

/**
 * @param {string} actionId
 * @param {ActionGuardPolicySlice} policy
 * @returns {boolean}
 */
export function isActionGuardedExternalWrites(actionId, policy) {
  const id = String(actionId ?? "").trim();
  if (!id) return false;

  if (id.startsWith("composio:")) {
    return isComposioWriteTool(id.slice("composio:".length));
  }
  if (id.startsWith("browser:")) {
    return policy.browserGateWrites === true && BROWSER_WRITE_ACTION_IDS.has(id);
  }
  if (CONNECTORS_WRITE_TOOLS.has(id)) return true;
  return false;
}

/**
 * @param {string} actionId
 * @param {ActionGuardPolicySlice} policy
 * @returns {boolean}
 */
export function isActionGuarded(actionId, policy) {
  if (!policy?.enabled) return false;
  const gateMode = policy.gateMode === "allowlist" ? "allowlist" : "external_writes";
  const guardedActions = Array.isArray(policy.guardedActions) ? policy.guardedActions : [];

  if (gateMode === "external_writes") {
    if (isActionGuardedExternalWrites(actionId, policy)) return true;
    if (actionId.startsWith("composio:")) {
      return isComposioToolGuarded(actionId.slice("composio:".length), guardedActions);
    }
    return guardedActions.includes(actionId);
  }

  if (actionId.startsWith("composio:")) {
    return isComposioToolGuarded(actionId.slice("composio:".length), guardedActions);
  }
  return guardedActions.includes(actionId);
}

/**
 * @param {string} toolName
 * @param {ActionGuardPolicySlice} policy
 * @returns {boolean}
 */
export function isGuardedComposioTool(toolName, policy) {
  const name = String(toolName ?? "").trim();
  const actionId = `composio:${name}`;
  return isActionGuarded(actionId, policy);
}

/**
 * @param {string} toolName
 * @param {Record<string, unknown>} args
 * @returns {Record<string, unknown>}
 */
export function buildComposioToolSummary(toolName, args) {
  const a = args && typeof args === "object" ? args : {};
  const readString = (v) => (typeof v === "string" ? v.trim() : "");
  const body = readString(a.body ?? a.message ?? a.text ?? a.content);
  return {
    tool: toolName,
    to: a.recipient_email ?? a.to ?? a.attendees ?? a.channel,
    cc: a.cc,
    bcc: a.bcc,
    subject: a.subject ?? a.title ?? a.summary,
    channel: a.channel ?? a.channel_id,
    repo: a.repo ?? a.repository,
    bodyPreview: body.slice(0, 400),
    argsPreview: JSON.stringify(a).slice(0, 400),
  };
}

/**
 * @param {unknown} statusPayload
 * @returns {ActionGuardPolicySlice}
 */
export function actionGuardPolicyFromStatus(statusPayload) {
  const row = statusPayload && typeof statusPayload === "object" ? statusPayload : {};
  const policy = /** @type {Record<string, unknown>} */ (row).policy;
  if (!policy || typeof policy !== "object") {
    return { enabled: false, gateMode: "external_writes", guardedActions: [], browserGateWrites: false };
  }
  const p = /** @type {Record<string, unknown>} */ (policy);
  return {
    enabled: p.enabled === true,
    gateMode: p.gateMode === "allowlist" ? "allowlist" : "external_writes",
    guardedActions: Array.isArray(p.guardedActions)
      ? p.guardedActions.filter((x) => typeof x === "string")
      : [],
    browserGateWrites: p.browserGateWrites === true,
  };
}
