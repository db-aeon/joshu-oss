/** Manifest-driven app voice tools — fast path without Hermes. */

export type AppVoiceCommand = {
  name: string;
  phrases: string[];
  action: string;
  params?: string[];
  description?: string;
};

export function buildAppVoiceToolDefinitions(
  appId: string,
  commands: AppVoiceCommand[],
): Array<Record<string, unknown>> {
  return commands.map((cmd) => {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const param of cmd.params ?? []) {
      properties[param] = { type: "string", description: `${param} for ${cmd.action}` };
      required.push(param);
    }

    return {
      type: "function",
      name: `app_${appId}_${cmd.name}`,
      description:
        cmd.description ??
        `Fast ${appId} action (${cmd.phrases.slice(0, 2).join(" / ")}). No Hermes — updates the app UI directly.`,
      parameters: {
        type: "object",
        properties,
        required,
      },
    };
  });
}

export function resolveAppVoiceTool(
  toolName: string,
  commands: AppVoiceCommand[],
  appId: string,
): { action: string; cmd: AppVoiceCommand } | null {
  const prefix = `app_${appId}_`;
  if (!toolName.startsWith(prefix)) return null;
  const cmdName = toolName.slice(prefix.length);
  const cmd = commands.find((c) => c.name === cmdName);
  if (!cmd) return null;
  return { action: cmd.action, cmd };
}

export function mapAppVoiceToolArgs(
  cmd: AppVoiceCommand,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const mapped: Record<string, unknown> = {};
  for (const param of cmd.params ?? []) {
    if (args[param] !== undefined) mapped[param] = args[param];
  }
  return mapped;
}
