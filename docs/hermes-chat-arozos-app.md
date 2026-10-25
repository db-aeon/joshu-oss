# jChat ArozOS App (Hermes Chat)

Joshu includes a small **jChat** ArozOS app (subservice `hermes-chat`) that uses Hermes Agent's
OpenAI-compatible chat-completions stream through the Joshu backend.

## Shape

- `apps/hermes-chat/` is a Joshu-owned Vite/React app.
- `arozos/subservice/hermes-chat/` registers the desktop app with ArozOS.
- `arozos/subservice/hermes-chat/.startscript` tells ArozOS to run `start.sh`
  instead of looking for a native `hermes-chat_<os>_<arch>` binary.
- `scripts/aroz-static-subservice.mjs` serves the built static assets from the
  subservice's private launch port.
- `src/server.ts` exposes `/api/hermes-chat/status`,
  `/api/hermes-chat/stream`, Composio under `/api/connectors/composio/*` (legacy `/api/hermes-chat/composio/*`),
  and voice helpers under the existing Joshu Express service (see **Voice** and
  **Composio** below).
- `src/composioApi.ts` + `src/composioRoutes.ts` integrate [Composio](https://docs.composio.dev/docs)
  tool-router sessions; `src/hermesApi.ts` writes `mcp_servers.composio` for Hermes.
- `src/hermesApi.ts` owns Hermes gateway startup and proxies streaming
  `POST :8642/v1/chat/completions` (the gateway **api_server** platform).

### Request path (jChat vs Telegram vs Slack)

jChat does **not** use the Hermes **Telegram** or **Slack** messaging adapters. It is Joshu’s own HTTP pipe into the **same** `hermes gateway run` process:

```text
jChat (browser)
  → ArozOS subservice → Joshu POST /api/hermes-chat/stream
  → Hermes :8642/v1/chat/completions   (api_server platform)
  → run_conversation() — same agent, tools, MCP, Hindsight

Telegram DM
  → Hermes gateway telegram platform (long polling)
  → run_conversation() — same brain, different session key

Slack DM / @mention
  → Hermes gateway slack platform (Socket Mode)
  → run_conversation() — same brain, different session key
```

| Surface | Ingress | Session key (typical) |
| ------- | ------- | --------------------- |
| **jChat** | Joshu → `api_server` | `joshu-hermes-chat:<sessionId>` |
| **Telegram chat bot** | `TELEGRAM_BOT_TOKEN` adapter | `agent:main:telegram:dm:<chat_id>` |
| **Slack chat bot** | `SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN` (Socket Mode) | `agent:main:slack:…` (Hermes session naming) |

All three share toolsets, MCP catalog, SOUL.md, and Hindsight auto-recall. They do **not** share transcript history unless you explicitly hand off sessions (`/handoff` on gateway platforms). Slack and Telegram **idle-reset after 30 minutes**; jChat does not. Use `session_search` from Slack to recall a jChat session. Slack setup: [hermes-integration — Slack chat](hermes-integration.md#slack-chat-hermes-messaging-gateway). Telegram: [hermes-integration — Telegram & jChat](hermes-integration.md#telegram-11-chat-hermes-messaging-gateway).

### Long turns and empty replies

Hermes can keep calling tools for up to **90 iterations** on one user message (tens of minutes). jChat is an SSE stream through Caddy. If that stream goes idle for ~100s (Cloudflare / some proxies), the browser connection dies while Hermes keeps working. Langfuse then shows a finished turn and jChat shows nothing.

Joshu sends SSE comment heartbeats every 15s on `/api/hermes-chat/stream` (and AG-UI), and Caddy `reverse_proxy /joshu/*` uses `flush_interval -1` plus 1h read/write timeouts. Recreate **caddy** after image/dist so the Caddyfile regenerates. If a drop still happens, jChat marks the bubble as an error instead of a successful empty reply — send **continue** to pick up Hermes session history.

DeepSeek replies can also look finished but end mid-sentence. Joshu’s DSML
scrubber holds back 32 characters so a split `<DSML…` tag is not shown; that
tail must be flushed **before** the gateway SSE sentinel or jChat keeps
`rested, or a` as the whole message. See
[hermes-integration — DeepSeek DSML stream scrub](hermes-integration.md#deepseek-dsml-stream-scrub).
jChat also applies `finalText` from the `done` event when it is a longer
prefix of the streamed deltas.

jChat is **sync-only** for the [Realtime Goal Broker](realtime-goals.md): every
turn goes to Hermes on the SSE stream (the owner can wait). Joshu still appends
owner/box turns to the **session thread** for routing consistency on other
surfaces, but jChat does not auto-queue long work. If a jChat turn discovers
mid-flight that work is long, Hermes cannot call `realtime_goal_defer` from a
jChat session — use SMS, voice, Slack, or Telegram for deferred goals.

Kanban completions for goals **started on other channels** may still appear via
the durable per-session surface-event queue; the open client polls that into the
transcript. See [theory of operation — channel policy](technical-reference/realtime-goals-theory-of-operation.md#channel-policy-summary).

### System prompt layers

Each turn, jChat POSTs `sessionId` + a **minimal** client system message (mail/tools hints in [`apps/hermes-chat/src/main.tsx`](../apps/hermes-chat/src/main.tsx)) and **only the latest user message** — not the full UI transcript. Hermes merges server-side session history and adds its own cached system prompt: companion `SOUL.md`, desktop `HERMES.md`, **`<available_skills>`** (truncated `description` per skill, ≤60 chars), then tool guidance. The model must call **`skill_view(name)`** to load a full `SKILL.md`; nothing in Joshu auto-selects EA skills when the conversation drifts. Details: [hermes-integration — Skill catalog](hermes-integration.md#skill-catalog-descriptions-and-skill_view), [ea-for-joshu — EA skills in jChat](hermes-integration.md#ea-skills-in-jchat-catalog--skill_view).

The browser never receives `HERMES_API_KEY`; it talks only to Joshu. The UI
supports markdown, GitHub-flavored markdown tables/lists, embedded image
attachments, assistant media links, and tool-progress cards emitted from Hermes
stream events.

## ArozOS Desktop Registration

Hermes Chat needs two ArozOS-facing pieces:

- The **subservice registration** lives in
  `arozos/subservice/hermes-chat/moduleInfo.json`. It names the module
  `jChat` and sets `StartDir` / `LaunchFWDir` to
  `hermes-chat/index.html`.
- The **desktop icon** is a `jChat.shortcut` file. ArozOS keeps user
  desktops in persistent runtime data, so `scripts/dev-arozos.sh` and
  `deploy/scripts/vps-start.sh` install the shortcut into the default desktop
  template and any existing user desktops each time they prepare ArozOS data.

The shortcut content is (line 2 = label, line 3 = module path — see
[`docs/arozos-desktop-shortcuts.md`](arozos-desktop-shortcuts.md)):

```text
module
jChat
jChat
img/joshu/chat.png
```

## ArozOS taskbar tray

Joshu replaces the stock ArozOS **background tasks** button (`#backgroundtaskBtn`) with a
compact jChat tray in the bottom taskbar ([`aroz-jchat-tray.js`](../arozos/web-overlays-vanilla/aroz-jchat-tray.js),
styled in fleet **paper-shell** CSS from the private `joshu-design` pack, or OSS [`aroz-vanilla-shell.css`](../arozos/web-overlays-vanilla/aroz-vanilla-shell.css)).

Layout (left → right, immediately left of the clock): **VU meter · mic · avatar**.

| Control | Behavior |
| --- | --- |
| **Avatar** | Toggle the **docked** jChat companion: opens or focuses it when hidden; adds `jp-jchat-dock-hidden` when open (required because dock CSS uses `display: flex !important`, which blocks jQuery `fadeOut`). Does not steal icon-launched floating windows. |
| **Mic** | Toggle Realtime voice mode on the **docked** iframe. Posts `jchat:voice-toggle`; opens the docked window first if needed. Disabled when `/api/voice/status` reports unavailable. Floating windows use their own in-window Mic. |
| **VU meter** | Winamp-style level bars driven by `@joshu/voice-client` `onAudioLevel` from the docked session. Grayed out when voice is off. |

**Persona:** tray and jChat iframe both load `GET /joshu/api/instance/identity`; portrait precedence is `avatarUrl` → `imageUrl` (see [self-host.md#identity-without-control-plane](self-host.md#identity-without-control-plane)). Email signatures use **`imageUrl` only**.

**Shell ↔ iframe IPC** ([`apps/hermes-chat/src/traySync.ts`](../apps/hermes-chat/src/traySync.ts)):

| Direction | Message | Payload |
| --- | --- | --- |
| iframe → shell | `jchat:tray` | `assistantName`, `portraitUrl`, optional `notification`, `voiceInputOn`, `voiceAvailable`, `audioLevel` |
| iframe → shell | `jchat:undock` | (none) — pops this docked window into a free-floating one |
| shell → iframe | `jchat:voice-toggle` | (none) — toggles voice mode in `main.tsx` (docked iframe only) |

When a new assistant reply completes, jChat sends `notification` text; the shell shows a toast above the taskbar if that window is hidden (click opens the **docked** companion). Applied with `scripts/apply_arozos_joshu_theme.py` on each `dev-arozos` / deploy boot (cache-busted `?v=` on overlay JS/CSS).

### Multiple windows (icon vs tray)

jChat is not a singleton. Each iframe mints its own Hermes `sessionId` (`joshu-hermes-chat:<id>`).

| Opener | Window | Session |
| --- | --- | --- |
| Desktop **jChat** icon, start menu, or `openModule("jChat")` | New **floating** ArozOS window (drag / resize / min / max) | Fresh session on each launch |
| Taskbar **avatar** | One **docked** companion (`jp-jchat-docked` — 400px right rail) | Continues that docked iframe’s session |
| **Undock** (title-bar ↗ / in-app **Undock**) | That docked window becomes floating | Same session; next tray click opens a **new** docked session |

Dock CSS lives in the paper-shell / vanilla overlay and targets **`.jp-jchat-docked` only**. Floating jChat windows use stock ArozOS chrome. `aroz-desktop-window-session.js` persists the docked/floating flag across a same-tab desktop refresh.

## Desktop presentation (two tiers)

jChat can open ArozOS apps and files on the user's screen without asking them to click icons manually. Shared client code: [`apps/hermes-chat/src/desktopActions.ts`](../apps/hermes-chat/src/desktopActions.ts) (`openModule`, `newFloatWindow`).

| Tier | Surface | Trigger | Path |
| --- | --- | --- | --- |
| **Fast — typed** | Text chat | `open the mail app`, `open jWeb`, … | Client regex in `matchQuickDesktopOpen()` → `executeDesktopAction()` — **no Hermes stream** |
| **Fast — voice** | Voice (S2S) | “open browser”, “open email”, … | Realtime `open_desktop` → `desktop_action` wire event → same executor |
| **Brain** | Text + voice | Specific file, search, calendar content | Hermes `desktop_open` tool → Joshu queue → `desktop_action` SSE |

A file opens in its app: `.md`, `.markdown`, `.mdx`, and `.txt` in jNotes (as a double-click on the desktop does), `.excalidraw` in jWhiteboard, and other files in MDEditor. When a window already shows the same file in that app, `openDesktopFile` shows and raises that window instead of opening another one (`packages/app-agent/src/desktopActions.ts`, test `npm run test:desktop-open-file`). The Multiplayer app uses the same function for "What I share".

**Hermes plugin:** [`.hermes/plugins/joshu-desktop/`](../.hermes/plugins/joshu-desktop/) — tool `desktop_open` (`kind: module | file`, `target`). Enqueue runs in a **`post_tool_call` hook** (Hermes passes `session_id` to hooks, not tool handlers). Joshu drains the queue on `desktop_open` completion and emits `desktop_action` on the chat SSE stream.

**Joshu API** (localhost only):

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/joshu/api/desktop-actions/enqueue` | Plugin enqueues `{ sessionKey, action }` |
| `GET` | `/joshu/api/desktop-actions/drain?sessionKey=…` | Voice brain / debug drain |

Session key for jChat: `joshu-hermes-chat:<sessionId>` (set via `X-Hermes-Session-Key` in [`src/hermesApi.ts`](../src/hermesApi.ts)).

**Enable plugin:** `JOSHU_HERMES_PLUGIN_NAMES` must include `joshu-desktop` (see [hermes-integration — joshu-desktop plugin](hermes-integration.md#joshu-desktop-plugin)). Restart the Hermes gateway after plugin changes.

**Module aliases** (voice + typed fast path): `browser` → jWeb, `mail` / `email` → jMail, `whiteboard` → jWhiteboard, etc. Canonical names: [arozos-desktop-shortcuts.md](arozos-desktop-shortcuts.md).

**Rebuild jChat subservice** after UI changes:

```bash
npm run build:hermes-chat
rsync -a --delete dist/hermes-chat/ .local/arozos-data/subservice/hermes-chat/app/
```

See [web-voice.md — Desktop presentation](vps-sandbox/web-voice.md#desktop-presentation-two-tiers).

## Voice

jChat uses **speech-to-speech** via `@joshu/voice-client` when voice-realtime is available (OpenAI Realtime or Gemini Live per `JOSHU_VOICE_PROVIDER`).

| Layer | Behavior |
| --- | --- |
| **Chat UI (typed)** | Fast path for `open …` app shortcuts (no Hermes); otherwise Hermes stream + tool cards |
| **Chat UI (voice)** | S2S transcript on casual turns; Hermes brain stream after `think` or `finish_dictation` |
| **Voice** | OpenAI Realtime / Gemini Live — direct answers, `open_desktop`, dictation buffer (`start_dictation` → `finish_dictation`), or co-present summary after `think` |

Dictation (lists, meeting notes, rambling) starts only when the speaker explicitly asks Joshu to wait until they finish — see [voice-think-speak.md — Dictation sessions](vps-sandbox/voice-think-speak.md#dictation-sessions-lists-notes-rambling).

`npm run dev:arozos` autostarts voice-realtime on `:8792` when a voice API key (`OPENAI_API_KEY` or `GEMINI_API_KEY` with `JOSHU_VOICE_PROVIDER=gemini_live`) and `HERMES_API_KEY` are set.

| Method | Path | Purpose |
| ------ | ---- | ------- |
| `GET` | `/api/voice/status` | Whether browser voice is available |
| `GET` | `/api/voice/session?chatSessionId=…` | Returns `{ wsUrl }` for the WebSocket client |

**Local dev:**

```bash
npm run dev:arozos          # Joshu + Hermes + voice-realtime
npm run dev:hermes-chat     # optional standalone UI
```

**Env:**

```bash
JOSHU_VOICE_MODE=realtime_s2s
JOSHU_WEB_VOICE_ENABLED=true
OPENAI_API_KEY=...
HERMES_API_KEY=...
TWILIO_MEDIA_STREAM_SECRET=...   # hex; browser WSS token
JOSHU_VOICE_WSS_HOST=127.0.0.1:8788   # dev: Joshu proxies voice, not ArozOS :8787
# VPS: JOSHU_VOICE_WSS_DIRECT=false (bootstrap default) — session wsUrl must be wss://<box>/voice-rt/…
```

`/api/voice/session` returns `wsUrl` for `@joshu/voice-client`. On VPS the browser must get a **public** `wss://` URL (Caddy → `:8792`), not `ws://127.0.0.1:8792`. See [web-voice.md — Browser WSS URL](vps-sandbox/web-voice.md#browser-wss-url-apivoicesession--wsurl).

Phone PSTN uses the same `voice-realtime` service on `:8792` — see [voice-realtime.md](vps-sandbox/voice-realtime.md).

Client behavior (`apps/hermes-chat/src/main.tsx`, `@joshu/voice-client`):

- Connects when `/api/voice/status` reports `available: true`
- `think_job_start` clears the assistant bubble before Hermes streams; Realtime transcript is never shown in jChat
- **Mic** (in-window toolbar) opens a **Realtime S2S** session via `voice-realtime`; spoken replies come from the provider, not a separate typed-chat TTS path
- **Taskbar mic** toggles voice on the **docked** companion only; audio level is mirrored to the tray VU meter via `jchat:tray`. Floating windows use their own in-window Mic.
- Typed chat is **text-only**; use **Mic** for spoken interaction

## Companion persona (portrait + avatar)

jChat loads companion identity from `GET /joshu/api/instance/identity` ([`useIdentity.ts`](../apps/hermes-chat/src/useIdentity.ts)):

| Field | Used for |
| --- | --- |
| `avatarUrl` | **Preferred** — gravatar-style headshot (Nano Banana 2 from onboarding) |
| `imageUrl` | Fallback — full Ideogram portrait |
| `name` | Assistant display name in header |
| `voiceId` | Gemini Live voice when `JOSHU_VOICE_PROVIDER=gemini_live` |

The taskbar tray uses the same `avatarUrl` → `imageUrl` precedence (see **ArozOS taskbar tray** above). Email signatures use **`imageUrl` only** (full portrait) — see [self-host.md#identity-without-control-plane](self-host.md#identity-without-control-plane).

## Streaming

The first version uses:

```text
POST /v1/chat/completions
stream: true
```

Hermes sends normal chat-completion delta chunks plus named
`hermes.tool.progress` SSE events. Joshu normalizes those into app-level SSE
events:

- `session` - the Hermes session id.
- `delta` - assistant text.
- `reasoning` - model reasoning text when the upstream stream exposes it.
- `tool` - tool lifecycle cards with name, label, emoji, call id, and status.
- `done` - stream complete.
- `error` - stream failed.

## Session Semantics

Each **window** (and each in-window **New chat**) is its own Hermes session. The frontend creates a random session id per iframe load (and again on **New chat**) and sends it on each request. Joshu forwards it to Hermes as `X-Hermes-Session-Id`. Follow-up messages in that window continue the same transcript; a second jChat window does not share it. Past chats remain available from the history drawer (`session_search` on other surfaces).

## Local Development

Run the full ArozOS topology:

```bash
npm run dev:arozos
```

Open `http://127.0.0.1:8787`, log into ArozOS, then launch **jChat** (module name `jChat`; legacy label “Hermes Chat”).

For standalone frontend iteration:

```bash
npm run dev:hermes-chat
```

Standalone mode expects the Joshu backend at `/joshu/api/hermes-chat`. Override
that with `VITE_HERMES_CHAT_API_BASE` when needed.

## Docker image packaging

`deploy/RELEASE.json` produces `dist/hermes-chat/` (either built **inside** the image or copied from **local `dist/`** in fast mode — see **`docs/hitl-camofox-notes.md`**) and syncs assets into:

```text
/opt/arozos-template/subservice/hermes-chat/app/
```

`deploy/scripts/vps-start.sh` refreshes the subservice from the image template into
the persistent ArozOS data volume on every boot. It also refreshes the Hermes
Chat desktop shortcut because the ArozOS volume preserves existing user
desktops.

For quick image rebuilds when you only changed Joshu (**including voice UI or
`src/server.ts` routes**):

```bash
npm run vps:build-image   # npm run build:deploy locally, then prebuilt dist/=1
```

Use **`npm run vps:build-image`** for a fully self-contained in-image **`npm ci` +
tsc + Vite** build (better when the host has no toolchain or CI builds the
image).

## Troubleshooting

### App Does Not Appear On The Desktop

Check both registration layers:

1. The subservice folder must contain `.startscript`. Without it, ArozOS tries
   to launch a native binary like `hermes-chat_darwin_arm64`; the `start.sh`
   static server never runs, and ArozOS does not register the module.
2. The current user's desktop must contain `jChat.shortcut` (install helper removes legacy `Hermes Chat.shortcut`). Adding a new module does not automatically rewrite existing persisted desktops.

The local fix is to restart the parity stack so ArozOS rescans subservices:

```bash
npm run dev:arozos
```

Healthy startup logs should include:

```text
[Subservice] Subservice Registered: jChat
[joshu-hermes-chat] serving .../subservice/hermes-chat/app on 127.0.0.1:<port>
```

## Telephony (Twilio PSTN)

Inbound phone calls use **Twilio Programmable Voice** + Media Streams into **voice-realtime** (Gemini Live or OpenAI Realtime), not the jChat browser mic path.

**Self-host setup** (buy a number, Console webhook, `instance.env`, recreate stack): [`vps-sandbox/twilio-self-host.md`](vps-sandbox/twilio-self-host.md).

Runtime / passphrase / lock clips: [`vps-sandbox/voice-realtime.md`](vps-sandbox/voice-realtime.md) · owner UI: [`telephone-arozos-app.md`](telephone-arozos-app.md).

Quick reference — with `JOSHU_VOICE_MODE=realtime_s2s`:

| Piece | Value |
| --- | --- |
| Voice webhook (POST) | `https://<host>/joshu/api/twilio/voice/inbound` |
| Media Stream WSS | `wss://<host>/voice-rt/media/<hex-secret>` (secret in **path**) |
| Required env | `TWILIO_AUTH_TOKEN`, `TWILIO_MEDIA_STREAM_SECRET`, `TWILIO_VOICE_WEBHOOK_URL`, `TWILIO_THINK_PASSWORD` |

## Composio app connections (Gmail, GitHub, Slack, …)

jChat can connect third-party accounts through [Composio](https://docs.composio.dev/docs)
so Hermes can call their tools via MCP (search email, create issues, post to Slack, etc.).

**Intended workflow:** connect once in the **Connectors** desktop app (OAuth in a pop-up tab).
jChat has **Open Connectors** only — no inline OAuth UI. After connecting, the **sandbox keeps working**
— Hermes gateway, cron, voice, or any other Joshu path can use those connections without keeping
Connectors open. Composio holds and refreshes OAuth tokens; Joshu/Hermes only need `COMPOSIO_API_KEY`
and a persisted tool-router session on disk.

### Setup

Add to Joshu env (see [`.env.example`](../.env.example); VPS: `/etc/joshu/instance.env`):

```bash
COMPOSIO_API_KEY=...          # https://app.composio.dev → project settings
# Optional: providers shown before search (comma-separated slugs)
# JOSHU_COMPOSIO_FEATURED_TOOLKITS=gmail,github,slack,notion,googlecalendar
```

Restart Joshu / `dev:arozos`. jChat status shows `composio.enabled: true` from
`GET /api/hermes-chat/status`. Rebuild jChat after UI changes: `npm run build:hermes-chat`.

### UI flow

1. Open **Connectors** on the ArozOS desktop (or jChat → **Open Connectors**).
2. **Connect** tab → pick a provider → **Connect** (allow pop-ups if prompted).
3. Complete OAuth in the **new browser tab** (see **OAuth and ArozOS iframes** below).
4. Close the OAuth tab or refocus the desktop — Connectors refreshes; status should show **Connected**.
5. For **multiple Gmail accounts**, use **Connect apps** → **Connect another account** on the Gmail row.
6. Chat in jChat normally. For **finding mail**, skills direct Hermes to **gbrain** and **mcp-joshu-connectors**
   first; Composio Gmail remains available as fallback (see skill `joshu-mail` → `references/mail-search-order.md`).

Disconnect in Connectors revokes the Composio **connected account** for this sandbox.

See [`docs/connectors-arozos-app.md`](connectors-arozos-app.md).

### Architecture

```text
Browser (Connectors)  →  Joshu /api/connectors/composio/*  →  Composio API (OAuth + tokens)
Hermes gateway   →  mcp_servers.composio (HTTP MCP)    →  Composio tool-router (per user_id)
```

Joshu uses Composio’s **tool-router session** pattern (`composio.create(user_id)` /
`composio.use(session_id)`), then exposes `session.mcp.url` + headers to Hermes. See
[Configuring sessions](https://docs.composio.dev/docs/configuring-sessions.md) and
[Native tools vs MCP](https://docs.composio.dev/docs/native-tools-vs-mcp.md).

The Joshu API keeps one tool-router session for each box, and `getOrCreateComposioSession` in `src/composioApi.ts` follows these rules:

1. The process keeps the session in memory for 10 minutes, and parallel callers wait for one shared request. A Composio tool call (`composioToolsExecute`) therefore makes no session call of its own.
2. Joshu sends the toolkit auth configs to the session (`session.update`) only when they change. The store file keeps a key of the last auth configs that Joshu sent, so a restart does not send them again.
3. Joshu makes a new session only when Composio says that the stored session is not found (HTTP 404). A 409 ("Config version conflict") makes Joshu fetch the session again and retry the update one time. A 429 or another error fails the call and keeps the stored session.
4. Joshu writes `composio-session.json` to a temp file and renames it, so a reader never sees a half-written file.

The box also has a read session for the same Composio user (`readSession` in `composio-session.json`), with only read-only tools and the Composio workbench on. Joshu reuses it and sends it changed auth configs by the same rules. The Composio MCP guard runs the workbench on the read session only; see [`agent-safety.md`](agent-safety.md#architecture).

A box with four Gmail accounts made about 7,400 sessions in 20 hours (2026-10-20) before these rules. Each Gmail tool call sent the auth configs again, the parallel updates got 409, and the old code made a new session for each error, so Composio rate-limited the project. Test: `npm run test:composio-session-cache`.

Hermes config (written by `applyComposioMcpToHermesConfig` in `src/hermesApi.ts`):

- `mcp_servers.composio` — the URL of the local Composio MCP guard (`http://127.0.0.1:8796/mcp`), no headers, `connect_timeout: 120` (1800 with the action guard on), `enabled: true` when a session exists. The guard reads the upstream session URL and headers from the Joshu API; see [`agent-safety.md`](agent-safety.md#architecture)
- `toolsets` includes `mcp-composio` after `mcp-gbrain` and `mcp-joshu-connectors` (mail recall order in skills)

On each chat stream, Joshu calls `syncComposioHermesMcp` so the session/MCP block stays current.

### Where credentials live

| What | Stored where | Notes |
| ---- | ------------- | ----- |
| OAuth access/refresh tokens | **Composio cloud** (connected accounts) | Keyed by Composio project + `user_id`; Composio refreshes tokens |
| Tool-router `sessionId`, MCP URL | **`{AROZ_DATA}/files/users/{user}/.joshu/composio-session.json`** | Joshu metadata only — not the secrets |
| Hermes MCP client config | **`~/.hermes/config.yaml`** → `mcp_servers.composio` | Local Composio MCP guard URL only, no Composio key |

Composio **`user_id`** is **not** the jChat Hermes transcript id. Resolution order (`src/composioApi.ts`):

1. **`COMPOSIO_USER_ID`** when set (VPS: unique slug per box, e.g. `mybox`)
2. ArozOS desktop user from `AROZ_DATA/files/users/<email>/` → same as **`JOSHU_AROZ_USER`**
3. Fallback `joshu-local`

| Environment | Typical `user_id` | ArozOS login |
|-------------|-------------------|--------------|
| VPS (current provision) | Customer slug | Owner email (`JOSHU_AROZ_USER`) |
| Local dev | First non-`admin` user dir or `COMPOSIO_USER_ID` override | Your dev user |

One **box** = one Composio `user_id` (slug). Reusing the same owner email on multiple boxes without `COMPOSIO_USER_ID` shares Gmail OAuth across boxes — see [connectors.md](connectors.md).

**Not tied to ArozOS login:** Composio routes do not check desktop session cookies. Anyone
who can reach `/joshu/api/hermes-chat/*` on the box can list/connect (same as other
Hermes-chat APIs). Protect the sandbox network like any Joshu deployment.

### API routes

Canonical base: `/joshu/api/connectors/composio/` (see [`docs/connectors-arozos-app.md`](connectors-arozos-app.md)).

Legacy aliases under `/api/hermes-chat/composio/*` remain for older clients.

`GET /api/hermes-chat/status` also returns `composio: { enabled: true|false }`.

Implementation: `src/composioApi.ts`, `src/connectors/composioRoutes.ts`, UI `apps/connectors/`. Dependency: `@composio/core`.

### OAuth and ArozOS iframes

jChat runs inside an ArozOS **desktop iframe**. Navigating that iframe to Composio’s OAuth
URL fails with a browser error like *“Unsafe attempt to load URL … from frame”* because
Composio blocks embedding.

**Fix in product:** **Connect** opens OAuth with `window.open(redirectUrl, "_blank")`. The
parent window stays in the iframe; auth runs at top level in a new tab. After success,
Composio redirects to **`/joshu/oauth-done.html`** (“You're connected — you can close this tab”).

After OAuth, close the tab (or use **Close tab**). Connectors polls when the popup closes
and on `window` `focus`, then calls `POST …/composio/sync` / `post-connect` so Hermes
reloads MCP config.

### VPS / background operation

After a successful browser connect:

| Requirement | Why |
| ----------- | --- |
| `COMPOSIO_API_KEY` in instance env | Joshu + Hermes MCP client authenticate to Composio |
| Persistent volume | `composio-session.json`, `~/.hermes/config.yaml`, ArozOS user data survive reboot |
| Hermes gateway running or auto-start | `HERMES_API_AUTO_START=true` (default on VPS) |
| Active connected account in Composio | Disconnect in UI or Composio dashboard revokes access |

You do **not** need to stay logged into ArozOS or keep jChat open for Hermes to use Gmail/etc.
on later turns, cron jobs, or voice — as long as the gateway process can start and Composio
still has the connection for that `user_id`.

**VPS tip:** set `COMPOSIO_API_KEY`, `NYLAS_API_KEY`, and `COMPOSIO_USER_ID` in `/etc/joshu/instance.env` (or your compose env file). See [connectors.md](connectors.md) and [self-host.md](self-host.md).

### Troubleshooting Composio

| Symptom | Likely cause | Fix |
| ------- | ------------- | --- |
| **Open Connectors** disabled / Composio off | No `COMPOSIO_API_KEY` | Set env; restart Joshu; check `/joshu/api/connectors/composio/status` |
| `limit` must be ≤ 50 | Composio API cap | Already clamped in Joshu; upgrade if you forked an older build |
| OAuth iframe / `chromewebdata` error | OAuth opened inside iframe | Use current jChat build (popup tab); allow pop-ups |
| Pop-up blocked | Browser policy | Allow pop-ups for the ArozOS host; retry **Connect** |
| Connected in UI but Hermes can’t use tools | Stale gateway MCP | Close OAuth tab (triggers sync) or `POST …/composio/sync` with `restartGateway: true` |
| Local shows Connected; VPS (or vice versa) does not | Different `COMPOSIO_API_KEY` projects; same `COMPOSIO_USER_ID` is not enough | Compare key prefixes; see [connectors-arozos-app — Local laptop vs fleet](connectors-arozos-app.md#local-laptop-vs-fleet-box-composio) |
| Disconnect 502 / `ConnectedAccount_ResourceNotFound` | Stale toolkit disk cache with ghost `ca_…` ids | Delete `.joshu/composio-toolkits-cache.json`; hard-refresh; current Joshu reconciles live connection state on list |
| jChat shows 1–3 connectors tools; `project_kanban_*` missing | Partial MCP catalog at gateway boot | `:8795/health` OK but Hermes registered tools before MCP was ready — nudge `GET …/hermes-chat/status?after_mcp_boot=1` or recreate stack; **new** jChat session after fix |
| Works until reboot | Missing persistent `composio-session.json` or wiped `~/.hermes` | Ensure `AROZ_DATA` / `joshu_hermes` volumes mount correctly on VPS |
| Gmail still connected after “factory reset” | OAuth tokens live in **Composio cloud**, not only local `.joshu/` | Use **hard** factory reset ([`box-state.md`](box-state.md#hard-factory-reset)); or `npx tsx scripts/box-wipe-connectors.ts` |
| Mail mirrors reappear ~10m after wipe | Connector cron + Composio still connected | Disconnect Composio accounts first (hard reset preflight) — see [`connectors.md`](connectors.md#hard-factory-reset) |

In-chat auth fallback: Hermes can still prompt for a Composio Connect Link via
`COMPOSIO_MANAGE_CONNECTIONS` if a tool needs a provider you have not connected in the modal.
Pre-connecting in the **Connectors** app avoids that during normal use.

## Current Non-goals

- No file persistence bridge to ArozOS storage.
- No direct browser calls to Hermes Agent.
- No wholesale port of `~/hermes-workspace`; that repo remains
  a reference for UI patterns only.
