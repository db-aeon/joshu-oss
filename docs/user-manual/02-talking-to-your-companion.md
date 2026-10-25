# Talking to your companion

You can reach your companion in six ways. It is the same companion each time, with the same knowledge of you, so use whatever is easiest at the moment.

jChat works on every box. Each of the other channels needs a service that you set up yourself (see [Optional services](01-getting-started.md#optional-services)). Text messages and phone calls need your own Twilio number, email needs your own Nylas account, and Slack and Telegram need a one-time setup in the **Safety** app.

| Channel | Best for |
|---|---|
| Text message (SMS) | Quick requests on the go, and answering your companion's questions |
| Phone call | Talking things through while you drive or walk |
| jChat on your desktop | Longer work, setup, and anything with files |
| Email | Requests that come with attachments, and meetings to schedule |
| Slack | Asking from where your team already works |
| Telegram | Quick requests, if you prefer Telegram to text messages |

## Text messages

Text your companion's phone number, which you find in the **Telephone** app. Your companion answers only texts from the mobile number in your profile, so add your mobile first (see [Getting started](01-getting-started.md#the-four-setup-steps)).

Texts work only after you connect the SMS side of your Twilio number to your box, as the [Twilio guide](../vps-sandbox/twilio-self-host.md) describes. For US mobile numbers, the number also needs an approved A2P 10DLC registration on your Twilio account.

- Replies are short and plain. A long answer can come as up to four texts.
- If your companion needs more than a few seconds, it texts that it is working on it and that it will text you when it is done.
- After about 30 minutes of quiet, the next text starts a new conversation.
- **STOP** turns off all texts from your companion, and **START** turns them on again. **HELP** sends a short help message. Note that **CANCEL** on its own also turns off texts. To cancel a request, say "cancel that" or "never mind" instead.

## Phone calls

Call your companion's number. Calls work after you connect your Twilio number to your box and add a Gemini API key, as the [Twilio guide](../vps-sandbox/twilio-self-host.md) describes. Before your companion talks to you, it asks for your passphrase or your keypad PIN (see [Your phone passphrase](01-getting-started.md#your-phone-passphrase)). You hear "Unlocked", and then your companion greets you and tells you about any news that you have not heard yet.

- When your companion has to look something up, you hear "One moment." If it takes long, your companion offers to text you the answer, and you can hang up. Hanging up does not stop the work.
- Your companion never reads links aloud. It texts them to you.
- Say "No, that's it" to end the call.

Your companion can also **call you back**. When a long request that you made on a call is finished, your companion calls you during your working hours, or between 07:00 and 22:00 soon after you last talked. At other times it texts you. Callbacks always ask for your passphrase. If you miss a callback, your companion leaves a short voicemail and texts you the details. Say "Call me back" on any channel to get a call now, or "Don't call, text me" to get texts instead.

## jChat

Open **jChat** from its icon on your desktop. Each time you open the app, you start a new chat. The avatar in the taskbar opens a chat panel on the right that keeps its conversation.

- Click the microphone to talk instead of typing. Say "wait until I finish" if you want to dictate a longer message.
- Say "open mail" or "open browser" to open an app. Your companion can also open files and apps on your screen for you.
- A message appears when an answer arrives while jChat is hidden.
- If an answer comes back as an error, type **continue**.
- Your old chats are in the history list.

## Email

Your companion can have its own email address on a domain that you own, for example `mina@example.com`. You create the address with your Nylas account in the Welcome app or in **jMail**, under **Setup** (see the [agent mailbox guide](../nylas-agent-mailbox.md)). Your companion checks its mail about every 10 minutes.

- **Ask by email.** Email your companion a request. It does the work and replies in the same thread, with files attached if needed (for example a PDF or a slide deck). If it needs something from you, it asks.
- **Copy it on emails.** When you add your companion in To or CC, or when you write "copying my assistant" in an email, your companion can act on that thread, for example to schedule a meeting. If you do not include it, your companion only files the email into the right project.

See [Mail, calendar, and meetings](03-mail-calendar-and-meetings.md) for more.

## Slack and Telegram

In Slack, send your companion a direct message. To talk with your companion in a channel, invite it first with `/invite @<companion>`, and then mention it. In Telegram, send it a direct message.

To connect Slack, you need a Slack workspace where you can add apps. In most small workspaces, the person who made the workspace can add apps.

1. On your desktop, open the **Safety** app.
2. Under "Slack chat with <companion>", click **Connect Slack**. The **jWeb** browser opens a Slack page.
3. Sign in to Slack in jWeb, as you do in any browser. If Slack asks for a code from your authentication app, enter the code in jWeb. If the code page opens in a new tab, click that tab at the top of jWeb. The Safety app shows what your box sees and tells you when it needs you. When you are signed in, for example when Slack shows "Launching <your workspace>", your box goes on by itself. You don't need to click **Open Slack**.
4. Wait while your box makes your companion's Slack app. The Safety app shows each step.
5. When Slack asks you to allow the app, click **Allow**.
6. Wait for your companion's direct message in Slack. It usually comes within a minute. If your companion is in the middle of a task, the Safety app tells you so, and the message comes when the task ends, at most about 10 minutes later.
7. Open Slack and answer your companion. Your companion answers in the direct message itself, not in a thread, and the whole direct message is one conversation.

Here is what you see in Slack:

> **Mina:** Hi Maya, it's Mina. You can message me here anytime, like a coworker. Ask me about your day, your email, or anything you want done.
>
> **You:** What's on my calendar today?
>
> **Mina:** You have three things today: the studio call at 10, lunch with Sam at 1, and the price list review at 4.

Sometimes the box needs your help on the way:

- If Slack asks which workspace to use, pick your workspace and click **Generate**. Slack asks when you are signed in to more than one workspace.
- If the Safety app shows the name of a button, click that button in jWeb. Slack changes its pages from time to time, and your box then cannot find the button by itself.
- If you are signed in and the Safety app still asks you to sign in, click **I'm signed in**.
- If Slack asks you to prove that you are a person, do that in jWeb.
- If Slack shows "Request to install" instead of **Allow**, your workspace needs an admin to approve new apps, and **Connect Slack** cannot finish. Use **Set up by hand** instead: create the app, request the install, and after your admin approves it, install the app and copy the two codes into the Safety app.
- If your companion is using the browser to wait for you on another task, the Safety app asks you to finish that task first.
- A connection stops after 30 minutes, and it also stops when your box restarts. If the Safety app says that the connection stopped, or shows **Connect Slack** again, click **Connect Slack** again.
- Your companion has no picture in Slack at first. To add one, open the link "Portrait of <companion>" in the Safety app and save the picture. Then open the link "Slack app settings" and upload the picture as the app icon.

If **Connect Slack** does not work, click **Set up by hand** in the Safety app and follow the steps there. You copy two codes from Slack into the Safety app. If your companion then answers your first Slack message with a pairing code, enter the code in the Safety app under **Pairing code**.

Approvals always come by text message, not in Slack (see [Safety and approvals](07-safety-and-approvals.md)).

Telegram needs a one-time setup in the **Safety** app, with a Telegram bot that you make yourself. You can also put the bot settings `TELEGRAM_BOT_TOKEN` and `TELEGRAM_ALLOWED_USERS` in `/etc/joshu/instance.env`. Approvals do not come in Telegram either.

- Each channel has its own conversation, and a conversation starts fresh after 30 minutes of quiet. In Slack, type `!new` to start fresh at once. In Telegram, type `/new`.

## Ask now, get the answer later

Many requests take some time, for example "Find me a flight to Chicago next Tuesday" or "Book a table for four on Friday." When you ask for something like this by text, phone, Slack, or Telegram, your companion says that it is on it, and you can keep talking or go on with your day.

- **Add details or change your mind.** For about a minute after you ask, more details join the same request, and "never mind" stops it before it starts.
- **Cancel.** Say "never mind", "cancel that", or "forget it" to stop your latest request. If more than one request is open, your companion asks which one.
- **Check progress.** Ask "How's that going?"
- **Answer questions.** If your companion needs a choice from you, it asks one question, and your answer goes to the right request.
- **Follow up.** Up to two days later, you can add to a request, for example "nonstop only".
- **Get the result.** The answer comes where you are: on your call, in the chat where you texted recently, or by a callback. If your companion cannot finish, it says so honestly, and you can reply "try again" or "cancel".

If a request needs you on a website, for example to pay, your companion texts you a link (see [When your companion needs you in the browser](07-safety-and-approvals.md#when-your-companion-needs-you-in-the-browser)).

Next: [Mail, calendar, and meetings](03-mail-calendar-and-meetings.md).
