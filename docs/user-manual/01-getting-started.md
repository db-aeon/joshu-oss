# Getting started

## Your companion and your box

Your companion is your Joshu, an AI assistant that works only for you. It has its own name, picture, and voice, and it signs its emails as "*your name*'s Joshu".

Your companion lives on your **box**, the server where you installed Joshu. You run the box yourself, so you also decide which accounts and services your companion can use. If you have not installed Joshu yet, start with the [self-host guide](../self-host.md) and the [VPS quickstart](../vps-sandbox/hetzner-quickstart.md).

The box has three addresses that you will use:

| What | Example | What it is for |
|---|---|---|
| Your desktop | `https://mybox.example.com` | A desktop in your web browser, with your files and apps. The address is the domain that you set as `CUSTOMER_DOMAIN` when you installed the box. |
| Your companion's email | `mina@example.com` | Your companion's own inbox, on a domain that you own. You can email it, and other people can too. |
| Your companion's phone number | shown in the **Telephone** app | Call or text your companion. The number comes from your own Twilio account. |

The desktop works as soon as the box is installed. The email address and the phone number are optional, and you set them up yourself (see [Optional services](#optional-services)).

## Your companion's name, picture, and voice

You set your companion's identity in the file `/etc/joshu/instance.env` on your server:

| Setting | What it sets |
|---|---|
| `JOSHU_NAME` | Your companion's name, for example `Mina` |
| `JOSHU_OWNER_NAME` | Your name, as your companion uses it, for example `Maya` |
| `JOSHU_IMAGE_URL` and `JOSHU_AVATAR_URL` | The address of your companion's picture |
| `JOSHU_VOICE_ID` | The voice of your companion on calls and in jChat, for example the Gemini voice `Kore` |

If you set nothing, your companion is called "Companion" and you are called "Owner". After you change the file, restart the Joshu stack as the self-host guide describes, and start a new chat in jChat.

Your companion starts with the default personality that comes with Joshu. There is no personality quiz on a self-hosted box.

## First login

Open your desktop address in a web browser. On the first visit, the box asks you to create an account. Use the same username that you set as `JOSHU_AROZ_USER` when you installed the box, and choose the `administrator` group. Then sign in.

After you sign in, the **Welcome** app opens by itself. Welcome asks a few questions so that your companion knows how you work:

1. **Connect AI.** Paste your OpenRouter API key, so that your companion can think and chat. You get a key at [openrouter.ai/keys](https://openrouter.ai/keys). You can also paste a Gemini API key from [aistudio.google.com/apikey](https://aistudio.google.com/apikey). The Gemini key turns on the microphone in jChat and phone calls, and it also lets **File Brain** and **Memory** work. If you already put these keys in `/etc/joshu/instance.env`, Welcome skips this step.
2. **Big picture.** Tick the things that matter to you now. Each one becomes a project folder that your companion keeps up to date.
3. **Schedule and email.** Your work email, your mobile number (optional here, but important, see below), your time zone, and your working hours.
4. **Review.** Check your answers. If you set up a Nylas account (see [Optional services](#optional-services)), you can also create your companion's mailbox here. Then click **Finish setup**.

When you finish, your companion sets up your morning, evening, and weekly briefs from your working hours. You can open Welcome again at any time from its desktop icon to change your answers or to add a key that you skipped.

## The four setup steps

Your companion works best when four things are done. Until they are, your companion reminds you once a day, and it mentions the next open step at the end of one reply each day. The daily reminder comes by text message when your box can send texts, and otherwise by email from your companion's mailbox to your work email.

1. **Your profile.** Your work email, time zone, and working hours, in the Welcome app.
2. **Your mobile number.** Open the **Telephone** app and enter your own mobile number with the country code, for example `+1 415 555 0100`. Do not enter your companion's number here. Your companion uses your mobile to text you, to ask for your approval, and to recognize you when you call.
3. **Your work mail.** Open the **Connectors** app, choose **Gmail**, click **Connect**, and sign in with your work account.
4. **Your calendar.** In **Connectors**, choose **Google Calendar** and click **Connect**.

Each step completes by itself when your companion sees that it is done. Telling your companion "done" does not complete a step, because your companion checks the real setting.

Your companion also has optional **setup tips**, for example saving its phone number as a contact on your phone, or setting a keypad PIN for calls. Setup tips never send you reminders.

## Optional services

Some features need an account with an outside service. You make each account yourself, and you put its key in `/etc/joshu/instance.env`. Then you restart the Joshu stack.

| Feature | Service | What to set | Guide |
|---|---|---|---|
| Connect Gmail, Google Calendar, Slack, and other accounts | Composio | `COMPOSIO_API_KEY` | [Connectors](../connectors-arozos-app.md) |
| Your companion's own email address and calendar | Nylas, with a domain that you verified in Nylas | `NYLAS_API_KEY` | [Agent mailbox](../nylas-agent-mailbox.md) |
| Phone calls and text messages | Twilio, with a number that you bought | `TWILIO_*` settings | [Twilio phone](../vps-sandbox/twilio-self-host.md) |

Without Composio, the Connectors app cannot connect your accounts, so your companion cannot read your mail or calendar. Without Nylas, your companion has no email address of its own. Without Twilio, you talk to your companion in jChat, by email, in Slack, or in Telegram.

For text messages to US mobile numbers, your Twilio number also needs an A2P 10DLC registration on your own Twilio account. Until the registration is approved, the carriers block the texts. The Twilio guide explains the steps.

## Connect your accounts

The **Connectors** app connects your companion to your other accounts through your Composio account. Click **Connect apps**, choose a service (for example Gmail, Google Calendar, Google Drive, or Slack), and sign in in the window that opens. When the last page says that you can close the window, you are done.

- To add a second mailbox, click **Connect another account**. Each mailbox gets its own tab in the **jMail** app.
- New mail arrives on your box about every 10 minutes. Connecting an account does not copy your old mail.
- To give your companion a head start, click **Analyze mail for setup (Day 0)** after you connect Gmail. Your companion reads your last 30 days of mail and calendar and fills in the Welcome app for you to check.
- To disconnect an account, open Connectors and disconnect that account.

## Your phone passphrase

When you call your companion, it asks for your spoken **passphrase**, or for a keypad **PIN** if you set one. The passphrase stops other people from using your companion by phone. You set the first passphrase as `TWILIO_THINK_PASSWORD` when you set up Twilio, and you can change it and set a PIN in the **Telephone** app.

- Choose two clear words with several syllables, for example "harbor lantern".
- After three wrong tries, your companion hangs up.
- You can turn on **Skip the passphrase from my phone**, so that calls from your own mobile go straight through. Anyone who has your unlocked phone can then talk to your companion, so only use this if your phone is locked.

## If you forget your desktop password

A self-hosted box does not email reset links. When you click **Forgot password?** on the sign-in page, the box shows how to reset the password from your server.

1. Sign in to your server with SSH as `root`.
2. Run `cd /opt/joshu` and then `bash scripts/arozos-reset-password.sh YOUR_USERNAME 'your-new-password'`.
3. Wait until the box is back, and sign in with the new password.

The script stops the desktop for a short time while it changes the password. The first run also takes one or two minutes to prepare. If another administrator account on the same box is still signed in, that person can also reset your password in **System Settings**, under **Users**. The [VPS quickstart](../vps-sandbox/hetzner-quickstart.md#forgot-arozos-password) has more detail.

The desktop password is not the password of **Hermes Admin**. See [The Kanban dashboard](09-desktop-apps.md#the-kanban-dashboard).

## Change your companion

To give your companion a new name, picture, or voice, change the settings in `/etc/joshu/instance.env` (see [Your companion's name, picture, and voice](#your-companions-name-picture-and-voice)) and restart the Joshu stack. The email address and phone number of your companion stay the same, because they come from your Nylas and Twilio accounts. After the change, start a new chat in jChat.

Next: [Talking to your companion](02-talking-to-your-companion.md).
