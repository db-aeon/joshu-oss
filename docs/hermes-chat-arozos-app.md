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

All three share toolsets, MCP catalog, SOUL.md, and Hindsight auto-recall. They do **not** share transcript history unless you explicitly hand off sessions (`/handoff` on gateway platforms). Slack setup: [hermes-integration — Slack chat](hermes-integration.md#slack-chat-hermes-messaging-gateway). Telegram: [hermes-integration — Telegram & jChat](hermes-integration.md#telegram-11-chat-hermes-messaging-gateway).

### System prompt layers

Each turn, jChat POSTs `sessionId` + a **minimal** client system message (mail/tools hints in [`apps/hermes-chat/src/main.tsx`](../apps/hermes-chat/src/main.tsx)) and **only the latest user message** — not the full UI transcript. Hermes merges server-side session history and adds its own cached system prompt: companion `SOUL.md`, desktop `HERMES.md`, **`<available_skills>`** (truncated `description` per skill, ≤60 chars), then tool guidance. The model must call **`skill_view(name)`** to load a full `SKILL.md`; nothing in Joshu auto-selects EA skills when the conversation drifts. Details: [hermes-integration — Skill catalog](hermes-integration.md#skill-catalog-descriptions-and-skill_view), [ea-for-joshu — EA skills in jChat](executive-assistant.md#ea-skills-in-jchat-catalog--skill_view).

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
styled in [`aroz-paper-shell.css`](../arozos/web-overlays-vanilla/aroz-vanilla-shell.css)).

Layout (left → right, immediately left of the clock): **VU meter · mic · avatar**.

| Control | Behavior |
| --- | --- |
| **Avatar** | Toggle jChat: opens or focuses the docked window when hidden; adds `jp-jchat-dock-hidden` on the float window when open (required because dock CSS uses `display: flex !important`, which blocks jQuery `fadeOut`). |
| **Mic** | Toggle Realtime voice mode. Posts `jchat:voice-toggle` into the jChat iframe; opens jChat first if needed. Disabled when `/api/voice/status` reports unavailable. |
| **VU meter** | Winamp-style level bars driven by `@joshu/voice-client` `onAudioLevel` (mic while listening, playback while speaking). Grayed out when voice is off. |

**Persona:** tray and jChat iframe both load `GET /joshu/api/instance/identity`; portrait precedence is `avatarUrl` → `imageUrl` (see [self-host.md#identity-without-control-plane](self-host.md#identity-without-control-plane)). Email signatures use **`imageUrl` only**.

**Shell ↔ iframe IPC** ([`apps/hermes-chat/src/traySync.ts`](../apps/hermes-chat/src/traySync.ts)):

| Direction | Message | Payload |
| --- | --- | --- |
| iframe → shell | `jchat:tray` | `assistantName`, `portraitUrl`, optional `notification`, `voiceInputOn`, `voiceAvailable`, `audioLevel` |
| shell → iframe | `jchat:voice-toggle` | (none) — toggles voice mode in `main.tsx` |

When a new assistant reply completes, jChat sends `notification` text; the shell shows a toast above the taskbar (click opens jChat; does not close an open window).

Applied with `scripts/apply_arozos_joshu_theme.py` on each `dev-arozos` / deploy boot (cache-busted `?v=` on overlay JS/CSS).

## Desktop presentation (two tiers)

jChat can open ArozOS apps and files on the user's screen without asking them to click icons manually. Shared client code: [`apps/hermes-chat/src/desktopActions.ts`](../apps/hermes-chat/src/desktopActions.ts) (`openModule`, `newFloatWindow`).

| Tier | Surface | Trigger | Path |
| --- | --- | --- | --- |
| **Fast — typed** | Text chat | `open the mail app`, `open jWeb`, … | Client regex in `matchQuickDesktopOpen()` → `executeDesktopAction()` — **no Hermes stream** |
| **Fast — voice** | Voice (S2S) | “open browser”, “open email”, … | Realtime `open_desktop` → `desktop_action` wire event → same executor |
| **Brain** | Text + voice | Specific file, search, calendar content | Hermes `desktop_open` tool → Joshu queue → `desktop_action` SSE |

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
| **Chat UI (voice)** | S2S transcript on casual turns; Hermes brain stream after `think` |
| **Voice** | OpenAI Realtime / Gemini Live — direct answers, `open_desktop`, or co-present summary after `think` |

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
- **Mic** (in-window toolbar and taskbar tray) disabled when voice-realtime is unavailable
- Taskbar mic toggles the same voice session; audio level is mirrored to the tray VU meter via `jchat:tray`
- Typed-chat **Speech** toggle still uses Hermes TTS via `/api/hermes-chat/tts` (separate from voice mode)

## Companion persona (portrait + avatar)

jChat loads companion identity from `GET /joshu/api/instance/identity` ([`useIdentity.ts`](../apps/hermes-chat/src/useIdentity.ts)):

| Field | Used for |
| --- | --- |
| `avatarUrl` | **Preferred** — gravatar-style headshot (Nano Banana 2 from onboarding) |
| `imageUrl` | Fallback — full Ideogram portrait |
| `name` | Assistant display name in header |
| `voiceId` | Gemini Live voice when `JOSHU_VOICE_PROVIDER=gemini_live` |

The taskbar tray uses the same `avatarUrl` → `imageUrl` precedence (see **ArozOS taskbar tray** above). Email signatures use **`imageUrl` only** (full portrait) — see [self-host.md#identity-without-control-plane](self-host.md#identity-without-control-plane).

## Typed-chat TTS (Speech toggle)

When Voice mode is off, jChat can read assistant replies aloud via Hermes TTS:

| Method | Path | Purpose |
| ------ | ---- | ------- |
| `POST` | `/api/hermes-chat/tts` | JSON `{ text }` → audio stream |

UI:

- **Mic** (chat toolbar or taskbar tray) — Enables Realtime S2S capture; segments end on silence thresholds from Hermes **`voice`** config (defaults can be fetched from **`voice-settings`**).
- **Speech** — After each completed assistant bubble, converts visible assistant **markdown** to plain text → **`POST …/tts`**. Playback pauses mic capture briefly to reduce echo.

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

One app launch equals one fresh session. The frontend creates a random launch
session id and sends it on each request. Joshu forwards it to Hermes as
`X-Hermes-Session-Id`, so follow-up messages in the same browser app instance
continue the same Hermes transcript without adding a session manager yet.

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

### Voice: TTS returns 400 Bad Request

Joshu **`POST /api/hermes-chat/tts`** responds **400** when **`JSON.text`** is
missing or empty after normalization. Check Joshu logs for a line beginning
with **`[joshu] tts:`** — it logs why the body was rejected.

Common causes:

- Assistant reply is **markdown-only** (for example fenced code fills the bubble
  such that plaintext for TTS is empty after stripping).
- Stale bundles: rebuild **`apps/hermes-chat`** and **`src/server`** and redeploy
  (prefer **`npm run vps:build-image`** after **`npm run build:deploy`** so
  `dist/` matches your tree).

Hermes subprocess failures (misconfigured TTS, network, etc.) show as **502** with
JSON error text, not **400**.

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

> **Status:** Twilio PSTN is implemented for OpenAI Realtime and Gemini Live (`JOSHU_VOICE_PROVIDER=gemini_live`). Expect rough edges (latency, VAD tuning) until exercised on your line.

Joshu can expose the **same Hermes Chat voice + completion pipeline** on a real phone number using **Twilio Programmable Voice** with **bidirectional Media Streams** (μ-law 8 kHz WebSocket audio).

Configure Twilio to `POST` the voice webhook to the **exact** URL that Joshu exposes (including `PUBLIC_BASE_PATH`, e.g. `/joshu`). Joshu validates `X-Twilio-Signature` against **`TWILIO_VOICE_WEBHOOK_URL`** (must match the configured webhook character-for-character).

### Environment

Set in Joshu’s environment (see [`.env.example`](../.env.example)):

| Variable | Purpose |
| -------- | ------- |
| `TWILIO_AUTH_TOKEN` | Primary Auth Token for signature validation on `POST /voice/inbound`. |
| `TWILIO_MEDIA_STREAM_SECRET` | Shared secret for Media Stream auth. Generate with `openssl rand -hex 32` (hex only — avoid base64 `+`/`=`). |
| `TWILIO_VOICE_WEBHOOK_URL` | Full HTTPS URL for the inbound voice webhook (example: `https://your-host/joshu/api/twilio/voice/inbound`). |
| `TWILIO_MEDIA_STREAM_WSS_URL` | Optional full `wss://` URL for `<Stream>`. If omitted, derived from `TWILIO_VOICE_WEBHOOK_URL`: `https` → `wss`, `/voice/inbound` → `/media-stream/<secret>` (secret in **path**, not `?token=` — required for ngrok and many proxies). |
| `TWILIO_PHONE_SYSTEM_PROMPT` | Optional system prompt tuned for spoken replies. |
| `TWILIO_HERMES_MODEL` | Optional Hermes chat model override (defaults like Hermes Chat). |

When these are unset, Twilio routes stay inactive and a short log explains what is missing.

### Endpoints

| Method | Path | Purpose |
| ------ | ---- | ------- |
| `POST` | `/api/twilio/voice/inbound` | Returns TwiML `<Connect><Stream url="wss://…"/></Connect>` after signature verification. |
| `GET` | `/api/twilio/health` | Confirms Hermes gateway readiness when phone routes are enabled. |
| WebSocket | `/api/twilio/media-stream` or `/api/twilio/media-stream/<secret>` | Bidirectional μ-law audio; secret in path (preferred) or `?token=` query must match `TWILIO_MEDIA_STREAM_SECRET`. |

### Behaviour

- Per-call Hermes session key: `phone:<CallSid>` (via `X-Hermes-Session-Key` / session id in `HermesApiRunner.streamHermesChat`).
- STT/TTS: same Hermes subprocess scripts as **`/api/hermes-chat/transcribe`** and **`/api/hermes-chat/tts`**.
- Outbound TTS is decoded with **`ffmpeg`** to mono PCM 8 kHz, then re-encoded to μ-law for Twilio. **Install `ffmpeg` on the host** for local/dev; the VPS sandbox image already includes it.

### Public URL / TLS

Twilio requires a **public HTTPS** webhook and **`wss:`** media URL. For local development, use a tunnel (e.g. ngrok, Cloudflare Tunnel) whose HTTPS URL matches **`TWILIO_VOICE_WEBHOOK_URL`**.

### Compliance / abuse

Treat production voice like any customer-facing channel: follow carrier rules on robocalling/recording consent, publish applicable notices, and restrict who can reach the number. The Media Stream WebSocket requires **`token`** (secret in URL); rotate **`TWILIO_MEDIA_STREAM_SECRET`** if it leaks.

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

Hermes config (written by `applyComposioMcpToHermesConfig` in `src/hermesApi.ts`):

- `mcp_servers.composio` — URL, `x-api-key` header, `connect_timeout: 120`, `enabled: true` when session exists
- `toolsets` includes `mcp-composio` after `mcp-gbrain` and `mcp-joshu-connectors` (mail recall order in skills)

On each chat stream, Joshu calls `syncComposioHermesMcp` so the session/MCP block stays current.

### Where credentials live

| What | Stored where | Notes |
| ---- | ------------- | ----- |
| OAuth access/refresh tokens | **Composio cloud** (connected accounts) | Keyed by Composio project + `user_id`; Composio refreshes tokens |
| Tool-router `sessionId`, MCP URL | **`{AROZ_DATA}/files/users/{user}/.joshu/composio-session.json`** | Joshu metadata only — not the secrets |
| Hermes MCP client config | **`~/.hermes/config.yaml`** → `mcp_servers.composio` | URL + API key header for the gateway |

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
parent jChat window stays in the iframe; auth runs at top level in a new tab.

After OAuth, close the tab or refocus the desktop window. jChat polls when the popup closes
and on `window` `focus`, then calls `POST …/composio/sync` with `restartGateway: true` so
Hermes reloads MCP config.

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
| jChat shows 1–3 connectors tools; `project_kanban_*` missing | Partial MCP catalog at gateway boot | `:8795/health` OK but Hermes registered tools before MCP was ready — nudge `GET …/hermes-chat/status?after_mcp_boot=1` or recreate stack; **new** jChat session after fix |
| Works until reboot | Missing persistent `composio-session.json` or wiped `~/.hermes` | Ensure `AROZ_DATA` / `joshu_hermes` volumes mount correctly on VPS |
| Gmail still connected after “factory reset” | OAuth tokens live in **Composio cloud**, not only local `.joshu/` | Use **hard** factory reset ([`box-state.md`](box-state.md#hard-factory-reset)); or `npx tsx scripts/box-wipe-connectors.ts` |
| Mail mirrors reappear ~10m after wipe | Connector cron + Composio still connected | Disconnect Composio accounts first (hard reset preflight) — see [`connectors.md`](connectors.md#hard-factory-reset) |

In-chat auth fallback: Hermes can still prompt for a Composio Connect Link via
`COMPOSIO_MANAGE_CONNECTIONS` if a tool needs a provider you have not connected in the modal.
Pre-connecting in the **Connectors** app avoids that during normal use.

## Current Non-goals

- No session list or resume UI.
- No file persistence bridge to ArozOS storage.
- No direct browser calls to Hermes Agent.
- No wholesale port of `~/hermes-workspace`; that repo remains
  a reference for UI patterns only.
