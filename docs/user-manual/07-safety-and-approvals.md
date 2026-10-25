# Safety and approvals

Your companion can read for you freely, and it can ask you before it does something that other people will see. The chapter explains how to turn on these approvals on your own box, how they work, and how you can change them.

## Turn on approvals first

On a self-hosted box, approvals are off when you install the box. While approvals are off, your companion sends email to people outside, sends calendar invites, and posts in Slack without asking you. The copy to your work email is then the only way that you see what it sent.

Approvals work only when all of these are true:

1. Your Twilio number is connected to your box for text messages (see the [Twilio guide](../vps-sandbox/twilio-self-host.md)).
2. Your mobile number is in the **Telephone** app.
3. Approvals are switched on in the **Safety** app. You can also set `JOSHU_ACTION_GUARD_ENABLED=true` in `/etc/joshu/instance.env`.

If your box cannot send texts, your companion has no way to ask you, so it goes ahead without asking, even when the switch is on. The status bar of the Safety app shows whether approvals work. Click **Test approval** to check.

## Approvals by text message

When approvals work, before your companion sends an email to somebody outside, sends a calendar invite, or posts in Slack, it texts your mobile and describes what it wants to do. Reply **Y** to approve or **N** to stop it. Words like "yes", "ok", "approve", "no", and "deny" also work. A longer sentence that starts with "Ok…" counts as normal chat, not as an approval.

If you say no, or if you do not answer within 30 minutes, nothing is sent. You can change the waiting time in the **Safety** app (5, 15, 30, or 60 minutes).

Approvals come only by text message, so you need your mobile number in the **Telephone** app (see [Getting started](01-getting-started.md#the-four-setup-steps)).

Your companion does not ask before:

- reading mail, calendars, and files;
- sending mail only to your own work email;
- anything that you do yourself, for example mail that you write in jMail.

When your companion emails people outside, it copies (CC) your work email, so you always see what it sent.

## The Safety app

The **Safety** app has:

- an on and off switch for approvals;
- the waiting time;
- **Test approval**, which sends you a test text so that you can check that approvals reach you;
- a status bar that shows whether approvals work.

## When your companion needs you in the browser

Some steps on websites are for you only: signing in, two-factor codes, payments, and final confirmations. When your companion reaches such a step, it sends you a link with its answer, for example by text when you asked by text or by phone. The link opens a page on your own desktop address. Open the link on your phone and sign in with your desktop username and password. You must sign in each time, also when you are already signed in on your desktop.

The page shows what your companion needs, a live picture of the website, and normal text fields below the picture. Type into the fields, not into the picture, then tap **Fill and continue**. When you are finished, tap **I'm done**, or just reply to your companion's text. About 20 seconds later, your companion tells you what happened next.

- Use two fingers on the picture to scroll or zoom.
- If a drop-down list does not open in the picture, choose the value in the fields below.
- **More Options** helps with unusual pages.
- The link works for 45 minutes, longer while you use it, and at most 3 hours.

## Multiplayer safety

Teams in Multiplayer have extra protections. See [Safety in Multiplayer](08-boss-mode.md#safety).

Next: [How to use Multiplayer](08-boss-mode.md).
