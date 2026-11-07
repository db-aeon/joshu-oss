/**
 * Unit tests of the metered provider config (change treg-metered-provider, tasks 1.3 and 2.2, and
 * change content-router, tasks 1.1 and 5.2). The same cases run for fal and router with the real
 * functions of src/meteredProviders/.
 * No network: the usage summary comes from a fake fetch.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "joshu-metered-"));
// No provision file and a temporary state dir, so each setting comes from process.env.
process.env.JOSHU_COMPOSE_ENV_FILE = path.join(stateDir, "no-instance.env");
process.env.JOSHU_STATE_DIR = stateDir;

const config = await import("../src/meteredProviders/config.ts");
const { MEDIA_PLUGIN, routerToolsetActive, syncMediaBackend, syncMeteredProviderMcpServers, toolsetsWithMeteredProviders } = await import(
  "../src/meteredProviders/hermesConfig.ts"
);
const {
  METERED_PROVIDER_DEFINITIONS,
  clearUsageSummaryCache,
  fetchUsageSummaryFromCp,
  getMeteredProviderDefinition,
  meteredProviderMcpEnabled,
  resolveMeteredProviderApiKey,
  setMeteredProviderUserEnabled,
  writeMeteredProviderConfig,
} = config;

const ENV_NAMES = METERED_PROVIDER_DEFINITIONS.flatMap((def) => [
  def.modeEnv,
  def.relayUrlEnv,
  def.usageSummaryUrlEnv,
  def.ossEnvKey,
  ...def.ossEnvKeyAliases,
]);

/** Clear each metered provider setting, the owner config, and the cached usage summary. */
function reset() {
  for (const name of ENV_NAMES) delete process.env[name];
  delete process.env.CONTROL_PLANE_URL;
  fs.rmSync(path.join(stateDir, "connectors-providers.env"), { force: true });
  clearUsageSummaryCache();
  process.env.JOSHU_INSTANCE_ID = "inst-1";
  process.env.INSTANCE_AGENT_TOKEN = "tok";
}

function useRelay(def) {
  process.env[def.modeEnv] = "relay";
  process.env[def.relayUrlEnv] = `https://cp.example/api/instances/providers/${def.id}/mcp`;
  process.env[def.usageSummaryUrlEnv] = "https://cp.example/api/instances/usage/summary";
}

async function loadBalance(balanceUsd) {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ balanceUsd, balanceUsdDisplay: balanceUsd.toFixed(2), providers: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  const summary = await fetchUsageSummaryFromCp({ ttlMs: 0, fetchImpl });
  assert.equal(summary?.balanceUsd, balanceUsd);
}

const cases = [];
for (const def of METERED_PROVIDER_DEFINITIONS) {
  cases.push(
    [`${def.id}: relay mode ignores a key in the instance env`, async () => {
      useRelay(def);
      process.env[def.ossEnvKey] = "cp-default-key-must-not-leak";
      assert.equal(resolveMeteredProviderApiKey(def, stateDir), "");
    }],
    [`${def.id}: toolset off before the first usage summary`, async () => {
      useRelay(def);
      assert.equal(meteredProviderMcpEnabled(def, stateDir), false);
    }],
    [`${def.id}: toolset off with a balance of $0`, async () => {
      useRelay(def);
      await loadBalance(0);
      assert.equal(meteredProviderMcpEnabled(def, stateDir), false);
    }],
    [`${def.id}: toolset on with a balance above $0`, async () => {
      useRelay(def);
      await loadBalance(4.2);
      assert.equal(meteredProviderMcpEnabled(def, stateDir), true);
    }],
    [`${def.id}: toolset off when the owner turns the provider off`, async () => {
      useRelay(def);
      await loadBalance(4.2);
      setMeteredProviderUserEnabled(def, false, stateDir);
      assert.equal(meteredProviderMcpEnabled(def, stateDir), false);
    }],
    [`${def.id}: direct mode on with a saved key`, async () => {
      process.env[def.modeEnv] = "direct";
      assert.equal(meteredProviderMcpEnabled(def, stateDir), false);
      writeMeteredProviderConfig({ [def.ossEnvKey]: "owner-key" }, stateDir);
      assert.equal(resolveMeteredProviderApiKey(def, stateDir), "owner-key");
      assert.equal(meteredProviderMcpEnabled(def, stateDir), true);
    }],
  );
}

const router = getMeteredProviderDefinition("router");
cases.push(
  ["router: the definition of design D1 of change content-router", async () => {
    assert.equal(getMeteredProviderDefinition("treg"), null, "provider treg is gone");
    assert.deepEqual(
      [router.modeEnv, router.relayUrlEnv, router.usageSummaryUrlEnv, router.ossEnvKey, router.ossMcpUrl, router.hermesServerName, router.hermesToolset, router.localMcpPort],
      ["JOSHU_ROUTER_MODE", "JOSHU_ROUTER_RELAY_URL", "JOSHU_ROUTER_USAGE_SUMMARY_URL", "JOSHU_ROUTER_API_KEY", "https://hello.joshu.me/api/router/mcp", "joshu_router", "mcp-joshu-router", 8798],
    );
  }],
  ["fleet box: the router and fal use the relay with no setting of their own", async () => {
    process.env.CONTROL_PLANE_URL = "https://cp.example/";
    for (const def of METERED_PROVIDER_DEFINITIONS) {
      assert.equal(config.resolveMeteredProviderMode(def), "relay", def.id);
      assert.equal(config.meteredProviderRelayConfigured(def), true, def.id);
      assert.equal(config.meteredProviderRelayUrl(def.id), `https://cp.example/api/instances/providers/${def.id}/mcp`);
    }
    process.env[router.modeEnv] = "off";
    assert.equal(config.resolveMeteredProviderMode(router), "off", "JOSHU_ROUTER_MODE still wins");
    delete process.env[router.modeEnv];
    delete process.env.INSTANCE_AGENT_TOKEN;
    assert.equal(config.resolveMeteredProviderMode(router), "direct", "no agent token: a self-hosted box");
  }],
  ["hermes: router relay mode writes the local relay URL and toolset mcp-joshu-router", async () => {
    useRelay(router);
    await loadBalance(4.2);
    const servers = {};
    const { changed, activeToolsets } = syncMeteredProviderMcpServers(servers, stateDir);
    assert.equal(changed, true);
    assert.deepEqual(servers.joshu_router, { url: "http://127.0.0.1:8798/mcp", connect_timeout: 120, enabled: true });
    assert.deepEqual(toolsetsWithMeteredProviders(["web"], activeToolsets), ["web", "mcp-joshu-router"]);
  }],
  ["hermes: router direct mode writes hello.joshu.me/api/router/mcp with the router API key", async () => {
    process.env[router.modeEnv] = "direct";
    writeMeteredProviderConfig({ JOSHU_ROUTER_API_KEY: "jr_owner" }, stateDir);
    const servers = {};
    const { activeToolsets } = syncMeteredProviderMcpServers(servers, stateDir);
    assert.deepEqual(servers.joshu_router, {
      url: "https://hello.joshu.me/api/router/mcp",
      headers: { Authorization: "Bearer jr_owner" },
      connect_timeout: 120,
      enabled: true,
    });
    assert.deepEqual([...activeToolsets], ["mcp-joshu-router"]);
  }],
  ["hermes: router off disables the server and removes the toolset; fal does not change", async () => {
    useRelay(getMeteredProviderDefinition("fal"));
    await loadBalance(4.2);
    process.env[router.modeEnv] = "off";
    const servers = { joshu_router: { url: "http://127.0.0.1:8798/mcp", enabled: true } };
    const { activeToolsets } = syncMeteredProviderMcpServers(servers, stateDir);
    assert.equal(servers.joshu_router.enabled, false);
    assert.equal(servers.fal_ai.enabled, true);
    assert.deepEqual(toolsetsWithMeteredProviders(["web", "mcp-joshu-router"], activeToolsets), ["web", "mcp-fal"]);
  }],
  ["hermes: the retired treg server and toolset mcp-treg are removed", async () => {
    useRelay(router);
    await loadBalance(4.2);
    const servers = { treg: { url: "http://127.0.0.1:8798/mcp", enabled: true } };
    const { changed, activeToolsets } = syncMeteredProviderMcpServers(servers, stateDir);
    assert.equal(changed, true);
    assert.equal("treg" in servers, false);
    assert.deepEqual(toolsetsWithMeteredProviders(["web", "mcp-treg"], activeToolsets), ["web", "mcp-joshu-router"]);
  }],
);

/** The Hermes media backend for the three states of the router toolset (change content-router, task 5.2). */
function mediaState(config) {
  return {
    plugin: (config.plugins?.enabled ?? []).includes(MEDIA_PLUGIN),
    image: config.image_gen?.provider ?? null,
    video: config.video_gen?.provider ?? null,
  };
}
cases.push(
  ["media: router relay with money turns the joshu media backend on", async () => {
    useRelay(router);
    await loadBalance(4.2);
    const { activeToolsets } = syncMeteredProviderMcpServers({}, stateDir);
    const config = { plugins: { enabled: ["joshu-research"] } };
    const toolsets = ["web"];
    const result = syncMediaBackend(config, toolsets, routerToolsetActive(activeToolsets));
    assert.deepEqual(result, { changed: true, pluginsChanged: true });
    assert.deepEqual(mediaState(config), { plugin: true, image: "joshu", video: "joshu" });
    assert.deepEqual(toolsets, ["web", "image_gen", "video_gen"]);
    assert.deepEqual(syncMediaBackend(config, toolsets, true), { changed: false, pluginsChanged: false }, "a second sync changes nothing");
  }],
  ["media: router direct with a router API key turns the joshu media backend on", async () => {
    process.env[router.modeEnv] = "direct";
    writeMeteredProviderConfig({ JOSHU_ROUTER_API_KEY: "jr_owner" }, stateDir);
    const { activeToolsets } = syncMeteredProviderMcpServers({}, stateDir);
    const config = {};
    syncMediaBackend(config, [], routerToolsetActive(activeToolsets));
    assert.deepEqual(mediaState(config), { plugin: true, image: "joshu", video: "joshu" });
  }],
  ["media: router off, or a balance of $0, turns the joshu media backend off", async () => {
    for (const setup of [() => { process.env[router.modeEnv] = "off"; }, async () => { useRelay(router); await loadBalance(0); }]) {
      reset();
      await setup();
      const { activeToolsets } = syncMeteredProviderMcpServers({}, stateDir);
      const config = { plugins: { enabled: ["joshu-research", MEDIA_PLUGIN] }, image_gen: { provider: "joshu", model: "auto" }, video_gen: { provider: "joshu" } };
      const result = syncMediaBackend(config, ["web", "image_gen"], routerToolsetActive(activeToolsets));
      assert.deepEqual(result, { changed: true, pluginsChanged: true });
      assert.deepEqual(mediaState(config), { plugin: false, image: null, video: null });
      assert.deepEqual(config.image_gen, { model: "auto" }, "other image settings stay");
    }
  }],
  ["media: a media provider that the owner chose stays", async () => {
    const config = { image_gen: { provider: "openai" } };
    syncMediaBackend(config, [], true);
    assert.equal(config.image_gen.provider, "openai");
    syncMediaBackend(config, [], false);
    assert.equal(config.image_gen.provider, "openai");
  }],
);

let failed = 0;
for (const [name, fn] of cases) {
  reset();
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL ${name}\n`, err);
  }
}
fs.rmSync(stateDir, { recursive: true, force: true });
console.log(`\n${cases.length - failed}/${cases.length} passed`);
if (failed) process.exit(1);
