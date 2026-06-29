/**
 * Lightweight manifest validation (schema v2 subset).
 */

export type JoshuGuiActionDef = {
  name: string;
  description?: string;
};

export type JoshuVoiceCommandDef = {
  name: string;
  phrases: string[];
  action: string;
  params?: string[];
  description?: string;
};

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
    if (agent.guiActions !== undefined && !Array.isArray(agent.guiActions)) {
      errors.push("agent.guiActions must be an array");
    }
    if (agent.voiceCommands !== undefined && !Array.isArray(agent.voiceCommands)) {
      errors.push("agent.voiceCommands must be an array");
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, errors: [], manifest: doc as JoshuAppManifest };
}
