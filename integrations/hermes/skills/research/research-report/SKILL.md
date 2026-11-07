---
name: research-report
description: Make or resend a Research report, set up and change a recurring report, or make a report update, when the owner asks for research on a topic or wants to follow a topic.
metadata:
  hermes:
    category: productivity
    version: "1.3.1"
---

# Research report

Use this skill when the owner asks for research on a topic, for example "research the market for electric bike subscriptions". Also use it when the owner wants to follow a topic on a schedule, for example "every weekday at 7, send me what's new in humanoid robots", when the owner asks about a recurring report, and when the owner asks for an earlier report again.

The box does the research with the tools of plugin `joshu-research` and saves everything in the folder `Research` of joshu's files. Do not do the research yourself with `web_search` or the browser, and do not write your own report.

- A **Research report** covers one topic once: web sources with a citation for each fact, pictures, and a small box of social posts, as a PDF. Tool `research_report_make`.
- A **recurring report** follows one or more topics on a schedule. Each run sends a **report update** with only the stories that are new or developing since the last one. Tool `research_recurring_save`.
- A **report update** against an earlier Research report shows what changed since that report. Tool `research_update_make`.

## 1. Decide what the owner wants

- The owner names a schedule ("every weekday", "each Monday", "every morning"), or says "keep me posted on", "follow", or "track": a recurring report (section 7).
- The owner asks to research a topic: first call `research_report_find` with the topic words (section 6). Make a new Research report only when no earlier one matches, or when the owner asks for a new report from the start.
- The owner asks to send an earlier report again: section 6.
- The owner asks for the full update: section 9.

Write each topic in a few plain words, for example "electric bike subscriptions". When the owner says "this company" or "this product", write its name. When a topic can mean more than one thing, ask the owner one short question before you start, and wait for the answer. Example: "Apple" can be the company or the fruit. Ask nothing when the topic has one clear meaning.

## 2. Tell the owner that the report started

- In jChat, first write one line, for example "On it. The report takes a few minutes.", and then call the tool.
- By text message, phone, Slack, or Telegram, the owner already got the acknowledgment of the realtime goal. Do not send another one.
- By email, send no separate message. Your one reply has the report.

## 3. Make the report

Call `research_report_make` with the topic. The tool waits until the report is done, at most 10 minutes. Do not call it twice for the same request.

Also send these fields when the owner gave them:

- `notes`: what the owner said about the topic, in the words of the owner: what it means, what it is not, and what to look at, for example "CLARA Analytics, the claims AI company, not the Clara agent of Hippo". When you asked which meaning the owner wants (section 1), put the answer here. Section 7 tells what does not go in the notes.
- `sections`: only when the owner asks for a fixed structure in so many words, for example "make it with sections on funding, product launches, and competitors" is `["funding", "product launches", "competitors"]`. At most 6, in order and in the owner's words. Most requests give guidance, not a structure: "cover this space", "be exhaustive", "start with those 4 points", or a list of things to look at. Then leave `sections` out and put the guidance in `notes`, and the box picks the themes from what it finds. When in doubt, leave `sections` out. Do not ask for sections.
- When the owner points at something you said, for example "those 4 bullet points", write those points into `notes` as what the owner asked to cover.
- `web_provider`: only when the owner asks for You.com web search in so many words, send `"you.com"`. Leave it out otherwise, and the box searches the web with Exa.

The result has:

- `summary`: at most three sentences. Send it as it is.
- `emailBody`: the body of an email answer: the summary, and the headline, first paragraph, and main link of each theme. Send it as it is.
- `reportLink`: the link that opens the PDF without a sign-in.
- `pdfDesktopPath`: the PDF path for mail attachments.
- `pdfFilesPath`: the PDF path for `desktop_open`.
- `sources`: each source and its state.

## 4. Answer in the same conversation

- **Email** (worker of `ea-owner-reply`): reply on the thread with `nylas_send_message`. The body is `emailBody` as it is, then one line that the full report is attached. `attachments` is `[pdfDesktopPath]`. Then `kanban_complete`.
- **Text message, phone call, Slack, Telegram** (worker of `realtime-goal`): complete the task with the summary, a blank line, and the `reportLink` alone on the last line. Joshu sends that text to the owner. In Slack and Telegram, Joshu uploads the PDF with it. After a phone call, Joshu delivers it like any phone result: a callback that speaks the summary and texts the link, or a text message.
- **jChat**: answer with the summary and the `reportLink` as a Markdown link named "Open the report". Then call `desktop_open` with `kind: "file"` and `target: pdfFilesPath`.

## 5. When the report fails

When a tool of this skill returns `ok: false`, tell the owner in the same conversation that the report failed and that they can ask again. Do not send a partial report, and do not call the tool again on your own.

## 6. An earlier report, and research on the same topic again

Call `research_report_find` with the topic words, or with a date as `YYYY-MM-DD`.

- **Send it again** ("send me the electric bike report again"): answer as in section 4 with the summary and the `reportLink` of the match. When several reports match, take the newest one, unless the owner named a date.
- **Research it again** ("research Clara Analytics again", or a research request on the topic of an earlier report):
  - One report matches: call `research_update_make` with its `id` as `report_id` and the channel of the request (`email`, `sms`, `slack`, or `telegram`; use `email` for jChat). The tool waits, at most 10 minutes. Answer as in section 4, with the date of the earlier report in one sentence (for example "Here is what changed since your October 21 report:") and then the `digest` as it is (the summary and the themes with their links, written for the channel). When `newStories` and `developingStories` are both 0, say that nothing new came up since that report.
  - More than one report matches: ask one short question that names the reports with their dates and offers a new report, for example "Do you want an update of your October 21 report on Clara Analytics, or a new report?". Wait for the answer.
  - No report matches, the owner asks for a new report from the start, or the owner names sections or says what the topic means or is not: make a new Research report (section 3) with those `sections` and `notes`. A report update keeps the parts and the plan of the earlier report, so it cannot follow them.
- No report matches a request to send one again: say that you found no such report, and offer to make a new one.

## 7. Set up a recurring report

Call `research_recurring_save` with:

- `topics`: one entry for each topic the owner named, in their order. Each topic becomes one part of each report update. A company with its competitors and its market is one topic: "this company, competitors, and any movement in the overall space" is the one topic "CLARA Analytics". The box finds the competitors and the words of the space itself and searches them on each run.
- `days` and `times`: from the request, in the owner timezone. "Every weekday at 7" is `days: ["mon","tue","wed","thu","fri"]`, `times: ["07:00"]`. "Monday morning" is `days: ["mon"]`, `times: ["08:00"]` unless the owner names a time.
- `channel`: leave it out for email, the default on every channel of the request. Send `sms`, `slack`, or `telegram` only when the owner names that channel ("text it to me", "post it in Slack").
- `sources`: `auto` unless the owner names sources. "Only news and Reddit" is `["web", "reddit"]`. Web and news is always in.
- `notes`: what the owner said about content and format, and about what a topic means or is not, in the words of the owner, for example "at most 8 items, one line on why each one matters for my startup". Leave out recipients, tools, and budgets. The topics are the sections of each report update, so sections that the owner names for a recurring report are topics.

  The notes hold only what the owner said. Do not research the topic first, and do not add competitor names, facts about the topic, or style words that the owner did not say, for example "keep it tight and skimmable". The box writes the report updates in its own short style, and it follows each word of the notes as a rule of the owner. This rule is also for the `notes` of `research_report_make`.
- `nothing_new_line`: `true` only when the owner asks to hear about it when nothing is new.

Do not ask the owner for sources, a format, or an app. Ask one short question only when the request has no time or no days at all.

## 8. Confirm the setup in the same conversation

Right after `research_recurring_save` answers `ok: true`, tell the owner in your answer, on the channel of the request:

- the parts (`lanes[].topic`);
- the schedule (`scheduleText`) and the channel (`channelText`);
- the sources of each part (`lanes[].sources`). With Auto sources, say which sources the box picked and why, from `lanes[].reason`, in one short sentence;
- the date and time of the first report update (`nextRunAt`), in the owner timezone.

The owner does not need to answer. Keep it short. Example: "Done. Every weekday at 7:00 am I'll email you what's new in humanoid robots and in defense robotics contracts. I'll look at web and news pages, X, Reddit, and YouTube, because that's where these topics get the most coverage. The first update comes Monday at 7:00 am."

Changes, pauses, and deletes:

- Call `research_recurring_list` to find the `id`. When more than one recurring report can match, ask one short question.
- Change the parts, the schedule, the channel, the sources, or the notes with `research_recurring_save` and the `id`, and send only the fields that change. `topics` is always the full new list, `sources` is always the full new list ("add TikTok" adds `tiktok` to the current list), and `notes` is always the full new text ("skip the why it matters lines" removes that rule from the notes).
- Pause, resume, or delete with `research_recurring_state`. A delete keeps the saved report updates in `Research`.
- Confirm each change in one or two sentences, with the new schedule or parts.

## 9. The full update

When the owner asks for the full update ("send me the full update"), call `research_update_pdf` with `update`: the `lastUpdateId` of the recurring report from `research_recurring_list`, or the `updateId` of a report update from `research_update_make`. When the owner replies to the email of a report update, the recurring report is the one named in the subject ("<name>: <date>"). An email report update already has the full update attached as a PDF, so the owner asks for it mostly on the other channels or for an earlier report update. When the owner asks anyway, send it again.

- **Email**: reply on the thread with `nylas_send_message`, one sentence in the body, and `attachments: [pdfDesktopPath]`.
- **Text message, Slack, Telegram**: one sentence and the `reportLink` alone on the last line.
- **jChat**: the `reportLink` as a Markdown link named "Open the full update", then `desktop_open` with `kind: "file"` and `target: pdfFilesPath`.

## 10. Questions about earlier report updates

Each report update is in the folder of its report under `Research`, with its summary, themes, and links in `update.md` (`digest.md` before November 2026) and the stories in `update.json`. Recurring reports are under `Research/Recurring/`. To answer a question such as "what happened with the Army humanoid contract last month?", search the files of the owner (gbrain) for the story, and answer from the report updates that have it.
