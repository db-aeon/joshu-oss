<div align="center">
  <h1>Joshu</h1>

  [![Release](https://img.shields.io/github/v/release/db-aeon/joshu-oss?display_name=release&label=release&color=blue)](https://github.com/db-aeon/joshu-oss/releases/latest)
  [![Docker image](https://img.shields.io/github/v/release/db-aeon/joshu-oss?display_name=release&label=ghcr.io%2Fdb--aeon%2Fjoshu--oss&logo=docker&logoColor=white)](https://github.com/db-aeon/joshu-oss/pkgs/container/joshu-oss)
  [![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)
  [![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)
</div>

---


> **Looking for a managed, one-click box?**  
> Visit [joshu.me](https://joshu.me) for the hosted service (separate from this AGPL self-host tree).

> **Early stage**  
> This repository is early. We have gotten the stack running for community self-host, but expect rough edges and breaking changes. Provided as-is, no warranty.

## What is Joshu?

Joshu is a different take on AI agents: instead of an AI trying to drive your laptop, you and the AI **share a computer built for both of you**.

- **Hermes harness** — The LLM runs inside [Hermes](https://github.com/NousResearch/hermes-agent), which owns multi-gateway communication (chat, SMS, telephony, voice), routes messages to the model, and executes structured skills.
- **Cloud desktop (LGUI)** — Not only a chat UI: a full cloud desktop where you and the agent operate the same apps (mail, files, whiteboard, browser) together. Apps expose language pipelines so the agent can open, read, and act — while you use them like normal desktop software. Purpose-built for joint human–AI use, not remote-control of macOS/Windows.
- **Hybrid web browser (jWeb)** — A sandboxed browser-in-browser (Camofox + noVNC). Separate cookies from your laptop Chrome, with a human-in-the-loop path for login/2FA — the usual hard stop for “computer use” agents.
- **GBrain semantic files** — Filesystem + [GBrain](https://github.com/garrytan/gbrain)-style semantic indexing. Agent work, saved mail threads, and uploads are searchable by meaning and by normal CLI tools.
- **Hindsight memory** — Long-term recall wired in as the memory provider.
- **Your box** — The stack runs on a dedicated Ubuntu VPS (Hetzner, DO, etc.) or locally for development — not a shared multi-tenant runtime in the open-source path.
- **Skills & apps** — Hermes skills plus Joshu desktop apps (jChat, jMail, Connectors, Schedules, last30days, Telephone, Welcome, and more). Build new apps with the [App SDK](docs/app-sdk.md).

## Quick start (local development)

### Prerequisites

- **Node.js** 22+
- **npm** (lockfile: `package-lock.json`)
- **Docker** (Camofox browser container)
- **Go** 1.24+ (ArozOS desktop build)

### Installation

1. **Clone**
   ```bash
   git clone https://github.com/db-aeon/joshu-oss.git
   cd joshu-oss
   ```

2. **Install dependencies**
   ```bash
   npm ci
   ```

3. **Configure environment**
   ```bash
   cp .env.example .env
   # set at least OPENROUTER_API_KEY (and other keys as needed)
   ```

4. **Start the local desk stack**
   ```bash
   npm run dev:arozos
   ```
   Starts Camofox, builds ArozOS when needed, and boots the Joshu backend.

5. **Open the desktop**  
   [http://127.0.0.1:8787](http://127.0.0.1:8787)

Details: [docs/local-installation.md](docs/local-installation.md).

## Deployment & self-hosting

Joshu ships as public Docker images for a standalone VPS (no control plane required).

| Path | Doc |
|------|-----|
| **Ubuntu VPS walkthrough (Hetzner / DigitalOcean)** | [docs/vps-sandbox/hetzner-quickstart.md](docs/vps-sandbox/hetzner-quickstart.md) |
| Self-host overview | [docs/self-host.md](docs/self-host.md) |
| Deploy / image env | [deploy/README.md](deploy/README.md) |

Pin images from [`deploy/RELEASE.json`](deploy/RELEASE.json) (currently **0.1.43**):

- `ghcr.io/db-aeon/joshu-oss:0.1.43` (+ `:latest`)
- `ghcr.io/db-aeon/joshu-oss-voice-realtime:0.1.43` (+ `:latest`)

Bring your own API keys (OpenRouter via Welcome after first login; optional ScrapeCreators, Exa, Langfuse, Nylas, Twilio — see `deploy/.env.vps.example`). No managed relays are required for self-host.

## Documentation

Start at [docs/README.md](docs/README.md).

| Topic | Doc |
|-------|-----|
| Local install (Hermes, Hindsight, gbrain) | [local-installation.md](docs/local-installation.md) |
| Platform architecture | [platform-architecture.md](docs/platform-architecture.md) |
| App SDK / `joshu.app.json` | [app-sdk.md](docs/app-sdk.md) |
| Embedded agent apps | [app-agent.md](docs/app-agent.md) |
| Executive assistant | [executive-assistant.md](docs/executive-assistant.md) |
| last30days research app | [last30days-user-guide.md](docs/last30days-user-guide.md) |
| Connectors / mail | [connectors.md](docs/connectors.md) |

## Desktop apps (selection)

jWeb · jChat · jMail · Connectors · Safety · Memory · File Brain · jWhiteboard · Schedules · last30days · Welcome · jTerm · Telephone · jMovie — see the [docs index](docs/README.md).

## Contributing

Community PRs land in **this** repository. See [CONTRIBUTING.md](CONTRIBUTING.md).

Related (private): `joshu` fleet super-repo, `joshu-control-plane`, `joshu-design` brand pack.

## Releases

The current Docker version is on the [Releases page](https://github.com/db-aeon/joshu-oss/releases/latest) (and the badge above). Tagging `v*-oss` builds and pushes GHCR images and creates a GitHub Release:

- `ghcr.io/db-aeon/joshu-oss:<version>` (+ `:latest`)
- `ghcr.io/db-aeon/joshu-oss-voice-realtime:<version>` (+ `:latest`)

Vanilla theme on the public image. Pins: [`deploy/RELEASE.json`](deploy/RELEASE.json).

## License

**AGPL-3.0 OR Commercial** — see [LICENSE](LICENSE), [COMMERCIAL_LICENSE.md](COMMERCIAL_LICENSE.md), and [TRADEMARK.md](TRADEMARK.md).
