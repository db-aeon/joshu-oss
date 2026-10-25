# VPS / Docker box stack

This directory documents running the Joshu **box stack** on a VPS or local Docker host.

The **control plane** (managed provisioning, customer portal at `hello.joshu.me`) is proprietary and not part of this repository. Self-hosters use [`../self-host.md`](../self-host.md) instead.

## Documents (public)

| Doc | Purpose |
| --- | --- |
| [`hetzner-quickstart.md`](hetzner-quickstart.md) | **Hetzner Ubuntu** self-host walkthrough (example build) |
| [`../self-host.md`](../self-host.md) | Standalone Docker bootstrap |
| [`runtime-topology.md`](runtime-topology.md) | How legacy assumptions map to Compose |
| [`../runtime-assets.md`](../runtime-assets.md) | API-served HTML/PNG must be listed so they land in `dist/` |
| [`instance-agent-protocol.md`](instance-agent-protocol.md) | Optional sidecar for managed hosting — heartbeats and signed commands |
| [`voice-realtime.md`](voice-realtime.md) | Speech-to-speech voice: the voice sidecar, phone and browser paths |
| [`voice-think-speak.md`](voice-think-speak.md) | How voice splits quick spoken answers from longer work (think vs speak) |
| [`web-voice.md`](web-voice.md) | Voice in the browser |
| [`twilio-self-host.md`](twilio-self-host.md) | Your own Twilio number for phone calls and SMS |

## Code layout

| Path | Purpose |
| --- | --- |
| [`deploy/`](../../deploy/) | Docker Compose, Caddy, `vps-start.sh` |
| [`packages/instance-agent/`](../../packages/instance-agent/) | Optional sidecar (`docker compose --profile fleet`) |
| [`packages/voice-realtime/`](../../packages/voice-realtime/) | Gemini Live speech-to-speech (optional profile) |

## Quick start

**Hetzner / Ubuntu VPS:** [hetzner-quickstart.md](hetzner-quickstart.md).

```bash
sudo bash scripts/bootstrap-self-host.sh
```

Or see [`../self-host.md`](../self-host.md).

## Image

Public OSS images (pin tags in `deploy/RELEASE.json`):

- `ghcr.io/db-aeon/joshu-oss:latest` — main stack (Vanilla theme)
- `ghcr.io/db-aeon/joshu-oss-voice-realtime:latest` — voice sidecar (optional `voice-rt` profile)
