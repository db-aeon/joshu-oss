# VPS / Docker box stack

This directory documents running the Joshu box stack on a host. Docker Compose is deprecated. The supported way to run a box is single-container mode, as [`self-host.md`](../self-host.md) tells, and a later release removes Docker Compose. A box on a Compose host keeps working until then.

The **control plane** (managed provisioning, customer portal at `hello.joshu.me`) is proprietary and not part of this repository. Self-hosters use [`../self-host.md`](../self-host.md) instead.

## Documents (public)

| Doc | Purpose |
| --- | --- |
| [`../self-host.md`](../self-host.md) | Run a box in single-container mode, and move a box from Docker Compose |
| [`hetzner-quickstart.md`](hetzner-quickstart.md) | Hetzner Ubuntu walkthrough for a Compose host (deprecated) |
| [`runtime-topology.md`](runtime-topology.md) | Processes, paths, variables, and boot order of a box |
| [`../runtime-assets.md`](../runtime-assets.md) | API-served HTML/PNG must be listed so they land in `dist/` |
| [`instance-agent-protocol.md`](instance-agent-protocol.md) | Optional sidecar for managed hosting — heartbeats and signed commands |
| [`voice-realtime.md`](voice-realtime.md) | Speech-to-speech voice: the voice sidecar, phone and browser paths |
| [`voice-think-speak.md`](voice-think-speak.md) | How voice splits quick spoken answers from longer work (think vs speak) |
| [`web-voice.md`](web-voice.md) | Voice in the browser |
| [`twilio-self-host.md`](twilio-self-host.md) | Your own Twilio number for phone calls and SMS |

## Code layout

| Path | Purpose |
| --- | --- |
| [`deploy/`](../../deploy/) | The image build, `vps-start.sh`, Caddy, and the deprecated Docker Compose files |
| [`packages/instance-agent/`](../../packages/instance-agent/) | Instance agent for a box with a control plane, a process in single-container mode (on a deprecated Compose host, profile `fleet`) |
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
