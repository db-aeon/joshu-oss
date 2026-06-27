# VPS / Docker box stack

This directory documents running the Joshu **box stack** on a VPS or local Docker host.

The **control plane** (managed provisioning, customer portal at `hello.joshu.me`) is proprietary and not part of this repository. Self-hosters use [`../self-host.md`](../self-host.md) instead.

## Documents (public)

| Doc | Purpose |
| --- | --- |
| [`../self-host.md`](../self-host.md) | Standalone Docker bootstrap |
| [`runtime-topology.md`](runtime-topology.md) | How legacy assumptions map to Compose |
| [`instance-agent-protocol.md`](instance-agent-protocol.md) | Optional fleet sidecar — heartbeats and signed commands |
| [`control-plane.md`](control-plane.md) | Stub — points to proprietary CP repo |

## Code layout

| Path | Purpose |
| --- | --- |
| [`deploy/`](../../deploy/) | Docker Compose, Caddy, `vps-start.sh` |
| [`packages/instance-agent/`](../../packages/instance-agent/) | Optional sidecar (`docker compose --profile fleet`) |
| [`packages/voice-realtime/`](../../packages/voice-realtime/) | OpenAI Realtime speech-to-speech (optional profile) |

## Quick start

```bash
sudo bash scripts/bootstrap-self-host.sh
```

Or see [`../self-host.md`](../self-host.md).

## Image

Public OSS image: `ghcr.io/db-aeon/joshu-oss:latest` (Vanilla theme). Pin tags in `deploy/RELEASE.json` when building from source.
