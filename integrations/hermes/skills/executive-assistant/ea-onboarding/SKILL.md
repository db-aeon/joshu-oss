---
name: ea-onboarding
description: "Resolve setup cards on ea-onboarding: required setup steps (profile, mobile, work Gmail, calendar) and optional setup tips."
metadata:
  hermes:
    category: joshu
    version: "1.0.0"
---

# EA Onboarding

**Board:** `ea-onboarding` — the setup board. One card for each setup step in `factory/onboarding-prompts.yaml` that the owner has not done. Cards have `kind: onboarding`, `prompt_id:`, and `type:` in the body, then the how-to: sections "Why", "Steps", and "Common mistakes".

Two types of card:
- **Required setup step** (`type: required`): blocked, block kind `needs_input` (an owner question). Gets the daily nudge and the setup mention.
- **Setup tip** (`type: tip`): blocked with reason `optional setup tip` and no block kind. No nudge, no setup mention. The owner may ignore it or move it to done. Setup tips: `tip-connect-work-account` (only when no connected Google account has the work email), `tip-voice-pin`, `tip-save-box-number`, `tip-first-phone-request`, `tip-email-a-request`.

Used when:
- Proactive resolve runs on an `ea-onboarding` blocked card (`proactive:resolve:<taskId>`)
- Owner replies to a setup nudge (SMS/jChat)

**Not** mail ingress, scheduling, or project work — no `nylas_send_message`.

## Resolve mode

When Joshu routes an owner reply to this skill:

1. `skill_view('ea-onboarding')` — this section.
2. `kanban_show` — read `prompt_id`, `type`, `deep_link`, title, block_reason, comments, and the how-to in the body.
3. **Re-check completion** (box state, not owner assertion alone). The required setup steps:
   - `owner-profile` → owner name, time zone, and primary work email in the profile (Welcome → "Schedule & email")
   - `owner-mobile-sms` → `resolveOwnerCaller` (Telephone settings, Welcome, or `TWILIO_OWNER_CALLER`)
   - `connect-work-gmail` → at least one Gmail account in Connectors
   - `connect-calendar` → at least one Google Calendar account in Connectors
4. If the step is done → `kanban_complete` with audit comment; tell owner setup is done for that item. Joshu's reconcile also closes cards by itself.
5. If not done → guide the owner with the **Steps** and **Common mistakes** of the card body. Do not invent other steps.
6. Owner says **later** → comment on card; do not complete.
7. Owner says **skip** on a **required** setup step → acknowledge; explain why it is needed (section "Why" of the card); keep card blocked until the step is done.
8. **Setup tip** card → help if asked. If the owner does not want the tip, or did it in a way the box cannot see (for example saving Joshu's number as a contact), `kanban_complete` the card.
9. Reply in first person — what you checked, what to do next. No board slugs in SMS.

## Forbidden

- `nylas_send_message` on this board
- `ea-playbook` mail ingress or Project reconcile (no project slug)
- Inventing new setup steps not in the card body
- Nudging the owner about a setup tip

## Registry

New setup prompts ship in `factory/onboarding-prompts.yaml` with `introducedIn`. Joshu reconcile upserts cards on upgrade — you do not create cards manually.
