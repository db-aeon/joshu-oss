# Safety (ArozOS desktop app)

**Safety** is the desktop UI for Joshu agent write policy: action guard (HITL), MCP hard blocks, owner SMS approval status, and Hermes chat tokens.

For the full security model (tiers, bypass matrix, architecture), see **[`agent-safety.md`](agent-safety.md)**.

---

## Stack

| Layer | Path |
|-------|------|
| Desktop UI | `apps/safety-settings/` → `dist/safety-settings/` → `arozos/subservice/safety-settings/app/` |
| ArozOS subservice | `arozos/subservice/safety-settings/` (`moduleInfo.json`, `start.sh`, **`.startscript`**) |
| REST API | `src/safetySettings/` → `/joshu/api/safety-settings` |
| Policy file | `.joshu/action-guard/policy.json` |
| Local secrets / toggles | `.joshu/safety-settings/local-env.json` |
| Owner channel | `.joshu/owner-channel/owner-channel.json` |

**Display name:** desktop label and `moduleInfo.json` `"Name"` are **Safety**. Subservice directory remains `safety-settings/`.

---

## Dev and build

```bash
npm run dev:safety-settings   # Vite :3010, proxies /joshu → :8788
npm run build:safety-settings
npm run dev:arozos            # builds all subservices + installs Safety.shortcut
```

Open from the ArozOS **Safety** desktop icon, or `http://127.0.0.1:8787/safety-settings/index.html` (path via subservice proxy).

---

## UI sections

### Browser backend (jWeb / handoff)

| Control | Description |
|---------|-------------|
| Shared browser | **Local Chromium** (default, OSS self-host) or **Browser Use Cloud** (Joshu-managed fleet with control plane) |

Saved to `.joshu/safety-settings/local-env.json` as `JOSHU_BROWSER_BACKEND` and `JOSHU_CLOUD_BROWSER`. Overrides `instance.env` on stack restart. **Restart `joshu-stack`** after changing. Cloud option is disabled when `CONTROL_PLANE_URL` + instance agent token are missing.

See [`hitl-camofox-notes.md` — Browser backend](hitl-camofox-notes.md#browser-backend-local-chromium-vs-browser-use-cloud).

### Status bar

Live summary: gate active/off, owner SMS configured, Slack chat configured, **Hermes gateway** running/stopped.

### Action guard (HITL)

| Control | Description |
|---------|-------------|
| Enable action guard | Master switch (`policy.json` / `JOSHU_ACTION_GUARD_ENABLED`) |
| Gate mode | `external_writes` (default) or `allowlist` |
| Approval timeout | 5 / 15 / 30 / 60 minutes |
| Gate browser writes | Hermes browser **click/type/press** in the shared browser when enabled (default **off**). Requires the Hermes CDP browser guards patch (`scripts/patch-hermes-browser-cdp-guards.mjs`) + gateway restart — see [`agent-safety.md` — Browser write gate](agent-safety.md#browser-write-gate) |
| Bypass owner-only mail | Skip gate for sends to `primaryWorkEmail` only |
| LLM classifier | Optional soft classifier for ambiguous actions + threshold |

### Owner approval (SMS)

Read-only status for Twilio owner SMS (Telephone owner mobile, or `TWILIO_OWNER_CALLER`). Approvals are sent by text; reply **Y** or **N**. See [`vps-sandbox/twilio-self-host.md`](vps-sandbox/twilio-self-host.md) and [`telephone-arozos-app.md`](telephone-arozos-app.md).

### Hard policy

| Control | Description |
|---------|-------------|
| MCP tool policy | Tier-1 blocks: Composio Gmail send, deletes, Nylas calendar writes |
| Terminal mail guard | Block `nylas email send` / curl send bypass in Hermes terminal |

### Hermes Telegram chat

Password field for `TELEGRAM_BOT_TOKEN` (Hermes owner ↔ agent chat — separate from SMS approvals). **Pairing code**: when the Telegram bot answers an unknown user with a pairing code, enter the code here to approve the user (see Slack chat below).

### Slack chat with the companion

Slack chat: the owner messages the companion in Slack like a coworker. The Hermes gateway runs the Hermes Slack adapter in **Socket Mode** with the bot token and the app token of the box Slack app (one Slack app for each box). Slack chat is separate from the **Composio Slack** toolkit in Connectors (MCP tools that read and send Slack messages for the owner). Action-guard approvals use **SMS**, not Slack. See [hermes-integration — Slack chat](hermes-integration.md#slack-chat-hermes-messaging-gateway).

**Connect Slack** (the default path):

1. The owner clicks **Connect Slack**. The Safety app opens jWeb, and the Joshu API opens `api.slack.com/apps` in the shared browser.
2. The owner signs in to Slack in jWeb. On each poll, the Joshu API reads every tab of the shared browser (address, title, headings, open dialog, **Generate Token**), names the Slack page, and the card says what the box sees and what the owner does next. After a sign-in (for example "Launching <workspace>"), the Joshu API keeps one tab and opens `api.slack.com/apps`. **I'm signed in** on the card tells the box to do that at once.
3. Fixed code in the Joshu API (no model) clicks **Generate Token** under "Your App Configuration Tokens", makes the box Slack app with `apps.manifest.create`, and clicks **Generate Token and Scopes** on the settings page of the app (scope `connections:write`). The code finds each token by its pattern: the app token on the page, the configuration token through the **Copy access token** button (a copy catcher in the page, no write to the clipboard). The code checks the result of each click and tries each click step up to 3 times; when **Generate Token** opens no dialog, it loads the page again first. The stack log names the step that stopped a try. When a button is not where the code expects it, the card tells the owner which button to click, and the run continues after the click.
4. The shared browser opens the Slack consent page. The owner clicks **Allow**. Slack sends the shared browser to `https://<box host>/joshu/api/slack/oauth/callback`, and the Joshu API exchanges the code for the bot token.
5. The Joshu API checks both tokens, saves them, saves the Slack user who clicked **Allow** in `SLACK_ALLOWED_USERS`, and deletes the earlier box Slack app of the same workspace. If `SLACK_HOME_CHANNEL` is empty, the DM channel with the owner becomes the Slack home channel.
6. The Joshu API restarts the Hermes gateway and waits until the new gateway answers. The restart waits while the gateway runs a cron job, an api_server turn, or a live call (at most 10 minutes); the card then says that the companion is finishing a task and will message in a few minutes.
7. The companion sends the owner a first DM in Slack. The DM comes only after the restart, so when the owner answers at once, the companion answers.

The tokens and the configuration token stay in the memory of the run and in `local-env.json`. They never go into a model, a trace, a log, or the run status. A run ends after 30 minutes. If the workspace needs approval by an admin, the owner starts again after the admin approves.

**Set up by hand** (the fallback path):

| Control | Description |
|---------|-------------|
| **Create Slack app** | Opens `api.slack.com/apps?new_app=1&manifest_json=…` with the box manifest filled in |
| **Copy manifest** / **Download manifest** | The box manifest as JSON |
| **Verify tokens** | `auth.test` on the `xoxb-…` token and `apps.connections.open` on the `xapp-…` token |
| **Bot token** | `SLACK_BOT_TOKEN` (`xoxb-…`, from Install App after install) |
| **App token** | `SLACK_APP_TOKEN` (`xapp-…`, App-Level Token with `connections:write`) |
| **Allowed member IDs** | Optional `SLACK_ALLOWED_USERS` (`U…`). After Save, Joshu looks up the owner email with `users.lookupByEmail` and fills it in |
| **Home channel** | Optional `SLACK_HOME_CHANNEL` (`C…` / `D…`) for cron / proactive delivery. Defaults to the DM with the companion |
| **Allowed channels** | Optional `SLACK_ALLOWED_CHANNELS` — restrict which channels accept @mentions |

On **Save** with new Slack tokens, Joshu checks each new token with Slack first. A token that Slack rejects shows an error, and Save changes nothing. Then Joshu saves the tokens and finds the Slack user of the owner. Save answers at once; the companion sends the first DM after the background restart of the Hermes gateway.

**Pairing code**: if no owner address matches a Slack user, `SLACK_ALLOWED_USERS` stays empty. The owner sends the companion a DM in Slack, and the companion answers with a pairing code. The owner enters the code under **Pairing code**. Joshu runs `hermes pairing approve slack <code>`, adds the user to `SLACK_ALLOWED_USERS`, and the companion sends a DM. A Joshu patch of Hermes (`scripts/patch-hermes-pairing-reply.py`) makes the pairing reply point to the Safety app.

**The box manifest** comes from `hermes slack manifest --agent-view` (`buildBoxSlackManifest` in `src/hermesSlackSetup.ts`): `agent_view` (a normal DM in the Slack Messages tab), the name of the companion in every name and description, only the slash commands `/new` and `/stop`, scope `users:read.email`, and the OAuth redirect URL of the box. A manifest cannot set the app icon: the card links to the portrait of the companion and to the settings page of the box Slack app.

When Slack or Telegram settings change, Save syncs `SLACK_*` / `TELEGRAM_*` into `~/.hermes/.env` and restarts the Hermes gateway in the background. The restart waits while the Hermes gateway runs a cron job, an api_server turn, or a live call (at most 10 minutes).

### Actions

- **Save** — writes policy file, optional owner-channel `gateMode`, and local-env; restarts the Hermes gateway in the background when messaging changed
- **Restart gateway** — sync messaging env and restart Hermes (picks up Slack/Telegram tokens)
- **Test approval** — sends a test HITL notification by SMS. Reply **Y** or **N** to approve or deny.
- **Refresh** — reload from server

---

## Source badges

Each setting shows where the effective value comes from:

| Badge | Meaning |
|-------|---------|
| **.env** | Locked — set in process environment |
| **saved here** | `.joshu/safety-settings/local-env.json` |
| **policy file** | `.joshu/action-guard/policy.json` |
| **default** | Built-in default |

---

## Settings map

| UI control | Env var (if set) | Persisted to |
|------------|------------------|--------------|
| Enable action guard | `JOSHU_ACTION_GUARD_ENABLED` | `policy.json` |
| Gate mode | `JOSHU_ACTION_GUARD_GATE_MODE` | `policy.json` + owner channel |
| Browser gate | `JOSHU_ACTION_GUARD_BROWSER_GATE` | `policy.json` |
| LLM classifier | `JOSHU_ACTION_GUARD_LLM` | `policy.json` |
| Approval timeout | `JOSHU_ACTION_GUARD_TIMEOUT_MS` | `policy.json` |
| MCP hard policy | `JOSHU_MCP_TOOL_POLICY_ENABLED` | `policy.json` `mcpToolPolicyEnabled` |
| Terminal mail guard | `JOSHU_TERMINAL_MAIL_GUARD` | `local-env.json` |
| Owner SMS | Telephone **Your mobile** (or `TWILIO_OWNER_CALLER`) + Twilio account/number/webhook | `.joshu/telephone/settings.json` then `instance.env` |
| Hermes chat bot | `TELEGRAM_BOT_TOKEN` | `local-env.json` |
| Hermes Slack bot / app tokens | `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` | `local-env.json` |
| Slack allowed users / channels | `SLACK_ALLOWED_USERS`, `SLACK_HOME_CHANNEL`, `SLACK_ALLOWED_CHANNELS` | `local-env.json` |
| Box Slack app (Connect Slack) | `SLACK_APP_ID` | `local-env.json` |

---

## API

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/joshu/api/safety-settings` | GET | Current settings + source badges |
| `/joshu/api/safety-settings` | PUT | Update policy, secrets. New Slack tokens are checked with Slack first. A messaging change restarts the Hermes gateway in the background |
| `/joshu/api/safety-settings/restart-gateway` | POST | Sync `~/.hermes/.env` messaging vars and restart Hermes gateway at once |
| `/joshu/api/safety-settings/slack-setup` | GET | Slack setup steps, configured and owner-linked flags, app settings and portrait links |
| `/joshu/api/safety-settings/slack-manifest` | POST | Box manifest JSON and the prefilled "create app" link |
| `/joshu/api/safety-settings/slack-verify` | POST | Check `xoxb` (`auth.test`) and `xapp` (`apps.connections.open`) tokens |
| `/joshu/api/safety-settings/slack-connect` | GET | Status of the Slack connect run (phase, hint, error, app ID, workspace; never a token) |
| `/joshu/api/safety-settings/slack-connect/start` | POST | Start a Slack connect run. `409` while a browser handoff is pending |
| `/joshu/api/safety-settings/slack-connect/signed-in` | POST | The owner clicked **I'm signed in**: at its next look, the run keeps one tab and opens `api.slack.com/apps`. Changes nothing outside phase `sign_in` |
| `/joshu/api/safety-settings/slack-connect/cancel` | POST | Cancel the Slack connect run |
| `/joshu/api/safety-settings/pairing/approve` | POST | `{ platform: "slack" \| "telegram", code }` — approve a Hermes pairing code |
| `/joshu/api/slack/oauth/callback` | GET | Public. Slack OAuth redirect of Slack connect; needs the `state` of the current run |
| `/joshu/api/safety-settings/test-approval` | POST | Send test approval notification |
| `/joshu/api/hermes/gateway` | GET | Gateway running / auto-start status |

All routes under `/joshu/api/safety-settings` need the ArozOS desktop session of the owner (`verifyArozosDesktopSession`) or a direct localhost request. Other requests get `401`. See [`vps-sandbox/box-api-edge-security.md`](vps-sandbox/box-api-edge-security.md).

Implementation: [`src/safetySettings/store.ts`](../src/safetySettings/store.ts), [`src/safetySettings/routes.ts`](../src/safetySettings/routes.ts), [`src/slackConnect/`](../src/slackConnect/).

---

## Apply vs restart

| Change | Takes effect |
|--------|----------------|
| Gate mode, timeouts, MCP policy toggle | Immediately for Joshu + MCP proxies on next policy fetch |
| **Browser gate** (`browserGateWrites`) | Joshu immediately; Hermes after gateway restart (`JOSHU_ACTION_GUARD_BROWSER_GATE` synced to `~/.hermes/.env`) |
| Approval SMS | Immediate when Twilio owner SMS is configured |
| `TELEGRAM_BOT_TOKEN`, `SLACK_*` (local-env) | After the background restart of the Hermes gateway that Save starts (or **Safety → Restart gateway**) |
| `JOSHU_TERMINAL_MAIL_GUARD` (local-env) | After Hermes gateway restart (**Safety → Restart gateway**) |
| Values in `.env` | After process restart |

Save syncs messaging env to `~/.hermes/.env` immediately; the running gateway process must restart to load new Slack/Telegram tokens.

---

## Troubleshooting

### Desktop icon does nothing

ArozOS static subservices require **`.startscript`** in `arozos/subservice/safety-settings/` so boot uses `start.sh` instead of looking for a missing binary.

1. Confirm `arozos/subservice/safety-settings/.startscript` exists
2. Restart `npm run dev:arozos`
3. Look for log line: `[joshu-safety-settings] serving …/safety-settings/app on 127.0.0.1:…`

### API errors in the app

Joshu must be running on `:8788`. In dev, Vite proxies `/joshu` to the API.

### Test approval fails

Owner SMS must be configured (Telephone owner mobile or `TWILIO_OWNER_CALLER`, plus Twilio webhook). Check `GET /joshu/api/action-guard/status` → `smsConfigured` / `ownerChannelLinked`. Reply **Y** or **N** to the test SMS.

**Slack chat:** after Connect Slack or Save, the Hermes gateway restarts in the background (it waits while the gateway is busy). The card shows "Your Slack user: Linked" when `SLACK_ALLOWED_USERS` has your `U…` ID; if not, DM the companion and enter the pairing code. DM the companion or `@mention` it in an invited channel. If **Connect Slack** stops at a token step, follow the hint in the card and click the named button in jWeb, or use **Set up by hand**. One Socket Mode connection per Slack app — do not reuse the same `xapp-` token on two boxes at once. Channel `@mentions` reply in a **thread** by default — see [hermes-integration — Slack chat](hermes-integration.md#slack-chat-hermes-messaging-gateway) (`reply_in_thread: false` for in-channel replies). If nothing happens, check `~/.hermes/logs/gateway.log` for `inbound message: platform=slack` (no line ⇒ Socket Mode not receiving on this box).

**Hermes Telegram chat:** DM the **chat** bot (`TELEGRAM_BOT_TOKEN`) — that is not the approval path.

---

## Related

- Security overview: [`agent-safety.md`](agent-safety.md)
- Connectors: [`connectors-arozos-app.md`](connectors-arozos-app.md)
- Desktop shortcuts: [`arozos-desktop-shortcuts.md`](arozos-desktop-shortcuts.md)
