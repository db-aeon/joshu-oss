/**
 * Lightweight manifest validation (schema v2 subset).
 */

import {
  resolveManifestVoiceTools,
  validateGuiActionEntry,
  validateVoiceCommandsLegacy,
  type JoshuGuiActionDef,
  type JoshuVoiceCommandDef,
} from "./manifestAgent.js";

export type {
  JoshuGuiActionDef,
  JoshuGuiActionParameterDef,
  JoshuGuiActionVoiceDef,
  JoshuVoiceCommandDef,
  ManifestVoiceTool,
} from "./manifestAgent.js";
export { resolveManifestVoiceTools, parameterNamesForGuiAction } from "./manifestAgent.js";

export type JoshuAppManifest = {
  id: string;
  name: string;
  version: string;
  license: string;
  publisher: string;
  entry: string;
  apiPrefix?: string;
  description?: string;
  data?: {
    uses?: string[];
    mail?: { accounts?: string };
  };
  agent?: {
    skill?: string;
    usesSkills?: string[];
    headless?: boolean;
    intents?: Array<{ phrase: string; action: string }>;
    guiActions?: JoshuGuiActionDef[];
    /** @deprecated Prefer guiActions[].voice */
    voiceCommands?: JoshuVoiceCommandDef[];
    actions?: Array<{ name: string; description?: string; handler?: string }>;
  };
};

const ID_PATTERN = /^[a-z0-9-]+$/;
const LICENSES = new Set(["AGPL-3.0", "MIT", "proprietary"]);
const DATA_USES = new Set(["mail", "calendar", "files", "memory", "connections"]);

export type ManifestValidationResult = {
  ok: boolean;
  errors: string[];
  manifest?: JoshuAppManifest;
};

function parseLegacyVoiceCommands(raw: unknown, errors: string[]): JoshuVoiceCommandDef[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    errors.push("agent.voiceCommands must be an array");
    return [];
  }
  const out: JoshuVoiceCommandDef[] = [];
  for (const [i, entry] of raw.entries()) {
    if (!entry || typeof entry !== "object") {
      errors.push(`agent.voiceCommands[${i}] must be an object`);
      continue;
    }
    const row = entry as Record<string, unknown>;
    const name = typeof row.name === "string" ? row.name.trim() : "";
    const action = typeof row.action === "string" ? row.action.trim() : "";
    const phrases = Array.isArray(row.phrases)
      ? row.phrases.filter((p): p is string => typeof p === "string" && p.trim().length > 0)
      : [];
    if (!name) errors.push(`agent.voiceCommands[${i}].name required`);
    if (!action) errors.push(`agent.voiceCommands[${i}].action required`);
    if (phrases.length === 0) errors.push(`agent.voiceCommands[${i}].phrases must be non-empty`);
    out.push({
      name,
      phrases,
      action,
      params: Array.isArray(row.params)
        ? row.params.filter((p): p is string => typeof p === "string" && p.trim().length > 0)
        : undefined,
      description: typeof row.description === "string" ? row.description : undefined,
    });
  }
  return out;
}

export function validateJoshuAppManifest(raw: unknown): ManifestValidationResult {
  const errors: string[] = [];
  if (!raw || typeof raw !== "object") {
    return { ok: false, errors: ["Manifest must be a JSON object"] };
  }
  const doc = raw as Record<string, unknown>;

  for (const field of ["id", "name", "version", "license", "publisher", "entry"] as const) {
    if (typeof doc[field] !== "string" || !doc[field].trim()) {
      errors.push(`Missing or invalid required field: ${field}`);
    }
  }

  if (typeof doc.id === "string" && !ID_PATTERN.test(doc.id)) {
    errors.push("id must match ^[a-z0-9-]+$");
  }
  if (typeof doc.license === "string" && !LICENSES.has(doc.license)) {
    errors.push(`license must be one of: ${[...LICENSES].join(", ")}`);
  }

  if (doc.data && typeof doc.data === "object") {
    const data = doc.data as Record<string, unknown>;
    if (data.uses !== undefined) {
      if (!Array.isArray(data.uses)) {
        errors.push("data.uses must be an array");
      } else {
        for (const use of data.uses) {
          if (typeof use !== "string" || !DATA_USES.has(use)) {
            errors.push(`data.uses contains invalid domain: ${String(use)}`);
          }
        }
      }
    }
  }

  let parsedAgent: JoshuAppManifest["agent"] | undefined;

  if (doc.agent && typeof doc.agent === "object") {
    const agent = doc.agent as Record<string, unknown>;
    if (agent.actions !== undefined) {
      if (!Array.isArray(agent.actions)) {
        errors.push("agent.actions must be an array");
      } else {
        for (const action of agent.actions) {
          if (!action || typeof action !== "object" || typeof (action as { name?: unknown }).name !== "string") {
            errors.push("Each agent.actions entry requires name");
          }
        }
      }
    }

    const guiActions: JoshuGuiActionDef[] = [];
    if (agent.guiActions !== undefined) {
      if (!Array.isArray(agent.guiActions)) {
        errors.push("agent.guiActions must be an array");
      } else {
        const seenNames = new Set<string>();
        agent.guiActions.forEach((entry, i) => {
          const parsed = validateGuiActionEntry(entry, `agent.guiActions[${i}]`, errors);
          if (!parsed) return;
          if (seenNames.has(parsed.name)) {
            errors.push(`agent.guiActions duplicate name: ${parsed.name}`);
            return;
          }
          seenNames.add(parsed.name);
          guiActions.push(parsed);
        });
      }
    }

    const legacyVoice = parseLegacyVoiceCommands(agent.voiceCommands, errors);
    const guiActionNames = new Set(guiActions.map((a) => a.name));
    validateVoiceCommandsLegacy(legacyVoice, guiActionNames, errors);

    const voiceTools = resolveManifestVoiceTools(guiActions, legacyVoice);
    const shortcutSeen = new Set<string>();
    for (const tool of voiceTools) {
      if (shortcutSeen.has(tool.name)) {
        errors.push(`Duplicate voice shortcut name: ${tool.name}`);
      }
      shortcutSeen.add(tool.name);
    }

    parsedAgent = {
      ...(agent as JoshuAppManifest["agent"]),
      guiActions: guiActions.length > 0 ? guiActions : undefined,
      voiceCommands: legacyVoice.length > 0 ? legacyVoice : undefined,
    };
  }

  if (errors.length > 0) return { ok: false, errors };
  const manifest = { ...(doc as JoshuAppManifest), agent: parsedAgent ?? (doc.agent as JoshuAppManifest["agent"]) };
  return { ok: true, errors: [], manifest };
}
