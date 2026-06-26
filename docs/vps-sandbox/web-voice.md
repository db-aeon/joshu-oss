# Web voice (browser / laptop)

Low-latency voice for Joshu desktop apps (jChat, jMail) via **speech-to-speech** (`voice-realtime`) — OpenAI Realtime or **Gemini Live** (`JOSHU_VOICE_PROVIDER=gemini_live`) for browser and PSTN.

**Core model:** [voice-think-speak.md](voice-think-speak.md) — when to **think** (Hermes) vs what to **say** (S2S speech).

See [joshu-identity.md](../joshu-identity.md) for platform vs assistant naming.

## Stack

| Surface | Service | Port / WSS | Upstream |
| --- | --- | --- | --- |
| **Phone (PSTN)** | `packages/voice-realtime` | `:8792` → `/voice-rt/media` | OpenAI or Gemini (`JOSHU_VOICE_PROVIDER`) |
| **Browser / laptop** | Same `voice-realtime` | **VPS:** Caddy `wss://<box>/voice-rt/media?token=…` → `:8792`. **Local dev:** Joshu `:8788` proxies `/voice-rt/*` → `:8792` (or direct `:8792` when browser is on localhost — see below) | OpenAI or Gemini (`JOSHU_VOICE_PROVIDER`) |

Implementation: [`packages/voice-realtime/`](../../packages/voice-realtime/). Shared browser client: [`packages/voice-client/`](../../packages/voice-client/).

## Selective voice + brain on screen

| Layer | Casual turn (no `think`) | Work turn (`think`) |
| --- | --- | --- |
| **Surface (jChat today)** | S2S output transcription | Hermes brain stream |
| **Voice** | S2S organic speech | Brief phrase + co-present summary after brain |

Wire protocol: [`voiceSurfaceSync.ts`](../../packages/voice-realtime/src/voiceSurfaceSync.ts) — includes `desktop_action` for opening apps/files on the ArozOS shell.

### Desktop presentation (two tiers)

| Tier | Surface | Trigger | Path |
| --- | --- | --- | --- |
| **Fast — typed** | jChat text | `open the mail app`, `open jWeb` | [`matchQuickDesktopOpen`](../../apps/hermes-chat/src/desktopActions.ts) → local `openModule()` — skips Hermes |
| **Fast — voice** | jChat / jMail mic | “open browser”, “open email”, … | Realtime `open_desktop` → `desktop_action` → [`desktopActions.ts`](../../apps/hermes-chat/src/desktopActions.ts) |
| **Brain** | Text + voice | File path, search, multi-step | `think` → Hermes `desktop_open` → Joshu enqueue → `desktop_action` SSE |

**Hermes path details:** Plugin [`.hermes/plugins/joshu-desktop/`](../../.hermes/plugins/joshu-desktop/) validates module/file targets and enqueues via `POST /joshu/api/desktop-actions/enqueue` in a **`post_tool_call` hook** (session id is available there). [`src/server.ts`](../../src/server.ts) drains on `desktop_open` tool completion and emits `desktop_action`; falls back to parsing the tool result JSON if the queue is empty.

**Config:** `JOSHU_HERMES_PLUGIN_NAMES` must include `joshu-desktop`. Gateway restart required after plugin updates.

Full jChat wiring: [hermes-chat-arozos-app.md — Desktop presentation](../hermes-chat-arozos-app.md#desktop-presentation-two-tiers).

See [voice-think-speak.md — Browser](voice-think-speak.md#browser--s2s-for-casual-speech-hermes-only-on-think).

### Brain only on `think`

| Event | Action |
| --- | --- |
| User transcript arrives | Store quote; arm organic surface sync — do **not** start brain |
| S2S `response.done` + `think` | Start one brain job; `voiceInject=true` |
| S2S `response.done`, no `think` | Finalize surface from S2S transcription |
| Late transcript after `think` already started | Skip — same utterance |

Hermes session key per job: `voice-think:{surfaceSessionId}:{jobId}` ([`brainThink.ts`](../../packages/voice-realtime/src/brainThink.ts)).

### One Realtime speech per brain answer (voice)

After `think`, function output is recorded **without** an immediate `response.create` (no duplicate spoken ack + inject summary). When Hermes SSE completes, `injectAssistantMessage` triggers a single co-present summary for audio.

Phone differs: handler injects **"One moment."** after `think` with `triggerResponse: false` on tool output. See [voice-think-speak.md](voice-think-speak.md) for desktop-access antipatterns, duplicate acks, and OpenAI dashboard notes.

## Barge-in (browser)

| Layer | Behavior |
| --- | --- |
| **Client** (`packages/voice-client`) | Barge-in only while `speaking`; requires consecutive loud frames (RMS ≥ 520); mic uplink muted during TTS so speaker bleed does not hit server VAD |
| **Server** | OpenAI `speech_started` triggers barge-in **only** while assistant is speaking; client `browser_interrupt` always wins |

Browser VAD is stricter than phone defaults (`threshold: 0.68`, `silence_duration_ms: 950`).

## Configuration

```bash
JOSHU_VOICE_MODE=realtime_s2s
JOSHU_WEB_VOICE_ENABLED=true
JOSHU_VOICE_PROVIDER=openai          # openai (default) | gemini_live (browser + PSTN)
HERMES_API_KEY=...
TWILIO_MEDIA_STREAM_SECRET=...         # hex; reused as browser WSS token
VOICE_REALTIME_URL=http://127.0.0.1:8792
JOSHU_VOICE_WSS_HOST=127.0.0.1:8788    # dev: browser WS via Joshu, not ArozOS :8787
JOSHU_VOICE_WSS_DIRECT=false           # VPS bootstrap default; see “Browser WSS URL” below
```

### Browser WSS URL (`/api/voice/session` → `wsUrl`)

[`src/voiceWebApi.ts`](../../src/voiceWebApi.ts) builds the URL the browser mic uses:

| Context | Typical `wsUrl` |
| --- | --- |
| **VPS / remote browser** | `wss://<CUSTOMER_DOMAIN>/voice-rt/media?token=…` (Caddy → `:8792`) |
| **Local dev (browser on localhost)** | `ws://127.0.0.1:8792/voice-rt/media?token=…` when `JOSHU_VOICE_WSS_DIRECT=auto` and both voice-realtime and the session request are loopback |
| **Local dev (ArozOS :8787)** | `ws://127.0.0.1:8788/voice-rt/media?token=…` via Joshu proxy — set `JOSHU_VOICE_WSS_HOST=127.0.0.1:8788` |

`JOSHU_VOICE_WSS_DIRECT` (`auto` \| `true` \| `false`):

- **`auto` (default):** bypass Joshu’s WebSocket proxy only when **both** `VOICE_REALTIME_URL` and the HTTP `Host` on `/api/voice/session` are loopback (local dev). On VPS, voice-realtime is also `127.0.0.1:8792` but the browser is remote — `auto` must **not** return a localhost `wsUrl`.
- **`false`:** always use the public origin (`wss://<box>/…` on VPS; Joshu proxy on dev). Set explicitly in [`sandboxEnv.ts`](../../apps/control-plane/src/lib/sandboxEnv.ts) bootstrap.
- **`true`:** always connect straight to `VOICE_REALTIME_URL` (rare; debugging only).

**Symptom:** jChat shows `Voice connection failed: Voice WebSocket failed to connect` while `/api/voice/status` is `available: true`. Check session API — bad `wsUrl` looks like `ws://127.0.0.1:8792/…` from a remote browser. Fix: image/dist with the loopback-client guard in `voiceWebApi.ts`, or `JOSHU_VOICE_WSS_DIRECT=false` + recreate `joshu-stack`. See [troubleshooting — browser voice WSS](troubleshooting-and-lessons.md#browser-voice-websocket-failed-to-connect-2026-06-24).

**OpenAI (default or PSTN):**

```bash
OPENAI_API_KEY=...
OPENAI_REALTIME_MODEL=gpt-realtime-2
OPENAI_REALTIME_VOICE=alloy
```

**Gemini Live (browser + PSTN):**

```bash
JOSHU_VOICE_PROVIDER=gemini_live
GEMINI_API_KEY=...
GEMINI_LIVE_MODEL=gemini-3.1-flash-live-preview
GEMINI_LIVE_VOICE=Kore                 # or JOSHU_VOICE_ID from identity (LLM-picked Gemini-TTS voice at onboarding)
```

OpenAI PSTN still needs `OPENAI_API_KEY` when `JOSHU_VOICE_PROVIDER=openai`. Gemini PSTN uses the same `JOSHU_VOICE_PROVIDER=gemini_live` as browser — see [voice-realtime.md — Gemini PSTN](voice-realtime.md#gemini-pstn-twilio).

Optional tuning:

```bash
VOICE_REALTIME_DEBUG=true              # full speech-instruct payloads + OpenAI events
VOICE_HERMES_PROGRESS_FIRST_DELAY_MS=10000   # long brain jobs only (browser + phone)
JOSHU_WEB_VOICE_SYSTEM_PROMPT=...      # Realtime instructions for desktop
```

WSS: `ws://127.0.0.1:8788/voice-rt/media?token=…` (Joshu proxies `/voice-rt/*` → `:8792`).

## Local dev

```bash
npm run dev:arozos   # autostarts voice-realtime when voice API key + HERMES_API_KEY are set
```

OpenAI: needs `OPENAI_API_KEY`. Gemini: set `JOSHU_VOICE_PROVIDER=gemini_live` and `GEMINI_API_KEY`.

Or manually: `npm run voice-realtime:dev`

## VPS (production / test box)

Production boxes read **`/etc/joshu/instance.env`**, not your laptop `.env`. Compose profile **`voice-rt`** runs `voice-realtime` on `:8792` from **`JOSHU_VOICE_IMAGE_REF`** (GHCR `joshu-voice-realtime:<version>` — same tag as `joshu-sandbox`). Admin **Update release** pulls both images via instance-agent.

**Hotpatch checklist (e.g. `patrick.box.joshu.me`)** when ahead of the last GHCR voice tag:

1. **Build + push** voice image: `JOSHU_IMAGE_TAG=0.1.24 JOSHU_IMAGE_PUSH=1 npm run vps:build-image` (pushes sandbox + voice-realtime).
2. **SSH** → ensure `/etc/joshu/instance.env` has `JOSHU_VOICE_IMAGE_REF=ghcr.io/db-aeon/joshu-voice-realtime:0.1.24` (admin update sets this automatically).
3. **Pull + recreate:**

   ```bash
   cd /opt/joshu/deploy
   docker compose -f docker-compose.yml --env-file /etc/joshu/instance.env pull voice-realtime
   docker compose -f docker-compose.yml --env-file /etc/joshu/instance.env --profile voice-rt \
     up -d --force-recreate voice-realtime
   ```

   Or queue **Update release** from admin (recommended once instance-agent with voice pull is deployed).

4. **Joshu API** (`dist/voiceWebApi.js`) — ships in `joshu-sandbox` image / `syncDistFromImage`; see [hotpatch-running-box.md](hotpatch-running-box.md).

5. **Verify:**

   ```bash
   curl -fsS http://127.0.0.1:8792/health | jq '{web, provider, model}'
   curl -fsS http://127.0.0.1:8788/joshu/api/voice/status | jq '{available, stack, provider}'
   curl -fsS -H "Host: ${CUSTOMER_DOMAIN}" -H "X-Forwarded-Proto: https" \
     "http://127.0.0.1:8788/joshu/api/voice/session?chatSessionId=probe" | jq '.wsUrl'
   # expect wss://${CUSTOMER_DOMAIN}/voice-rt/media?token=… — not ws://127.0.0.1:8792
   ```

   From browser: jChat mic → `stack: "gemini_live"`.

See [hotpatch-running-box.md](hotpatch-running-box.md) for dist vs image lanes.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/joshu/api/voice/status` | `{ available, stack, service }` |
| `GET` | `/joshu/api/voice/session?chatSessionId=…` | `{ wsUrl, transport, stack }` |
| `GET` | `/joshu/api/instance/identity` | Assistant persona (`name`, `owner`, `imageUrl` portrait, `avatarUrl` gravatar, `voiceId`) |
| `POST` | `/joshu/api/instance/sync-companion-identity` | Re-sync `identity.json` + `SOUL.md` from `instance.env` (localhost only) |

## Related

- [voice-think-speak.md](voice-think-speak.md) — when to think vs what to say (phone + browser)
- [voice-realtime.md](voice-realtime.md) — service architecture, PSTN, logging, VPS deploy
- [joshu-identity.md](../joshu-identity.md) — identity schema and terminology
- [hermes-chat-arozos-app.md](../hermes-chat-arozos-app.md) — jChat voice wiring
