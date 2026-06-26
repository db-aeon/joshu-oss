# Investor / broadcast response classification

When Dan sends a bulk investor update or broadcast (sourced from a single `todo.md` task like "Email existing investors"), the inboxes produce **N independent reply stubs** from different recipients. Each needs separate triage within the same parent project.

## Response types and treatment

| Response type | Signal | Treatment |
|---|---|---|
| **Info / status change** | "I stepped down", "I'm moving firms", "Send to my partner" | Note in journal + about.md. No todo row unless a follow-up action is created (e.g. "Contact Mara about fundraising"). Mark stakeholder status updated. |
| **Scheduling request (direct)** | "Let's meet Mon or Tue", "Free this week for a call" | Keep in the parent project — embedded scheduling (investor follow-up is a project step). Add scheduling task to todo if not already there. |
| **Scheduling via Calendly** | "Start w/ this and LMK. https://calendly.com/rick-barryfamilyoffice" (or similar link-instead-of-pick) | Use the Calendly link directly. Do NOT propose alternate slots — the investor proactively offered their booking page. Check Dan's calendar for available slots on the Calendly page, or pick the earliest that works. If the book-by deadline is given, respect it. This is still embedded scheduling under the parent project. |
| **Scheduling resolved** | "Call booked for Tue 11:30", "Confirmed for Thursday" | Add prep item to todo with the confirmed time + dial-in. Remove from open scheduling tasks. Not waiting — this is a calendar commitment. |
| **Out of office / bounce** | OOO auto-reply, delivery failure | Note in journal as related notification. If OOO has a return date, add waiting row with that date. |
| **Referral to someone else** | "Mara will handle this", "Talk to Noah about scheduling" | Create new external-contact row in todo if the referral person needs follow-up. Set Waiting on to the referral contact. |
| **Resolved by owner / thread terminal** | Dan already replied to the investor (asked "what are you up to", made a closing remark) and the investor's reply is just conversational closure. No remaining ask on either side. | File under journal only — no todo row, no new action. The thread is naturally resolved. Mark the owner's todo row (e.g. "Email existing investors") as noting a response from this recipient, not as needing follow-up. |

## Key distinctions

- **Do NOT create separate projects per investor response at first blush.** All follow-up from a single broadcast starts under the same parent project. But as volume accumulates (5+ threads, 2+ active scheduling negotiations, a multi-person investor list to process), review whether the investor activity has crossed the threshold into its own project — see "Project scope hygiene" in ea-playbook SKILL.md.
- **File on the parent project first**, then **`scheduling_create_meeting_task`** on `ea-scheduling` when a call is needed — investor follow-ups are project steps, not standalone cold scheduling.
- **Do NOT duplicate the parent broadcast tracking** — the "Email existing investors" todo row stays done; these responses are its downstream effects.

## Calendly security blocks

Calendly often rejects automated booking via browser agents with a "This booking cannot be completed" / "security reasons" error (error code prefix `tid-rb-`). When this happens:

1. **Don't retry** — the block is session-level, not time-of-day.
2. **Read the available slots** from the Calendly page so you know what's on offer.
3. **Email the investor directly** with the specific time you want — e.g. "Thursday, June 18 at 10:00 AM PT works well for Dan. Could you send over a calendar invite?"
4. **CC Dan** on the reply so he's in the loop.
5. **Create a kanban card** tracking the scheduling as "waiting on reply" so the slot doesn't get lost.

The fallback is email-based confirmation with a specific proposed time, not re-offering a menu of options — the investor already put their calendar online, so pick and confirm.

## Parent thread reference

When documenting in the project journal, group all responses under a single heading:

```
**Investor newsletter follow-up** (from "[Aeon Investors]" thread):
- Clark Landry — stepped down, Mara handles fundraising. Noted.
- Elizabeth Yin (Hustle Fund) — call booked Tue Jun 16 @ 11:30 AM PDT (phone).
- Thierry Ho (Reitler Advisory) — wants Zoom call, scheduling pending.
```