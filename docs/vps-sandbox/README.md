# VPS / Docker box stack

This directory documents running the Joshu **box stack** on a VPS or local Docker host.

The **control plane** (managed provisioning, customer portal at `hello.joshu.me`) is proprietary and not part of this repository. Self-hosters use [`../self-host.md`](../self-host.md) instead.

## Documents (public)

| Doc | Purpose |
| --- | --- |
| [`hetzner-quickstart.md`](hetzner-quickstart.md) | **Hetzner Ubuntu** self-host walkthrough (example build) |
| [`../self-host.md`](../self-host.md) | Standalone Docker bootstrap |
| [`runtime-topology.md`](runtime-topology.md) | How legacy assumptions map to Compose |
| [`instance-agent-protocol.md`](instance-agent-protocol.md) | Optional sidecar for managed hosting — heartbeats and signed commands |
| [`control-plane.md`](control-plane.md) | Stub — points to proprietary CP repo |

## Code layout

| Path | Purpose |
| --- | --- |
| [`deploy/`](../../deploy/) | Docker Compose, Caddy, `vps-start.sh` |
| [`packages/instance-agent/`](../../packages/instance-agent/) | Optional sidecar (`docker compose --profile fleet`) |
| [`packages/voice-realtime/`](../../packages/voice-realtime/) | OpenAI Realtime speech-to-speech (optional profile) |

## Quick start

**Hetzner / Ubuntu VPS:** [hetzner-quickstart.md](hetzner-quickstart.md) (recommended — installs Docker, pulls GHCR image).

**Same machine as git clone:**

```bash
sudo bash scripts/bootstrap-self-host.sh
```

Or see [`../self-host.md`](../self-host.md).

## Image

Public OSS images (pin tags in `deploy/RELEASE.json`):

- `ghcr.io/db-aeon/joshu-oss:latest` — main stack (Vanilla theme)
- `ghcr.io/db-aeon/joshu-oss-voice-realtime:latest` — voice sidecar (optional `voice-rt` profile)
