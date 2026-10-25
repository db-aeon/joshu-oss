# The onboarding board

Board `ea-onboarding` is the setup board of a box: one card for each setup step that the owner has not done yet. A setup step is either a required setup step or a setup tip. The cards are records for the owner, not jobs. Joshu creates each card blocked, so no worker starts for it, and closes it when it sees that the step is done.

## Setup steps

The setup steps are listed in [`factory/onboarding-prompts.yaml`](../../factory/onboarding-prompts.yaml), in order. Each entry has an id, a type, a title, the release that introduced it, the desktop app where the owner does it (`deepLink`, for example `Connectors`), a named check (`completeWhen`), and the how-to: `why`, `steps`, and `mistakes`. A required setup step also has `mention`, the one sentence of the setup mention. A setup tip can have `showWhen`, a named check that must be true before its card appears. The named checks are in `src/onboarding/promptPredicates.ts`. A step added in a new release shows up on existing boxes after the upgrade.

| Setup step | Type | Done when |
|---|---|---|
| `owner-profile` | required | The profile has the owner name, a valid time zone, and the primary work email (Welcome, "Schedule & email") |
| `owner-mobile-sms` | required | The box has an owner mobile (`resolveOwnerCaller`: Telephone settings, or `TWILIO_OWNER_CALLER`) |
| `connect-work-gmail` | required | At least one Gmail account is connected in Connectors |
| `connect-calendar` | required | At least one Google Calendar account is connected in Connectors |
| `tip-connect-work-account` | tip | A connected Gmail or Google Calendar account has the primary work email. The card appears only when at least one Google account is connected. |
| `tip-voice-pin` | tip | Telephone has a keypad PIN |
| `tip-save-box-number` | tip | The owner moves the card to done |
| `tip-first-phone-request` | tip | The owner presence of the owner outbox has a phone call |
| `tip-email-a-request` | tip | The owner moves the card to done |

The required checks accept any connected account, not only the account of the work email. On some boxes the work mail is not on Google, and those boxes work with the accounts they have. The setup tip `tip-connect-work-account` covers the case where the work account is on Google but not connected.

## Cards and the reconcile

`reconcileOnboardingBoard` (`src/onboarding/reconcileOnboardingBoard.ts`) makes the board match the checks:

- For a step that is done, it completes the open card.
- For a required setup step that is not done, it makes sure a card exists and is blocked with reason `awaiting owner` and block kind `needs_input`, so the card is an owner question.
- For a setup tip that is not done, it makes sure a card exists and is blocked with reason `optional setup tip` and no block kind. The card is not an owner question.
- It never opens a done card again, so a card that the owner completed stays done.
- Steps that the owner declined or snoozed are left alone.

The card body starts with `kind: onboarding`, `prompt_id`, `type`, `deep_link`, and `required`, then has the sections "Why", "Steps", and "Common mistakes", and ends with `howto_version: <hash>`. When a release changes the how-to of a step, the reconcile replaces the body of the open card (Kanban bridge action `set_body`, allowed only on this board).

The reconcile runs when Welcome finishes, after a connectors change, after the owner saves a mobile number in Telephone or says yes to the owner mobile offer on a phone call, and daily at 06:00 UTC (Hermes cron job "Joshu onboarding reconcile"). Each start of the Joshu API installs that job when it is missing, also on a box where Welcome never finished (see [Hermes cron jobs of a box](../hermes-integration.md#hermes-cron-jobs-of-a-box)).

## How the owner hears about it

Only required setup steps remind the owner. Setup tips never get a nudge or a setup mention.

- **Nudge.** Each open required setup card is an owner question, so the hourly nudge can send it. While a required step is open, onboarding cards rank first, with at most one onboarding nudge a day.
- **Setup mention.** While a required step is open, the companion ends one reply each day on each channel (web chat, SMS, phone, Slack, Telegram, and email replies to the owner) with the `mention` sentence of the first open required setup step. The day is the local day of the owner. The dates are in the onboarding prompt state (`.joshu/onboarding/prompt-state.json`, field `mentions`). Code: `src/onboarding/setupMention.ts`. SMS, phone, Slack, and Telegram get the sentence through the broker context (`POST /api/realtime-goals/context` with `setupMention: true`), web chat through `POST /api/hermes-chat/stream`, and email through the line `setup_mention:` in the body of the owner-reply task.

When the owner replies about a card, the `ea-onboarding` skill checks the step again and either completes the card or tells the owner where to do it, with the steps from the card body.
