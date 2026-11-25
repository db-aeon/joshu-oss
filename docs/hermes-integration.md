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

**Setup (recommended):** Safety → **Slack chat with the companion** → **Connect Slack**. The owner signs in to Slack in jWeb and clicks **Allow**; the Joshu API makes the box Slack app (`agent_view`, one app for each box) and saves both tokens and the owner's Slack user, restarts the gateway (with the busy wait), and after the restart the companion sends the owner a first DM. **Set up by hand** is the fallback: a prefilled "create app" link, then paste `xoxb-…` / `xapp-…` and Save (no member ID: Joshu looks up the owner email, or the owner enters a pairing code). Invite the bot (`/invite @bot`) for channel `@mentions`. In a group DM, an owner message that addresses the companion by name also counts as a mention ([slack-chat.md](technical-reference/slack-chat.md#design-decisions)). Joshu sets four suggested prompts (`platforms.slack.extra.suggested_prompts` in `~/.hermes/config.yaml`).

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
- **2026-11: A split skill takes the box pitfalls of its sections.** Release 0.1.61 moved sections of `ea-playbook` into two new factory skills, `ea-mail-ingress` and `ea-mail-track`. A box pitfall that a box wrote into a moved section must reach the worker that now preloads the new skill. A split skill names the old skill in `metadata.joshu.split_from`. Before any LLM merge, the skills seed keeps a copy of the box copy of the old skill. When it first copies the split skill to the box, `scripts/move-split-skill-pitfalls.mjs` adds each box pitfall of that copy whose nearest heading is also a heading of the split skill, word for word, under "Pitfalls kept from this box". The seed state marks the split skill as box-evolved, so its next factory update is an LLM merge and keeps the moved box pitfalls. The merge prompt tells the model to drop the moved sections from the old skill. When the model keeps a moved box pitfall in the old skill too, it is in two skills, which costs a few lines and loses nothing. The alternative was to build the worker skills from the box `ea-playbook` at each seed. It was rejected, because Hermes learning edits the skill that a worker uses, and a built skill would lose those edits at the next seed. Box evolution that is not a box pitfall stays in the old skill. Test: case 10 of `npm run test:hermes-skills-seed`.
- **Limit.** The skills seed keeps no copy of the factory skill of the last seed, so code cannot tell a box pitfall that the box wrote from a pitfall that an older factory skill had and the new factory skill removed. When the model does not name such a pitfall, it comes back under "Pitfalls kept from this box". Box evolution in another form than a box pitfall, for example a changed procedure step, has no check. Test: `npm run test:skill-merge-pitfalls`.

## Hermes memory

Hermes memory is two files in `$HERMES_HOME/memories/`. `MEMORY.md` holds box notes, which are facts about the box and about the limits of tools. `USER.md` holds owner rules and other facts about the owner. The companion and the workers change the files only with the Hermes memory tool, with target `memory` for `MEMORY.md` and target `user` for `USER.md`. Hindsight is a separate memory and has its own section above.

- **When a session reads the files.** Hermes loads both files into the system prompt once, when a session starts. A change of a file reaches the next session, and a session that is running keeps the text that it started with.
- **Which sessions read the files.** A jChat session, a worker, and a proactive compose session read both files. A Hermes cron job runs with `skip_memory`, and Hermes still loads both files into its system prompt, and gives it the memory tool, when the toolset list of the job has `memory`. The Hermes cron jobs of a box have the default toolsets, which include `memory`.
- **What happens when a file is full.** Hermes does not shorten a file by itself. A write that goes over the size limit fails, and the model must remove or shorten entries in the same turn. Action `replace` of the memory tool replaces the whole entry that it matches.

Decisions (2026-11):

- **Joshu sets the size limits to 6,000 characters for `MEMORY.md` and 4,000 characters for `USER.md`.** `syncJoshuHermesMemoryLimits` in `src/hermesMemoryLimits.ts` writes `memory.memory_char_limit` and `memory.user_char_limit` to `config.yaml` at the Hermes gateway warm-up. The defaults of Hermes are 2,200 and 1,375 characters. On one busy box, 59 of 103 writes with the memory tool failed, and 19 of them were over the limit. A write with `replace` on the full file also removed four older rules of the owner. The new limits hold about three times as many entries as that box had. When both files are full, the system prompt of a session grows by about 1,600 tokens. We did not keep the defaults and rely on the model to merge entries, because Hermes already asks for that and the writes still failed. We did not add a rules file that Joshu owns, because that needs a new tool to write it. We did not choose much higher limits, because each session pays for the full text, and a larger file keeps an untrue box note for longer.
- **Joshu raises a limit and never lowers it.** The function sets a limit only when `config.yaml` has no value or a lower value, so an owner of a self-hosted box who sets a higher limit keeps it. We did not add an environment variable for the two numbers, because the higher value in `config.yaml` already covers that need.
- **Owner rules go to target `user`.** The two files have separate limits. On the same box, all 103 writes had target `memory`, and Hermes cron jobs made 55 of them, so box notes and owner rules shared one small file. With owner rules in `USER.md`, a Hermes cron job that saves a box note cannot fill the file that holds the owner rules. We did not take toolset `memory` from Hermes cron jobs. Hermes makes the memory store of a Hermes cron job only when the job has that toolset, so a job without it would not read the owner rules. The release facts check job also needs the memory tool.
- **HERMES.md gives the guidance, and no code enforces it.** Section "What to remember" of HERMES.md (`buildHermesContextMarkdown` in `src/hermesContextFile.ts`) tells where a lesson goes: an owner rule to target `user`, a box note to target `memory`, and how to do one kind of task in the skill of that task. It also tells that `replace` replaces the whole entry. The model decides what is an owner rule. We did not add a guard, because a guard here would correct a choice of the model and would not protect the owner from harm. We did not patch the memory tool so that `replace` keeps the other facts of an entry, because Joshu would carry one more upstream patch, and more room removes the reason for most `replace` calls.
- **A Hermes cron job does not load HERMES.md.** Hermes loads context files for a Hermes cron job only from the working folder of the job. The Hermes cron jobs of a box have no working folder, or the folder `/opt/joshu`, so their system prompts do not hold HERMES.md. We did not change that here, because an owner tells the companion a rule in a chat, a text, or an email, and those reach a session or a worker. A Hermes cron job writes box notes, and target `memory` is the right target for them.

Limits and rollback:

- The guidance is advice to the model. A worker can still save an owner rule with target `memory`, where it has more room than before and can still be replaced by a later write.
- The change does not move the entries that a box already has. An owner rule that is in `MEMORY.md` stays there, and each session still reads it.
- To go back to the defaults of Hermes, remove the two keys from `config.yaml`. A file that is then over the default limit still loads in full, because Hermes checks the limit only when it writes. Hermes then refuses an `add` or a `replace` that leaves the file over the limit, and it accepts a `remove`. When one entry alone is longer than the limit of the whole file, Hermes treats the file as changed from outside, saves a copy with the ending `.bak.<time>`, and refuses each write to the file until a person shortens the entry.

Tests: `npm run test:hermes-memory-limits` and `npm run test:hermes-context-file`.

## Session history

Hermes keeps each session in the file `state.db` of the Hermes home, with each message and two search indexes of the message text. The tool `session_search` of Hermes searches this file, so the companion can find an earlier conversation. Hermes also writes a transcript file for a session in `$HERMES_HOME/sessions/`.

Each session has a source. A run of a worker has the source `kanban`, a run of a Hermes cron job has the source `cron`, and a jChat session has the source `api_server`. On a box, most of the session history is worker runs. On one box after three months, `state.db` was 3.7 GB with 2,280 sessions. Kanban workers made 1,951 of the sessions, and the search indexes took about three quarters of the file.

At each start, the box deletes the old sessions of workers and of Hermes cron jobs. `prune_hermes_session_history` in `deploy/scripts/vps-start.sh` runs `scripts/hermes-session-prune.py` with the Python of Hermes. The script works in this order:

1. It finds each session whose source is in `JOSHU_SESSION_PRUNE_SOURCES` (default `kanban,cron`) and whose last message is older than `JOSHU_SESSION_PRUNE_DAYS` days (default 30).
2. It gives each of these sessions an end time, with the end reason `joshu_session_prune`, when the session has none.
3. It calls `prune_sessions` of Hermes for each source, the oldest sessions first, in steps of 10 days of age. Hermes deletes the sessions, their messages, and their transcript files.
4. When it deleted a session, it records in table `state_meta` that a `VACUUM` is still to do. It runs the `VACUUM` at most one time in 30 days, and only when the disk has room. `VACUUM` gives the freed space back to the disk.

The start of the box waits for the script, so the script has a time budget. The start script stops the script after `JOSHU_SESSION_PRUNE_TIMEOUT_SEC` seconds (default 240), and the budget is half of that time. After the budget, the script starts no new delete step and no `VACUUM`. The next start of the box goes on from there, so a box with a large file can need two or three starts.

The script prints one line of JSON, and the start script writes the line to the log of the stack with the prefix `[vps-start] hermes session prune:`. When the script fails or runs out of time, the start script writes a line with `WARN` and goes on with the start. `JOSHU_SESSION_PRUNE_DAYS=0` turns the delete off.

Decisions (2026-11):

- **The box deletes only the sessions of workers and of Hermes cron jobs.** Nobody continues a worker run or a cron run, and the result of the run is in the Kanban task and in the files. The conversations of the owner are a small part of the file, and `session_search` reads them, so they stay. We did not use the Hermes setting `sessions.auto_prune`, because it deletes the sessions of every source.
- **Hindsight is not a copy of the session history.** Hindsight keeps facts that it takes from some sessions, and it gets nothing from a Hermes cron job. So the age limit is the only thing that decides what a box keeps of a worker run.
- **The script ends a session before the delete.** `prune_sessions` of Hermes deletes only a session that has an end time, and Hermes never gives a Kanban worker session an end time. Without this step the delete removes the cron sessions and none of the worker sessions. The script ends a session through `end_session` of Hermes, and it reads the list of old sessions from `state.db` with a read-only connection.
- **The delete runs at the start of the box, before the Hermes gateway.** `VACUUM` writes the whole file again and locks it for that time. Before the gateway starts, no other process writes `state.db`. A box restarts at each release update, so the delete runs at least as often as releases come. We did not add a timer to a running box, because a `VACUUM` there blocks each session until it ends.
- **The script works in steps inside a time budget.** A release update waits 600 seconds for a healthy box and fails after that time. So the delete must not hold the start for long. One call of `prune_sessions` is one transaction, and a stopped transaction deletes nothing. With steps of 10 days of age, each start keeps what it deleted. On a test file of 1.1 GB, the delete of 567 sessions and the `VACUUM` took 48 seconds on a laptop.
- **A record tells that a `VACUUM` is still to do.** A start that deletes sessions can run out of time before the `VACUUM`. The key `joshu_session_prune_vacuum_pending` in table `state_meta` makes a later start run the `VACUUM`, also when that start deletes nothing.
- **`VACUUM` needs two times the file size next to `state.db`.** `VACUUM` writes a copy of the file to the temporary folder and writes the copy back through the journal. The script runs `VACUUM` only when the folder of `state.db` has two times the file size free and the temporary folder has one time the file size free.
- **The script uses the same `last_vacuum` record as Hermes.** Hermes keeps the time of the last `VACUUM` in table `state_meta`. The script reads and writes the same key, so the two do not run `VACUUM` twice in 30 days.

Limits and rollback:

- A box that runs for a long time with no restart keeps its old worker sessions until the next start.
- The first run on a box with a large file can use the whole time limit, and the file gets smaller only at the start that runs `VACUUM`.
- When the disk has no room for `VACUUM`, the script deletes the sessions and does not run `VACUUM`. The file then stays the same size, and Hermes uses the freed space for new sessions.
- A deleted session cannot come back. For a worker run that is older than the age limit, the Kanban task, the files, and the Langfuse trace stay, and the messages of the session are gone from the box.
- Sessions with the source `subagent` or `cli` stay. Add a source to `JOSHU_SESSION_PRUNE_SOURCES` to delete its old sessions too.

Tests: `npm run test:hermes-session-prune`. With `JOSHU_TEST_HERMES_PYTHON` and `HERMES_AGENT_ROOT` set, the test also runs the script with the code of a Hermes checkout.

## Release facts

The companion writes down what it learns about tool limits, in Hermes memory (`$HERMES_HOME/memories/MEMORY.md` and `USER.md`) and in skills that the box makes itself. When a release removes a limit, these notes stay, and the companion keeps the workaround. For example, a note said that the calendar tools could write only one calendar account, so the companion made events in the browser, also after a release had fixed the tools.

[`factory/release-facts.yaml`](../factory/release-facts.yaml) lists release facts. Each fact names the first release where it is true (`introducedIn`), the fact, and the old belief that it makes untrue. On the first start of the Joshu API at a new release, after the skills seed, `src/releaseFacts.ts` selects the facts that the box has not checked and adds a one-time Hermes cron job "Joshu release facts check <release>".

- **Why an agent turn and words, not patterns.** The companion words a note in many ways, so a list of regular expressions misses notes. The agent turn reads each note and judges whether it contradicts a fact. We did not tag memory notes with the release where the companion saw a limit, because that needs a change of the Hermes memory tool, and old notes have no tag.
- **Why once per release, with a stamp.** The stamp file `$HERMES_HOME/.joshu-release-facts-checked` keeps the release that the box checked last (line 1) and the version of the check job (line 2, `check <version>`). The job covers each fact with `introducedIn` after the stamp and at or before the current release, so a box that skipped a release still checks the facts of that release. A box without a stamp checks every fact. The stamp moves only after the job exists, so a failed create is tried again at the next start. The hook runs in the Joshu API, not in an upgrade script, so both upgrade paths (the operator script and the instance agent) run it.
- **Why a version of the check job in the stamp.** A stamp with an older version of the check job (`RELEASE_FACTS_CHECK_VERSION` in `src/releaseFacts.ts`), or with one line, counts as no stamp, so the box checks every fact up to its release once more. Raise the version when a change of the job makes the earlier checks incomplete. Version 2 came after the jobs of version 1 could not change Hermes memory on any box. A new stamp file name would do the same, but it hides why the box checks again. Moving the stamp only after the job has run was rejected, because the Joshu API does not watch the job.
- **How the job works.** Schedule `15m` (one run, after the gateway is up), `repeat: 1`, `deliver: local` (nothing goes to the owner), toolsets `memory`, `file`, `skills`, and `no_mcp`. The entries of `MEMORY.md` and `USER.md` are in the system prompt of the job, and the job removes or replaces an untrue entry with the Hermes memory tool. It changes box-made skills with `skill_manage`. It uses the file tools only to read and search the skill files. The hourly learning GitHub sync keeps a copy of `memories/` and `skills/`, so a wrong edit can be undone.
- **Why the memory tool and not the file tools.** A Hermes cron agent runs with `skip_memory`, but Hermes still gives it the memory tool when its toolset list names `memory`. The write guard refuses `write_file` and `patch` outside `HERMES_WRITE_SAFE_ROOT` (the owner Desktop and `/tmp/joshu-scratch`), so the first jobs, which had only `file` and `skills`, could not change `memories/MEMORY.md`. Adding `memories/` to `HERMES_WRITE_SAFE_ROOT` was rejected, because the variable applies to every session, and a whole-file write can lose entries or the `§` separators. The memory tool keeps the separators and checks the size limit.
- **Why no MCP server.** Hermes adds each enabled MCP server to a cron job whose toolset list names no MCP server, so without `no_mcp` the job could call every MCP tool of the box, also the tools of `joshu_connectors` that send mail. The job needs none. Hermes has no toolset with only the read tools, so the job keeps `write_file` and `patch` of toolset `file`; the write guard limits them to the owner Desktop and `/tmp/joshu-scratch`, and the prompt forbids them.
- **Which skills the job checks.** At schedule time, `factorySkillFolders` lists each factory skill folder (`integrations/hermes/skills/<folder>`, on the box `skills/joshu/<folder>`) and each app skill (`arozos/subservice/<app>/skills/<skill>`, on the box `skills/joshu/<skill>` and `skills/apps/<app>/`). The prompt tells the job to skip these folders and `skills/apps`, and leaves the factory skills to the skills seed. Every other skill folder is a box-made skill. Hermes often puts a box-made skill about Joshu under `skills/joshu/`, so skipping that whole folder, as the first jobs did, missed those skills.
- **Limits.** The job does not change the Hindsight memory bank. After a long job run, Hermes background skill review can still make a new skill from the job; Joshu keeps the review on for every session, and a cron job has no setting to turn it off.

Add a release fact in the pull request of each change that removes a tool limit or a workaround that the companion may have written down (`docs/releases/AGENTS.md`).

## The Hermes model of a box

Each release names one Hermes model: `JOSHU_OPENROUTER_DEFAULT_MODEL` in `src/joshuOpenRouterDefaults.ts`. A box runs the model of its release, so a release update can change the model of every box. `JOSHU_HERMES_MODEL` in `/etc/joshu/instance.env` overrides the model on one box, and only an operator or a self-hosting owner sets it on purpose. The Joshu API writes the model into `model.default` and `cron.model` of the Hermes `config.yaml` at each start, so Hermes chat and the unpinned cron jobs use it. The voice service sends the same model with each request to Hermes.

Older releases worked differently. The managed control plane wrote `JOSHU_HERMES_MODEL` into `instance.env` when it made a box, and in October 2026 30 cron jobs were pinned by hand to `deepseek/deepseek-v4.1-flash`. Both kept a box on its first model through every update. These steps remove them:

- The instance agent removes `JOSHU_HERMES_MODEL` from `instance.env` during a release update when the value names one of the models that the control plane wrote (`releaseEnvRemovals` in `packages/instance-agent/src/releaseEnv.ts`). It does this before it recreates the stack and voice containers, so both start without the value. Another value is a deliberate override and stays.
- At each start, the Joshu API removes the model pin of each cron job that is pinned to one of those models on OpenRouter (cron bridge action `unpin_models`). An unpinned job runs on `cron.model`, so the Hermes drift guard does not skip it. A job pinned to another model or another provider keeps its pin.
- In single-container mode no instance agent runs a release update, because the box gets a release by a rebuild of its container. There the start script removes the same lines before anything reads `instance.env` (`scripts/drop-control-plane-models.mjs`, which uses `controlPlaneEnvRemovals` of the Joshu API).

The Hindsight model follows the same rule. Each release names one Hindsight model for retain, reflect, and consolidation: `JOSHU_OPENROUTER_HINDSIGHT_LLM_MODEL`. `scripts/start-hindsight.sh` sets it when `HINDSIGHT_API_LLM_PROVIDER` is `openrouter` and `HINDSIGHT_API_LLM_MODEL` is unset. The control plane wrote `HINDSIGHT_API_LLM_MODEL=google/gemini-3.1-flash-lite` into `instance.env` of each box, so the cleanup of `instance.env` above also removes that line, when `HINDSIGHT_API_LLM_PROVIDER` is `openrouter`. A box whose Hindsight uses another provider keeps its own model, because the release model is an OpenRouter model id.

The other models of a release are constants with an env override for one box:

| Use | Constant or default | Override |
|---|---|---|
| Small classifiers: mail triage, action guard, realtime goal router, Day 0 | `JOSHU_OPENROUTER_CLASSIFIER_MODEL` | `JOSHU_EA_CLASSIFIER_MODEL`, `JOSHU_ACTION_GUARD_CLASSIFIER_MODEL`, `JOSHU_REALTIME_GOALS_CLASSIFIER_MODEL`, `JOSHU_DAY0_MODEL` |
| Hermes session search | `JOSHU_OPENROUTER_SESSION_SEARCH_MODEL` | `JOSHU_HERMES_SESSION_SEARCH_MODEL` |
| Skills merge at the skills seed | default in `scripts/merge-hermes-factory-skill.mjs` | `JOSHU_HERMES_SKILLS_MERGE_MODEL` |

Before a release changes a model, check that the OpenRouter account of the boxes allows the new model. An account guardrail with a list of allowed models answers HTTP 404 "Model blocked by guardrail" for a model that is not in the list, and then every request with that model fails on every box.

Design decisions:

- 2026-11-11: the release owns the model, not the control plane. A new model needs testing with the skills and patches of a release, so it ships with the release. Before, new boxes got the model from a control plane setting that nobody changed with the releases, and four boxes ran an old model. A release field in `deploy/RELEASE.json` that the update writes into `instance.env` was the other option. It was rejected, because the code default already exists in the image, and a self-hosted box has no control plane to send the field.
- 2026-11-11: the cleanup recognizes the old control plane values by a fixed list of models, not by a marker. The old lines have no marker, and the list has only the three models that the control plane ever wrote. An override that names one of these models is also removed. Its effect is the same as the release model until a release changes the model.
- 2026-11-11: the shell scripts and the voice service keep a copy of the model name as a fallback, because they cannot import the TypeScript constant. The test `npm run test:release-hermes-model` fails when a copy differs from the constant, and when the list in the instance agent differs from the list in the Joshu API.
- 2026-11-18: the release also owns the Hindsight model. The control plane wrote the Hindsight model into each box, as it did with the Hermes model, so a new Hindsight model needed an env change on each box. The start script of Hindsight now has the release model as its fallback, and the cleanup of `instance.env` removes the old control plane value. Only OpenRouter is covered, because the release model is an OpenRouter model id and a box on another provider chose its model on purpose. A job of the control plane that rewrites the env of each box was the other option. It was rejected, because it must run again for each new model, and a self-hosted box has no control plane. A rollback to a release before this one needs the line `HINDSIGHT_API_LLM_MODEL` written back by hand, because the older start script has no fallback.
- 2026-11-18: in single-container mode the start script does the cleanup of `instance.env`, not the instance agent. A sandbox box gets a release by a rebuild, and the instance agent there runs no release update. The start script is the first reader of `instance.env` in that mode, so every service starts without the old values. The deploy script could remove the lines when it writes the release pins of a sandbox, but a self-hosted box in single-container mode has no deploy script.

Code map: `src/joshuOpenRouterDefaults.ts` (the models, the lists, and `controlPlaneEnvRemovals`), `scripts/start-hindsight.sh` (the Hindsight fallback), `scripts/drop-control-plane-models.mjs` (the cleanup in single-container mode), `src/hermesApi.ts` (`getJoshuHermesModel`, config sync), `src/hermesReleaseModel.ts` and `scripts/hermes-cron-bridge.py` (cron unpin), `packages/instance-agent/src/releaseEnv.ts` and `scripts/patch-instance-env.mjs --unset` (the `instance.env` cleanup). Tests: `npm run test:release-hermes-model`, `npm run test:hermes-cron-unpin-models` (needs a Hermes checkout).

## The web provider of a box

A box searches the web and reads pages in two places: the Hermes tools `web_search` and `web_extract` of the companion, and the research pipeline of Research reports and recurring reports. Both use the same rule. A box that can reach You.com uses You.com, and a box that only has an Exa key (`EXA_API_KEY`) uses Exa. On a box with both, Exa is the fallback: it answers a search or a page that You.com could not answer.

A box reaches You.com in one of two ways:

- **Relay mode** (`JOSHU_YOU_MODE=relay` in `/etc/joshu/instance.env`). The box holds no You.com key. It posts each You.com call to the proxy of the control plane (`JOSHU_YOU_RELAY_URL`, or `<CONTROL_PLANE_URL>/api/instances/you/proxy`) with its instance agent token, and the control plane adds the key. A managed box works this way.
- **Own key** (`YDC_API_KEY`). A self-hosted box can set the You.com key of its owner, and then calls `https://ydc-index.io` directly.

`JOSHU_YOU_MODE=off` turns You.com off. Both ways make the same two calls: the web search with `POST /v1/search`, and the text of one page with `POST /v1/extract`.

- **Research pipeline.** `boxWebClient` in `src/research/pipeline/you.ts` gives the web client of the box. The You.com client has the interface of the Exa client, so the pipeline code is the same for both. The source list of a report names the provider that the box used, "Web (You.com)" or "Web (Exa)". A request can name a provider with `web_provider`, and then the box uses that one.
- **Companion.** Hermes has no You.com web backend, so Joshu ships one: plugin `joshu-web-you` in `.hermes/plugins/`, which registers the web backend `you`. The plugin holds no key and no rule about the provider. It posts each call to the Joshu API on localhost, `POST /api/web/search` or `POST /api/web/extract` (`src/webProvider/routes.ts`), and the Joshu API runs the call with the web client of the box. The Joshu API sets `web.backend` in the Hermes `config.yaml` at each start (`applyWebBackend` in `src/hermesApi.ts`) and keeps the plugin enabled. When the Joshu API itself does not answer and the box has an Exa key, the plugin calls the Exa backend of Hermes.
- **Passages for a question.** For news and paper pages, the pipeline asks for the passages of a page that answer the brief. Exa has such a call and You.com has none, so these passages come from Exa when the box has an Exa key, and are left out when it has none.

Design decisions:

- 2026-11-18: You.com is the web provider of a box that can reach You.com, for the companion and for the research pipeline. Before, the companion always used Exa, and a Research report used You.com only when the owner asked for it and only through the content router. Dan chose You.com as the default for both.
- 2026-11-18: a managed box holds no You.com key. It reaches You.com through a proxy of the control plane, with its instance agent token. One key that all boxes share was the first design. It was rejected, because a box runs an agent with a terminal, so a key on a box can leak, and a shared key then leaks for every box at once and cannot be taken away from one box. You.com has no API that makes keys, so one key for each box, as with Exa, is not possible.
- 2026-11-18: the proxy is not the content router. The content router takes the cost from the usage wallet of the owner and has no endpoint for the full text of a page, so a web search of the companion would stop with an empty wallet. The path through the content router stays for a box with no You.com access, when a request names You.com.
- 2026-11-18: Exa stays as the fallback, and the Exa key stays on the boxes. A failed web search stops the companion in the middle of a task, and a box in relay mode depends on the control plane for each search. Removing Exa was the other option. It was rejected for now, also because You.com has no call for the passages of a page for a question.
- 2026-11-18: the backend of the companion calls the Joshu API, and the Joshu API calls You.com. So the rule about the provider, the proxy call, and the fallback exist one time, in TypeScript, for the companion and for the research pipeline, and the plugin holds no key and no token. A backend that calls the proxy from Python was the other option. It was rejected, because it copies the rule and makes the plugin read the instance agent token.
- 2026-11-19: a search result keeps at most 1,500 characters of passages, and the companion gets at most 600 characters as the description of a result. You.com returns up to about 14,000 characters of passages for one result. Exa is asked for at most 1,500, and the prompts and time limits of the research pipeline are tuned for that size.

Code map: `src/research/pipeline/you.ts` (`youAccess`, `youRelayPost`, `youDirectPost`, `makeYouApiClient`, `boxWebClient`), `src/webProvider/routes.ts` (the two routes for the plugin), `.hermes/plugins/joshu-web-you/` (the backend), `src/hermesApi.ts` (`applyWebBackend`), `deploy/scripts/vps-start.sh` (plugin enable at start), `src/research/make.ts` and `src/research/recurring/runtime.ts` (the callers). Tests: `npm run test:joshu-web-you`, `npm run test:hermes-web-backend`, `npm run test:research-pipeline`.

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
