# Joshu Hermes Plugins

Project-local Hermes plugins live here.

Example layout:

```text
.hermes/plugins/joshu-browser/
├── plugin.yaml
├── __init__.py
├── schemas.py
└── tools.py
```

Joshu starts Hermes with `HERMES_ENABLE_PROJECT_PLUGINS=true`, so Hermes can
discover plugins from this directory. Discovery does not enable plugins by
itself; add plugin names to `JOSHU_HERMES_PLUGIN_NAMES` or to
`plugins.enabled` in `$HERMES_HOME/config.yaml`.

**Rule: Hermes plugins do not write to stdout.** Use Python `logging` (or
`print(…, file=sys.stderr)` for rare errors). Do not write a line at level INFO or
higher for each LLM call. A blocked write to stdout stops every turn in the Hermes
gateway.

## joshu-langfuse-relay

Fleet default observability path: posts turn/tool events to the control plane
(`JOSHU_LANGFUSE_RELAY_URL` / `CONTROL_PLANE_URL`) with instance-agent Bearer
auth. **No Langfuse pk/sk on the box.** Requires `JOSHU_INSTANCE_ID` +
`INSTANCE_AGENT_TOKEN`. Enable via `JOSHU_HERMES_PLUGIN_NAMES=joshu-langfuse-relay`
(and leave stock `observability/langfuse` disabled).

## joshu-realtime-goals

Conservative Slack/Telegram admission hook plus `realtime_goal_defer` fallback
tool. `cron_guard.py` adds a `pre_tool_call` hook that blocks a Hermes `cronjob`
call whose delivery target cannot reach anyone; the rules match
`src/cronDelivery.ts`. Joshu auto-enables this plugin and its toolset during gateway config sync.
The durable broker and channel behavior are documented in
[`docs/realtime-goals.md`](../../docs/realtime-goals.md).
