# Help and common questions

**My companion does not answer my texts.**
Check that your mobile number is in the **Telephone** app, with the country code. Your companion answers only that number. Also check that your Twilio number sends texts to your box, as the [Twilio guide](../vps-sandbox/twilio-self-host.md) describes. For US mobile numbers, the number needs an approved A2P 10DLC registration on your Twilio account. If you once sent STOP or CANCEL, send **START** to turn texts on again.

**My companion does not answer my calls.**
Calls need your Twilio number, the voice service of your box, and a Gemini API key. The [Twilio guide](../vps-sandbox/twilio-self-host.md) has a health check and a list of common problems.

**My companion does not ask me for approvals.**
On a self-hosted box, approvals are off until you turn them on in the **Safety** app. Approvals also come by text message, so your box must be able to send texts and your mobile number must be in the **Telephone** app. In the **Safety** app, click **Test approval** to check that approvals reach you. See [Turn on approvals first](07-safety-and-approvals.md#turn-on-approvals-first).

**My companion did not act on an email.**
Your companion acts on an email thread only when it is in To, CC, or BCC, or when the email says that it will help. New mail can take up to 10 minutes to arrive on your box. Your companion also needs its own mailbox from your Nylas account (see [Optional services](01-getting-started.md#optional-services)).

**The Connectors app shows nothing to connect.**
The Connectors app needs your Composio API key as `COMPOSIO_API_KEY` in `/etc/joshu/instance.env`. Add the key and restart the Joshu stack.

**jChat does not answer.**
Your companion needs your OpenRouter API key. Open the **Welcome** app and add the key in the **Connect AI** step.

**The phone call hangs up after the passphrase.**
After three wrong tries, the call ends. Check or change your passphrase in the **Telephone** app. Two clear words with several syllables work best. You can also set a keypad PIN.

**I get too many, or too few, nudges.**
Reply **MORE** or **LESS** to a nudge. See [Nudges](04-reminders-nudges-and-daily-briefs.md#nudges).

**jWeb is blank.**
jWeb goes to sleep after about 5 minutes of no use. Open it again and it wakes up.

**File Brain finds nothing.**
File Brain needs a Gemini API key, which you add in the **Welcome** app. Right after a restart, File Brain also needs a few minutes to rebuild its index. Wait, then search again.

**jChat shows an error.**
Type **continue**. If that does not help, start a new chat.

**My companion remembers something wrong.**
Tell it the right fact in chat, for example "Sam is my business partner."

**I forgot my desktop password.**
A self-hosted box does not email reset links. Reset the password from your server with SSH. See [Getting started](01-getting-started.md#if-you-forget-your-desktop-password).

**I want to start over.**
In **Settings**, under **Joshu**, **Box State**, you can make a snapshot first and then use **Hard reset**. See [Snapshots and reset](09-desktop-apps.md#snapshots-and-reset).

**How do I get help from a person?**
You run your box yourself, so nobody looks after it for you. The [self-host guide](../self-host.md) and the [VPS quickstart](../vps-sandbox/hetzner-quickstart.md) list common problems and their fixes. If you find a bug, open an issue in the Joshu GitHub repository.
