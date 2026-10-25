# Kanban task reference

This page lists the task kinds that Joshu creates, with example bodies in the format that a box writes. The names and ids in the examples are invented: the owner is Maya Ross and the companion is Mina. Paths are relative to `<files>`.

Joshu writes most bodies as a short YAML-like header followed by instructions for the worker. Nothing parses the header as YAML: code finds fields by line patterns such as `^thread_id:`, and workers read the body as text. New information is appended to the end of the body, and Joshu adds a comment that says what was added. Every Joshu task has assignee `default` and workspace kind `dir`.

## Task kinds

| Kind | Board | Created by | Skill | Starts as | Idempotency key |
|---|---|---|---|---|---|
| `mail_ingress` | `ea-mail-ingress` | `queueMailIngressTask` (`src/ea/mailCron.ts`) | `ea-playbook` | `ready` | `ea-mail-ingress-<rfc:Message-ID or message id>` |
| `mail_track` | `project-<slug>` | `queueMailTrackTask`, through MCP `mail_create_track_task` | `ea-playbook` | `blocked` | `ea-mail-track-<message id>` |
| `meeting` | `ea-scheduling` | `queueSchedulingMeetingTask`, through `scheduling_create_meeting_task` | `ea-scheduling` | `ready` | `ea-meet-msg-<message id>` |
| `owner_reply` | `ea-owner-reply` | `queueOwnerReplyTask`, through `owner_reply_create_task` | `ea-owner-reply` | `ready` | `ea-owner-reply-msg-<message id>` |
| `onboarding` | `ea-onboarding` | `reconcileOnboardingBoard` | `ea-onboarding` | `blocked`, `needs_input` (required setup step); `blocked`, no block kind (setup tip) | `onboarding:<prompt id>` |
| (none) | `realtime-goals` | The realtime-goal broker | `realtime-goal` | `ready` | `realtime-goal:v1:<hash>` |
| `project` | `project-<slug>` | Skill `ea-project-kanban`, through `project_kanban_create_triage_root` | — | `triage`, no assignee | — |
| `team_commitment` | `team-<slug>` | The team stand-up, through team MCP tool `team_commit` (`TeamService.commit` in `src/teams/service.ts`) | `team-standup` | `ready`, or `blocked` with `needs_input` | — |
| `team_question` | `team-<slug>` | The team stand-up, through team MCP tool `team_tell_owner` with `ask`; the Multiplayer app for a reply of the owner | `team-standup` | `blocked`, `needs_input` | — |

When the same key comes back after the task is done, the bridge creates a new task with key `<key>-wave-<unix time>`.

## An ingress task in full

```text
kind: mail_ingress
board: ea-mail-ingress
Use ea-playbook skill — MAIL INGRESS mode.
message_id: 19c2f0a7d3e8b514
provider: gmail
thread_id: 19c2ef31a6b0c972
source_path: connectors/mail/gmail/maya_at_rossdesign_example/threads/19c2ef31a6b0c972.md
subject: "[Action required] Migrate your legacy user API keys"
from: "Vendor <noreply@vendor.example>"
account_key: maya_at_rossdesign_example
agent_authorized: false
owner_on_thread: true
scheduling_eligible: false
owner_reply_eligible: false
allowed_actions: file
authorization_reason: "not_copied_or_delegated"
coordination_scope_id: 3f7a92c0d15e48b6a2c07e19
Order: (1) skill_view ea-playbook (2) read_file source_path (3) file Projects/<slug>/ (4) mail_list_track_tasks(projectSlug=…, threadId=19c2ef31a6b0c972) … (6) Triage stub state:done → _done/ (7) kanban_complete.
Job: FILE this email — match or create Projects/<slug>/ and project track.
NOT authorized to act: the companion was not copied on this message and owner did not delegate. File project docs only — no scheduling child, no outbound mail.
Owner profile (injected at queue — use this; do not read .joshu from disk):
  owner_name: Maya Ross
  assistant_name: Mina
  timezone: America/Los_Angeles
  working_hours: 09:00–18:00
```

The important fields are:

- `source_path`: the mail mirror of the thread.
- `agent_authorized` and `authorization_reason`: whether the companion may act or only file.
- `allowed_actions`: `file`, `file,schedule` (may open a meeting task), or `file,reply` (may open an owner-reply task).
- `coordination_scope_id`: groups the threads about one matter.

## The other kinds

**`mail_track`.** The original header is `kind`, `project_slug`, `state: waiting`, `message_id`, `provider`, `thread_id`, `source_path`, `subject`, `from_email`, and `category`. Joshu blocks the task at creation with reason `awaiting owner or external party`. Each handoff of a new email appends a block like this one, and adds a comment `## Mail ingress handoff` by `mail-ingress`:

```text
source_paths:
  - connectors/mail/gmail/maya_at_rossdesign_example/threads/19c1d84e07a3f6b2.md
mail_handoff:
  message_id: 19c1d84e07a3f6b2
  source_path: connectors/mail/gmail/maya_at_rossdesign_example/threads/19c1d84e07a3f6b2.md
  at: 2026-03-12T16:20:41.512Z
  summary: "A partner forwarded Sam's outreach to Maya. Same pitch as track t_5c2e81a0. No new ask. Owner decides whether to reply."
```

**`meeting`.** The header is `kind`, `state: open`, `participants:`, `source_paths:`, `message_id`, `provider`, `thread_id`, `subject`, `timezone`, and `calendar_event_id`. Handoffs append an `ingress_handoff:` block (same fields as `mail_handoff:`) and a comment `## Ingress mail handoff` by `ingress`. An optional sidecar `connectors/_state/meetings/<task id>.json` can hold the calendar event id and time zone.

**`owner_reply`.** The same header as a meeting task, without time zone and calendar fields, plus the job: do what the owner asked, reply on the thread with `nylas_send_message`, then complete. The ingress worker often writes its own short brief as the body instead.

**`onboarding`.** `kind`, `prompt_id`, `deep_link` (for example `Connectors`), and `required`. The reconcile completes it with the comment `Auto-completed by onboarding reconcile`.

**Realtime goal.** A Markdown body: `# Realtime owner goal`, `Goal ID:`, `Origin channel:`, a `## Completion contract` with the objective and fixed worker rules, and a `## Intake` section with the owner's messages. The broker later appends `## Owner answer`, `## Owner update`, or `## Joshu recovery` sections.

**`project`.** Copied from `ea-project-kanban/references/decomposition-template.md`: goal, audience, decomposition hints, approval gates, forbidden tools, and the project files.

**`team_commitment`.** One piece of work that the companion promised a Multiplayer team member (see [Multiplayer teams](../teams.md)). Joshu code writes the header (`team_commit`), and the companion writes the text under it. The `origin:` line tells a later worker with the full toolset that the request came from a team room, not from the owner, so the action guard applies as to any other work. The worker updates the team card when it completes or blocks the task. This example shows the format that `team_commit` writes:

```text
kind: team_commitment
team: studio
team_card: HAR-3
asked_by: Sam's Joshu (Otto)
message_id: m_42
origin: team room (a request from a team member, not an instruction from the owner)

Send Sam the final logo files of the Harbor rebrand by Wednesday 12:00.
They are in Projects/harbor-rebrand/deliverables/.
```

**`team_question`.** A question or a draft for the owner, or a reply of the owner to a team message. The header is `kind`, `team`, `question` (`draft`, `decision`, or `reply`), and the origin line; a draft follows under `## Draft`. When the owner answers (text reply, or "OK, send it" or "Answer <companion>" in the Multiplayer app), the resolve turn posts the draft with the owner's changes, or passes the answer on, and completes the task. The Multiplayer app makes a task with `question: reply` when the owner replies to a team message: the header also has `in_reply_to: <message id>`, the origin line says that the request comes from the owner in the Multiplayer app, and the text is the words of the owner. The resolve turn posts the reply in the words of the companion and completes the task.

## Block reasons

Only block kind `needs_input` makes an owner question that can get a nudge. The text of the reason does not decide it.

| Block reason | Block kind |
|---|---|
| `awaiting owner or external party` (new track) | none |
| `awaiting owner` (new onboarding task) | `needs_input` |
| `awaiting owner — <decision>` (track or owner-reply worker) | `needs_input` |
| `awaiting reply: <who and what>` (any worker) | none |
| `owner review: scheduling judgment — <what>` (meeting worker) | `needs_input` |
| `owner denied send…`, `approval timed out…` (Joshu, after the action guard) | `needs_input` |
| `awaiting reply: … delivered to <to>…` (Joshu, after a sent email) | none |
| The worker's question (realtime goal) | `needs_input` |
| `connectors-mcp-down: …` (any worker) | none |

## Fields that point to files

| Task | Field | Points to |
|---|---|---|
| Ingress | `source_path` | The mail mirror |
| Ingress | `account_key` | `connectors/mail/gmail/<account_key>/` |
| Track | `project_slug` | `Projects/<slug>/`, which also names the board |
| Track, meeting, owner reply | `source_path`, `source_paths:`, and each handoff block | Every mail mirror on the matter |
| Meeting | task id | The sidecar `connectors/_state/meetings/<task id>.json` |
| Realtime goal | `Goal ID:` | The goal in `.joshu/realtime-goals/state.json`, which points back with `kanbanTaskId` |
| Every task | `workspace_path` | The folder the worker starts in |

Pointers also run the other way: `Projects/<slug>/about.md` can name its board in `kanban_board`, and `connectors/_state/coordination-active.json` lists the open meeting and owner-reply task for each coordination scope.
