# Hermes integration

Joshu treats [Hermes](https://github.com/NousResearch/hermes-agent) as an **upstream dependency**. Customize via skills, plugins, environment variables, and Joshu startup scripts — not by forking Hermes.

## Where Hermes lives

**Local development:** separate Hermes checkout; point Joshu at the venv binary:

```bash
export HERMES_BIN=/path/to/hermes-agent/venv/bin/hermes
```

See [`local-installation.md`](local-installation.md) for full setup.

**Docker / VPS:** Hermes is installed inside the sandbox image (typically `/opt/hermes-agent`). Runtime state is under `$HERMES_HOME` (default `~/.hermes`).

**Pin:** Image builds pin `HERMES_AGENT_REF` in `deploy/Dockerfile` / `deploy/RELEASE.json`. Update the pin when upgrading Hermes.

## Customization points

| Layer | Location in this repo |
|-------|------------------------|
| Skills | `integrations/hermes/skills/` |
| Toolsets / MCP wiring | `src/hermes*.ts`, gateway sync scripts |
| Gateway env | `~/.hermes/.env`, synced from box `.env` on start |
| jChat / voice routes | `apps/hermes-chat/`, [`hermes-chat-arozos-app.md`](hermes-chat-arozos-app.md) |
| Action guard | [`connectors.md`](connectors.md#action-guard-owner-approval-for-writes) |

Install optional Hermes extras (`voice`, `messaging`, …) in the same venv/image as documented in `local-installation.md`.

## Gateway

Joshu runs `hermes gateway run` for jChat, optional Telegram/Slack messaging, and MCP tool hosting. Restart via `npm run dev:arozos` locally or `vps-start.sh` on a box.

**Telegram / Slack (optional):** configure bot tokens in `~/.hermes/.env` (Safety app syncs them on save). These are **agent chat** surfaces only — write-approval HITL is owner SMS. See [`safety-settings-arozos-app.md`](safety-settings-arozos-app.md) and [`agent-safety.md`](agent-safety.md#owner-approval-sms).

Deep customization (skills, plugins, Langfuse, patches): [`hermes-integration.md`](hermes-integration.md).

## Telegram 1:1 chat (Hermes messaging gateway)

Full owner ↔ agent chat on Telegram via the Hermes **telegram** platform (long polling). This is **not** action-guard HITL — approvals use owner SMS.

| | Hermes chat bot |
|---|-----------------|
| Env | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USERS` |
| Purpose | Agent conversation (jChat-equivalent on Telegram) |

**Setup:** Safety → Hermes Telegram (or paste tokens into `.env` / `local-env.json`) → **Restart gateway**. DM the **chat** bot. Sessions use `agent:main:telegram:dm:<chat_id>`.

jChat uses the same gateway process but a different pipe (`api_server` / `joshu-hermes-chat:<sessionId>`). See [`hermes-chat-arozos-app.md`](hermes-chat-arozos-app.md#request-path-jchat-vs-telegram-vs-slack). Full steps: [`hermes-integration.md` — Telegram](hermes-integration.md#telegram-11-chat-hermes-messaging-gateway).

## Slack chat (Hermes messaging gateway)

Hermes Slack chat uses **Socket Mode** (`SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN`). Do not conflate with other Slack integrations:

| Integration | Config | Purpose |
|-------------|--------|---------|
| **Hermes Slack chat** | Safety → **Connect Slack** (or set up by hand) | Full agent DM / channel `@mention` |
| **Composio Slack** | Connectors OAuth | Agent MCP tools (`SLACK_SEND_MESSAGE`, …) |

**Setup (recommended):** Safety → **Slack chat with the companion** → **Connect Slack**. The owner signs in to Slack in jWeb and clicks **Allow**; the Joshu API makes the box Slack app (`agent_view`, one app for each box) and saves both tokens and the owner's Slack user, restarts the gateway (with the busy wait), and after the restart the companion sends the owner a first DM. **Set up by hand** is the fallback: a prefilled "create app" link, then paste `xoxb-…` / `xapp-…` and Save (no member ID: Joshu looks up the owner email, or the owner enters a pairing code). Invite the bot (`/invite @bot`) for channel `@mentions`. Joshu sets four suggested prompts (`platforms.slack.extra.suggested_prompts` in `~/.hermes/config.yaml`).

**One Socket Mode connection per Slack app** — do not reuse the same `xapp-` token on local and a VPS box at once (only one machine receives messages).

**Channel replies vs threads:** Hermes defaults to replying in a Slack **thread** for channel `@mentions`. To reply in the main channel instead, set in `~/.hermes/config.yaml` then restart the gateway:

```yaml
platforms:
  slack:
    extra:
      reply_in_thread: false
      # Optional: keep threads but also post the first reply to the channel
      # reply_broadcast: true
```

Messages already inside a thread still get in-thread replies. Upstream: [Hermes Slack messaging](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/slack).

**Session timeout:** Joshu idle-resets Slack and Telegram after **30 minutes** (`JOSHU_HERMES_MESSAGING_IDLE_MINUTES`). jChat stays continuous. Past chats remain in `session_search`.

**Verify:** DM the bot or `@mention` it; gateway log should show `inbound message: platform=slack` in `~/.hermes/logs/gateway.log`. UI details: [`safety-settings-arozos-app.md`](safety-settings-arozos-app.md#slack-chat-with-the-companion). Full steps: [`hermes-integration.md` — Slack](hermes-integration.md#slack-chat-hermes-messaging-gateway).

## Hindsight memory

Hermes uses Hindsight for long-term memory. Viewer subservice: Memory app on the desktop. Index paths and MCP tools are documented in [`file-brain.md`](file-brain.md) and skill READMEs under `integrations/hermes/skills/`.

## Coordination scope (multi-channel, 2026-09)

Executive Assistant mail can spawn **scheduling** (`ea-scheduling`) and **owner-reply** (`ea-owner-reply`) workers from the same owner-facing ask. **Coordination scope** mutexes those spawns across Kanban boards and mail provider thread aliases (Gmail vs Nylas, linked by RFC Message-ID).

| Layer | Path |
|-------|------|
| Core | [`src/coordination/`](../src/coordination/) |
| Mail adapter | [`src/coordination/adapters/mail.ts`](../src/coordination/adapters/mail.ts) |
| EA wrapper | [`src/ea/conversationScope.ts`](../src/ea/conversationScope.ts) |

**Workers:** preflight with connectors MCP **`coordination_list_active`** before `scheduling_create_meeting_task` / `owner_reply_create_task`. On conflict the API returns `action: existing_coordination` — hand off to the returned `task_id`.

**REST:** `GET /joshu/api/coordination/scope?channel=mail&threadId=…&sourcePath=…`

Mail is **phase 1**. SMS / Slack / voice adapters will use the same registry ([`executive-assistant.md`](executive-assistant.md#coordination-scope-2026-09)).

Tests: `npm run test:coordination-scope` · `npm run test:owner-reply`.

## Deferred realtime goals

Owner-authenticated SMS, browser/PSTN voice, Slack, and Telegram share Joshu's
Realtime Goal Broker and **session-thread router** — clearly long work is
clarified if necessary, acknowledged immediately, held in a durable commit
window, and executed as one managed Kanban task. jChat and AG-UI are sync-only
(Hermes stream); they maintain a session thread but do not auto-queue.

See [`realtime-goals-theory-of-operation.md`](technical-reference/realtime-goals-theory-of-operation.md)
for the routing model, and [`realtime-goals.md`](realtime-goals.md) for state,
idempotency, cancellation, callbacks, and verification.

## Factory skill learning

Factory skills are seeded into `$HERMES_HOME/skills/joshu/`. Hermes background review may patch those copies in place (not delete them). Joshu does not run `hermes curator adopt` for them, so they stay off the curator archive walk. A changed factory skill still merges the new factory `SKILL.md` with the box copy (the skills seed runs when the seed key, a content hash of the factory skills, changes). The boot patch is `scripts/apply-hermes-factory-skill-background-writes.sh` (applied from `vps-start.sh` before the gateway restart).

The LLM merge must keep the box pitfalls. A box pitfall is a paragraph of a box skill that starts with `**Pitfall`, which is the form that Hermes learning writes. The merge prompt asks the model to keep each box pitfall word for word, unless the factory skill makes it wrong, and to list each box pitfall that it left out after the line `=== DROPPED BOX PITFALLS ===`, as `- <bold title> :: <reason>`. Then `scripts/lib/skill-merge-pitfalls.mjs` compares the box skill with the merged `SKILL.md` by the bold title of each box pitfall, in lowercase words only. It adds back each box pitfall that the merged `SKILL.md` does not have and that the list does not name with a reason, word for word, under heading "Pitfalls kept from this box". The merge script logs one line for each box pitfall that it kept this way and for each box pitfall that the model dropped with a reason, and it does not write the list to the box skill.

- **2026-10: A drop of a box pitfall needs a reason.** On box clara, the LLM merge of the upgrade to 0.1.51 dropped three box pitfalls of `ea-playbook` without a trace, although the prompt asked it to keep them. One alternative was to add back every missing box pitfall in code. It was rejected, because a factory fix can make a box pitfall wrong, and the prompt tells the model to drop box sections that contradict the factory; code cannot judge that, and the model can. The other alternative was to trust the prompt alone, which had failed. So the model decides, and code makes sure that each drop has a reason.
- **2026-10: The list of dropped box pitfalls follows a marker line in the plain answer.** A JSON answer with the whole `SKILL.md` as a string was the alternative. It was rejected, because a box skill can have 700 lines, and a small model breaks the escapes of a long string more often than it forgets a marker line. Without the marker line, the list is empty, so code adds back each missing box pitfall.
- **Limit.** The skills seed keeps no copy of the factory skill of the last seed, so code cannot tell a box pitfall that the box wrote from a pitfall that an older factory skill had and the new factory skill removed. When the model does not name such a pitfall, it comes back under "Pitfalls kept from this box". Box evolution in another form than a box pitfall, for example a changed procedure step, has no check. Test: `npm run test:skill-merge-pitfalls`.

## Release facts

The companion writes down what it learns about tool limits, in Hermes memory (`$HERMES_HOME/memories/MEMORY.md` and `USER.md`) and in skills that the box makes itself. When a release removes a limit, these notes stay, and the companion keeps the workaround. For example, a note said that the calendar tools could write only one calendar account, so the companion made events in the browser, also after a release had fixed the tools.

[`factory/release-facts.yaml`](../factory/release-facts.yaml) lists release facts. Each fact names the first release where it is true (`introducedIn`), the fact, and the old belief that it makes untrue. On the first start of the Joshu API at a new release, after the skills seed, `src/releaseFacts.ts` selects the facts that the box has not checked and adds a one-time Hermes cron job "Joshu release facts check <release>".

- **Why an agent turn and words, not patterns.** The companion words a note in many ways, so a list of regular expressions misses notes. The agent turn reads each note and judges whether it contradicts a fact. We did not tag memory notes with the release where the companion saw a limit, because that needs a change of the Hermes memory tool, and old notes have no tag.
- **Why once per release, with a stamp.** The stamp file `$HERMES_HOME/.joshu-release-facts-checked` keeps the release that the box checked last. The job covers each fact with `introducedIn` after the stamp and at or before the current release, so a box that skipped a release still checks the facts of that release. A box without a stamp checks every fact. The stamp moves only after the job exists, so a failed create is tried again at the next start. The hook runs in the Joshu API, not in an upgrade script, so both upgrade paths (the operator script and the instance agent) run it.
- **How the job works.** Schedule `15m` (one run, after the gateway is up), `repeat: 1`, `deliver: local` (nothing goes to the owner), toolsets `file` and `skills`. A Hermes cron agent runs without the memory tool (`skip_memory`), so the job patches the memory files with the file tools and keeps the `§` separators between entries. It changes box-made skills with `skill_manage` and leaves the factory skills under `skills/joshu/` to the skills seed. The hourly learning GitHub sync keeps a copy of `memories/` and `skills/`, so a wrong edit can be undone.
- **Limit.** The job does not change the Hindsight memory bank.

Add a release fact in the pull request of each change that removes a tool limit or a workaround that the companion may have written down (`docs/releases/AGENTS.md`).

## Hermes cron jobs of a box

Joshu installs three Hermes cron jobs on each box for the setup board and for nudges:

| Job | Schedule | What it does | Which boxes |
|-----|----------|--------------|-------------|
| Joshu onboarding reconcile | daily at 06:00 UTC | Runs the reconcile of the setup board (`scripts/onboarding-reconcile.sh`, no LLM). | Every box. |
| Joshu proactive tick | hourly | Calls `POST /api/proactive/tick`, which can send one nudge (`proactive-tick.sh`, no LLM). | Boxes where setup is finished. |
| Joshu proactive hygiene | weekdays, one hour after the start of the working hours of the owner | Runs skill `joshu-proactive` to close stale blocked Kanban tasks. | Boxes where setup is finished and the onboarding draft or the Nylas profile gives the owner name and the owner timezone. |

The box cron sync (`syncBoxCronJobs` in `src/onboarding/boxCronSync.ts`) installs each job that applies to the box and is missing. It runs at Finish setup and at each start of the Joshu API, at listen and again 20 seconds later. Each job install lists the jobs through the cron bridge and finds the job by name. A job with the right schedule and script stays unchanged, and a job with a wrong schedule or script gets an update. When one job install fails, the box cron sync logs a warning and goes on with the next job, and the Joshu API keeps running. Hermes keeps a paused job paused, so the box cron sync does not resume a job that the owner paused.

Design decisions:

- 2026-10-14: the Joshu API runs the box cron sync at each start. Before, only Finish setup installed the jobs, so a box that finished setup on an older release, or never finished setup, did not get them, and an upgrade did not add them. An upgrade step in the upgrade script was the other option. It was rejected, because a box that restarts without an upgrade, or a self-hosted box, would not get the jobs. The second pass after 20 seconds catches a box where the ArozOS volume is not ready at listen, because the box cron sync reads `onboarding.json` in the ArozOS user folder.
- 2026-10-14: every box gets the onboarding reconcile job, and the proactive jobs need a finished setup. The onboarding reconcile job only updates the setup board, and the setup board matters most on a box where setup is not finished. The proactive jobs send nudges to the owner and use the owner timezone and working hours that Finish setup saves. Installing all three jobs on every box was the other option. It was rejected for now, because a box with a Nylas profile and no finished setup would start to get nudges.

Code map: `src/onboarding/boxCronSync.ts` (which jobs a box gets), `src/onboarding/onboardingCronJobs.ts`, `src/proactive/proactiveCronJobs.ts`, `src/proactive/hygieneCronJobs.ts` (one job each), `src/server.ts` (the call at start), `src/onboarding/workspaceWriter.ts` (the call at Finish setup). Test: `npm run test:box-cron-sync`. The EA morning, evening, and weekly jobs are not part of the box cron sync. Finish setup installs them, and `scripts/repair-ea-cron-timezone.mjs` repairs them.

## Related docs

- [`hermes-integration.md`](hermes-integration.md) — skills, plugins, Slack/Telegram depth, Langfuse, patches
- [`hermes-chat-arozos-app.md`](hermes-chat-arozos-app.md) — jChat request path and voice
- [`safety-settings-arozos-app.md`](safety-settings-arozos-app.md) — Safety UI for messaging tokens
- [`connectors.md`](connectors.md) — Composio, mail mirrors, action guard
- [`realtime-goals-theory-of-operation.md`](technical-reference/realtime-goals-theory-of-operation.md) — routing model
- [`realtime-goals.md`](realtime-goals.md) — durable long work (implementation)
- [`agent-safety.md`](agent-safety.md) — write policy overview
