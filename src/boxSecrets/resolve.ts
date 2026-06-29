import { provisionEnvTrim } from "../provisionInstanceEnv.js";
import { BOX_SECRETS_UI_KEYS, readBoxSecretsOverrides, type BoxSecretsUiKey } from "./localEnv.js";

function processEnvTrim(name: string): string {
  return process.env[name]?.trim() ?? "";
}

/** True when control plane or operator set the key in /etc/joshu/instance.env. */
export function isProvisionLockedSecret(name: BoxSecretsUiKey): boolean {
  return Boolean(provisionEnvTrim(name));
}

/** Provision file → process env → Welcome box-secrets local-env. */
export function resolveBoxSecret(name: BoxSecretsUiKey, projectRoot = process.cwd()): string {
  const fromProvision = provisionEnvTrim(name);
  if (fromProvision) return fromProvision;
  const fromProcess = processEnvTrim(name);
  if (fromProcess) return fromProcess;
  return readBoxSecretsOverrides(projectRoot)[name] ?? "";
}

export function isStandaloneSelfHost(): boolean {
  const standalone = provisionEnvTrim("JOSHU_STANDALONE");
  if (standalone === "1" || standalone?.toLowerCase() === "true") return true;
  // Fleet / control-plane boxes carry an instance agent token at provision time.
  return !provisionEnvTrim("INSTANCE_AGENT_TOKEN");
}

export function isLlmConfigured(projectRoot = process.cwd()): boolean {
  return Boolean(resolveBoxSecret("OPENROUTER_API_KEY", projectRoot));
}

/** Standalone boxes without a provisioned OpenRouter key should collect it in Welcome. */
export function needsConnectAiInWelcome(projectRoot = process.cwd()): boolean {
  if (!isStandaloneSelfHost()) return false;
  if (isProvisionLockedSecret("OPENROUTER_API_KEY")) return false;
  return !isLlmConfigured(projectRoot);
}

export function readBoxSecretsStatus(projectRoot = process.cwd()) {
  const fields: Record<
    BoxSecretsUiKey,
    { configured: boolean; source: "provision" | "env" | "local" | "unset"; locked: boolean }
  > = {
    OPENROUTER_API_KEY: { configured: false, source: "unset", locked: false },
    HINDSIGHT_API_LLM_API_KEY: { configured: false, source: "unset", locked: false },
  };

  for (const key of BOX_SECRETS_UI_KEYS) {
    const locked = isProvisionLockedSecret(key);
    const fromProvision = provisionEnvTrim(key);
    const fromProcess = processEnvTrim(key);
    const fromLocal = readBoxSecretsOverrides(projectRoot)[key];
    if (fromProvision) {
      fields[key] = { configured: true, source: "provision", locked: true };
    } else if (fromProcess) {
      fields[key] = { configured: true, source: "env", locked: false };
    } else if (fromLocal) {
      fields[key] = { configured: true, source: "local", locked: false };
    } else {
      fields[key] = { configured: false, source: "unset", locked: false };
    }
  }

  return {
    standalone: isStandaloneSelfHost(),
    needsConnectAi: needsConnectAiInWelcome(projectRoot),
    llmConfigured: isLlmConfigured(projectRoot),
    fields,
  };
}
