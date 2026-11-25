/**
 * Hindsight state for the box health report (`components.hindsight` of `/api/instance/health`).
 *
 * The component reports the real state of Hindsight on the box:
 * - `enabled: false`, `ok: false`, `reason: "disabled"` when JOSHU_HINDSIGHT_ENABLED turns Hindsight off.
 *   The fleet runs with Hindsight on, so a disabled Hindsight is a fault that the fleet failure
 *   digest of the control plane must show.
 * - `enabled: true`, `ok: true` when `HINDSIGHT_API_URL/health` answers 2xx.
 * - `enabled: true`, `ok: false` with a reason when the health URL fails or does not answer.
 */

export type HindsightHealth = {
  ok: boolean;
  enabled: boolean;
  reason?: string;
};

function envValue(name: string): string {
  return process.env[name]?.trim() ?? "";
}

/**
 * True when JOSHU_HINDSIGHT_ENABLED turns Hindsight on. In auto mode (unset or "auto"),
 * Hindsight is on only when the local API has LLM configuration to start, so that
 * ordinary dev runs do not fail.
 */
export function isJoshuHindsightEnabled(): boolean {
  const value = envValue("JOSHU_HINDSIGHT_ENABLED").toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return Boolean(
    envValue("HINDSIGHT_API_LLM_API_KEY") ||
      envValue("HINDSIGHT_API_LLM_PROVIDER") ||
      envValue("HINDSIGHT_API_LLM_BASE_URL"),
  );
}

export async function probeHindsightHealth(
  apiUrl: string,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<HindsightHealth> {
  if (!isJoshuHindsightEnabled()) return { ok: false, enabled: false, reason: "disabled" };
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const url = new URL("/health", `${apiUrl.replace(/\/+$/, "")}/`);
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(options.timeoutMs ?? 3_000) });
    if (res.ok) return { ok: true, enabled: true };
    return { ok: false, enabled: true, reason: `health HTTP ${res.status}` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, enabled: true, reason: `unreachable: ${message.slice(0, 120)}` };
  }
}
