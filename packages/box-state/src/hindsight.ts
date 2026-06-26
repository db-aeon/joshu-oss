/**
 * Clear Hindsight conversation memory during hard factory reset.
 */

import type { BoxPaths } from "./paths.js";

function envTrim(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback;
}

export interface WipeHindsightResult {
  ok: boolean;
  skipped?: boolean;
  error?: string;
}

/** DELETE all memories in the configured Hindsight bank (preserves bank profile). */
export async function wipeHindsightMemories(paths: BoxPaths): Promise<WipeHindsightResult> {
  const apiUrl = envTrim("HINDSIGHT_API_URL", "http://127.0.0.1:8888").replace(/\/+$/, "");
  const bankId = paths.hindsightBankId;
  const apiKey = envTrim("HINDSIGHT_API_KEY");

  try {
    const health = await fetch(`${apiUrl}/health`, { signal: AbortSignal.timeout(3_000) });
    if (!health.ok) {
      return { ok: false, skipped: true, error: `Hindsight health ${health.status}` };
    }
  } catch (err) {
    return {
      ok: false,
      skipped: true,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const headers: Record<string, string> = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  try {
    const response = await fetch(`${apiUrl}/v1/default/banks/${encodeURIComponent(bankId)}/memories`, {
      method: "DELETE",
      headers,
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return { ok: false, error: `Hindsight clear memories ${response.status}: ${body}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
