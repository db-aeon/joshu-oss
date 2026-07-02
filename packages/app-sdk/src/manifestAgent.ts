/**
 * Embedded app agent manifest — guiActions as SSOT for chat, Hermes, and voice fast tools.
 */

export type JoshuGuiActionParameterDef = {
  name: string;
  type?: "string" | "number" | "boolean" | "object";
  description?: string;
  required?: boolean;
};

/** Voice shortcut metadata on a guiAction (Option A — no separate voiceCommands required). */
export type JoshuGuiActionVoiceDef = {
  /** Gemini tool suffix: app_{appId}_{shortcut}. Defaults to guiAction name. */
  shortcut?: string;
  phrases: string[];
  description?: string;
};

export type JoshuGuiActionDef = {
  name: string;
  description?: string;
  parameters?: JoshuGuiActionParameterDef[];
  voice?: JoshuGuiActionVoiceDef;
};

/** @deprecated Prefer guiActions[].voice — kept for legacy manifests. */
export type JoshuVoiceCommandDef = {
  name: string;
  phrases: string[];
  action: string;
  params?: string[];
  description?: string;
};

/** Normalized voice fast-path tool (voice-realtime / Gemini). */
export type ManifestVoiceTool = {
  name: string;
  phrases: string[];
  action: string;
  params?: string[];
  description?: string;
};

const PARAM_TYPES = new Set(["string", "number", "boolean", "object"]);
const IDENT_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]*$/;

export function parameterNamesForGuiAction(action: JoshuGuiActionDef): string[] {
  return (action.parameters ?? []).map((p) => p.name).filter(Boolean);
}

/** Build voice fast tools from guiActions[].voice; merge legacy voiceCommands when not superseded. */
export function resolveManifestVoiceTools(
  guiActions?: JoshuGuiActionDef[],
  legacyVoiceCommands?: JoshuVoiceCommandDef[],
): ManifestVoiceTool[] {
  const tools: ManifestVoiceTool[] = [];
  const seenShortcuts = new Set<string>();
  const actionsByName = new Map((guiActions ?? []).map((a) => [a.name, a]));

  for (const ga of guiActions ?? []) {
    const voice = ga.voice;
    if (!voice?.phrases?.length) continue;
    const shortcut = (voice.shortcut?.trim() || ga.name).trim();
    if (!shortcut || seenShortcuts.has(shortcut)) continue;
    const paramNames = parameterNamesForGuiAction(ga);
    tools.push({
      name: shortcut,
      phrases: voice.phrases.filter(Boolean),
      action: ga.name,
      params: paramNames.length > 0 ? paramNames : undefined,
      description: voice.description ?? ga.description,
    });
    seenShortcuts.add(shortcut);
  }

  for (const legacy of legacyVoiceCommands ?? []) {
    if (seenShortcuts.has(legacy.name)) continue;
    const linked = actionsByName.get(legacy.action);
    const inheritedParams =
      legacy.params?.length ? legacy.params : linked ? parameterNamesForGuiAction(linked) : undefined;
    tools.push({
      name: legacy.name,
      phrases: legacy.phrases,
      action: legacy.action,
      params: inheritedParams?.length ? inheritedParams : undefined,
      description: legacy.description ?? linked?.description,
    });
    seenShortcuts.add(legacy.name);
  }

  return tools;
}

export function validateGuiActionEntry(raw: unknown, path: string, errors: string[]): JoshuGuiActionDef | null {
  if (!raw || typeof raw !== "object") {
    errors.push(`${path} must be an object`);
    return null;
  }
  const row = raw as Record<string, unknown>;
  const name = typeof row.name === "string" ? row.name.trim() : "";
  if (!name || !IDENT_PATTERN.test(name)) {
    errors.push(`${path}.name must be a valid identifier`);
    return null;
  }

  const parameters: JoshuGuiActionParameterDef[] = [];
  if (row.parameters !== undefined) {
    if (!Array.isArray(row.parameters)) {
      errors.push(`${path}.parameters must be an array`);
    } else {
      const seenParams = new Set<string>();
      row.parameters.forEach((entry, i) => {
        if (!entry || typeof entry !== "object") {
          errors.push(`${path}.parameters[${i}] must be an object`);
          return;
        }
        const p = entry as Record<string, unknown>;
        const pName = typeof p.name === "string" ? p.name.trim() : "";
        if (!pName || !IDENT_PATTERN.test(pName)) {
          errors.push(`${path}.parameters[${i}].name must be a valid identifier`);
          return;
        }
        if (seenParams.has(pName)) {
          errors.push(`${path}.parameters duplicate name: ${pName}`);
          return;
        }
        seenParams.add(pName);
        const pType = typeof p.type === "string" ? p.type : "string";
        if (!PARAM_TYPES.has(pType)) {
          errors.push(`${path}.parameters[${i}].type must be string|number|boolean|object`);
          return;
        }
        parameters.push({
          name: pName,
          type: pType as JoshuGuiActionParameterDef["type"],
          description: typeof p.description === "string" ? p.description : undefined,
          required: p.required === true,
        });
      });
    }
  }

  let voice: JoshuGuiActionVoiceDef | undefined;
  if (row.voice !== undefined) {
    if (!row.voice || typeof row.voice !== "object") {
      errors.push(`${path}.voice must be an object`);
    } else {
      const v = row.voice as Record<string, unknown>;
      const phrases = Array.isArray(v.phrases)
        ? v.phrases.filter((p): p is string => typeof p === "string" && p.trim().length > 0)
        : [];
      if (phrases.length === 0) {
        errors.push(`${path}.voice.phrases must be a non-empty string array`);
      }
      const shortcut = typeof v.shortcut === "string" ? v.shortcut.trim() : undefined;
      if (shortcut && !IDENT_PATTERN.test(shortcut)) {
        errors.push(`${path}.voice.shortcut must be a valid identifier`);
      }
      voice = {
        shortcut: shortcut || undefined,
        phrases,
        description: typeof v.description === "string" ? v.description : undefined,
      };
    }
  }

  return {
    name,
    description: typeof row.description === "string" ? row.description : undefined,
    parameters: parameters.length > 0 ? parameters : undefined,
    voice,
  };
}

export function validateVoiceCommandsLegacy(
  legacy: JoshuVoiceCommandDef[] | undefined,
  guiActionNames: Set<string>,
  errors: string[],
): void {
  if (!legacy?.length) return;
  for (const [i, cmd] of legacy.entries()) {
    if (!cmd.name?.trim()) errors.push(`agent.voiceCommands[${i}].name required`);
    if (!cmd.action?.trim()) errors.push(`agent.voiceCommands[${i}].action required`);
    else if (!guiActionNames.has(cmd.action)) {
      errors.push(`agent.voiceCommands[${i}].action "${cmd.action}" must match a guiActions[].name`);
    }
    if (!Array.isArray(cmd.phrases) || cmd.phrases.length === 0) {
      errors.push(`agent.voiceCommands[${i}].phrases must be a non-empty array`);
    }
  }
}
