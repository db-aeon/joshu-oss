/**
 * Proactive Hermes session turn when an async last30days run completes out-of-app.
 */

import { readHermesGatewayPreference } from "../hermesGatewayPreference.js";
import {
  HermesApiRunner,
  buildTurnSystemMessages,
  type HermesChatMessage,
} from "../hermesApi.js";
import type { Last30DaysRunRecord } from "./runner.js";
import type { ResearchExportResult } from "./researchExport.js";
import { buildLast30DaysSessionDeliveryPrompt } from "./deliverySummary.js";
import { pushHermesChatSessionEvent } from "../hermesChatSessionPush.js";

function envOr(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

function shouldReplyInHermesSession(run: Last30DaysRunRecord): boolean {
  const key = run.hermesSessionKey?.trim();
  if (!key) return false;
  // Embedded app chat blocks until done — no second proactive turn.
  if (key.startsWith("joshu-app:")) return false;
  return true;
}

function resolveHermesSession(
  run: Last30DaysRunRecord,
): { sessionId: string; sessionKey: string } | null {
  const key = run.hermesSessionKey?.trim();
  if (!key) return null;

  const explicitId = run.hermesSessionId?.trim();
  if (explicitId) return { sessionId: explicitId, sessionKey: key };

  if (key.startsWith("joshu-hermes-chat:")) {
    return { sessionId: key.slice("joshu-hermes-chat:".length), sessionKey: key };
  }

  // Telegram / Slack gateway keys — Hermes accepts the full key as session identity.
  return { sessionId: key, sessionKey: key };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableHermesDeliveryError(error: string): boolean {
  return /503|gateway_draining|draining|timed out waiting/i.test(error);
}

function buildHermesRunner(projectRoot: string): HermesApiRunner {
  const autoStart =
    readHermesGatewayPreference(projectRoot) ?? envOr("HERMES_API_AUTO_START", "true") !== "false";
  return new HermesApiRunner({
    binary: envOr("HERMES_BIN", "/Users/danbenyamin/Documents/dev/hermes-agent/venv/bin/hermes"),
    cdpUrl: envOr("BROWSER_CDP_URL", ""),
    apiBaseUrl: envOr("HERMES_API_BASE_URL", "http://127.0.0.1:8642"),
    apiKey: envOr("HERMES_API_KEY", "change-me-local-dev"),
    autoStartGateway: autoStart,
  });
}

/** Deliver completion summary into the originating Hermes chat session (Telegram, jChat, …). */
export async function deliverResearchToHermesSession(
  projectRoot: string,
  run: Last30DaysRunRecord,
  exportResult: ResearchExportResult | null,
): Promise<{ delivered: boolean; finalText?: string; error?: string }> {
  if (!shouldReplyInHermesSession(run)) {
    return { delivered: false };
  }

  const session = resolveHermesSession(run);
  if (!session) return { delivered: false, error: "missing session" };

  const prompt = buildLast30DaysSessionDeliveryPrompt(run, exportResult);
  const messages: HermesChatMessage[] = [
    ...buildTurnSystemMessages(projectRoot),
    {
      role: "system",
      content:
        "The user previously asked for last30days research. The job finished asynchronously. " +
        "Summarize findings in plain language. Mention the saved report path (joshu://…) and offer " +
        "to open it on the desktop, email a summary, or dig deeper — do not start another run unless asked.",
    },
    { role: "user", content: prompt },
  ];

  const runner = buildHermesRunner(projectRoot);
  const maxAttempts = 4;
  let lastError = "unknown";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // Do not replace a healthy gateway — that kills in-flight cron sessions.
      const healthy = await runner.probeGatewayHealth();
      if (!healthy) {
        await runner.ensureGatewayReady().catch(() => undefined);
      }

      const { finalText } = await runner.streamHermesChat(
        {
          sessionId: session.sessionId,
          sessionKey: session.sessionKey,
          messages,
        },
        {},
      );
      console.log(
        `[last30days] Hermes session delivery ok run=${run.id.slice(0, 8)} session=${session.sessionId.slice(0, 24)}`,
      );
      const pushed = pushHermesChatSessionEvent(session.sessionId, {
        type: "transcript_updated",
        sessionId: session.sessionId,
        reason: "last30days_complete",
        runId: run.id,
      });
      if (pushed > 0) {
        console.log(`[last30days] pushed transcript_updated to ${pushed} jChat listener(s)`);
      }
      return { delivered: true, finalText };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (!isRetryableHermesDeliveryError(lastError) || attempt >= maxAttempts) {
        console.warn(`[last30days] Hermes session delivery failed for run ${run.id}: ${lastError}`);
        return { delivered: false, error: lastError };
      }
      const waitMs = 5_000 * attempt;
      console.warn(
        `[last30days] Hermes session delivery retry ${attempt}/${maxAttempts} for run ${run.id.slice(0, 8)} in ${waitMs}ms: ${lastError}`,
      );
      await sleep(waitMs);
    }
  }

  console.warn(`[last30days] Hermes session delivery failed for run ${run.id}: ${lastError}`);
  return { delivered: false, error: lastError };
}
