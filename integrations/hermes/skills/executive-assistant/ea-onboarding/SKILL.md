---
name: ea-onboarding
description: "Resolve setup-debt cards on ea-onboarding (Connectors, owner mobile, release prompts)."
metadata:
  hermes:
    category: joshu
    version: "1.0.0"
---

# EA Onboarding

**Board:** `ea-onboarding` — setup checklist from the ship-with-release onboarding registry (`factory/onboarding-prompts.yaml`). Cards have `kind: onboarding` and `prompt_id:` in the body.

Used when:
- Proactive resolve runs on an `ea-onboarding` blocked card (`proactive:resolve:<taskId>`)
- Owner replies to a setup nudge (SMS/jChat)

**Not** mail ingress, scheduling, or project work — no `nylas_send_message`.

## Resolve mode

When Joshu routes an owner reply to this skill:

1. `skill_view('ea-onboarding')` — this section.
2. `kanban_show` — read `prompt_id`, `deep_link`, title, block_reason, comments.
3. **Re-check completion** (box state, not owner assertion alone):
   - `connect-work-gmail` → Connectors Gmail connected
   - `owner-mobile-sms` → `resolveOwnerCaller` (Telephone settings, Welcome, or `TWILIO_OWNER_CALLER`)
4. If predicate satisfied → `kanban_complete` with audit comment; tell owner setup is done for that item.
5. If not satisfied → guide owner to the right desktop app:
   - `deep_link: Connectors` → open Connectors, connect work Gmail + calendar
   - `deep_link: Telephone` → open Telephone → **Your mobile**
   - `deep_link: Welcome` → reopen Welcome → Schedule & email → **Your mobile**
6. Owner says **later** → comment on card; do not complete. (Snooze via prompt-state is future — for now leave blocked.)
7. Owner says **skip** on **required** items → acknowledge; explain why it is needed; keep card blocked until predicate passes.
8. Reply in first person — what you checked, what to do next. No board slugs in SMS.

## Forbidden

- `nylas_send_message` on this board
- `ea-playbook` mail ingress or Project reconcile (no project slug)
- Inventing new setup steps not in the card body

## Registry

New setup prompts ship in `factory/onboarding-prompts.yaml` with `introducedIn`. Joshu reconcile upserts cards on upgrade — you do not create cards manually.
