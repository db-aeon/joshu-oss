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

Kanban workers do not find these project plugins: the Kanban dispatcher starts each worker in the
owner's files folder, not in `/opt/joshu`. So `deploy/scripts/vps-start.sh` copies each plugin of
this folder into `$HERMES_HOME/plugins/` at every boot, and a worker gets the tools of the release,
for example the research tools for a request by text message. A project plugin overrides a user
plugin with the same name, so the gateway still runs the copy in `/opt/joshu`.

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

## joshu-research

Tools of Research reports (`research_report_make`, `research_report_find`), of
recurring reports (`research_recurring_save`, `research_recurring_list`,
`research_recurring_state`), and of report updates (`research_update_make`,
`research_update_pdf`). They call the Joshu API on localhost and wait for the answer
(at most 11 minutes for a new report or a report update). Joshu auto-enables this plugin and its toolset during gateway config
sync, and drops the retired `joshu-last30days`. Skill `research-report` tells the
companion how to answer on each channel; see
[`docs/hermes-customizations.md`](../../docs/hermes-customizations.md#joshu-research-plugin).

## joshu-web-you

Web backend `you` for the Hermes tools `web_search` and `web_extract` (change you-web-provider).
The plugin holds no key. It posts each call to `POST /api/web/search` or `POST /api/web/extract`
of the Joshu API on localhost. The Joshu API runs the call with You.com, through the proxy of the
control plane or with the own key of a self-hosted box, and uses Exa when You.com fails. When the
Joshu API does not answer and the box has an Exa key, the plugin calls the Exa backend of Hermes.
The gateway sync sets `web.backend` to `you` and enables the plugin while the box can reach
You.com. See [`docs/hermes-integration.md`](../../docs/hermes-integration.md#the-web-provider-of-a-box).
Test: `npm run test:joshu-web-you`.

## joshu-media

Image provider and video provider `joshu` for the Hermes tools `image_generate` and
`video_generate` (change content-router). Each provider posts the prompt to
`POST /api/router/media` of the Joshu API, which calls the content router, saves the file on
the Desktop of the owner, and returns the path. The box holds no fal.ai key for this. The gateway
sync enables the plugin and sets `image_gen.provider` and `video_gen.provider` to `joshu` only
while the toolset `mcp-joshu-router` is on, and removes them when it is off. See
[`docs/technical-reference/metered-providers.md`](../../docs/technical-reference/metered-providers.md).
Test: `npm run test:joshu-media`.

## joshu-realtime-goals

Conservative Slack/Telegram admission hook plus `realtime_goal_defer` fallback
tool. The admission hook sends the downloaded files and the chat context of the
message with the text, so a realtime goal gets them.

`cron_guard.py` adds a `pre_tool_call` hook that blocks a Hermes `cronjob`
call whose delivery target cannot reach anyone; the rules match
`src/cronDelivery.ts`. `step_limit.py` adds the step-limit warning to the tool
results of a worker on board `realtime-goals` when 15 steps or fewer are left
(`pre_api_request`, `transform_tool_result`), and writes the last summary of a
run that reached the step limit as a `## Step-limit note` comment on the Kanban
task (`post_llm_call`). Joshu auto-enables this plugin and its toolset during gateway config sync.
The durable broker and channel behavior are documented in
[`docs/realtime-goals.md`](../../docs/realtime-goals.md).
