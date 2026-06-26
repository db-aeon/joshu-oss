# DO sandbox + auto Twilio number smoke test

Run after control-plane and GHCR image are configured ([`control-plane-local-provisioning.md`](../docs/vps-sandbox/control-plane-local-provisioning.md)).

## Control plane env

```dotenv
VPS_PROVIDER=digitalocean
DIGITALOCEAN_API_TOKEN=...
DIGITALOCEAN_REGION=nyc3
TWILIO_ACCOUNT_SID=...
TWILIO_AUTH_TOKEN=...
TWILIO_AUTO_PROVISION=true
DEFAULT_TWILIO_AUTH_TOKEN=<same auth token for sandbox instance.env>
DEFAULT_OPENROUTER_API_KEY=...
```

## Steps

1. Start control plane: `npm run control-plane:dev`
2. Create + provision instance with `vpsProvider: digitalocean` (admin UI or API)
3. Wait for instance **active** + agent heartbeats
4. Confirm `PhoneNumber` row:

```bash
curl -s "$CONTROL_PLANE_URL/api/admin/instances/$INSTANCE_ID" \
  -H "x-admin-key: $ADMIN_API_KEY" | jq '.phoneNumbers'
```

5. Or force Twilio step:

```bash
curl -X POST "$CONTROL_PLANE_URL/api/admin/instances/$INSTANCE_ID/provision-twilio" \
  -H "x-admin-key: $ADMIN_API_KEY"
```

6. Call the returned `e164`; verify logs on VPS: `[twilio-phone] transcript`

7. Destroy instance and confirm number released:

```bash
curl -X POST "$CONTROL_PLANE_URL/api/admin/instances/$INSTANCE_ID/destroy" \
  -H "x-admin-key: $ADMIN_API_KEY"
```

## Realtime voice with OpenAI STT/TTS (optional)

On the droplet, set `JOSHU_VOICE_MODE=realtime`, `VOICE_STT_PROVIDER=openai`, `VOICE_TTS_PROVIDER=openai`, inject `OPENAI_API_KEY`, and enable compose profile `voice`. Provision already sets `TWILIO_MEDIA_STREAM_WSS_URL` to `wss://<host>/voice/media?token=...` in realtime mode.

Models: [gpt-realtime-whisper](https://developers.openai.com/api/docs/models/gpt-realtime-whisper) (STT), [gpt-4o-mini-tts](https://developers.openai.com/api/docs/models/gpt-4o-mini-tts) (TTS). Hermes still owns the LLM/tools layer.

See [`voice-realtime.md`](../docs/vps-sandbox/voice-realtime.md).
