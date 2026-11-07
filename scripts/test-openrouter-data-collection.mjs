#!/usr/bin/env node
/**
 * No-training routing guard (spec model-provider-privacy, change openrouter-data-collection-deny).
 *
 * 1. Static scan: each source file that sends a request to OpenRouter (contains
 *    "openrouter.ai/api") must use withOpenRouterDataPolicy or set data_collection.
 * 2. withOpenRouterDataPolicy and syncJoshuOpenRouterDataPolicy add the excluded upstream providers
 *    to the ignore list and keep other provider preferences.
 * 3. The Python patches for Hermes and Hindsight apply to fixtures with
 *    the anchors of the pinned upstream files, are idempotent, and give the expected request body.
 * 4. scripts/start-hindsight.sh sets HINDSIGHT_API_LLM_EXTRA_BODY only for OpenRouter.
 *
 * Usage: npm run test:openrouter-data-collection
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "joshu-openrouter-dc-"));
const SELF = "scripts/test-openrouter-data-collection.mjs";

// --- 1. Static scan --------------------------------------------------------------------------

const SCAN_ROOTS = ["src", "scripts", "packages", ".hermes", "apps", "integrations/hermes", "deploy"];
const SOURCE_EXT = /\.(ts|tsx|mts|mjs|js|cjs|py|sh)$/;
const OPENROUTER_REQUEST = /openrouter\.ai\/api/;
const DATA_POLICY = /withOpenRouterDataPolicy|data_collection/;

export function filesMissingDataPolicy(files, read) {
  return files.filter((file) => {
    const text = read(file);
    return OPENROUTER_REQUEST.test(text) && !DATA_POLICY.test(text);
  });
}

const tracked = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "--", ...SCAN_ROOTS],
  { cwd: root, encoding: "utf8" },
)
  .split("\n")
  .filter((file) => file && SOURCE_EXT.test(file) && file !== SELF && !file.includes("node_modules/"))
  .filter((file) => fs.existsSync(path.join(root, file)));
const missing = filesMissingDataPolicy(tracked, (file) => fs.readFileSync(path.join(root, file), "utf8"));
assert.deepEqual(
  missing,
  [],
  `files call OpenRouter without no-training routing (use withOpenRouterDataPolicy from src/joshuOpenRouterDefaults.ts): ${missing.join(", ")}`,
);
assert.ok(
  tracked.includes("src/day0/llm.ts") && tracked.includes("scripts/merge-hermes-factory-skill.mjs"),
  "static scan sees the known OpenRouter callers",
);
const fixtureCaller = 'await fetch("https://openrouter.ai/api/v1/chat/completions", { body: JSON.stringify({ model }) });';
assert.deepEqual(
  filesMissingDataPolicy(["new-caller.ts"], () => fixtureCaller),
  ["new-caller.ts"],
  "static scan flags a new caller without no-training routing",
);

// --- 2. TypeScript helpers --------------------------------------------------------------------

const {
  JOSHU_OPENROUTER_DATA_COLLECTION,
  JOSHU_OPENROUTER_IGNORED_PROVIDERS,
  withOpenRouterDataPolicy,
  syncJoshuOpenRouterDataPolicy,
} = await import(path.join(root, "src/joshuOpenRouterDefaults.ts"));

assert.equal(JOSHU_OPENROUTER_DATA_COLLECTION, "deny");
assert.deepEqual(JOSHU_OPENROUTER_IGNORED_PROVIDERS, ["relace"], "Relace is an excluded upstream provider (#206)");
assert.deepEqual(withOpenRouterDataPolicy({ model: "m" }), {
  model: "m",
  provider: { data_collection: "deny", ignore: ["relace"] },
});
assert.deepEqual(
  withOpenRouterDataPolicy({ model: "m", provider: { order: ["together"], data_collection: "allow" } }).provider,
  { order: ["together"], data_collection: "deny", ignore: ["relace"] },
  "body helper keeps order and replaces allow",
);
assert.deepEqual(
  withOpenRouterDataPolicy({ model: "m", provider: { ignore: ["novita", "Relace"] } }).provider.ignore,
  ["novita", "Relace"],
  "body helper keeps the ignore list and does not add a slug twice",
);
assert.equal("zdr" in withOpenRouterDataPolicy({ model: "m" }).provider, false, "no zero data retention");

const emptyConfig = {};
assert.equal(syncJoshuOpenRouterDataPolicy(emptyConfig), true, "first sync changes the config");
assert.deepEqual(emptyConfig.provider_routing, { data_collection: "deny", ignore: ["relace"] });
assert.equal(syncJoshuOpenRouterDataPolicy(emptyConfig), false, "second sync changes nothing");
const orderConfig = { provider_routing: { order: ["together"], data_collection: "allow" } };
assert.equal(syncJoshuOpenRouterDataPolicy(orderConfig), true);
assert.deepEqual(orderConfig.provider_routing, { order: ["together"], data_collection: "deny", ignore: ["relace"] });
// A box on the release before this change has data_collection but no ignore list.
const oldBoxConfig = { provider_routing: { data_collection: "deny" } };
assert.equal(syncJoshuOpenRouterDataPolicy(oldBoxConfig), true, "sync adds the ignore list on an old box");
assert.deepEqual(oldBoxConfig.provider_routing, { data_collection: "deny", ignore: ["relace"] });
const ownerIgnoreConfig = { provider_routing: { data_collection: "deny", ignore: ["novita"] } };
assert.equal(syncJoshuOpenRouterDataPolicy(ownerIgnoreConfig), true);
assert.deepEqual(ownerIgnoreConfig.provider_routing.ignore, ["novita", "relace"], "owner ignore list stays");
assert.equal(syncJoshuOpenRouterDataPolicy(ownerIgnoreConfig), false, "second sync changes nothing");

// --- 3. Python patches ------------------------------------------------------------------------

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function pyCompile(...files) {
  run("python3", ["-m", "py_compile", ...files]);
}

// Hermes: anchors from Hermes v0.20.0 (HERMES_AGENT_REF in deploy/Dockerfile).
const hermesDir = path.join(tmp, "hermes");
const profileFile = path.join(hermesDir, "plugins/model-providers/openrouter/__init__.py");
const transportFile = path.join(hermesDir, "agent/transports/chat_completions.py");
const auxiliaryFile = path.join(hermesDir, "agent/auxiliary_client.py");
write(path.join(hermesDir, "agent/__init__.py"), "");
write(
  path.join(hermesDir, "hermes_cli/__init__.py"),
  "",
);
write(
  path.join(hermesDir, "hermes_cli/config.py"),
  `import json, os
def read_raw_config_readonly():
    mode = os.environ.get("FIXTURE_CONFIG", "deny")
    if mode == "raise":
        raise RuntimeError("config unreadable")
    if mode == "none":
        return {}
    return {"provider_routing": {"data_collection": mode, "ignore": ["relace"]}}
`,
);
write(
  profileFile,
  `class OpenRouterProfile:
    def build_extra_body(self, *, session_id=None, **context):
        body = {}
        prefs = context.get("provider_preferences")
        if prefs:
            body["provider"] = prefs
        return body
`,
);
write(
  transportFile,
  `def build(params):
        extra_body = {}
        is_openrouter = params.get("is_openrouter", False)
        provider_prefs = params.get("provider_preferences")
        if provider_prefs and is_openrouter:
            extra_body["provider"] = provider_prefs
        return extra_body
`,
);
write(
  auxiliaryFile,
  `def build(profile, model, effective_base, reasoning_config, extra_body):
        if True:
            profile_body = profile.build_extra_body(
                model=model,
                base_url=effective_base,
                reasoning_config=reasoning_config,
            ) or {}
        merged = dict(extra_body or {})
        merged.update(profile_body)
        return merged
`,
);
const hermesPatch = path.join(root, "scripts/patch-hermes-openrouter-data-collection.py");
run("python3", [hermesPatch], { env: { ...process.env, HERMES_DIR: hermesDir } });
const afterFirst = [profileFile, transportFile, auxiliaryFile].map((f) => fs.readFileSync(f, "utf8"));
const second = run("python3", [hermesPatch], { env: { ...process.env, HERMES_DIR: hermesDir } });
assert.match(second, /already patched/, "Hermes patch is idempotent");
assert.deepEqual(
  [profileFile, transportFile, auxiliaryFile].map((f) => fs.readFileSync(f, "utf8")),
  afterFirst,
  "second Hermes patch run changes nothing",
);
pyCompile(profileFile, transportFile, auxiliaryFile, path.join(hermesDir, "agent/joshu_openrouter_privacy.py"));

function hermesProbe(mode) {
  const code = `
import importlib.util, json
spec = importlib.util.spec_from_file_location("orp", ${JSON.stringify(profileFile)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
spec2 = importlib.util.spec_from_file_location("cc", ${JSON.stringify(transportFile)})
t = importlib.util.module_from_spec(spec2); spec2.loader.exec_module(t)
spec3 = importlib.util.spec_from_file_location("aux", ${JSON.stringify(auxiliaryFile)})
a = importlib.util.module_from_spec(spec3); spec3.loader.exec_module(a)
p = m.OpenRouterProfile()
print(json.dumps({
  "aux_task": p.build_extra_body().get("provider"),
  "main_prefs": p.build_extra_body(provider_preferences={"only": ["together"]}).get("provider"),
  "explicit": p.build_extra_body(provider_preferences={"data_collection": "allow"}).get("provider"),
  "ignore_merge": p.build_extra_body(provider_preferences={"ignore": ["novita", "Relace"]}).get("provider").get("ignore"),
  "transport": t.build({"is_openrouter": True}).get("provider"),
  "transport_other": t.build({"is_openrouter": False}).get("provider"),
  "aux_extra_body": a.build(p, "m", "", None, {"provider": {"order": ["google"]}}).get("provider"),
}))
`;
  return JSON.parse(run("python3", ["-c", code], { cwd: hermesDir, env: { ...process.env, FIXTURE_CONFIG: mode, PYTHONPATH: hermesDir } }));
}
const deny = hermesProbe("deny");
const DENY = { data_collection: "deny", ignore: ["relace"] };
assert.deepEqual(deny.aux_task, DENY, "auxiliary task gets deny and the ignore list from config");
assert.deepEqual(deny.main_prefs, { only: ["together"], ...DENY }, "main prefs keep only");
assert.deepEqual(
  deny.explicit,
  { data_collection: "allow", ignore: ["relace"] },
  "a data_collection value in the request prefs wins; the ignore list is still added",
);
assert.deepEqual(deny.ignore_merge, ["novita", "Relace"], "request ignore list stays, no slug twice");
assert.deepEqual(deny.transport, DENY, "transport fallback path gets deny");
assert.equal(deny.transport_other, null, "non-OpenRouter transport gets no provider field");
assert.deepEqual(deny.aux_extra_body, { order: ["google"], ...DENY }, "aux extra_body order stays");
assert.deepEqual(hermesProbe("raise").aux_task, DENY, "unreadable config fails closed");
assert.equal(hermesProbe("none").aux_task, null, "no config value adds nothing");

// The fallback list of the Hermes patch is the same as the list of src/joshuOpenRouterDefaults.ts.
const moduleText = fs.readFileSync(path.join(hermesDir, "agent/joshu_openrouter_privacy.py"), "utf8");
assert.match(
  moduleText,
  new RegExp(`DEFAULT_IGNORED_PROVIDERS: List\\[str\\] = \\[${JOSHU_OPENROUTER_IGNORED_PROVIDERS.map((s) => `'${s}'`).join(", ")}\\]`),
  "Hermes patch fallback list matches JOSHU_OPENROUTER_IGNORED_PROVIDERS",
);

const hermesMissing = path.join(tmp, "hermes-missing");
write(path.join(hermesMissing, "plugins/model-providers/openrouter/__init__.py"), "class X:\n    pass\n");
write(path.join(hermesMissing, "agent/transports/chat_completions.py"), "\n");
write(path.join(hermesMissing, "agent/auxiliary_client.py"), "\n");
const missingRun = spawnSync("python3", [hermesPatch], {
  encoding: "utf8",
  env: { ...process.env, HERMES_DIR: hermesMissing },
});
assert.notEqual(missingRun.status, 0, "Hermes patch fails when an anchor is missing");

// Hindsight rerank: anchor from hindsight-api-slim 0.7.2 engine/cross_encoder.py.
const crossEncoder = path.join(tmp, "hindsight/cross_encoder.py");
write(
  crossEncoder,
  `class _CohereCompatibleRerankClient:
    def __init__(self, rerank_url, client):
        self.rerank_url = rerank_url
        self.include_top_n = True
        self._async_client = client

    async def predict(self, texts):
        for _ in [0]:
            body = {"model": "cohere/rerank-v3.5", "documents": texts}
            if self.include_top_n:
                body["top_n"] = len(texts)

            response = await self._async_client.post(self.rerank_url, json=body)
        return response
`,
);
const rerankPatch = path.join(root, "scripts/patch-hindsight-openrouter-rerank.py");
run("python3", [rerankPatch, crossEncoder]);
assert.match(run("python3", [rerankPatch, crossEncoder]), /already patched/, "rerank patch is idempotent");
pyCompile(crossEncoder);
const rerankBodies = JSON.parse(
  run("python3", [
    "-c",
    `
import asyncio, importlib.util, json
spec = importlib.util.spec_from_file_location("ce", ${JSON.stringify(crossEncoder)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
class C:
    async def post(self, url, json):
        return json
out = {}
for url in ("https://openrouter.ai/api/v1/rerank", "https://api.cohere.example/v2/rerank"):
    out[url] = asyncio.run(m._CohereCompatibleRerankClient(url, C()).predict(["a"])).get("provider")
print(json.dumps(out))
`,
  ]),
);
assert.deepEqual(rerankBodies["https://openrouter.ai/api/v1/rerank"], { data_collection: "deny" });
assert.equal(rerankBodies["https://api.cohere.example/v2/rerank"], null, "other rerank hosts get no provider field");


// --- 4. start-hindsight.sh --------------------------------------------------------------------

const startHindsight = fs.readFileSync(path.join(root, "scripts/start-hindsight.sh"), "utf8");
const block = startHindsight.match(/^# No-training routing[\s\S]*?^fi$/m)?.[0];
assert.ok(block, "start-hindsight.sh has the no-training routing block");
function hindsightExtraBody(provider, extraBody) {
  return run("bash", ["-c", `set -euo pipefail\n${block}\necho "\${HINDSIGHT_API_LLM_EXTRA_BODY:-<unset>}"`], {
    env: { PATH: process.env.PATH, HINDSIGHT_API_LLM_PROVIDER: provider, HINDSIGHT_API_LLM_EXTRA_BODY: extraBody },
  }).trim();
}
assert.deepEqual(JSON.parse(hindsightExtraBody("openrouter", "")), { provider: { data_collection: "deny" } });
assert.deepEqual(JSON.parse(hindsightExtraBody("openrouter", '{"provider":{"order":["x"]},"temperature":0}')), {
  provider: { order: ["x"], data_collection: "deny" },
  temperature: 0,
});
assert.equal(hindsightExtraBody("openai", ""), "<unset>", "OpenAI Hindsight gets no provider field");

fs.rmSync(tmp, { recursive: true, force: true });
console.log("OK: openrouter no-training routing");
