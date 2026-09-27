/**
 * Preflight a Gemini Live model with the exact phone setup voice-realtime sends
 * (tools, NON_BLOCKING behavior, thinking config, session resumption, compression).
 * Exits 0 only when the server answers `setupComplete` — run before switching a box's
 * GEMINI_LIVE_MODEL so a rejected model id or setup field never takes the phone down.
 *
 *   node dist/geminiLivePreflightCli.js [model] [--thinking=low|medium|high]
 */
import "./loadEnv.js";

import { GEMINI_LIVE_PHONE_THINKING_LEVEL, parseGeminiThinkingLevel } from "./config.js";
import { GeminiLiveClient } from "./geminiLiveClient.js";
import { PHONE_TOOL_NAMES } from "./realtimeTools.js";

const TIMEOUT_MS = 15_000;

const model = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
const thinkingArg = process.argv.find((arg) => arg.startsWith("--thinking="))?.split("=")[1];
const thinkingLevel = parseGeminiThinkingLevel(thinkingArg ?? "") ?? GEMINI_LIVE_PHONE_THINKING_LEVEL;

let settled = false;
const finish = (code: number, message: string): void => {
  if (settled) return;
  settled = true;
  (code === 0 ? console.info : console.error)(`[gemini-preflight] ${message}`);
  client.close();
  process.exit(code);
};

const client = new GeminiLiveClient(
  { audioFormat: "pcmu", model, toolNames: PHONE_TOOL_NAMES, thinkingLevel },
  {
    sessionId: "preflight",
    onReady: () =>
      finish(
        0,
        `ok model=${model ?? "(GEMINI_LIVE_MODEL)"} nativeAsyncTools=${client.nativeAsyncTools} thinking=${thinkingLevel}`,
      ),
    onError: (message) => finish(1, `rejected: ${message}`),
  },
);

setTimeout(() => finish(1, `timeout after ${TIMEOUT_MS}ms waiting for setupComplete`), TIMEOUT_MS).unref();
client.connect();
