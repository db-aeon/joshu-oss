# Metered providers

## Purpose

A metered provider is an outside service that the companion uses through an MCP server, and that costs money for each call. Joshu has two metered providers. The first is fal.ai (`fal`), which makes images, video, audio, and 3D. The second is the content router (`router`), a service of the Joshu control plane with one catalog of the data and media that a box can ask for, for example the caption, the transcript, and the comments of one social media post, or the odds of a prediction market. The content router picks the cheapest working way to reach each provider endpoint (treg, fal.ai, Composio, or a provider key of Joshu) and takes the provider price plus the router markup from the usage wallet of the owner.

On a fleet box, the calls go through the control plane with the agent token of the box. On a self-hosted box, the owner saves their own key in Connectors: a fal.ai key for fal, and a router API key, which the owner creates in their account on joshu.me, for the content router.

This document covers the box side: the provider definitions, the local metered MCP relay, the Hermes configuration, the Connectors card, the skill for social posts, the Hermes media plugin `joshu-media`, and what the social sources of Research reports do when the usage wallet is empty. How the box asks the content router for the social sources of Research reports is in [Research reports](research-reports.md). The billing and the channels of the content router are in the private documents of the control plane.

## Motivation

These constraints shaped the design:

- A fleet box must never hold a provider key. A key on a box could leak to the companion, to a skill, or to a log, and it would let anyone with the box spend the money of Joshu.
- The owner pays for what the companion uses. The cost of a call is only known after the call, so the control plane checks the balance of the usage wallet before each billable call and takes the real cost after it.
- Hermes registers the tools of an MCP server once, when the gateway starts. A toolset that is on while the usage wallet is empty gives the companion tools that fail on each call, so the box turns the toolset off when the balance is zero.
- A self-hosted box has no control plane. The owner of a self-hosted box needs the same tools with their own key and no usage wallet.
- A second and a third provider should need a new definition, not new code. The first version of this code had fal in the name of each function.
- A login wall hides most of an Instagram or Facebook post from the shared browser. The content router returns the full post from its link, so the companion needs a rule for when to use the content router and when to use the shared browser.
- The companion should see one catalog and the owner one card. Two data providers with catalogs that overlap would give the companion two ways to do the same job, at two prices.
- Hermes makes images and videos with its own tools and a media provider plugin. Its managed tool gateway works only with a Nous Portal account, so the box needs its own media provider to send these calls to the usage wallet.

## Architecture

![Architecture diagram: Hermes on the box calls the metered MCP relay on port 8798, and the control plane passes the call to the content router, which picks treg, fal, Composio, or a direct provider key and takes the cost plus the router markup from the usage wallet. The joshu-media plugin and the social sources reach the content router through the router client of the Joshu API, the gateway sync turns the router toolset and the media backend on or off, and the shared browser is the fallback.](diagrams/metered-providers.svg)

Source of the diagram: [`diagrams/metered-providers.json`](diagrams/metered-providers.json).

The parts:

- **Provider definitions** (`METERED_PROVIDER_DEFINITIONS` in `src/meteredProviders/config.ts`). Each definition has the id, the names of its settings (the mode, the relay URL, the usage summary URL, and the owner switch), the key name and the MCP URL for a self-hosted box, the local port, the Hermes MCP server name, and the Hermes toolset. The functions of `config.ts` take a definition: the mode, the owner switch, the relay check, the key of a self-hosted box, the local relay URL, and whether the toolset is on.
- **Usage summary.** `fetchUsageSummaryFromCp` reads the balance of the usage wallet from the control plane with the agent token of the box, and keeps it in a cache for 15 seconds. One usage summary serves each provider.
- **Local metered MCP relay** (`scripts/lib/metered-mcp-relay.mjs`). One process for each provider in relay mode, on `127.0.0.1` and the port of the provider. The relay is an MCP server for Hermes. It forwards `tools/list` and `tools/call` as JSON-RPC to the metered MCP relay route of the control plane, with the bearer `<instance id>.<agent token>`. `scripts/start-metered-mcp-relay.sh <provider id> <port>` starts it, and `scripts/start-fal-mcp-relay.sh` is a wrapper for fal that the release image still names.
- **MCP supervisor and health** (`src/mcpSupervisor.ts`, `src/mcpDependencyHealth.ts`). For each provider in relay mode, the health check probes `/health` of the local relay, and the supervisor restarts the relay when the probe fails.
- **Hermes configuration** (`src/meteredProviders/hermesConfig.ts`, called by the gateway sync in `src/hermesApi.ts`). For each provider, the sync writes one MCP server into `~/.hermes/config.yaml` (`fal_ai`, `joshu_router`) and adds or removes its toolset (`mcp-fal`, `mcp-joshu-router`). `src/hermesMcpAllowlist.ts` lists both server names as servers that Joshu owns. The sync also removes the MCP server `treg` and toolset `mcp-treg` of the releases before the content router (`RETIRED_METERED_PROVIDERS`), because port 8798 now serves the content router.
- **Connectors** (`src/connectors/meteredProviderRoutes.ts`, `apps/connectors/src/main.tsx`). One card for each provider in section "AI providers": the on or off switch, and either the balance with a link to the usage billing page (fleet box) or the key field with a line on where to get the key (self-hosted box).
- **Skills** (`integrations/hermes/skills/research/`). Skill `joshu-content-router` tells the companion how to use the router tools, lists the default hints (for example "Seedance for the best video"), and tells how to write a hint of the owner into the box skill `joshu-content-cache`. Skill `joshu-social-posts` has the rule for a link to one post on Instagram, Facebook, TikTok, YouTube, Threads, or LinkedIn: the provider endpoint of the route cache for the post details, the transcript, and the comments, the limit of five calls for each link, and the fallback to the shared browser.
- **Content router client** (`src/contentRouter/client.ts`). The client of the router call route and of the public catalog routes of the control plane, used by the social sources and the media route. It runs in the Joshu API, never in Hermes.
- **Media plugin `joshu-media`** (`.hermes/plugins/joshu-media/`) and the media route (`src/contentRouter/media.ts`). The plugin is the image provider and the video provider `joshu` of the Hermes tools `image_generate` and `video_generate`.

## Theory of operation

### Modes

Each provider has a mode in its own setting (`JOSHU_FAL_MODE`, `JOSHU_ROUTER_MODE`). The box reads the provision file first and the process env second. A box needs no setting of its own: when the mode is not set, a fleet box (it has `CONTROL_PLANE_URL` and `INSTANCE_AGENT_TOKEN`) uses `relay`, and a self-hosted box uses `direct`. When `JOSHU_<ID>_RELAY_URL` is not set, the relay URL is `<CONTROL_PLANE_URL>/api/instances/providers/<id>/mcp`. Set `JOSHU_<ID>_MODE=off` only to turn a provider off on one box.

| Mode | Who | What Hermes calls |
|------|-----|-------------------|
| `relay` | A fleet box. The control plane writes the mode, the relay URL, and the usage summary URL at provision. | The local metered MCP relay on the port of the provider. The box ignores a provider key in the instance env. |
| `direct` | A self-hosted box. This is the default when the setting is missing. | The MCP URL of the provider (`https://mcp.fal.ai/mcp`, `https://hello.joshu.me/api/router/mcp`) with `Authorization: Bearer <key>`. The owner saves the key in Connectors, or sets `FAL_KEY` or `JOSHU_ROUTER_API_KEY` in the env. |
| `off` | A box where the provider is turned off. | Nothing. The MCP server is disabled. |

### When the toolset is on

At each gateway sync, the box first refreshes the usage summary when at least one provider is in relay mode. Then, for each provider, the toolset is on only when all of these are true:

1. The mode is not `off`.
2. The owner has not turned the provider off in Connectors. The owner switch is `FAL_MCP_USER_ENABLED` or `ROUTER_MCP_USER_ENABLED` in `connectors-providers.env` of the Joshu state folder. In relay mode, the default is on. In direct mode, the default follows whether a key is saved.
3. In relay mode: the relay URL is set, and the last usage summary shows a balance above zero. Before the first usage summary, the toolset is off.
4. In direct mode: a key is saved.

When a toolset is off, the sync sets `enabled: false` on its MCP server and removes the toolset from the toolset list. The toolset of one provider does not change the other provider.

### One router call on a fleet box

1. The owner sends a link to an Instagram reel and asks what the video says. Skill `joshu-social-posts` tells the companion to read the route cache, and to call `mcp_joshu_router_call` with `endpoint` `scrapecreators.x.v2-instagram-media-transcript` (the entry `instagram video transcript`) and `params` `{"url": "<link>"}`.
2. Hermes sends the MCP call to the local metered MCP relay of the content router on port 8798.
3. The relay sends `tools/call` as JSON-RPC to `JOSHU_ROUTER_RELAY_URL`, the router path of the metered MCP relay route of the control plane, with the agent token of the box.
4. The content router checks the balance of the usage wallet against the price of the provider endpoint, calls the cheapest channel that works, and takes the cost plus the router markup from the usage wallet. The reply is the reply of the provider, without the envelope of the channel.
5. The relay gives the reply to Hermes. When the control plane refuses the call, the relay gives Hermes an error result with the reason, for example `insufficient_balance`.
6. The companion answers from the transcript. When the content router is off, has no provider endpoint for the site, or returns no data, the companion opens the link in the shared browser instead.

### One picture or video

1. The owner asks for a picture of a red bicycle. Hermes calls its tool `image_generate`. The gateway sync set `image_gen.provider` to `joshu`, so Hermes gives the call to the image provider of plugin `joshu-media`.
2. The plugin posts the prompt, the options, and the provider endpoint, when the request names one, to `POST /api/router/media` of the Joshu API on localhost.
3. The Joshu API calls the router call route with capability `image.generate` (or `video.generate`) and provider endpoint `auto`, or the provider endpoint of a hint. A video can take up to 10 minutes.
4. The content router reaches fal.ai and returns the fal result. The Joshu API downloads the file from the link in the result, saves it on the Desktop of the owner, and returns the path.
5. Hermes gets the path in its normal result shape and sends the file to the owner.

The tool `video_generate` of the pinned Hermes has an argument `model`, so the companion can pass the provider endpoint of a hint, for example a Seedance endpoint for "the best video". The tool `image_generate` has no such argument, so a picture uses `auto` unless `image_gen.model` is set in the Hermes configuration.

The gateway sync turns the media backend on together with the toolset `mcp-joshu-router`: it adds `joshu-media` to `plugins.enabled`, sets `image_gen.provider` and `video_gen.provider` to `joshu`, and adds the toolsets `image_gen` and `video_gen`. When the router toolset is off, the sync removes the plugin and the provider `joshu`, so Hermes has no media tool that would fail on each call. A media provider that the owner chose stays.

### The social sources when the usage wallet is empty

The content router answers HTTP 402 when the balance is lower than the price of a call. The client of the content router (`src/contentRouter/client.ts`) turns HTTP 402 into a `RouterError` of kind `usage wallet empty`, and makes no retry. The source gets the state "could not be reached" with engine status `usage wallet empty`, and the other sources of the run continue. `sourceListHtml` in `src/research/template.ts` writes the list "Sources searched" of a Research report and of a report update. For such a source, the list says that the usage wallet is empty and links to the usage billing page of the control plane (`controlPlaneUsageDashboardUrl()`). On a self-hosted box without a router API key, the list says that the social sources need a router API key.

## Design decisions

### 2026-10-31: One set of functions for each metered provider

The functions of `src/meteredProviders/config.ts` take a provider definition, and each definition holds the names of its settings. The second provider was one new definition and no new function.

Alternatives: copy each fal function for the second provider. Rejected, because each later provider would add the same copies again, and the copies would drift.

### 2026-10-31: One start script for each provider

`scripts/start-metered-mcp-relay.sh <provider id> <port>` starts the local metered MCP relay of any provider, with one PID file and one log file for each provider in `~/.joshu/`. The MCP supervisor passes the id and the port of each definition, so the port is written once, in the definition. `scripts/start-fal-mcp-relay.sh` stays as a one-line wrapper, because older release images and runbooks name it.

Alternatives: one start script for each provider. Rejected for the same reason as the functions.

### 2026-10-31: One usage summary for all providers

The usage summary of the control plane has one balance for the owner, and the balance pays for each provider. The box keeps one cache, and uses the first usage summary URL that is set. Each provider still has its own usage summary setting, so that each provider has the same three settings.

### 2026-11-01: The content router replaces treg as a metered provider

The box has one data provider, `router`, with toolset `mcp-joshu-router`, the local relay on port 8798, and the settings `JOSHU_ROUTER_MODE`, `JOSHU_ROUTER_RELAY_URL`, and `JOSHU_ROUTER_USAGE_SUMMARY_URL`. Treg is now one channel of the content router on the control plane, and the box never calls treg itself. A self-hosted box connects to `https://hello.joshu.me/api/router/mcp` with the router API key of the owner (`JOSHU_ROUTER_API_KEY`), so it uses the same catalog and the same tools as a fleet box, and the content router takes the cost from the usage wallet of that owner. The gateway sync removes the MCP server and the toolset of the old provider `treg`.

Alternatives: keep `treg` next to `router`. Rejected, because the companion would see two catalogs that overlap, and the owner would see two cards. A treg token on a self-hosted box was rejected for the same reason, and because it would give a self-hosted box a different catalog from a fleet box.

### 2026-11-01: Hermes media goes through the plugin `joshu-media`

Plugin `joshu-media` registers an image provider and a video provider named `joshu`. Each provider posts to `POST /api/router/media` of the Joshu API, which calls the content router with capability `image.generate` or `video.generate`, waits for the result, and saves the file on the Desktop. So the Hermes tools `image_generate` and `video_generate` work on a fleet box with no fal.ai key on the box, and each picture or video takes its cost from the usage wallet. The plugin calls the Joshu API and not the control plane, so the agent token stays out of the Hermes environment.

The media route downloads the file only from an `https` link to a public host, checks the address of the host and of each redirect, and stops at 25 MB for an image and 200 MB for a video, because the link comes from the reply of a provider. It accepts a provider endpoint from a hint only when the router catalog lists it under `image.generate` or `video.generate`, so a request cannot reach another paid endpoint.

Alternatives: the managed tool gateway of Hermes. Rejected, because Hermes uses it only with a Nous Portal account. The fal tools of `mcp-fal` stay for the companion, but the Hermes media tools are the ones that skills and the Hermes model know.

### 2026-10-31: The rule for social post links is a factory skill

The rule goes into the factory skill `joshu-social-posts`, which reaches each box through the skills seed. The skill points to the route cache, which starts with the ScrapeCreators provider endpoint of each site and job, so the companion does not search the router catalog for each link, and it uses provider endpoints with a fixed price.

Alternatives: add the rule to a skill that a companion wrote on one box. Rejected, because such a skill is not in the repository and does not reach the other boxes.

### 2026-10-31: The social sources name an empty usage wallet

HTTP 402 from the content router becomes the failure kind `usage wallet empty`, and the source list of the report links to the usage billing page. The source state stays "could not be reached", so the code that ranks source states does not change.

Alternatives: leave HTTP 402 as a plain error. Rejected, because the owner then sees "could not be reached" and cannot know that money fixes it.

## Limits and failure modes

- **Empty usage wallet.** The toolsets of the metered providers and the Hermes media tools are off, and the social sources of Research reports return nothing. The rest of a Research report still works. The toolsets come back at the next gateway sync after the owner adds money.
- **Stale balance.** The usage summary cache is 15 seconds old at most, and the toolset changes only at a gateway sync. A call can still reach the control plane after the balance went to zero. The control plane then refuses the call with `insufficient_balance` before it calls the provider.
- **Control plane not reachable.** The usage summary keeps its last value. Calls through the relay fail, and the companion uses the shared browser for social post links.
- **Relay process stops.** The MCP supervisor restarts it within a minute. Until Hermes connects again, the tools of the provider fail.
- **Large replies.** A page of comments can be long. The relay gives it to Hermes unchanged, and the skill asks for comments only when the owner asks about them.
- **Slow video.** A video can take minutes. The media route waits up to 10 minutes, and the plugin waits up to 11 minutes for the Joshu API.
- **Bad key on a self-hosted box.** When the owner turns a provider on in direct mode, the box probes the MCP URL of the provider with the key and refuses to turn it on after HTTP 401 or 403.
- **The relay of the control plane bills one call for each request.** The box sends one tool call for each request.

## Code map

| Area | Path |
|------|------|
| Provider definitions and modes | `src/meteredProviders/config.ts` |
| Hermes MCP servers and toolsets | `src/meteredProviders/hermesConfig.ts`, called from `src/hermesApi.ts` |
| Managed MCP server names | `src/hermesMcpAllowlist.ts` |
| Local metered MCP relay | `scripts/lib/metered-mcp-relay.mjs` |
| Start scripts | `scripts/start-metered-mcp-relay.sh`, `scripts/start-fal-mcp-relay.sh` |
| Supervisor and health | `src/mcpSupervisor.ts`, `src/mcpDependencyHealth.ts` |
| Connectors REST | `src/connectors/meteredProviderRoutes.ts` (`GET /api/connectors/providers`, `POST …/providers/:id/toggle`, `POST …/providers/:id/setup`) |
| Connectors card | `apps/connectors/src/main.tsx` |
| Skills | `integrations/hermes/skills/research/joshu-content-router/SKILL.md`, `integrations/hermes/skills/research/joshu-social-posts/SKILL.md` |
| Content router client and HTTP 402 | `src/contentRouter/client.ts`, `src/research/template.ts` (`sourceListHtml`) |
| Media plugin and media route | `.hermes/plugins/joshu-media/`, `src/contentRouter/media.ts` (`POST /api/router/media`), `syncMediaBackend` in `src/meteredProviders/hermesConfig.ts` |
| Tests | `npm run test:metered-providers-config`, `npm run test:content-router`, `npm run test:joshu-media`, `npm run test:research-social` |

Settings of a fleet box, which the control plane writes:

| Setting | Purpose |
|---------|---------|
| `JOSHU_FAL_MODE`, `JOSHU_ROUTER_MODE` | Optional. `relay`, `direct`, or `off`. Default: `relay` on a fleet box, `direct` on a self-hosted box |
| `JOSHU_FAL_RELAY_URL`, `JOSHU_ROUTER_RELAY_URL` | Optional. The metered MCP relay route of the control plane for the provider. Default: from `CONTROL_PLANE_URL` |
| `JOSHU_FAL_USAGE_SUMMARY_URL`, `JOSHU_ROUTER_USAGE_SUMMARY_URL` | The usage summary of the control plane |
| `JOSHU_INSTANCE_ID`, `INSTANCE_AGENT_TOKEN` | The agent token for the relay and the usage summary |
| `JOSHU_FAL_MCP_HTTP_URL`, `JOSHU_ROUTER_MCP_HTTP_URL` | Optional. Another base URL for the local relay (default `http://127.0.0.1:8797` and `http://127.0.0.1:8798`) |
| `JOSHU_ROUTER_URL` | Optional. Another base URL of the content router for the client of the Joshu API (default `CONTROL_PLANE_URL` on a fleet box, `https://hello.joshu.me` on a self-hosted box) |

Keys of a self-hosted box: `FAL_KEY` (or `FAL_API_KEY`) and `JOSHU_ROUTER_API_KEY`, in Connectors or in the env.

To run a laptop as a fleet box against the production control plane, the control plane repository has `scripts/issue-local-dev-relay-env.ts <box>`. The script writes `.local/instance.env`, which Joshu reads through `JOSHU_COMPOSE_ENV_FILE`. The script makes a new agent token, so a live box with the same name stops working until it gets the new token.
