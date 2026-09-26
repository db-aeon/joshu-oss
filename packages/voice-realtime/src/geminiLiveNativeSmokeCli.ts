/**
 * Scripted native-path smoke test against the real Gemini Live API (text turns, real
 * phone prompt + tools). Checks the three voice rules without placing a call:
 *
 *   1. general knowledge → answered directly, no tool
 *   2. owner info        → think; no owner facts spoken before the (canned) result
 *   3. long work         → start_task
 *
 *   node dist/geminiLiveNativeSmokeCli.js [model]
 *
 * Tool results are canned — Hermes and the broker are not called.
 */
import "./loadEnv.js";

import { GEMINI_LIVE_PHONE_THINKING_LEVEL, GEMINI_LIVE_MODEL, PHONE_SYSTEM_PROMPT } from "./config.js";
import { buildVoiceSystemPrompt, resolveJoshuIdentity } from "./joshuIdentity.js";
import { GeminiLiveClient } from "./geminiLiveClient.js";
import { PHONE_TOOL_NAMES } from "./realtimeTools.js";

const SCENARIO_TIMEOUT_MS = 30_000;
/** How long the canned tool "runs" — long enough to hear what the model says meanwhile. */
const TOOL_DELAY_MS = 2_500;

type Scenario = {
  name: string;
  say: string;
  /** Tool the model should call (undefined = none). */
  expectTool?: "think" | "start_task";
  /** Canned tool result, and a fact from it that must not be spoken before it arrives. */
  result?: Record<string, unknown>;
  secretFact?: RegExp;
};

const SCENARIOS: Scenario[] = [
  { name: "general knowledge", say: "What's the capital of Australia?" },
  {
    name: "owner info",
    say: "What's on my calendar tomorrow?",
    expectTool: "think",
    result: {
      status: "done",
      source: "hermes",
      answer: "Tomorrow: dentist with Dr. Okafor at 3:15 PM, then dinner with Maya at 7.",
      instruction: "Relay this answer to the caller in plain, natural speech. Keep every time and name exactly as given.",
    },
    secretFact: /okafor|3:15|maya/i,
  },
  {
    name: "long work",
    say: "Find me nonstop flights from SFO to Austin next Tuesday under 400 dollars and compare the options.",
    expectTool: "start_task",
    result: {
      status: "queued",
      goal_id: "smoke",
      message: "That'll take a few minutes, so I'm working on it in the background. I'll call you back when it's done.",
      instruction: "Confirm to the owner in one or two natural sentences that this is queued, then carry on.",
    },
  },
];

type ScenarioReport = {
  name: string;
  tools: string[];
  beforeResult: string;
  afterResult: string;
  pass: boolean;
  notes: string[];
};

function runScenario(model: string, systemPrompt: string, scenario: Scenario): Promise<ScenarioReport> {
  return new Promise((resolve) => {
    const tools: string[] = [];
    let beforeResult = "";
    let afterResult = "";
    let resultSent = false;
    let done = false;

    const finish = (): void => {
      if (done) return;
      done = true;
      client.close();
      const notes: string[] = [];
      const calledExpected = scenario.expectTool ? tools.includes(scenario.expectTool) : tools.length === 0;
      if (!calledExpected) {
        notes.push(scenario.expectTool ? `expected ${scenario.expectTool}` : "expected no tool call");
      }
      const leaked = scenario.secretFact?.test(beforeResult) ?? false;
      if (leaked) notes.push("owner fact spoken before the result (hallucination)");
      const relayed = !scenario.secretFact || scenario.secretFact.test(afterResult);
      if (!relayed) notes.push("result not relayed");
      resolve({
        name: scenario.name,
        tools,
        beforeResult: beforeResult.trim(),
        afterResult: afterResult.trim(),
        pass: calledExpected && !leaked && relayed,
        notes,
      });
    };

    const client = new GeminiLiveClient(
      {
        audioFormat: "pcmu",
        model,
        systemPrompt,
        toolNames: PHONE_TOOL_NAMES,
        thinkingLevel: GEMINI_LIVE_PHONE_THINKING_LEVEL,
      },
      {
        sessionId: `smoke:${scenario.name}`,
        onReady: () => client.sendUserText(scenario.say),
        onAssistantTranscript: (delta) => {
          if (resultSent) afterResult += delta;
          else beforeResult += delta;
        },
        onFunctionCall: ({ name, callId }) => {
          tools.push(name);
          const result = scenario.result ?? { status: "done", answer: "OK." };
          setTimeout(() => {
            resultSent = true;
            client.sendFunctionResult(callId, result);
          }, TOOL_DELAY_MS);
        },
        onResponseDone: () => {
          // No tool expected and none called: the direct answer is complete.
          if (!scenario.expectTool && tools.length === 0 && beforeResult.trim()) finish();
          // Result spoken.
          if (resultSent && afterResult.trim()) setTimeout(finish, 500);
        },
        onInteractionIdle: () => {
          if (resultSent || (!scenario.expectTool && beforeResult.trim())) finish();
        },
        onError: (message) => {
          console.error(`[gemini-smoke] ${scenario.name}: ${message}`);
          finish();
        },
      },
    );
    setTimeout(finish, SCENARIO_TIMEOUT_MS).unref();
    client.connect();
  });
}

async function main(): Promise<void> {
  const model = process.argv.slice(2).find((arg) => !arg.startsWith("--")) ?? GEMINI_LIVE_MODEL;
  const probe = new GeminiLiveClient({ model }, {});
  // Env prompt tracks GEMINI_LIVE_MODEL; build the native prompt for the model under test.
  const systemPrompt = probe.nativeAsyncTools
    ? buildVoiceSystemPrompt(resolveJoshuIdentity(), "phone", { nativeAsyncTools: true })
    : PHONE_SYSTEM_PROMPT;
  console.info(`[gemini-smoke] model=${model} nativeAsyncTools=${probe.nativeAsyncTools}`);

  let failures = 0;
  for (const scenario of SCENARIOS) {
    const report = await runScenario(model, systemPrompt, scenario);
    if (!report.pass) failures += 1;
    console.info(
      `[gemini-smoke] ${report.pass ? "PASS" : "FAIL"} ${report.name}`,
      JSON.stringify(
        {
          tools: report.tools,
          said: report.beforeResult.slice(0, 240),
          afterResult: report.afterResult.slice(0, 240),
          notes: report.notes,
        },
        null,
        2,
      ),
    );
  }
  process.exit(failures ? 1 : 0);
}

void main();
