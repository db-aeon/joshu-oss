import { spawnHermesPython } from "./hermesVoiceRuntime.js";

export type CronBridgeAction =
  | "status"
  | "list"
  | "get"
  | "create"
  | "update"
  | "pause"
  | "resume"
  | "run"
  | "remove";

export type CronBridgePayload = Record<string, unknown> & { action: CronBridgeAction };

export type CronBridgeResult = {
  success?: boolean;
  error?: string;
  jobs?: CronBridgeJobSummary[];
  job_id?: string;
  [key: string]: unknown;
};

export type CronBridgeJobSummary = {
  job_id?: string;
  name?: string;
  schedule?: string;
  prompt?: string;
  skills?: string[];
  script?: string;
  no_agent?: boolean;
  workdir?: string;
  enabled?: boolean;
  state?: string;
};

export async function callCronBridge(payload: CronBridgePayload): Promise<CronBridgeResult> {
  const { stdout, stderr, code } = await spawnHermesPython(
    "hermes-cron-bridge.py",
    [],
    JSON.stringify(payload),
  );
  const text = stdout.trim();
  if (!text) {
    throw new Error(stderr.trim() || `cron bridge exited with code ${code ?? "?"}`);
  }
  let parsed: CronBridgeResult;
  try {
    parsed = JSON.parse(text) as CronBridgeResult;
  } catch {
    throw new Error(stderr.trim() || text.slice(0, 500));
  }
  return parsed;
}
