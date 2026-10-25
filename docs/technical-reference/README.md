# Technical reference

The technical reference tells developers how Joshu works and why it works that way. It is for each person who reads or changes the code of Joshu, including the contributors to the open-source repository. Each technical reference document covers one subsystem. The document tells the problem that the subsystem solves, how the parts of the subsystem fit together, what happens at run time, and the reason for each important design decision.

The technical reference is not a user guide. A user guide tells owners how to use Joshu, and the technical reference tells developers how Joshu is built.

## How to read the technical reference

If Joshu is new to you, read [the system overview](system-overview.md) first. It shows how a box is built from end to end (the desktop, the Joshu API, Hermes, Kanban workers, connectors, memory, voice, and the Docker stack), and why the main boundaries exist. Then read [the gentle introduction to the app architecture](../joshu-app-architecture-intro.md) and [the platform architecture](../platform-architecture.md), which show the three layers of the app platform (apps, the platform data plane, and the runtime) and how a request moves between them. Then read the document of the subsystem that you want to change.

## Documents in this folder

Each new technical reference document goes in this folder. The technical reference documents that are older than this folder are in other folders of `docs/` and are listed in the next section. Such a document moves to this folder when a change rewrites most of the document.

| Subsystem | Document | What you learn |
|---|---|---|
| Whole box | [`system-overview.md`](system-overview.md) | How a box is built from end to end, how a chat turn, a realtime message, mail, and a write move through it, and why the main boundaries exist (Hermes as an upstream project, mail mirrors, safety tiers, the release image). |
| Slack chat | [`slack-chat.md`](slack-chat.md) | How Connect Slack makes the Slack app of a box and gets its tokens with fixed code in the shared browser, how the first direct message waits for the gateway restart, and why Slack chat reads like a direct message with a coworker. |
| Shared browser | [`shared-browser.md`](shared-browser.md) | How the owner sees and controls the shared browser in jWeb and on the handoff page, how the live view follows a sign-in popup, why jWeb shows the tab strip of Browser Use, and how long a Browser Use Cloud session stays up for a browser handoff. |
| Voice agent tools | [`voice-agent-tools.md`](voice-agent-tools.md) | How the voice agent calls tools on the native async tool path, and how the voice service checks its claims that something was sent or that work is running. |
| Realtime goals | [`realtime-goals-theory-of-operation.md`](realtime-goals-theory-of-operation.md) | How a message on SMS, voice, Slack, Telegram, or chat goes to a background worker or to a direct reply, and the trunk and branch model behind that choice. |

## Technical reference documents in other folders

| Subsystem | Document | What you learn |
|---|---|---|
| Platform and apps | [`platform-architecture.md`](../platform-architecture.md) | The three layers, the domains, the packages, and the app invoke API. |
| Platform and apps | [`joshu-app-architecture-intro.md`](../joshu-app-architecture-intro.md) | How the companion reaches an app through skills, the app GUI, and voice, with diagrams. |
| Platform and apps | [`platform-data.md`](../platform-data.md) | The TypeScript client that apps use to read mail, calendar, and files. |
| Hermes | [`hermes-integration.md`](../hermes-integration.md) | Why Joshu customizes Hermes with skills, plugins, and environment variables instead of a fork, and where each customization goes. |
| Box access | [`box-api-edge-security.md`](../vps-sandbox/box-api-edge-security.md) | Which routes of the box API a request from the internet can reach, which need a desktop session or a direct localhost request, and how an admin desktop login signs in as the owner with a one-time link. |
| Instance agent | [`instance-agent-protocol.md`](../vps-sandbox/instance-agent-protocol.md) | How the instance agent gets signed commands from the control plane, which commands it runs, and what each command returns. |
| Realtime goals | [`realtime-goals.md`](../realtime-goals.md) | The acknowledgment, the follow-up questions, and the results on the channel of the request. |
| Safety | [`agent-safety.md`](../agent-safety.md) | The three tiers that control the writes of the companion, and how the owner approves a write. |
| Mail and calendar | [`connectors.md`](../connectors.md) | How the connector apps copy mail and calendar into Markdown files, index the files, and give the companion a small set of actions. |
| Files and search | [`file-brain.md`](../file-brain.md) | How gbrain indexes the Desktop files and answers hybrid search. |
| Proactive nudges | [`kanban/cross-board-readers.md`](../kanban/cross-board-readers.md) | How the hourly proactive tick picks one owner question from all boards, when it composes and sends a nudge, and how owner replies reach the task. |
| Teams | [`teams.md`](../teams.md) | How the companions of different owners work together in a team stand-up. |
| Whiteboard | [`jwhiteboard-developer-guide.md`](../jwhiteboard-developer-guide.md) | How the UI, the semantic model, storage, the embedded agent, and voice of jWhiteboard fit together. |
| Whiteboard | [`curatorial-whiteboard.md`](../curatorial-whiteboard.md) | The semantic and review layer beside an Excalidraw board, and its authority rules. |
| Box stack | [`vps-sandbox/README.md`](../vps-sandbox/README.md) | The Docker stack of a box on a VPS or a local host. |
| Build | [`runtime-assets.md`](../runtime-assets.md) | Why the files that the API reads at run time must be copied to `dist/`. |
| Repositories | [`oss-fleet-sync.md`](../oss-fleet-sync.md) | How the public repository and the fleet repository stay aligned. |

## What a technical reference document has

Each technical reference document has these sections, in this order. A short document can join two sections, but it must keep the content of each.

1. **Purpose**: what the subsystem does, in two or three sentences.
2. **Motivation**: the problem that the subsystem solves, and the constraints that shaped the design (for example cost, privacy, or a limit of an upstream project).
3. **Architecture**: the components, the boundary of each component, the data that each component owns, and how the components connect. Add a Mermaid diagram when a diagram is clearer than text.
4. **Theory of operation**: what happens at run time, step by step, and the mental model that a developer needs to predict the behavior of the subsystem.
5. **Design decisions**: one entry for each important decision, with the date, the decision, the alternatives that were considered, and the reason that the decision won. When a later decision replaces an entry, keep the entry and write which entry replaces it.
6. **Limits and failure modes**: what the subsystem does not do, what can go wrong, and how the subsystem recovers.
7. **Code map**: the main files, the entry points, the configuration, and the tests.

Write about the current design. The design decisions section is the only place for history; release notes and GitHub issues hold the rest.
