---
name: joshu-content-router
description: Use the Joshu content router (toolset mcp-joshu-router) to get social posts, transcripts, prediction market odds, and other data, and to make images and videos; pass the hints of this skill and of skill joshu-content-cache to the research tools and the media tools; write a new hint of the owner into skill joshu-content-cache.
metadata:
  hermes:
    category: research
    version: "1.0.0"
---

# Content router

The content router is a service of Joshu. It has one catalog of the data and media that the box can ask for, and one call that picks the cheapest working way to reach each provider endpoint. Each call takes the provider price plus the router markup from the usage wallet of the owner. The Exa web search and Composio Search are base sources: they do not go through the content router and cost the owner nothing.

Use this skill when:

- you start a Research report or a recurring report (tools `research_report_make` and `research_recurring_save`): pass the hints that fit (section 4);
- the owner asks for a picture or a video (section 5);
- the owner asks for data that no other tool has, for example the odds of a prediction market, or the posts of one account;
- the owner tells you which source to use for a kind of request (section 6).

For a link to one social post, use skill `joshu-social-posts`.

## 1. Check that the content router is on

The content router is on when you have the tools of toolset `mcp-joshu-router`:

- `mcp_joshu_router_catalog_search` with `q` (words) and `limit`: finds capabilities and provider endpoints, with the price, the success rate, and the latency of each one. Free.
- `mcp_joshu_router_catalog_get` with `endpoint_id` or `capability_id`: the inputs and an example reply of one provider endpoint. Free.
- `mcp_joshu_router_call` with `endpoint` (a provider endpoint id, or `auto` with `capability`) and `params`: calls the provider endpoint. Costs money.

When you do not have these tools, the content router is off, or the usage wallet is empty. Tell the owner when it matters, for example when the owner asks for a video.

## 2. Make a call

1. Look for the job in the route cache first: `~/.hermes/skills/joshu-content-cache/references/routes.json` maps a kind of goal (for example "youtube videos" or "instagram video transcript") to a provider endpoint and the input name of the query.
2. When the route cache has no entry, call `mcp_joshu_router_catalog_search` with a few words about the job. Pick a provider endpoint with a low price and a high success rate. Read its inputs with `mcp_joshu_router_catalog_get` before the first call.
3. Call `mcp_joshu_router_call`. Make at most five paid calls for one request of the owner, unless the owner asks for more.

When a call fails with `insufficient_balance` (HTTP 402), the usage wallet is empty. Tell the owner that they can add money on the usage billing page of their Joshu account. Do not try again.

## Default social goals

The social posts of each Research report and each report update come from these goals, with the social query of the report. The Joshu API reads this table, so a change here changes the default goals of each report.

| Id | Goal | Label |
|----|------|-------|
| reddit | Reddit posts | Reddit |
| youtube | YouTube videos | YouTube |
| tiktok | TikTok videos | TikTok |
| instagram | Instagram reels | Instagram |
| x | X posts | X |

## 3. Default hints

A hint is one short line that adds a kind of source to a request or names the provider to prefer for it. These hints hold for every owner:

- Seedance for the best video.
- Polymarket for prediction market odds on political topics.

The hints of the owner are in section "Hints of the owner" of skill `joshu-content-cache`. A hint of the owner wins over a default hint.

## 4. Pass hints to the research tools

Before you call `research_report_make` or `research_recurring_save`, read the default hints above and the hints of the owner. Pass each hint that fits the topic in argument `hints`, word for word. Examples:

- The owner asks for research on the 2028 primaries: pass `["Polymarket for prediction market odds on political topics"]`. The report then gets a goal "prediction market odds" with the odds of each market.
- The owner asks for research on electric bike subscriptions: no default hint fits, so leave out `hints`.

Do not pass a hint that does not fit: each extra goal costs money on each report.

## 5. Pictures and videos

Use the Hermes tools `image_generate` and `video_generate`. On this box they call the content router (media provider `joshu`), and each picture or video takes its cost from the usage wallet. The file is saved on the Desktop of the owner, and the tool returns its path. Send the file to the owner.

- Without a hint, leave out `model`: the content router picks with `auto`.
- When a hint names a provider for the request, for example "Seedance for the best video" when the owner asks for the best quality video, find its provider endpoint with `mcp_joshu_router_catalog_search` (words "seedance video") and pass the id in argument `model` of `video_generate`.
- `image_generate` has no argument for the provider endpoint, so a picture always uses `auto`.

## 6. Write a hint of the owner

When the owner tells you which source to use for a kind of request, for example "use Polymarket for election odds" or "for videos, always use Veo", add one line to section "Hints of the owner" of `~/.hermes/skills/joshu-content-cache/SKILL.md` with `skill_manage` (action `patch`). Write the hint in the form "<provider> for <kind of request>". Then tell the owner that you will use it from now on.

Do not edit the files in `~/.hermes/skills/joshu-content-cache/references/`. The Joshu API writes them.
