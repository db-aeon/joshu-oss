# Reminders, nudges, and daily briefs

Your companion helps you keep track of your day in three ways: reminders that you ask for, nudges about things that wait for you, and daily briefs.

## Reminders

Ask your companion for a reminder on any channel, for example:

- "Remind me in 2 hours to call the bank."
- "Remind me at 9 am on Thursday to send the invoice."
- "Remind me every morning to write to Alex until I do it."

Reminders come by text message when your box can text you. Your box can text you when your Twilio number is connected for texts and your mobile number is in your profile. Otherwise reminders come by email from your companion's mailbox to your work email. If your box has neither, your companion cannot send you reminders.

- To stop a repeating reminder, reply **DONE** to the reminder text within two hours. Your companion answers, for example, "Done. I stopped the reminder 'Write to Alex'." You can also tell your companion at any time, for example "I wrote to Alex, stop that reminder."
- A repeating reminder comes at most once each hour. It stops after 30 days unless you give an end date, and it can last at most 180 days.
- You can have up to 20 reminders at the same time. Ask "What reminders do I have?" to see them.

## Nudges

Sometimes your companion needs a decision from you, for example "Should I accept the new meeting time from Alex?" When nobody else can answer, your companion sends you a **nudge**: a short text about one open question. Each nudge ends with a reference line such as `Ref: pj/t_3888bee9`, so that your reply goes to the right question.

By default, you get at most one nudge each day, on weekdays between 08:00 and 17:00, and never during a meeting. Nudges come the same way as reminders, by text or by email.

Reply to a nudge in one of these ways:

| Reply | What happens |
|---|---|
| Your answer, in your own words | Your companion continues with your answer. |
| **DONE** or **CLOSE** | Your companion closes the question. |
| **KEEP** | The question stays open for now. |
| **MORE** | You get more nudges each day (up to 5). |
| **LESS** | You get one nudge each day again. |
| **USEFUL** or **NOT USEFUL** | Your companion learns what helps you. |
| **EVENINGS OK** or **NO EVENINGS** | Nudges may, or may not, come in the evening. |
| **WEEKENDS OK** or **NO WEEKENDS** | Nudges may, or may not, come on weekends. |

DONE, CLOSE, and KEEP must be the whole message.

Each workday morning, your companion also cleans up old questions that no longer matter. If it is not sure, it asks you with a nudge, and you reply DONE or KEEP.

## Daily briefs

Your companion plans your day with you, at the times that come from your working hours in the Welcome app. The briefs come by email from your companion's mailbox, so they need your Nylas account (see [Optional services](01-getting-started.md#optional-services)).

- **Morning brief**, at the start of each workday: an email with what is left from yesterday, the decisions that wait for you, the meetings that are not settled, and two to four suggested priorities for today.
- **Evening brief**, at the end of each workday: what you planned compared with what happened.
- **Weekly brief**, on Friday morning: a summary of the week, when there is something to say.

In jChat, you can also say:

- "**morning review**" to go through the morning brief together and plan your day;
- "**time block today**" to get a plan of meetings, focused work, and short tasks for the day, drawn in **jWhiteboard**;
- "**shutdown**" to close your day.

Your companion keeps these plans in the `Planning` folder, one file for each day.

Next: [Files, search, and memory](05-files-search-and-memory.md).
