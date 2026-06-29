---
name: ea-project-kanban
description: "Drips, pipelines, HITL: Kanban project boards, not todo.md."
metadata:
  hermes:
    category: executive-assistant
    version: "1.4.0"
---

# EA Project Kanban

**Default for multi-step work.** If a request has several steps, parallel lanes, timed follow-ups, or **human-in-the-loop** (owner approval, replies, judgment calls), run it on a dedicated Hermes board — not as a one-shot chat turn or rows in `todo.md` alone.

Kanban gives you durable state (`ready` / `running` / `blocked` / `done`), crash recovery, Hermes Admin visibility, and `kanban_block` when waiting on a person. Joshu action guard on sends is a common HITL gate — workers should expect `kanban_block` until approval clears.

`Projects/<slug>/` holds a **brief summary** and file pointers — not a mirror of every card.

Layout: `docs/executive-assistant.md` · `${JOSHU_FILES_ROOT}/FILING.md`

## When to use Kanban (prefer this skill)

| Signal | Examples |
|--------|----------|
| **Multi-step** | Research → draft → send → follow up; gather docs → summarize → email |
| **Parallel** | Email 10 people; chase three vendors; multiple workstreams |
| **HITL** | Owner must approve sends (`nylas_send_message` action guard), confirm spend, pick between options |
| **Wait on others** | Block until reply; negotiate; "check back Thursday" |
| **Long-running** | Work may span days; needs resume after restart |
| **Supervision** | Owner wants to see cards on Hermes Admin |

**Skip Kanban** for: single quick answers, one immediate send with no follow-up, inbox stub filing (`ea-playbook`), or automated meeting-mail scheduling (`ea-scheduling`).

## Triggers

| Trigger | This skill |
|---------|------------|
| User asks to **start a project** or any **multi-step / HITL** task | Full kickoff below |
| Drip/outreach, email N people + follow up | Full kickoff below |
| User asks **status** on an active Kanban project | Read `about.md` `kanban_board`, use `kanban_list` on that board |
| Mail triage stub | **Not this skill** — use `ea-playbook` |
| Scheduling / meeting mail | **Not this skill** — use `ea-scheduling` on `ea-sched-*` boards |

## vs other EA skills

| Skill | Role |
|-------|------|
| **ea-playbook** | Ingest stubs → update `Projects/` docs; cron rollups |
| **ea-scheduling** | Fixed ingress + meeting boards for calendar negotiation |
| **ea-project-kanban** | **Multi-step and HITL work** on `project-<slug>` boards (campaigns are one common case) |

## Kickoff flow

1. **Clarify** (minimal): goal, steps or waves, who/what is parallel, **HITL gates** (approvals, owner decisions), follow-up timing.
2. **Filesystem** under `${JOSHU_FILES_ROOT}/Projects/<slug>/`:
   - `about.md` — outcome, urgency; leave `kanban_board` / `kanban_root_task` null until step 5
   - Supporting files as needed — e.g. `recipients.md` (outreach), `brief.md` (constraints for root card body)
3. **Board** `project-<slug>` (slug = folder slug, lowercase hyphens).

   Create the board using one of these paths (check in order):

   **A) Joshu bridge MCP tools (preferred on Joshu boxes).**  
   `mcp_joshu_connectors_project_kanban_ensure_board(projectSlug="<slug>", name="<Short title>")` creates the board and returns db_path.  
   Then `mcp_joshu_connectors_project_kanban_create_triage_root(projectSlug="<slug>", title="...", body="...")` for the root task (body from [decomposition-template.md](references/decomposition-template.md)).

   **B) `kanban_create` / `kanban_list` tools** if your profile has the `kanban` toolset (check your tool list before assuming they're absent — you may have them even when the CLI is missing).

   **C) Hermes CLI** if on PATH and tools unavailable:

   ```bash
   hermes kanban boards create project-<slug> \
     --name "<Short title>"
   # NOTE: workdir is set per-task on kanban create via --workspace dir:<path>, not on the board itself.
   ```

   **D) SQLite direct insert** if none of the above are available (see [references/kanban-sqlite.md](references/kanban-sqlite.md)).

   Board slug must match `project-<slug>`.

4. **Triage root card** (when not created via MCP in step A) — **no assignee**, `triage: true` (CLI: `--triage`). Body from [decomposition-template.md](references/decomposition-template.md). Pass body text inline:

   ```bash
   # Body text is passed inline via --body (not a file path flag)
   BODY=$(cat /path/to/body.md) && hermes kanban create "Title" --triage --body "$BODY"
   ```

5. **Update `about.md`** frontmatter:

```yaml
kanban_board: project-<slug>
kanban_root_task: <task_id from create>
```

Append one-line outcome under the title. Do **not** copy every child task into `todo.md`.

## Worker execution (after decompose)

Child tasks run via dispatcher (`kanban-worker` + assignee profile, default `default`).

1. `kanban_show()` — read title, body, workspace
2. Work in `$HERMES_KANBAN_WORKSPACE` (project folder)
3. Outbound mail: **`nylas_send_message`** via Joshu connectors MCP — **action guard = HITL**; do not spin in chat; `kanban_block(reason="awaiting owner approval")` until send succeeds
4. Browser / sensitive UI: use **joshu-browser** when the step needs owner in the loop; then `kanban_block` or `kanban_complete` with evidence in metadata
5. Complete: `kanban_complete(summary=..., metadata={step, evidence})`
6. **HITL / waiting:** `kanban_block(reason=...)` — owner reply, approval, external party, or "need decision"
7. Follow-ups: prefer `scheduled_at` on create or `parents` deps (next wave after prior `done`)

## Follow-ups and replies

- **Timed follow-up:** create or decompose wave-2 cards with `scheduled_at` (ISO8601) or parent links to wave-1 ids
- **Reply received:** comment on the relevant card; `kanban_block` follow-up until meeting worker logic applies — do not auto-send without reading the thread (`read_file` on mail mirror or gbrain)
- **Milestones only** in `journal_YYYY-MM-DD.md` and `about.md` summary — not per-card rows in `todo.md`

## Hermes Admin

Owner can supervise at `hermes-admin.<box>/` — pick board `project-<slug>` in the switcher.

## Forbidden

- `ea-sched-ingress` / `ea-scheduling` boards for campaigns
- `scheduling_*` MCP tools
- `triage` creates on EA boards (Joshu bridge rejects them)
- Mirroring full Kanban backlog into `todo.md`
- `kanban_create` from workers to fan out unrelated work (orchestrator / decomposer handles fan-out)

## Pitfalls

**Tool order matters.** On Joshu VPS boxes, prefer **Joshu bridge MCP** (step 3A) before CLI or SQLite. Do not waste retries on `hermes kanban` when `project_kanban_*` MCP tools are available.

**`hermes` CLI not on PATH.** If `which hermes` fails, fall through to `kanban_*` tools or SQLite (step 3D). Do not waste retries on the CLI.

**`kanban_*` tools not in toolset.** When the active profile doesn't include the `kanban` toolset, `kanban_create`, `kanban_list`, etc. are absent from available tools. Use MCP (3A) or SQLite direct insert (3D) without hesitation.

**SQLite db_path unknown.** Board databases live at `~/.hermes/kanban/boards/project-<slug>/kanban.db`. If the board hasn't been created yet, use `mcp_joshu_connectors_project_kanban_ensure_board` first, then locate the db from `.meta.db_path`.

**ID collision on manual insert.** Always query existing task IDs (`SELECT id FROM tasks`) and use `secrets.token_hex(6)` with a collision-check loop. Do not guess or increment hex values.

**Task state can change between dispatch and startup.** Always `kanban_show` first if the tool is available. If status is `blocked` or `archived`, stop — you shouldn't be running.

**Body is JSON, not opaque text.** The `body` column stores structured metadata (`name`, `email`, `e1_sent`, etc.) as serialized JSON. When reading `body` back, use `json.loads()` — do not treat it as plaintext.

## Escalation

Surface to owner: bulk list unclear, legal/financial sensitivity, repeated send failures, action guard timeout.