# Shared browser live view and session lifetime

## Purpose

The live view is the picture of the shared browser that the owner sees and controls in jWeb on the desktop and on the browser handoff page on a phone. The companion, the workers, and the owner use the same shared browser, so the live view lets the owner watch the companion and take over a step, for example a sign-in. This document covers how the live view works on the two browser backends, why jWeb shows the browser chrome of Browser Use, how long a Browser Use Cloud session stays up when nobody uses it, and what the SMS continuation after a browser handoff knows. Operations notes for the shared browser are in [`hitl-camofox-notes.md`](../hitl-camofox-notes.md).

## Motivation

A box runs the shared browser in one of two ways. Local Chromium runs in the stack container, and Browser Use Cloud runs in a session that the control plane provisions. The two backends show the browser differently, so the live view has two implementations.

These constraints shaped the design:

- Sites open new pages, e.g., a sign-in popup or a 2-factor page in a new tab. The owner must reach such a page in the live view, or the owner cannot finish a sign-in.
- Browser Use shows one page in its live view, the active page, and it changes the active page only when a client sends the CDP command `Target.activateTarget`. It does not change the active page when a page opens or closes.
- A phone screen is small. A tab strip and an address bar take space that the page needs on the handoff page.
- A Browser Use Cloud session costs money for each minute that it runs, so Joshu stops a session that nobody uses (the idle stop). A stop loses the open tabs, carts, and half-filled forms of the session, while saved logins stay in the browser profile.

## Architecture

The live view has these parts:

- Local Chromium: `src/browserScreencast.ts` streams the CDP screencast of one page over a WebSocket (`/api/browser/screencast`), and `public/screencast-client.js` draws it and sends clicks, wheel events, and keys back as CDP input events.
- Browser Use Cloud: the route `GET /api/browser/live-frame` in `src/server.ts` returns the live view URL of the Browser Use session. `public/cloud-live-frame.js` shows that URL in an iframe and polls the route, so the iframe reloads only when Browser Use starts a new session.
- `cloudLiveFrameUrl` in `src/cloudBrowser.ts` sets the query `ui` of the live view URL. With `ui=true`, Browser Use shows its browser chrome, which is a tab strip, back, forward, reload, and an address bar. With `ui=false`, it shows only the page.
- The active page module (`src/cloudBrowserActivePage.ts`) keeps one browser WebSocket open for the session and sends `Target.activateTarget` when a page with an opener opens or when the active page closes.
- jWeb (`public/app.js`, `public/index.html`, `public/styles.css`) and the handoff page (`public/handoff.js`) mount the live view.
- The session lifecycle in `src/cloudBrowser.ts` runs a tick every 30 seconds that renews the session and runs the idle stop. `src/server.ts` gives the lifecycle a `busy()` function, which holds the session, and an `onStop` callback. The browser handoff store (`src/browserHandoff/store.ts`) owns the browser handoff records and decides whether a pending browser handoff holds the session.

## Theory of operation

On local Chromium, jWeb shows the screencast of one page and its own address bar. Joshu keeps one tab in the shared browser. The same-tab shim loads links and `window.open` calls in the same tab, except a sign-in popup, so the owner and the companion see the same page.

On Browser Use Cloud, jWeb calls `/api/browser/live-frame?chrome=1`, and the route returns the live view URL with `ui=true`. jWeb adds class `live-browser-chrome` to the page, which hides the jWeb address bar, and the iframe fills the pane, because Browser Use fits the 1024 by 768 page under its own tab strip. The clipboard bar of jWeb stays, because pasting into the page of a remote browser still needs it.

When a site opens a sign-in popup, the active page module makes the popup the active page, so the live view shows it at once, and the tab strip shows it as a second tab. When the popup closes, the module makes the opener the active page again. When a site opens a page in a new tab for another reason, e.g., the 2-factor page of a Slack sign-in, the tab strip shows the new tab, and the owner clicks it.

The handoff page calls `/api/browser/live-frame` with its signed handoff token. The route never returns `ui=true` to a handoff viewer, also when the request has `chrome=1`, so the phone view shows only the page.

### Session lifetime on Browser Use Cloud

Each `browser_*` tool call of Hermes, each poll of a visible jWeb pane, and each heartbeat of the handoff page touch the session. The tick stops the session when the last touch is older than `CLOUD_BROWSER_IDLE_TIMEOUT_MS` (default 5 minutes) and `busy()` returns false. `busy()` returns true in these cases:

- the local browser agent runs a step;
- a `browser_*` tool call ran within the last 120 seconds;
- a browser handoff is pending and the owner has not opened the handoff page yet, until the link expires (45 minutes, extended by heartbeats up to 3 hours);
- a browser handoff is pending, the owner opened the handoff page, and the last owner activity on the handoff page is less than `HANDOFF_OWNER_ACTIVITY_MS` (default 10 minutes) old.

The first heartbeat or overlay poll of the handoff page sets `ownerOpenedAt` on the browser handoff record. Until then, a pending browser handoff holds the session for the whole life of the link, so the staged page is there when the owner opens the link late.

After an idle stop, Joshu tells the companion what happened in two ways. First, `src/cloudBrowser.ts` keeps one restart notice in memory, and `POST /api/browser/ensure` returns the restart notice once in field `restarted`. The patched `tools/browser_tool.py` of Hermes then returns the tool error `browser_restarted` with the message of the restart notice, after it adopted the new session, so the next call runs normally. Second, the `onStop` callback stamps `browserStoppedAt` and `browserStopReason` on each browser handoff record that is pending or that ended within the last hour, and `browser_handoff_status` returns a `message` that says when and why Joshu stopped the shared browser. A stop on shutdown of the stack container and a stop of an orphan session leave no restart notice, because the companion turns of the old process are gone too.

### SMS continuation after a browser handoff

When the owner taps "I'm done" on the browser handoff page, `src/browserHandoff/routes.ts` calls `deliverSmsHandoffContinuation`. The function waits 20 seconds, so that a Hermes turn that is still running can end, and it runs one Hermes turn on the current `sms:` session of the owner. That `sms:` session can be new, because a Kanban worker makes most browser handoffs, so the turn often sees no earlier turns.

The turn gets its context from one system message, which `buildSmsHandoffContinuationMessages` builds. The system message says that the companion made the browser handoff and that the owner finished the step. It then gives the request of the owner, the handoff brief in quotes with the note that the companion wrote it for the owner, the staged page, and the instruction to check the page with `browser_snapshot`. `loadHandoffTaskContext` finds the request in two places. First, it reads the objective of the realtime goal whose `kanbanTaskId` is the Kanban task id of the browser handoff. Second, it asks the Kanban bridge for the title and the body of that Kanban task on board `realtime-goals`. A lookup that fails leaves its part out. The user message of the turn only says that the owner finished the step. Joshu texts the reply of the turn to the owner and marks the browser handoff record, so the SMS continuation runs once.

Plugin `joshu-browser-handoff` sends the Kanban task id with `browser_handoff_request`. When the model passes no `kanban_task_id`, the plugin sends `HERMES_KANBAN_TASK`, which Hermes sets for each Kanban worker.

## Design decisions

- **2026-09-23: show Browser Use Cloud in an iframe with `ui=false`.** jWeb had its own address bar, so the page alone was enough. Replaced for jWeb by the decision of 2026-10-11.
- **2026-10-09: follow sign-in popups with `Target.activateTarget`.** The live view did not show a sign-in popup, and after the popup closed it showed a blank page. The alternative was to show the tab strip, and the team decided on 2026-10-09 to keep the tab strip hidden. The active page module fixes sign-in popups without a tab strip.
- **2026-10-11: jWeb shows the browser chrome of Browser Use (`ui=true`).** In a Slack connect test, each click on **Authenticate** opened the 2-factor page in a new tab that the owner could not see, so the owner could not finish the sign-in, and an operator closed tabs over CDP. The active page module helps only for pages with an opener. The alternatives were to extend the module to each new page, which would move the live view away from the page that the owner uses, or to build a tab strip in jWeb, which would copy what Browser Use already has. jWeb hides its own address bar so that the owner sees one address bar. The handoff page keeps `ui=false`, because the phone screen is small.
- **2026-10-20: the Joshu server closes page dialogs itself and catches the error.** The Joshu server and the Hermes workers drive the same browser over separate CDP connections. When a page opens a dialog, e.g., the `beforeunload` prompt of a form that is left open, both clients can try to close it. When a Playwright session has no `dialog` listener, Playwright closes the dialog itself and does not catch the error, so a worker that closed the dialog first made Chrome answer "No dialog is showing", and the Joshu server exited with an unhandled promise rejection. The stack restarted and the running workers stopped. `guardDialogs` in `src/chromiumSession.ts` now adds a `dialog` listener to the browser context, and the listener closes each dialog the way Playwright does, so it accepts `beforeunload` and dismisses each other dialog. It catches the error and logs it. The alternative was a process handler for `unhandledRejection`, which would also hide other bugs.

- **2026-09-25: a pending browser handoff holds the session only while the owner is active on the handoff page.** Before, a pending browser handoff held the session until the link expired, also after the owner closed the handoff page, so a session could run for up to 3 hours with nobody on it. Changed for unopened browser handoffs by the decision of 2026-10-16.
- **2026-10-16: an unopened browser handoff holds the session until the link expires.** Joshu counted the creation of a browser handoff as owner activity, so an owner who opened the link more than 10 minutes after the companion sent it found no staged page, and a staged flight checkout was lost this way. The alternatives were to hold the session for every pending browser handoff until expiry, which brings back the cost problem of 2026-09-25, and to save and restore the page state, which cannot restore a cart that a site keeps in its own server session. The hold costs at most 45 minutes of Browser Use time for a page that the owner asked for. After the owner opened the handoff page, the rule of 2026-09-25 stays.
- **2026-10-16: the companion learns about an idle stop.** After the idle stop above, the companion did not know that Joshu stopped the shared browser, and it told the owner that the website blocked it. Joshu now returns a one-time tool error `browser_restarted` and a plain `message` from `browser_handoff_status`. Joshu returns a tool error, instead of a note on the normal tool result, because each tool of `tools/browser_tool.py` builds its own result and the patch would need to change each return statement; one error is one branch in the ensure helper that each tool already calls. A note in the system prompt was rejected, because Kanban workers and chat turns build their prompts in different places. The restart notice stays in memory only, because a restart of the stack container ends the companion turns too.

- **2026-10-21: the SMS continuation gets the handoff brief and the request in a system message.** Before, the only description of the task was a user message with "Handoff instructions: <handoff brief>". For a passcode step of X, the model read the handoff brief as text that somebody else had sent the owner, and it told the owner that the browser handoff was a phishing attempt. The alternatives were to keep the user message and add a line that Joshu wrote it, which still gives the text the role of the owner, and to run the turn in the `sms:` session of the realtime goal, which can be a session that the owner no longer reads. A system message states who wrote the handoff brief and gives the request in each case.
- **2026-10-21: a skill rule stops requests for secrets.** A worker asked the owner to text the passcode of X, which would put the passcode in the SMS log, the Hermes session, and the traces. Skill `joshu-browser-handoff` now tells the companion to never ask for a password, passcode, PIN, recovery code, or one-time code by text, and to make a browser handoff at once. A check in the SMS send path was rejected, because a pattern on the words would also block ordinary text about a passcode screen, and the companion chooses the words.

## Limits and failure modes

- Local Chromium has no tab strip in the live view. A page that a site opens in a new tab, other than a sign-in popup, loads in the same tab because of the same-tab shim.
- The address bar of Browser Use bypasses `POST /api/camofox/navigate`, so `rememberBrowserTarget` does not see a URL that the owner types there. The companion reads the current page from the shared browser before it acts.
- When the owner closes the last tab in the tab strip, the next navigate of jWeb or of the companion opens a page again.
- The restart notice goes to the first `browser_*` call after the idle stop, from any Hermes process. When a worker that never used the old page gets the restart notice, the worker only retries the call, and the companion that staged the page learns about the stop from `browser_handoff_status` or from a page that is gone.
- A Hermes `tools/browser_tool.py` patched with an older ensure helper ignores field `restarted`, and the restart notice is lost. Restart the Hermes gateway after the patch.
- While the Joshu server has a Playwright connection to the shared browser, it closes each page dialog, as Playwright did before the dialog guard. A worker that wants to answer a dialog, e.g., type text into a `prompt`, can find the dialog already closed.
- The live view depends on behavior of Browser Use that its documentation does not describe (the active page and `ui`). If Browser Use changes it, the owner may see a page without the tab strip, or a stale page.

- The SMS continuation reads the Kanban task only on board `realtime-goals`. A browser handoff from a Kanban task on another board gets no Kanban task in the system message, and it gets no objective, because only a realtime goal has one.
- The rule against requests for secrets is skill text. A model that ignores the skill can still ask for a secret, and Joshu does not stop the SMS.

## Code map

| Part | Files |
|---|---|
| Live view URL and route | `cloudLiveFrameUrl` in `src/cloudBrowser.ts`, `GET /api/browser/live-frame` in `src/server.ts` |
| Active page | `src/cloudBrowserActivePage.ts` |
| Session lifetime and restart notice | `tick`, `stopCloudBrowser`, `takeCloudBrowserRestartNotice` in `src/cloudBrowser.ts`; `busy()`, `onStop`, and `POST /api/browser/ensure` in `src/server.ts` |
| Browser handoff hold and status message | `pendingHandoffBlocksCloudBrowser`, `markHandoffsBrowserStopped`, `handoffStatusMessage` in `src/browserHandoff/store.ts`; `GET /api/browser-handoff/status/:id` in `src/browserHandoff/routes.ts` |
| Hermes ensure helper (`browser_restarted`) | `scripts/patch-hermes-browser-cdp-guards.mjs` |
| Screencast (local Chromium) | `src/browserScreencast.ts`, `public/screencast-client.js` |
| Iframe client | `public/cloud-live-frame.js` |
| jWeb | `public/app.js`, `public/index.html`, `public/styles.css` |
| Handoff page | `public/handoff.js` |
| SMS continuation | `deliverSmsHandoffContinuation`, `loadHandoffTaskContext`, `buildSmsHandoffContinuationMessages` in `src/browserHandoff/smsContinue.ts`; Kanban task id in `.hermes/plugins/joshu-browser-handoff/tools.py` |
| Dialog guard | `guardDialogs` and `closeDialogQuietly` in `src/chromiumSession.ts` |
| Tests | `npm run test:cloud-browser-lifecycle`, `npm run test:cloud-browser-active-page`, `npm run test:browser-handoff`, `npm run test:hermes-tool-patches`, `npm run test:chromium-dialog-guard` |
