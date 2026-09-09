# Twilio phone (PSTN) — self-host setup

Give your Joshu box a real phone number with **Twilio Programmable Voice** + Media Streams. This guide is for **standalone OSS self-host** (you own the Twilio account). Managed fleet boxes get Twilio from the control plane automatically.

**Prerequisites:** a working VPS from [`hetzner-quickstart.md`](hetzner-quickstart.md) (HTTPS hostname, `voice-rt` image running, Gemini or OpenAI key for voice). Browser mic in jChat does **not** require Twilio.

Architecture and call UX (passphrase, lock clips): [`voice-realtime.md`](voice-realtime.md) · [`voice-think-speak.md`](voice-think-speak.md) · [`telephone-arozos-app.md`](../telephone-arozos-app.md).

---

## What you will configure

| Piece | Where |
| --- | --- |
| Twilio account + phone number | [Twilio Console](https://console.twilio.com/) |
| Voice webhook (HTTPS POST) | Twilio number → Joshu inbound URL |
| Secrets + URLs | `/etc/joshu/instance.env` on the VPS |
| Spoken unlock passphrase | `TWILIO_THINK_PASSWORD` (or Telephone desktop app) |

Joshu does **not** buy numbers for self-hosters. You buy the number; Joshu answers it.

---

## 1. Twilio account and number

1. Create or sign in at [console.twilio.com](https://console.twilio.com/).
2. **Phone Numbers → Buy a number** with **Voice** capability (SMS optional).
3. Open **Account → API keys & tokens** and copy the **Primary Auth Token** for the account (or subaccount) that owns the number. That value is `TWILIO_AUTH_TOKEN`.
4. Note the number in **E.164** (e.g. `+15551234567`) for `TWILIO_PHONE_NUMBER` (Telephone app display).

---

## 2. Generate a media-stream secret

This is **not** from Twilio. Joshu puts it in the Media Stream WebSocket path so proxies cannot strip it:

```bash
openssl rand -hex 32
```

Use hex only — base64 (`+` `/` `=`) breaks path tokens.

---

## 3. Set webhook in Twilio Console

On the number → **Voice Configuration** → **A call comes in**:

| Field | Value |
| --- | --- |
| Webhook | `https://mybox.example.com/joshu/api/twilio/voice/inbound` |
| Method | **HTTP POST** |

Replace `mybox.example.com` with your box hostname. The path must include `/joshu`. Do **not** use the Messaging webhook.

This URL must match `TWILIO_VOICE_WEBHOOK_URL` in `instance.env` **character-for-character** (Joshu validates `X-Twilio-Signature` against it). Prefer **no** trailing slash unless the console URL also has one.

---

## 4. Edit `/etc/joshu/instance.env`

SSH to the box and add (or uncomment) at least:

```bash
# Voice stack (S2S) — required for PSTN Media Streams via voice-realtime
JOSHU_VOICE_MODE=realtime_s2s
JOSHU_VOICE_PROVIDER=gemini_live   # or openai (needs OPENAI_API_KEY)

# Twilio
TWILIO_AUTH_TOKEN=<Primary Auth Token from console>
TWILIO_MEDIA_STREAM_SECRET=<output of openssl rand -hex 32>
TWILIO_VOICE_WEBHOOK_URL=https://mybox.example.com/joshu/api/twilio/voice/inbound
TWILIO_MEDIA_STREAM_WSS_URL=wss://mybox.example.com/voice-rt/media/<same-secret>
TWILIO_THINK_PASSWORD=harbor lantern
TWILIO_PHONE_NUMBER=+15551234567

# Optional
# TWILIO_OWNER_CALLER=+15559876543   # your cell — or set it in Telephone; slightly different greeting for others
```

### Required for PSTN

Inbound routes stay **disabled** until all of these are set:

| Variable | Role |
| --- | --- |
| `TWILIO_AUTH_TOKEN` | Signature check on inbound webhook |
| `TWILIO_MEDIA_STREAM_SECRET` | Auth for `wss://…/voice-rt/media/<secret>` |
| `TWILIO_VOICE_WEBHOOK_URL` | Exact console Voice URL |
| `TWILIO_THINK_PASSWORD` | Spoken unlock passphrase (every call starts locked) |

Without a passphrase, Joshu logs `[twilio-phone] disabled … TWILIO_THINK_PASSWORD` and does not register routes.

### Media Stream URL shape

With `JOSHU_VOICE_MODE=realtime_s2s`, audio goes to **voice-realtime** (Caddy → `:8792`):

```text
wss://mybox.example.com/voice-rt/media/<TWILIO_MEDIA_STREAM_SECRET>
```

- Secret in the **path**, not `?token=` (many proxies strip query strings on WebSocket upgrades).
- Path is `/voice-rt/media/…` on the **hostname root** — not under `/joshu`.
- Set `TWILIO_MEDIA_STREAM_WSS_URL` explicitly to that URL (recommended). If omitted, Joshu may derive a **legacy** `/joshu/api/twilio/media-stream/…` URL, which is the wrong path for S2S.

### Passphrase tips

Prefer **two clear, multi-syllable words** (`harbor lantern`, `copper canyon`). Short words blur on phone ASR. You can change the phrase later in the **Telephone** desktop app without recreating containers — see [`telephone-arozos-app.md`](../telephone-arozos-app.md).

### Voice provider keys

| Provider | Key |
| --- | --- |
| `gemini_live` (OSS default) | `GEMINI_API_KEY` — Welcome → Connect AI, or `instance.env` |
| `openai` | `OPENAI_API_KEY` in `instance.env` |

Also ensure `JOSHU_VOICE_IMAGE_REF` points at a published `joshu-oss-voice-realtime` image (set by bootstrap / release pins).

---

## 5. Recreate the stack

After editing `instance.env`:

```bash
set -a && source /etc/joshu/instance.env && set +a
bash /opt/joshu/deploy/scripts/render-caddyfile.sh /etc/joshu/instance.env

cd /opt/joshu/deploy
docker compose --env-file /etc/joshu/instance.env up -d --force-recreate joshu-stack
docker compose --env-file /etc/joshu/instance.env --profile voice-rt up -d --force-recreate voice-realtime
```

Confirm voice-realtime is up:

```bash
docker compose --env-file /etc/joshu/instance.env --profile voice-rt ps voice-realtime
curl -sS http://127.0.0.1:8792/health
```

---

## 6. Verify

1. **Health (from your laptop):**

   ```bash
   curl -sS https://mybox.example.com/joshu/api/twilio/health
   ```

   Expect `{ "ok": true, "hermesReady": true, … }`. A **404** means routes are still disabled (missing one of the four required env vars) or the stack was not recreated after edits.

2. **Call the Twilio number.** You should hear a passphrase prompt (from a pre-rendered lock clip when clips are ready).

3. **Say the passphrase**, then a task (e.g. “What’s on my calendar?”).

4. **Logs on the box:**

   ```bash
   docker compose --env-file /etc/joshu/instance.env logs -f --tail=100 joshu-stack voice-realtime 2>&1 | grep -E 'twilio-phone|voice-realtime'
   ```

   Look for inbound `200`, Media Stream start, then `[voice-realtime]` session / auth lines.

Desktop: open **Telephone** to confirm the displayed number and view/change the passphrase.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| No answer / Twilio error on webhook | Wrong Voice URL or stack down | Console URL = `TWILIO_VOICE_WEBHOOK_URL`; HTTPS works for `/joshu/api/twilio/health` |
| `403` / invalid signature | Auth token or URL mismatch | Primary Auth Token for the account that owns the number; URL exact match |
| Inbound `200` then immediate hangup | WSS never authenticated | Set path-style `TWILIO_MEDIA_STREAM_WSS_URL`; recreate stack after secret change |
| `[twilio-phone] disabled` | Missing required env | All four: auth token, media secret, webhook URL, think password |
| `ws rejected bad token` / `tokenLen=0` | Query token stripped or secret mismatch | Path token; same hex in env and WSS URL |
| voice-realtime not running | Profile / image | `--profile voice-rt`; `JOSHU_VOICE_IMAGE_REF` set; pull + recreate |
| Passphrase never unlocks | Hard-to-hear phrase / STT drift | Multi-syllable words; grep `auth passphrase rejected` / `heardPreview` |
| Silent or paraphrased lock lines | Clips missing | [`voice-realtime.md` — lock prompts](voice-realtime.md#deterministic-lock-prompts) |

More runtime symptoms: [`voice-realtime.md` — Troubleshooting](voice-realtime.md#troubleshooting).

---

## Local development

Same Twilio Console wiring, with a tunnel instead of your VPS hostname.

1. Set in repo-root `.env` (see [`.env.example`](../../.env.example)):

   ```dotenv
   PUBLIC_BASE_PATH=/joshu
   JOSHU_VOICE_MODE=realtime_s2s
   TWILIO_AUTH_TOKEN=...
   TWILIO_MEDIA_STREAM_SECRET=<openssl rand -hex 32>
   TWILIO_VOICE_WEBHOOK_URL=https://<tunnel-host>/joshu/api/twilio/voice/inbound
   TWILIO_MEDIA_STREAM_WSS_URL=wss://<tunnel-host>/voice-rt/media/<same-secret>
   TWILIO_THINK_PASSWORD=harbor lantern
   OPENAI_API_KEY=...   # or GEMINI_API_KEY for gemini_live
   HERMES_API_KEY=...   # match Hermes gateway
   ```

2. Tunnel **Joshu `:8788`**, not ArozOS `:8787`:

   | Terminal | Command |
   | --- | --- |
   | 1 | `npm run dev:arozos` |
   | 2 | `npm run voice-realtime:dev` (if not autostarted) |
   | 3 | `ngrok http 8788` **or** `npm run twilio-local:proxy` + `npm run twilio-local:ngrok` |

3. Point the Twilio Voice webhook at the tunnel HTTPS URL (same path as above). Helpers:

   ```bash
   npm run twilio-local:urls
   npm run twilio-local:env    # merge .env.twilio.local — restart Joshu after
   npm run twilio-local:check
   ```

When the tunnel host changes, update the console webhook and `TWILIO_*` URLs, then restart Joshu.

---

## Compliance

Treat the number like any public voice channel: follow Twilio / carrier rules on consent and recording, restrict who you publish the number to, and rotate `TWILIO_MEDIA_STREAM_SECRET` if it leaks.

### SMS / A2P 10DLC (optional)

US outbound SMS to mobile phones from a US 10DLC number requires **A2P Brand + Campaign** on the Twilio account that owns the number (otherwise carriers return error **30034**).

- **OSS self-host:** register in [Twilio Console / A2P docs](https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/quickstart) on your own account. Attach the number to a Messaging Service after Campaign **VERIFIED**.
- **Managed fleet:** per-box subaccount registration — private managed fleet A2P runbook (not in OSS) runbook (not published in OSS).

**Joshu SMS gateway (2026-08-25):** when A2P and env are set, Joshu registers `POST /joshu/api/twilio/sms/inbound` — owner-only inbound SMS → Hermes chat → SMS reply. Configure on the Twilio number:

| Twilio console | Value |
|----------------|--------|
| **SMS webhook** (POST) | `https://<your-host>/joshu/api/twilio/sms/inbound` |

Box env (in addition to voice vars):

```bash
TWILIO_ACCOUNT_SID=AC…                    # account that owns the number
TWILIO_AUTH_TOKEN=…
TWILIO_PHONE_NUMBER=+1…
TWILIO_MESSAGING_SERVICE_SID=MG…          # recommended after A2P
TWILIO_SMS_WEBHOOK_URL=https://<host>/joshu/api/twilio/sms/inbound
TWILIO_OWNER_CALLER=+1…                   # optional env fallback; or set owner mobile in Telephone
```

Health: `GET /joshu/api/twilio/sms/health` (env only — not delivery). Keywords STOP / HELP / START are handled locally.

**Outbound length (2026-09-08):** Joshu GSM-folds Unicode (em-dash → `-`) and caps bodies at **640 characters**. US carriers reject long concatenated SMS (Twilio **30019**, often 10+ UCS-2 segments). If inbound is 200 but the owner never gets a reply, check the Twilio Messages list for `undelivered` / **30019**.

When action guard is enabled, inbound **short** Y / N (also `yes`/`no`/`ok`/`okay`/`approve`/`deny`, or those plus a few words) is consumed as HITL approval **before** Hermes chat. Conversational SMS starting with “Ok …” / “Yes …” is **not** an approval. If nothing is pending, the message falls through to chat — see [`agent-safety.md`](../agent-safety.md#owner-approval-sms).

**Hermes tool surface:** SMS uses the same **`api_server`** pipe and **`platform_toolsets.api_server`** as jChat. Apply `scripts/patch-hermes-kanban-guidance-gate.py` via `apply-hermes-kanban-guidance-gate.sh` at boot so the Kanban worker system prompt does not leak onto owner chat. Optional: `TWILIO_SMS_SYSTEM_PROMPT` for per-box SMS copy.

**Hermes admin `[sms] Refusing to start`:** Joshu owns SMS ingress via `TWILIO_SMS_WEBHOOK_URL` — not Hermes’ separate `SMS_WEBHOOK_URL` platform. Apply `patch-hermes-joshu-disable-native-sms-platform.py` (or boot via `vps-start.sh`) so Hermes admin stays quiet; do not point Twilio at Hermes’ native SMS webhook unless you bypass Joshu intentionally.

---

## Related

| Doc | Topic |
| --- | --- |
| [`voice-realtime.md`](voice-realtime.md) | S2S service, passphrase UX, lock clips |
| [`voice-think-speak.md`](voice-think-speak.md) | When Realtime speaks vs Hermes `think` |
| [`telephone-arozos-app.md`](../telephone-arozos-app.md) | Number display + passphrase UI |
| [`agent-safety.md`](../agent-safety.md#owner-approval-sms) | Short Y/N SMS approvals vs conversational “Ok …” |
| [Twilio A2P 10DLC](https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/quickstart) | SMS compliance (self-host); managed fleet has a private per-box runbook |
| [`hetzner-quickstart.md`](hetzner-quickstart.md) | Box install before Twilio |
| [`.env.example`](../../.env.example) / [`deploy/.env.vps.example`](../../deploy/.env.vps.example) | Env knobs |
