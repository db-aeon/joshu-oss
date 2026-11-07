---
name: joshu-social-posts
description: Read one social media post, reel, or video from a link that the owner sends (Instagram, Facebook, TikTok, YouTube, Threads, LinkedIn) with the Joshu content router, and use the shared browser only when the content router is off or has no data.
metadata:
  hermes:
    category: research
    version: "2.0.0"
---

# Social posts

Use this skill when the owner sends a link to one post, reel, or video on Instagram, Facebook, TikTok, YouTube, Threads, or LinkedIn, and asks what it says, what it shows, or what people say about it.

A login wall hides most of these posts from the shared browser. The content router returns the caption, the counts, the transcript, and the comments of one post from its link, so try the content router first. Skill `joshu-content-router` tells more about the content router.

## 1. Check that the content router is on

The content router is on when you have the tools of toolset `mcp-joshu-router`: `mcp_joshu_router_catalog_search`, `mcp_joshu_router_catalog_get`, and `mcp_joshu_router_call`. When you do not have them, go to section 4.

Each call of `mcp_joshu_router_call` costs money from the usage wallet of the owner, about $0.002 for each provider endpoint of section 2. Calls of `mcp_joshu_router_catalog_search` and `mcp_joshu_router_catalog_get` are free.

## 2. Find the provider endpoint in the route cache

The route cache is the file `~/.hermes/skills/joshu-content-cache/references/routes.json`. Its key is the kind of goal, for example `instagram video transcript`, and each entry has the provider endpoint (`endpoint`) and the input name of the link (`queryInput`, which is `url`). Read the file, and use the entry for the site and the job:

| Job | Kinds of goal in the route cache |
|-----|----------------------------------|
| Post details | `instagram post details`, `facebook post details`, `tiktok video details`, `youtube video details`, `threads post details`, `linkedin post details` |
| Transcript of a video | `instagram video transcript`, `facebook video transcript`, `tiktok video transcript`, `youtube video transcript`, `linkedin video transcript` |
| Comments | `instagram post comments`, `facebook post comments`, `tiktok video comments`, `youtube video comments` |

Threads has no transcript and no comments, and LinkedIn has no comments.

Call `mcp_joshu_router_call` with `endpoint` set to the `endpoint` of the entry, and `params` set to `{"url": "<the link of the owner>"}`. Use the link as the owner sent it.

When the file is not there yet, or has no entry for the job, call `mcp_joshu_router_catalog_search` with words like "instagram post transcript", and pick a ScrapeCreators provider endpoint (its id starts with `scrapecreators.`).

Pick the calls that answer the question of the owner:

- "What does this video say?": the transcript. Add the post details when you also need the caption or the author.
- "What is this post?" or a link with no question: the post details. Add the transcript when the post is a video.
- "What do people say about it?": the comments. Ask for comments only when the owner asks about them, because a page of comments is long.

Answer from the data that the content router returned. Quote the caption or the transcript when the owner asks what the post says. Give the author, the date, and the counts (views, likes, comments) when they help.

## 3. Keep the cost low

- Use the ScrapeCreators provider endpoints of the route cache. They have a fixed price. Do not use a provider endpoint whose id starts with `treg.`, because such an endpoint can try more than one provider and cost more.
- Make at most five calls of `mcp_joshu_router_call` for one link, unless the owner asks for more, for example for all the comments. The comment endpoints return one page of comments for each call, with a `cursor` for the next page. When you stop at five calls and more comments are available, tell the owner.
- When a site or a job is not in the route cache, read the price of a provider endpoint with `mcp_joshu_router_catalog_get` before you call it.

## 4. Use the shared browser as the fallback

Open the link in the shared browser (skill `joshu-browser`) only in these cases:

- The tools of toolset `mcp-joshu-router` are not available.
- The router catalog has no provider endpoint for the site of the link.
- The router call fails, or returns no data.

When a router call fails and you use the shared browser, tell the owner that the full data was not available, because the shared browser sees only what a visitor without a login sees.

When a router call fails with `insufficient_balance`, the usage wallet of the owner is empty. Tell the owner that they can add money on the usage billing page of their Joshu account, and use the shared browser for this link.
