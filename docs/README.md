# Joshu documentation

Canonical docs for local dev, ArozOS apps, Hermes integration, connectors, and VPS sandboxes.

> **Public vs private:** The open-source snapshot (`joshu-oss`) ships a **curated subset** via
> [`README.oss.md`](README.oss.md) and [`scripts/prepare-oss-snapshot.sh`](../scripts/prepare-oss-snapshot.sh).
> This tree is the **full internal canon** — including `Joshu-SOP/`, fleet runbooks, brand guidelines,
> and [`hermes-customizations.md`](hermes-customizations.md). Control plane docs live in
> `joshu-control-plane/docs/`.

## Desktop app names (May 2026)

User-facing labels on the ArozOS desktop. Older docs may still say legacy names in parentheses.

| Desktop label | Legacy / internal names | Doc |
|---------------|------------------------|-----|
| **jWeb** | Joshu Browser, HITL browser | [`hitl-camofox-notes.md`](hitl-camofox-notes.md) |
| **jChat** | Hermes Chat | [`hermes-chat-arozos-app.md`](hermes-chat-arozos-app.md) |
| **jMail** | — | [`jmail-arozos-app.md`](jmail-arozos-app.md) |
| **Connectors** | Composio OAuth (was inline in jChat) | [`connectors-arozos-app.md`](connectors-arozos-app.md) |
| **Safety** | Action guard / write policy settings | [`safety-settings-arozos-app.md`](safety-settings-arozos-app.md) |
| **Memory** | Hindsight Viewer | [`hermes-customizations.md`](hermes-customizations.md#hindsight-memory) |
| **File Brain** | gbrain viewer | [`file-brain.md`](file-brain.md) |
| **jWhiteboard** | Excalidraw subservice | [`excalidraw-sandbox.md`](excalidraw-sandbox.md) |
| **Schedules** | Hermes cron UI | [`schedules-arozos-app.md`](schedules-arozos-app.md) |
| **Welcome** | Day-1 onboarding | [`welcome-onboarding.md`](welcome-onboarding.md) |
| **jMovie** | movie-editor | [`jmovie-arozos-app.md`](jmovie-arozos-app.md) |

Shortcut filenames and `moduleInfo.json` names: [`arozos-desktop-shortcuts.md`](arozos-desktop-shortcuts.md).

## Start here

| Topic | Doc |
|-------|-----|
| Local install (Hermes, Hindsight, gbrain, ArozOS stack) | [`local-installation.md`](local-installation.md) |
| EA GTD layout, capture, linking | [`Joshu-SOP/gtd-workspace-linking.md`](Joshu-SOP/gtd-workspace-linking.md) |
| EA time-block planning (Cal Newport + jWhiteboard) | [`Joshu-SOP/time-block-planning.md`](Joshu-SOP/time-block-planning.md) |
| EA daily handoff (morning review + shutdown) | [`Joshu-SOP/time-block-planning.md`](Joshu-SOP/time-block-planning.md#daily-handoff-morning-review) · [`ea-for-joshu.md`](Joshu-SOP/ea-for-joshu.md) |
| Hermes ownership, toolsets, Langfuse, Composio policy | [`hermes-customizations.md`](hermes-customizations.md) |
| File index + hybrid search (gbrain) | [`file-brain.md`](file-brain.md) |
| PDF knowledge base (drop → auto-index) | [`file-brain.md`](file-brain.md#knowledge-base-pdf-drop) |
| Mail/calendar mirrors, cron, REST + MCP | [`connectors.md`](connectors.md) |
| Agent write safety (HITL, hard blocks, owner channel) | [`agent-safety.md`](agent-safety.md) |
| Safety desktop app (configure policy) | [`safety-settings-arozos-app.md`](safety-settings-arozos-app.md) |
| Agent write safeguards (detail in connectors) | [`connectors.md` — Action guard](connectors.md#action-guard-owner-approval-for-writes) |
| Nylas agent inbox | [`nylas-agent-mailbox.md`](nylas-agent-mailbox.md) |
| Self-host (standalone Docker) | [`self-host.md`](self-host.md) |
| App SDK + `joshu.app.json` | [`app-sdk.md`](app-sdk.md) |
| Third-party licenses | [`THIRD_PARTY.md`](THIRD_PARTY.md) |
| VPS production sandboxes | [`vps-sandbox/README.md`](vps-sandbox/README.md) |
| Hotpatch a live box (git / dist / image) | [`vps-sandbox/hotpatch-running-box.md`](vps-sandbox/hotpatch-running-box.md) |
| Control plane (proprietary) | [`vps-sandbox/control-plane.md`](vps-sandbox/control-plane.md) |
| Design system + ArozOS shell theme | [`design/README.md`](design/README.md) · Vanilla OSS theme in `arozos/web-overlays-vanilla/` |

## Mail recall (agents)

Hermes skills define tool order — not a separate mail search engine:

1. **`mcp_gbrain_query`** over indexed `connectors/mail/` mirrors (`connector-mail` page type)
2. **`mcp_joshu_connectors_connectors_sync_now`** to refresh mirrors
3. **Composio Gmail** as live API fallback

Details: [`connectors.md`](connectors.md), [`file-brain.md`](file-brain.md#connector-mail-and-calendar-gbrain), skill [`joshu-mail`](../integrations/hermes/skills/mail/joshu-mail/SKILL.md).

## VPS sandbox docs

See the index in [`vps-sandbox/README.md`](vps-sandbox/README.md) (voice, provisioning, troubleshooting, control plane).
