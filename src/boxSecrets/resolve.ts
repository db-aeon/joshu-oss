import { provisionEnvTrim } from "../provisionInstanceEnv.js";
import { BOX_SECRETS_UI_KEYS, readBoxSecretsOverrides, type BoxSecretsUiKey } from "./localEnv.js";

function processEnvTrim(name: string): string {
  return process.env[name]?.trim() ?? "";
}

function embeddingsProvider(): string {
  return provisionEnvTrim("HINDSIGHT_API_EMBEDDINGS_PROVIDER") || "google";
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

export function isGeminiConfigured(projectRoot = process.cwd()): boolean {
  return Boolean(resolveBoxSecret("GEMINI_API_KEY", projectRoot));
}

/** gbrain + Hindsight embeddings — dedicated key or shared Gemini key on google provider. */
export function isEmbeddingsGeminiConfigured(projectRoot = process.cwd()): boolean {
  if (resolveBoxSecret("HINDSIGHT_API_EMBEDDINGS_GEMINI_API_KEY", projectRoot)) return true;
  if (embeddingsProvider() === "google" && isGeminiConfigured(projectRoot)) return true;
  return false;
}

/** True when the release pins a voice-realtime image (OSS self-host default in .env.vps.example). */
export function isVoiceOffered(): boolean {
  const ref = provisionEnvTrim("JOSHU_VOICE_IMAGE_REF");
  if (!ref) return false;
  return !ref.includes("your-org/");
}

export function needsOpenRouterInWelcome(projectRoot = process.cwd()): boolean {
  if (!isStandaloneSelfHost()) return false;
  if (isProvisionLockedSecret("OPENROUTER_API_KEY")) return false;
  return !isLlmConfigured(projectRoot);
}

/** Standalone boxes with voice image but no Gemini key yet — collect in Welcome Connect AI. */
export function needsGeminiVoiceInWelcome(projectRoot = process.cwd()): boolean {
  if (!isStandaloneSelfHost()) return false;
  if (!isVoiceOffered()) return false;
  if (isProvisionLockedSecret("GEMINI_API_KEY")) return false;
  return !isGeminiConfigured(projectRoot);
}

/** File brain + Hindsight need a Gemini embedding key when provider=google. */
export function needsEmbeddingsGeminiInWelcome(projectRoot = process.cwd()): boolean {
  if (!isStandaloneSelfHost()) return false;
  if (embeddingsProvider() !== "google") return false;
  if (isProvisionLockedSecret("HINDSIGHT_API_EMBEDDINGS_GEMINI_API_KEY")) return false;
  return !isEmbeddingsGeminiConfigured(projectRoot);
}

/** One Gemini key field in Welcome covers voice mic + google embeddings. */
export function needsGeminiMlInWelcome(projectRoot = process.cwd()): boolean {
  return needsGeminiVoiceInWelcome(projectRoot) || needsEmbeddingsGeminiInWelcome(projectRoot);
}

/** Standalone boxes missing any user-facing ML secret should show Connect AI. */
export function needsConnectAiInWelcome(projectRoot = process.cwd()): boolean {
  return (
    needsOpenRouterInWelcome(projectRoot) ||
    needsGeminiMlInWelcome(projectRoot)
  );
}

export function readBoxSecretsStatus(projectRoot = process.cwd()) {
  const fields: Record<
    BoxSecretsUiKey,
    { configured: boolean; source: "provision" | "env" | "local" | "unset"; locked: boolean }
  > = {
    OPENROUTER_API_KEY: { configured: false, source: "unset", locked: false },
    HINDSIGHT_API_LLM_API_KEY: { configured: false, source: "unset", locked: false },
    GEMINI_API_KEY: { configured: false, source: "unset", locked: false },
    HINDSIGHT_API_EMBEDDINGS_GEMINI_API_KEY: { configured: false, source: "unset", locked: false },
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
    } else if (key === "HINDSIGHT_API_EMBEDDINGS_GEMINI_API_KEY" && isEmbeddingsGeminiConfigured(projectRoot)) {
      // Shared GEMINI_API_KEY satisfies google embeddings without a dedicated field.
      const gemini = resolveBoxSecret("GEMINI_API_KEY", projectRoot);
      fields[key] = gemini
        ? { configured: true, source: fields.GEMINI_API_KEY.source, locked: false }
        : { configured: false, source: "unset", locked: false };
    } else {
      fields[key] = { configured: false, source: "unset", locked: false };
    }
  }

  return {
    standalone: isStandaloneSelfHost(),
    needsConnectAi: needsConnectAiInWelcome(projectRoot),
    needsOpenRouter: needsOpenRouterInWelcome(projectRoot),
    needsGeminiVoice: needsGeminiVoiceInWelcome(projectRoot),
    needsEmbeddingsGemini: needsEmbeddingsGeminiInWelcome(projectRoot),
    needsGeminiMl: needsGeminiMlInWelcome(projectRoot),
    embeddingsProvider: embeddingsProvider(),
    voiceOffered: isVoiceOffered(),
    llmConfigured: isLlmConfigured(projectRoot),
    geminiConfigured: isGeminiConfigured(projectRoot),
    embeddingsGeminiConfigured: isEmbeddingsGeminiConfigured(projectRoot),
    fields,
  };
}
