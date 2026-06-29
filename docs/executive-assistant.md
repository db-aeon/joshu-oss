# Executive Assistant (EA v2)

Generic guide to the Joshu **Executive Assistant** layout: GTD-style workspace, mail triage, scheduling, time blocking, and daily handoff. Identity (companion name, owner email) comes from **Welcome onboarding**, `identity.json`, and `instance.env` — never hardcoded in skills.

## Workspace layout

Factory seeds `templates/ea/` on first boot (`factory/manifest.yaml`):

```text
{files_root}/
  Triage/           # Mail stubs (work queue)
  Projects/         # Active work (about.md, todo.md, journal)
  Planning/         # Time-block diagrams + daily review
  Resources/        # Key contacts, reference
```

See [`templates/ea/FILING.md`](../templates/ea/FILING.md) for filing rules the companion follows.

## GTD mapping

| GTD bucket | Joshu path | Hermes skill |
|------------|------------|--------------|
| Inbox | `Triage/` + mail mirrors | `ea-playbook` |
| Next actions | `Projects/<slug>/todo.md` | `ea-playbook` |
| Multi-step / HITL | Kanban + project board | `ea-project-kanban` |
| Calendar / meetings | Live Google/Nylas + scheduling tasks | `ea-scheduling` |
| Daily plan | `Planning/time-block-*.excalidraw` | `ea-time-block` |
| Morning / shutdown | `Planning/daily-review-*.md` | `ea-morning-review`, `ea-shutdown` |

**Rule:** one canonical file per artifact; link elsewhere. Mail bodies stay in `connectors/mail/` mirrors — do not duplicate into project files.

## Identity at runtime

Skills must use live profile data, not example names:

| Need | Source |
|------|--------|
| Companion name | `identity.json` → `name`, or `JOSHU_NAME` |
| Owner display name | `identity.json` → `owner.displayName` |
| Owner work email | `JOSHU_OWNER_EMAIL`, Nylas `primaryWorkEmail` |
| Agent mailbox | Nylas agent grant / `nylas_get_profile` |
| Personal calendar | Connected Gmail calendars from profile |

## Onboarding

Day-1 setup: [`welcome-onboarding.md`](welcome-onboarding.md) — Welcome wizard seeds project folders and Hermes crons.

Optional mail analysis: [`day0-cold-start.md`](day0-cold-start.md) (fleet boxes with control plane may use CP-driven cold start instead).

## Time blocking

Cal Newport-style daily planning on **jWhiteboard**:

- Gather: `scripts/gather-time-block-input.mjs`
- Render: `scripts/render-time-block-excalidraw.mjs`
- Docs: [`excalidraw-sandbox.md`](excalidraw-sandbox.md)

On VPS, run scripts at `/opt/joshu/scripts/…` (not relative to Hermes Desktop cwd).

## Mail and connectors

- Agent inbox: [`nylas-agent-mailbox.md`](nylas-agent-mailbox.md)
- Owner Gmail + sync: [`connectors.md`](connectors.md)
- Mail search skill order: [`integrations/hermes/skills/mail/joshu-mail/SKILL.md`](../integrations/hermes/skills/mail/joshu-mail/SKILL.md)

## Hermes skills (factory allowlist)

Enabled in [`integrations/hermes/skills-enabled.yaml`](../integrations/hermes/skills-enabled.yaml):

- `ea-playbook`, `ea-scheduling`, `ea-time-block`, `ea-morning-review`, `ea-shutdown`, `ea-project-kanban`
- `joshu-brain`, `joshu-mail`, `excalidraw`, kanban tools

## Fleet-only depth

Operator SOPs, skill-evolution reviews, and customer-specific runbooks live in the **private** fleet monorepo — not in this public tree.
