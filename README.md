<div align="center">
  <h1>Joshu</h1>
  <p><b>A local-first, always-on AI app workspace and box stack.</b></p>

  [![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)
  [![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)
</div>

---

**Joshu** is an open-source, local-first app workspace designed for always-on deployments. It integrates the [Hermes Agent](https://github.com/NousResearch/hermes-agent) with a suite of desktop-class web applications, providing a private, self-hosted AI executive assistant environment.

## ✨ Features

- 🤖 **Hermes AI Integration:** Deeply integrated with Hermes for agentic workflows, scheduling, and memory.
- 🌐 **jWeb (HITL Browser):** A Human-in-the-Loop browser that shares a Camofox tab between you and the agent via noVNC.
- 💬 **jChat & jMail:** Native chat interface and Nylas/Composio-powered email client.
- 🧠 **Memory & File Brain:** Semantic memory extraction via Hindsight and local file indexing via gbrain.
- 🛠️ **Rich App Ecosystem:** Includes jWhiteboard (Excalidraw), Schedules (cron UI), jMovie (video editor), and Connectors (OAuth management).
- 🔒 **Privacy First:** Fully self-hostable on your own hardware or a VPS.

## 🚀 Quick Start (Local Development)

### Prerequisites

- **Node.js** (v20+)
- **pnpm** (v10+)
- **Docker** (required for the Camofox browser container)
- **Go** (v1.24+, required to build the ArozOS desktop environment)

### Installation

1. **Clone the repository:**
   ```bash
   git clone https://github.com/db-aeon/joshu-oss.git
   cd joshu-oss
   ```

2. **Install dependencies:**
   ```bash
   pnpm install
   ```

3. **Configure environment:**
   ```bash
   cp .env.example .env
   ```

4. **Start the local parity stack:**
   ```bash
   pnpm run dev:arozos
   ```
   *This starts the Camofox container, builds ArozOS, and boots the Joshu backend.*

5. **Open the desktop:**
   Navigate to [http://127.0.0.1:8787](http://127.0.0.1:8787) in your browser.

## 🌍 Deployment & Self-Hosting

Joshu is packaged as a Docker image for easy deployment on a VPS.

- **[VPS Quickstart](docs/vps-quickstart.md):** Step-by-step guide to deploying Joshu on an Ubuntu VPS.
- **[Self-Hosting Overview](docs/self-host.md):** General architecture and requirements for self-hosting.

## 📚 Documentation

Dive deeper into the Joshu architecture and SDKs:

- **[Local Installation Details](docs/local-installation.md):** In-depth guide on Hermes, File Brain, and Hindsight local setup.
- **[Platform Architecture](docs/platform-architecture.md):** Understand how Joshu, ArozOS, and Hermes interact.
- **[App SDK](docs/app-sdk.md):** Learn how to build new applications for the Joshu workspace.
- **[Executive Assistant](docs/executive-assistant.md):** Overview of the EA capabilities and skills.

## 🤝 Contributing

We welcome community contributions! Whether it's fixing bugs, adding new features, or improving documentation, please check out our [Contributing Guide](CONTRIBUTING.md) to get started. All community PRs should target this repository.

## 📦 Releases

Tag `v*-oss` on this repo to build and push to GHCR:

- `ghcr.io/db-aeon/joshu-oss:<version>` (+ `:latest`)
- `ghcr.io/db-aeon/joshu-oss-voice-realtime:<version>` (+ `:latest`)

Vanilla theme on the main image. Pins live in [`deploy/RELEASE.json`](deploy/RELEASE.json).

## 📄 License

This project is licensed under the **AGPL-3.0 License** - see the [LICENSE](LICENSE) file for details.
