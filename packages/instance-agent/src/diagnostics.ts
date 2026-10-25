/**
 * Diagnostics command (change release-deploy-automation, spec box-diagnostics).
 * The control plane queues a `diagnostics` command with a list of named queries. The agent
 * answers each query from a fixed allowlist of read-only reads and acks the command with the
 * answers as the command result. The agent never runs a command, path, or URL from the payload.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import { DIAGNOSTICS_PROBE } from "./diagnosticsProbe.js";

const execFileAsync = promisify(execFile);

export const DIAGNOSTIC_QUERIES = [
  "version",
  "health",
  "containers",
  "logs",
  "cron_jobs",
  "kanban",
  "realtime_goals",
  "hermes_config",
  "env_keys",
  "skills",
  "joshu_api",
] as const;
export type DiagnosticQueryName = (typeof DIAGNOSTIC_QUERIES)[number];

/** Docker services of deploy/docker-compose.yml, and Hermes log files in the stack container. */
const CONTAINER_LOG_SOURCES = ["joshu-stack", "voice-realtime", "instance-agent", "caddy"] as const;
const HERMES_LOG_SOURCES = ["hermes-agent", "hermes-errors", "gateway-starts"] as const;

/** GET paths of the Joshu API that the joshu_api query may read. Each path is read-only. */
export const JOSHU_API_PATHS = [
  "/joshu/api/instance/version",
  "/joshu/api/instance/health",
  "/joshu/api/instance/release-manifest",
  "/joshu/api/cron/status",
  "/joshu/api/cron/jobs",
  "/joshu/api/onboarding/setup-status",
  "/joshu/api/owner-reminders",
  "/joshu/api/ea/owner-reply/tasks",
  "/joshu/api/ea/mail/tracks",
  "/joshu/api/hermes-dashboard/status",
];

/** Keys of /etc/joshu/instance.env whose values the env_keys query may show. Other keys: names only. */
const PUBLIC_INSTANCE_ENV_KEYS = new Set([
  "JOSHU_RELEASE_VERSION",
  "JOSHU_RELEASE_CHANNEL",
  "JOSHU_IMAGE_REF",
  "JOSHU_VOICE_IMAGE_REF",
  "JOSHU_INSTANCE_AGENT_IMAGE_REF",
  "HERMES_AGENT_REF",
  "JOSHU_CLOUD_BROWSER",
  "JOSHU_VOICE_REALTIME_S2S",
]);

const MAX_QUERIES = 10;
const MAX_RESULT_CHARS = 64_000;
const MAX_TOTAL_CHARS = 256_000;

export interface DiagnosticQuery {
  query: DiagnosticQueryName;
  args: Record<string, string | number>;
}

export interface DiagnosticAnswer {
  query: DiagnosticQueryName;
  args: Record<string, string | number>;
  ok: boolean;
  data?: unknown;
  error?: string;
  truncated?: boolean;
}

function fail(message: string): never {
  throw new Error(`diagnostics: ${message}`);
}

function intArg(value: unknown, name: string, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) fail(`${name} must be an integer from 1 to ${max}`);
  return n;
}

function stringArg(value: unknown, name: string, pattern: RegExp): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string" || !pattern.test(value)) fail(`${name} has a value that is not allowed`);
  return value;
}

/**
 * Validate the payload of a diagnostics command. Unknown queries and unknown arguments are errors,
 * so a payload cannot ask for anything outside the allowlist.
 */
export function parseDiagnosticsPayload(payload: Record<string, unknown>): DiagnosticQuery[] {
  const raw = payload.queries;
  if (!Array.isArray(raw) || raw.length === 0) fail("payload.queries must be a non-empty array");
  if (raw.length > MAX_QUERIES) fail(`at most ${MAX_QUERIES} queries in one command`);
  return raw.map((item): DiagnosticQuery => {
    const entry = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    const query = entry.query as DiagnosticQueryName;
    if (!DIAGNOSTIC_QUERIES.includes(query)) fail(`unknown query ${String(entry.query)}`);
    const input = (entry.args && typeof entry.args === "object" ? entry.args : {}) as Record<string, unknown>;
    const allowed: Record<DiagnosticQueryName, string[]> = {
      version: [],
      health: [],
      containers: [],
      logs: ["source", "since", "tail", "grep"],
      cron_jobs: [],
      kanban: ["board", "limit"],
      realtime_goals: [],
      hermes_config: [],
      env_keys: [],
      skills: [],
      joshu_api: ["path"],
    };
    for (const key of Object.keys(input)) {
      if (!allowed[query].includes(key)) fail(`query ${query} has no argument ${key}`);
    }
    const args: Record<string, string | number> = {};
    if (query === "logs") {
      const source = String(input.source ?? "");
      if (![...CONTAINER_LOG_SOURCES, ...HERMES_LOG_SOURCES].includes(source as never)) {
        fail(`logs source must be one of ${[...CONTAINER_LOG_SOURCES, ...HERMES_LOG_SOURCES].join(", ")}`);
      }
      args.source = source;
      const since = stringArg(input.since, "since", /^([1-9]\d{0,3})(m|h)$/);
      if (since) {
        const hours = since.endsWith("h") ? Number(since.slice(0, -1)) : Number(since.slice(0, -1)) / 60;
        if (hours > 72) fail("since must be 72h or less");
        args.since = since;
      }
      args.tail = intArg(input.tail, "tail", 300, 2000);
      if (input.since !== undefined && (HERMES_LOG_SOURCES as readonly string[]).includes(source)) {
        fail(`since is not supported for ${source}; use tail`);
      }
      // Plain text, not a regular expression: the text can come from a pull request, and a
      // regular expression could block the agent.
      const grep = stringArg(input.grep, "grep", /^[^\n]{1,200}$/);
      if (grep) {
        args.grep = grep;
        if (!args.since && !(HERMES_LOG_SOURCES as readonly string[]).includes(source)) args.since = "24h";
      }
    } else if (query === "kanban") {
      const board = stringArg(input.board, "board", /^[a-z0-9][a-z0-9_-]{0,63}$|^\(default\)$/);
      if (board) args.board = board;
      args.limit = intArg(input.limit, "limit", 50, 200);
    } else if (query === "joshu_api") {
      const target = String(input.path ?? "");
      const [path, search = ""] = target.split("?", 2);
      if (!JOSHU_API_PATHS.includes(path)) fail(`joshu_api path must be one of ${JOSHU_API_PATHS.join(", ")}`);
      if (!/^[A-Za-z0-9=&_.,:-]{0,200}$/.test(search)) fail("joshu_api query string has characters that are not allowed");
      args.path = search ? `${path}?${search}` : path;
    }
    return { query, args };
  });
}

export interface DiagnosticsDeps {
  composeProject: string;
  joshuBaseUrl: string;
  instanceEnvFile: string;
  hostBundleFile: string;
  docker: (args: string[]) => Promise<string>;
  fetchText: (url: string) => Promise<{ status: number; text: string }>;
  readText: (path: string) => Promise<string>;
}

export function defaultDiagnosticsDeps(input: {
  joshuBaseUrl: string;
  instanceEnvFile: string;
  installDir: string;
}): DiagnosticsDeps {
  return {
    composeProject: process.env.JOSHU_COMPOSE_PROJECT?.trim() || "deploy",
    joshuBaseUrl: input.joshuBaseUrl,
    instanceEnvFile: input.instanceEnvFile,
    hostBundleFile: `${input.installDir}/deploy/.host-bundle.json`,
    docker: async (args) => {
      const { stdout, stderr } = await execFileAsync("docker", args, {
        timeout: 60_000,
        maxBuffer: 32 * 1024 * 1024,
      });
      // docker logs writes the container's stderr to stderr; keep both.
      return args[0] === "logs" ? `${stdout}${stderr}` : stdout;
    },
    fetchText: async (url) => {
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      return { status: res.status, text: await res.text() };
    },
    readText: (path) => readFile(path, "utf8"),
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Keep the lines that contain grep (case-insensitive plain text), then the last tail lines. */
function filterLines(lines: string[], grep: string | number | undefined, tail: number): string[] {
  const needle = typeof grep === "string" ? grep.toLowerCase() : null;
  return (needle ? lines.filter((line) => line.toLowerCase().includes(needle)) : lines).slice(-tail);
}

async function probe(deps: DiagnosticsDeps, query: string, args: string[] = []): Promise<unknown> {
  const stack = `${deps.composeProject}-joshu-stack-1`;
  const out = await deps.docker(["exec", stack, "python3", "-c", DIAGNOSTICS_PROBE, query, ...args]);
  return parseJson(out.trim());
}

function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (match) out[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

async function answerQuery(deps: DiagnosticsDeps, q: DiagnosticQuery): Promise<unknown> {
  switch (q.query) {
    case "version": {
      // The pins and the host bundle answer also when the Joshu API is down.
      const joshu = await deps
        .fetchText(`${deps.joshuBaseUrl}/joshu/api/instance/version`)
        .then((res) => parseJson(res.text))
        .catch((err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }));
      const hostBundle = await deps.readText(deps.hostBundleFile).then(parseJson, () => null);
      const env = await deps.readText(deps.instanceEnvFile).then(parseEnvFile, () => ({}) as Record<string, string>);
      const pins = Object.fromEntries(Object.entries(env).filter(([key]) => PUBLIC_INSTANCE_ENV_KEYS.has(key)));
      return { joshu, hostBundle, instanceEnvPins: pins };
    }
    case "health": {
      const res = await deps.fetchText(`${deps.joshuBaseUrl}/joshu/api/instance/health`);
      return { status: res.status, body: parseJson(res.text) };
    }
    case "containers": {
      const prefix = `${deps.composeProject}-`;
      const names = (await deps.docker(["ps", "-a", "--format", "{{.Names}}"]))
        .split("\n")
        .map((name) => name.trim())
        .filter((name) => name.startsWith(prefix));
      if (names.length === 0) return { containers: [] };
      const format =
        '{"name":{{json .Name}},"image":{{json .Config.Image}},"state":{{json .State.Status}},' +
        '"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}null{{end}},' +
        '"startedAt":{{json .State.StartedAt}},"restartCount":{{.RestartCount}}}';
      const rows = (await deps.docker(["inspect", "--format", format, ...names]))
        .split("\n")
        .filter((line) => line.trim())
        .map(parseJson);
      return { containers: rows };
    }
    case "logs": {
      const source = String(q.args.source);
      const tail = Number(q.args.tail);
      if ((HERMES_LOG_SOURCES as readonly string[]).includes(source)) {
        // Read more lines than tail when grep filters, so a match in older lines is found.
        const read = q.args.grep ? 20_000 : tail;
        const data = (await probe(deps, "log_file", [source, String(read)])) as { lines?: string[] };
        return { source, lines: filterLines(data.lines ?? [], q.args.grep, tail) };
      }
      const container = `${deps.composeProject}-${source}-1`;
      const args = ["logs", "--timestamps"];
      if (q.args.since) args.push("--since", String(q.args.since));
      if (!q.args.grep) args.push("--tail", String(tail));
      args.push(container);
      const lines = (await deps.docker(args)).split("\n").filter((line) => line.length > 0);
      return { source, lines: filterLines(lines, q.args.grep, tail) };
    }
    case "cron_jobs":
    case "realtime_goals":
    case "hermes_config":
    case "skills":
      return probe(deps, q.query);
    case "kanban":
      return probe(deps, "kanban", [String(q.args.board ?? ""), String(q.args.limit)]);
    case "env_keys": {
      const env = await deps.readText(deps.instanceEnvFile).then(parseEnvFile, () => ({}) as Record<string, string>);
      const instanceEnv = Object.fromEntries(
        Object.keys(env)
          .sort()
          .map((key) => [key, PUBLIC_INSTANCE_ENV_KEYS.has(key) ? env[key] : "[set]"]),
      );
      const hermes = await probe(deps, "env_keys");
      return { instanceEnv, ...(hermes as Record<string, unknown>) };
    }
    case "joshu_api": {
      const res = await deps.fetchText(`${deps.joshuBaseUrl}${q.args.path}`);
      return { status: res.status, body: parseJson(res.text) };
    }
  }
}

/** Cut a long answer so one command result stays small. Log lines lose the oldest lines first. */
function limitAnswer(answer: DiagnosticAnswer, budget: number): DiagnosticAnswer {
  const max = Math.min(MAX_RESULT_CHARS, budget);
  if (JSON.stringify(answer).length <= max) return answer;
  if (max < 1000) return { query: answer.query, args: answer.args, ok: false, error: "no space left in the result", truncated: true };
  const data = answer.data as { lines?: string[] } | undefined;
  if (data && Array.isArray(data.lines)) {
    const lines = [...data.lines];
    while (lines.length > 0 && JSON.stringify({ ...answer, data: { ...data, lines } }).length > max) {
      lines.splice(0, Math.max(1, Math.floor(lines.length / 10)));
    }
    return { ...answer, data: { ...data, lines }, truncated: true };
  }
  return { ...answer, data: JSON.stringify(answer.data).slice(0, Math.max(0, max - 500)), truncated: true };
}

export async function runDiagnostics(
  payload: Record<string, unknown>,
  deps: DiagnosticsDeps,
): Promise<{ answers: DiagnosticAnswer[]; answeredAt: string }> {
  const queries = parseDiagnosticsPayload(payload);
  const answers: DiagnosticAnswer[] = [];
  let used = 0;
  for (const q of queries) {
    let answer: DiagnosticAnswer;
    try {
      answer = { query: q.query, args: q.args, ok: true, data: await answerQuery(deps, q) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      answer = { query: q.query, args: q.args, ok: false, error: message.slice(0, 2000) };
    }
    answer = limitAnswer(answer, MAX_TOTAL_CHARS - used);
    used += JSON.stringify(answer).length;
    answers.push(answer);
  }
  return { answers, answeredAt: new Date().toISOString() };
}
