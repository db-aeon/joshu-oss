# Your desktop apps

Your desktop has apps for the things that you do with your companion. You can do almost everything by just talking to your companion, so think of the apps as a place to look and to fine-tune.

| App | What it is for |
|---|---|
| **jChat** | Chat with your companion on your desktop. |
| **jMail** | Read your companion's inbox and your connected Gmail inboxes, one tab for each. Under **Setup**, create your companion's mailbox with your Nylas account. |
| **jWeb** | A web browser that you and your companion share. You can watch your companion use it. |
| **Connectors** | Connect Gmail, Google Calendar, Slack, and other accounts through your Composio account. Under **AI providers**, paste your own fal.ai key for pictures and video. See [Getting started](01-getting-started.md#connect-your-accounts). |
| **Safety** | Choose when your companion must ask you first. See [Safety and approvals](07-safety-and-approvals.md). |
| **Telephone** | Your companion's phone number from your Twilio account, your mobile number, and your phone passphrase or PIN. |
| **Schedules** | The jobs that your companion does on a timetable, for example your daily briefs. |
| **Memory** | What your companion remembers. See [Files, search, and memory](05-files-search-and-memory.md#what-your-companion-remembers). |
| **File Brain** | Search everything on your desktop. |
| **jNotes** | Write and edit notes. Your companion can help you edit. |
| **jWhiteboard** | A shared whiteboard for planning with your companion. |
| **last30days** | Find out what people said about a topic in the last week or month. |
| **Multiplayer** | See your [Multiplayer](08-boss-mode.md#see-your-teams-in-the-multiplayer-app) teams: a group chat where each companion posts, and a board of all the team's work. |
| **jMovie** | Edit videos. |
| **Welcome** | Your AI keys, and your profile: work email, time zone, working hours, and priorities. |
| **Files**, **Settings**, **Trash** | The file manager, the settings of your box, and the trash. |

## jWeb

jWeb shows the browser that your companion uses. Type an address in the address bar to go to a page. Normal copy and paste does not always work inside the page, so use the **Paste into field** and **Copy from browser** buttons. When nobody uses jWeb for about 5 minutes, it goes to sleep, and it wakes up again when you open it. A blank jWeb is usually asleep, not broken.

## jWhiteboard

Click **New Board**, then **Start Session**, and ask your companion to add or change sticky notes. To change one sticky note, select it and then say what you want. Each change shows a small note under the sticky note, and the board saves by itself.

## Schedules

Schedules lists the jobs that your companion runs on a timetable. You can pause, resume, run, or delete a job, and you can make a new one. The easiest way to make a new job is to ask your companion, for example "Every Friday at 4 pm, send me a summary of open client work."

## last30days

Click **Research** for a one-time report on what people say about a topic, or **Watch** to check a topic every day or week. After three checks, a watched topic is labeled Trending, Steady, or Quiet. You can also ask your companion in chat, for example "Is anybody talking about our new product?"

On a self-hosted box, last30days searches the web without a key. For Reddit, YouTube, and TikTok, paste your own ScrapeCreators key, and for X, paste your own Xquik key. You paste both keys in the app, under the gear button, in **Settings**. See the [last30days guide](../last30days-user-guide.md).

## The Kanban dashboard

The Kanban dashboard shows your companion's to-do lists as boards of cards. Open it with the **Hermes Admin** icon on your desktop. The dashboard has its own address, `https://hermes-admin.` followed by your desktop domain, for example `https://hermes-admin.mybox.example.com`. The dashboard address needs its own DNS record (see the [VPS quickstart](../vps-sandbox/hetzner-quickstart.md#hermes-admin-desktop-shortcut)).

The dashboard asks for its own username and password, which are not your desktop login. The username is `admin`, and the box made the password when you installed it. You find the password as `JOSHU_HERMES_DASHBOARD_PASSWORD` in `/etc/joshu/instance.env` on your server.

In the **Kanban** tab, a list at the top lets you switch between boards:

- `ea-mail-ingress`: emails that your companion is filing.
- `ea-scheduling`: meetings that your companion is arranging.
- `ea-owner-reply`: requests that you emailed to your companion.
- `realtime-goals`: requests that you made by text, phone, Slack, or Telegram.
- `project-…`: one board for each project, mostly emails that wait for somebody's answer.
- `ea-onboarding`: setup steps that are still open.
- `team-…`: your promises to a [Multiplayer](08-boss-mode.md) team.

You never have to use the dashboard. It is there when you want to see everything that your companion is working on.

## Snapshots and reset

In **Settings**, under **Joshu**, the **Box State** page lets you save and restore your box:

- **Create snapshot** saves your files and your companion's memory, with a name that you choose.
- **Restore** brings back a snapshot. Your box may need a restart afterwards.
- **Soft apply** puts back missing default folders and files, and deletes nothing.
- **Hard reset** deletes all your files, mail copies, connected accounts, and memories, and starts the box fresh. Make a snapshot first if you might want anything back.

On a self-hosted box, a hard reset also deletes the settings that you made in the apps: the keys that you pasted in Welcome, the link to your companion's mailbox, and your mobile number, passphrase, and PIN in Telephone. Welcome then asks for your keys again. Everything in `/etc/joshu/instance.env` stays, for example your companion's name, picture, and voice, and the keys that you put in that file. Your companion's personality goes back to the default. See [Box state](../box-state.md) for the command line and the details.

## jTerm

jTerm is a command line for experts. It can change anything on your box, and it has no safety checks. If you are not sure what it does, do not use it.

Next: [Help and common questions](10-help.md).
