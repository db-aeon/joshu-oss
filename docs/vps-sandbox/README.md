# Joshu VPS Sandbox Architecture

This directory documents the **box stack on VPS** — Docker Compose, instance agent
protocol, voice, and troubleshooting.

The **control plane** (hello.joshu.me provisioning, portal) is **proprietary** and
documented in the private `joshu-control-plane` repository.
See [control-plane.md](control-plane.md).

For self-hosting without the control plane: [../self-host.md](../self-host.md).

## Documents

| Doc | Purpose |
| --- | --- |
| [control-plane.md](control-plane.md) | Proprietary CP — not in OSS repo |
| [self-host.md](../self-host.md) | Standalone Docker / bootstrap |
| [modal-to-vps-mapping.md](modal-to-vps-mapping.md) | Modal/runtime assumptions mapped to Docker Compose |
| [provider-choices.md](provider-choices.md) | Recommended vendors for VPS, DNS, email, Twilio |
| [instance-agent-protocol.md](instance-agent-protocol.md) | Heartbeats, signed commands, health contract |
| [hotpatch-running-box.md](hotpatch-running-box.md) | Git / dist / image hotfixes on a live box |
| [voice-think-speak.md](voice-think-speak.md) | When to think (Hermes) vs speak (Realtime) |
| [voice-realtime.md](voice-realtime.md) | OpenAI Realtime S2S service |
| [web-voice.md](web-voice.md) | Browser / jChat voice wiring |
| [first-provisioning-notes.md](first-provisioning-notes.md) | First Hetzner run lessons |
| [troubleshooting-and-lessons.md](troubleshooting-and-lessons.md) | Incidents and fixes |
| [../box-state.md](../box-state.md) | Snapshots, factory profile |

## Code layout (OSS repo)

| Path | Purpose |
| --- | --- |
| [`deploy/`](../../deploy/) | Docker Compose, Caddy, `vps-start.sh` |
| [`packages/instance-agent/`](../../packages/instance-agent/) | Optional fleet sidecar (`--profile fleet`) |
| [`packages/voice-realtime/`](../../packages/voice-realtime/) | OpenAI Realtime speech-to-speech |

## Quick start (self-host)

```bash
sudo bash scripts/bootstrap-self-host.sh
```

Or see [self-host.md](../self-host.md).

## Fleet operators

Joshu-managed sandboxes use the private control plane + `docker compose --profile fleet`.
Image tags: see [`deploy/RELEASE.json`](../../deploy/RELEASE.json).

Public OSS image: `ghcr.io/your-org/joshu-oss:latest` (Vanilla theme).

Branded fleet builds set `JOSHU_DESIGN_PACK` to the private `joshu-design` checkout.
