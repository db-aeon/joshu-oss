<div align="center">
  <h1>Joshu</h1>
  <p><b>A local-first, always-on AI app workspace and box stack.</b></p>

  [![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)
  [![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)
</div>

---

**Joshu** is an open-source, local-first app workspace designed for always-on deployments. It integrates the [Hermes Agent](https://github.com/NousResearch/hermes-agent) with a suite of desktop-class web applications, providing a private, self-hosted AI executive assistant environment.

> **💡 Looking for an easy, one-click solution?**  
> Visit [joshu.me](https://joshu.me) for our fully managed, ready-to-use paid service.

> **⚠️ Early Stage Notice**  
> This open-source repository is in a **VERY EARLY** stage of development. While every effort has been made to get the stack up and running for the community, it has not been thoroughly tested. It is provided "as is" with no warranty. Expect rough edges and potential breaking changes!

## ✨ What is Joshu?

Joshu is a fundamentally new approach to AI agents: instead of an AI trying to use your computer, you and the AI share a computer built specifically for both of you.

- 🧠 **LLM:** Powered by Deepseek v4 Flash via OpenRouter. Dealing with LLMs used to be a headache of cost, intelligence, speed, and censorship—that's a thing of the past.
- ⚡ **Hermes Harness:** The LLM is wrapped in the Hermes agent framework, which manages multi-gateway communication (chat, SMS, iMessage, telephony, voice). Hermes routes incoming messages to the LLM and handles structured skill execution.
- 🖥️ **The Cloud Desktop (LGUI):** Joshu's most unique feature. Rather than just a chat interface, Joshu provides a full cloud desktop (a "Language Graphical User Interface") running on the VPS that both the human AND the AI agent can operate simultaneously. Apps on the desktop (email client, file browser, whiteboard, web browser) have language pipelines built in, so Joshu can open, read, and interact with them programmatically, while you can also use them like a normal desktop app. This solves a fundamental problem with "computer use" AI: instead of trying to control a Mac or Windows desktop designed for a mouse and human eyes, Joshu's cloud desktop is purpose-built for joint human-AI operation from the ground up.
- 🌐 **Hybrid Web Browser:** Joshu includes a sandboxed browser-within-a-browser. It doesn't share cookies with your local Chrome, but it IS logged into your accounts (Facebook, Gmail, etc.). This lets Joshu handle tasks that require authentication—a hard blocker for most agent systems that can't get past login screens or 2FA without a human in the loop.
- 📁 **GBrain Semantic File System:** The Linux file system is augmented with GBrain (by Gary Tan), a semantic indexing layer. Every file Joshu creates, every email thread saved, and every document uploaded gets indexed. The LLM can query files both with traditional terminal commands (`grep`, `ls`) AND via semantic vector search, finding relevant files by meaning, not just filename.
- 💭 **Hindsight Memory System:** Hindsight is wired in as the memory provider, working seamlessly out of the box to give the agent long-term recall.
- ☁️ **Dedicated Cloud Box:** The entire system runs on a dedicated Ubuntu VPS (like DigitalOcean), not shared infrastructure. Each user gets their own box with dedicated CPU, GPU, RAM, and disk. A control plane app on Vercel manages the fleet of boxes.
- 📚 **Skill Library & Learning Loop:** In addition to the standard Hermes learning loop, the box reports any long sessions back to the control plane, which are then stored in Git for manual inspection to catch red flags and improve the system.

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
