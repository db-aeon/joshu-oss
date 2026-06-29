import type { AppAgentConfig, JoshuAppAgentManifest } from "./types.js";

export type CreateAppAgentConfigInput = {
  manifest: JoshuAppAgentManifest;
  apiBase?: string;
  threadId?: string;
  agentId?: string;
};

/** Derive HttpAgent session + endpoint settings from a joshu.app.json agent block. */
export function createAppAgentConfig(input: CreateAppAgentConfigInput): AppAgentConfig {
  const appId = input.manifest.id;
  const threadId = input.threadId ?? `${appId}:${Date.now()}`;
  const apiBase = (input.apiBase ?? "/joshu/api").replace(/\/+$/, "");

  return {
    appId,
    agentId: input.agentId ?? "hermes-default",
    threadId,
    apiBase,
    manifest: input.manifest,
  };
}

/** Collect skill names declared on the manifest for prompt trimming hints. */
export function collectManifestSkills(manifest: JoshuAppAgentManifest): string[] {
  const skills = new Set<string>();
  if (manifest.agent?.skill) skills.add(manifest.agent.skill);
  for (const name of manifest.agent?.usesSkills ?? []) {
    if (name.trim()) skills.add(name.trim());
  }
  return [...skills];
}
