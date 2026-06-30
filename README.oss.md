# Joshu (open-source box stack)

**Canonical AGPL repository** for the Joshu box stack — self-host, build apps, integrate Hermes.

| Repo | Role |
|------|------|
| **joshu-oss** (this repo, public) | AGPL engine + apps — **all community PRs land here** |
| **joshu** (private) | Fleet superset: merges this repo + `proprietary/`, `vendor/`, fleet SOPs |
| **joshu-control-plane** (private) | Portal, provisioning (`hello.joshu.me`) |
| **joshu-design** (private) | Brand pack (JDL) for managed fleet images |

| | |
|--|--|
| **License** | [AGPL-3.0 OR Commercial](LICENSE) — [COMMERCIAL_LICENSE.md](COMMERCIAL_LICENSE.md) |
| **Self-host** | [docs/self-host.md](docs/self-host.md) |
| **Contributing** | [CONTRIBUTING.md](CONTRIBUTING.md) — PRs to **this repository** |

Joshu is a local-first app workspace packaged as a Docker image for always-on deployments. Desktop apps include jWeb (HITL browser), jChat, jMail, Connectors, Memory, File Brain, jWhiteboard, Schedules, Welcome, and jMovie.

## Quick start

```bash
git clone https://github.com/db-aeon/joshu-oss.git
cd joshu-oss
npm ci
npm run dev:arozos
```

Self-host on a VPS: [docs/self-host.md](docs/self-host.md).

## Documentation

Start at [docs/README.md](docs/README.md).

Key topics: [local installation](docs/local-installation.md) · [executive assistant](docs/executive-assistant.md) · [app SDK](docs/app-sdk.md) · [platform architecture](docs/platform-architecture.md).

## Releases

Tag `v*-oss` on this repo to build and push to GHCR:

- `ghcr.io/db-aeon/joshu-oss:<version>` (+ `:latest`)
- `ghcr.io/db-aeon/joshu-oss-voice-realtime:<version>` (+ `:latest`)

Vanilla theme on the main image. Pins live in [`deploy/RELEASE.json`](deploy/RELEASE.json).

Managed fleet images (`joshu-sandbox`) are built from the private fleet repo after merging OSS `main`.
