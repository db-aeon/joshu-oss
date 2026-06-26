# Root triage card body template

Copy into the **triage** root task on board `project-<slug>`. Use for **any multi-step project** — not only email drips. Call out **HITL gates** explicitly so decomposed child tasks use `kanban_block` instead of guessing.

```markdown
kind: project
project_slug: <slug>
board: project-<slug>
skill: ea-project-kanban

Goal: <one sentence outcome>

Audience:
- See Projects/<slug>/recipients.md

Decomposition hints:
- Wave 1: one child task per recipient — read recipients.md row, draft personalized email, get owner approval if uncertain, send via nylas_send_message
- Wave 1 tasks: assignee default, workspace dir:${JOSHU_FILES_ROOT}/Projects/<slug>/
- Do NOT mirror every child into todo.md
- Wave 2: follow-up tasks with parents=[all wave-1 task ids]; scheduled_at +3 business days where appropriate
- If recipient replies: kanban_block that recipient's follow-up; comment with summary

HITL / approval (required section for most projects):
- List each gate: owner approve send, owner pick option, wait for reply, browser step, legal/financial sign-off
- nylas_send_message → action guard — worker must kanban_block until approved
- Draft in kanban_comment before send when tone or list is sensitive
- Never treat “waiting on owner” as done — kanban_block with clear reason

Forbidden on this board:
- scheduling_* MCP tools
- ea-sched-* boards
- kanban_create fan-out to ea-scheduling

Files:
- Projects/<slug>/about.md (summary + kanban_board pointer — update at milestones)
- Projects/<slug>/recipients.md
- Projects/<slug>/journal_YYYY-MM-DD.md (milestone log only)
```

## Board CLI (human or hermes-cli toolset)

```bash
hermes kanban boards create project-<slug> \
  --name "<Project title>" \
  --description "Joshu ad-hoc project" \
  --switch

hermes kanban create "Title" \
  --triage \
  --body "<paste body text here -- passed inline, not from file>"
  
# Note: --default-workdir and --body-file flags do not exist in the current Hermes CLI.
# Set workspace per-task via --workspace dir:<path> on kanban create.
# Pass body text inline with --body.
```

Or use `kanban_create` / `kanban_list` when the active profile has the `kanban` toolset.

### Fallback: no CLI, no kanban toolset

See `references/kanban-sqlite.md` in this skill — create cards via direct SQLite insert at `~/.hermes/kanban/boards/project-<slug>/kanban.db`. Same workflow, different tooling.
