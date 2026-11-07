# Box API edge security (Caddy + localhost)

Joshu listens on `127.0.0.1:8788`. Caddy reverse-proxies `/joshu/*` from the public hostname, so **`req.ip === 127.0.0.1` is not a security boundary** — every public request looks local.

## Helpers (`src/httpLocalhost.ts`)

| Helper | Use for |
|--------|---------|
| `isDirectLocalhostRequest` | Cron, instance-agent, Hermes plugins, box mutate, proactive, desktop-actions, app-gui-actions |
| `isDesktopBrowserOrLocalRequest` | Browser apps via same-origin Caddy: files, CWM, AG-UI (requires `Sec-Fetch-Site: same-origin\|same-site` + Cookie + `Host === CUSTOMER_DOMAIN`) |
| `verifyArozosDesktopSession` | Browser apps that change settings or approve work: the session cookie is checked with ArozOS (`/system/auth/checkLogin` on loopback). Direct localhost also passes |

## Status

| Surface | Gate |
|---------|------|
| `/api/proactive/*` | Direct localhost |
| `/api/box/snap\|restore\|…` + status/snapshots | Direct localhost |
| `/api/instance/send-owner-email`, `sync-companion-identity` | Direct localhost |
| `/api/desktop-login/code`, `/api/desktop-login/redeem` (admin desktop login) | Direct localhost. `code` is for the instance agent (command `desktop_login`); `redeem` is for the ArozOS page below. A code is random 32 bytes, works one time, expires after 2 minutes, and signs in only as `JOSHU_AROZ_USER`; the Joshu API keeps only its sha256 hash, in memory |
| `GET /system/auth/joshu-login?code=` (ArozOS, admin desktop login) | Public. ArozOS redeems the code on loopback and then signs the browser in as the owner for one hour (no remember-me). Any other code gets `401`. The owner password and the owner sessions do not change |
| `/api/desktop-actions/*`, `/api/app-gui-actions/*` | Direct localhost |
| `/api/browser-handoff/request`, `/status/*`, `/lock`, `/:id/cancel` | Direct localhost (Hermes plugin + Hermes CDP browser guards patch) |
| `/api/browser-handoff/:id/login` | Signed handoff token; verifies box username/password against ArozOS; sets `joshu_handoff_auth` |
| `/api/browser-handoff/:id/heartbeat`, `/:id/complete`, `/:id/form-fields`, `/:id/page-key`, `/:id/fill-form` | Signed handoff token **and** `joshu_handoff_auth` cookie (fresh password for this handoff) |
| `GET /handoff/:id` (mobile shell + live view) | Signed token; missing auth cookie serves the Joshu sign-in gate (does **not** skip if already logged into the desktop) |
| `/api/files/*`, `/api/excalidraw/cwm/*`, `/api/ag-ui/run` | Desktop browser or local |
| `/api/teams/preview`, `/api/teams/join` (Multiplayer, called by other boxes) | Public. Needs a valid invite code: random 18 bytes, single-use, expires after 7 days; the team boss stores only its sha256 hash |
| `/api/teams/:slug/room`, `/charter`, `/messages`, `/cards`, `/leave` (Multiplayer, called by other boxes) | Public. Needs `Authorization: Bearer <member token>` (random 32 bytes; the team boss stores only its sha256 hash). Every failed check (no token, unknown token, removed or left member, team not hosted) gets the same 404 `not found` |
| `GET /teams/join/:code` (Multiplayer invite link opened in a browser) | Public static page with no team data |
| `/api/team-local/*` (Multiplayer, companion of this box) | Direct localhost |
| `/api/safety-settings` and every route under it (Safety app, Slack connect status/start/cancel, pairing code approval) | `verifyArozosDesktopSession`, as one middleware for the whole path. Other requests get `401` |
| `GET /api/telephone`, `PUT /api/telephone`, `POST /api/telephone/passphrase` (Telephone app) | `verifyArozosDesktopSession`. Other requests get `401 desktop_session_required`. `GET` and `PUT` never return the passphrase; only `POST /api/telephone/passphrase` does, for button Show. See [Telephone settings](#telephone-settings) |
| `POST /api/telephone/owner-mobile/from-call` (voice service) | Direct localhost and `Authorization: Bearer $HERMES_API_KEY` (`voiceLocalServiceAuthorized`). A desktop session is not enough |
| `GET /api/slack/oauth/callback` (Slack connect OAuth redirect) | Public, because the shared browser follows the Slack redirect without a desktop session. Needs the single-use `state` of the current Slack connect run (32 random bytes); any other `state` gets `400` and no Slack call |
| `GET /api/connectors/mail/gmail/live-search` (live Gmail search: connectors MCP tool `gmail_search_live`) | `verifyArozosDesktopSession` (the ArozOS session of the owner, or direct localhost). Other requests get `403` and no Gmail call |
| `POST /api/research/reports`, `GET /api/research/reports?q=` (Research reports: the Hermes plugin `joshu-research` and the Research app) | `verifyArozosDesktopSession` (the ArozOS session of the owner, or direct localhost). Other requests get `403` |
| `GET`, `POST /api/research/recurring`, `PATCH`, `DELETE /api/research/recurring/:id`, `POST /api/research/recurring/:id/pause` and `/resume`, `GET /api/research/recurring/:id/updates` and `/stories`, `GET /api/research/channels` (recurring reports: the plugin tools and the Research app) | `verifyArozosDesktopSession`. Other requests get `403` |
| `POST /api/research/recurring/:id/run` (the script of the Hermes cron job of a recurring report), `POST /api/research/reports/:id/updates`, `POST /api/research/updates/pdf` (plugin tools `research_update_make` and `research_update_pdf`) | Direct localhost. Any request through Caddy gets `403` |
| `GET /api/research/u/<update identifier>/<signature>/update.pdf` (report link of the PDF of a report update) | Public, like the report link of a Research report: the signature of the update identifier with the same per-box secret. The identifier must match one of the two folder shapes of a report update (`<report>/updates/<run>` or `Recurring/<slug>/updates/<run>`), and the resolved path must stay in `<files>/Research/`; anything else gets `404` |
| `GET /api/research/r/:id/:sig/report.pdf` (report link of a Research report) | Public. Needs the signature of the report identifier: HMAC-SHA256 with the per-box secret `.joshu/research/link-secret`, cut to 128 bits. Serves only `report.pdf` of that one report, inline, with `X-Robots-Tag: noindex`. A wrong signature, an identifier outside `<files>/Research/`, or a deleted report gets `404`. No expiry, so a forwarded link keeps working |
| Each route under `/api/connectors`, `/api/nylas`, and `/api/onboarding` (mail mirror search, live mail reads, calendar, connector status and settings, Composio connect and disconnect, metered providers, owner channel, the companion mailbox, the Welcome draft and Finish setup) | `verifyArozosDesktopSession`, as one middleware for the three path prefixes (`src/connectors/apiAccess.ts`). Other requests get `401` `desktop_session_required` and run no route. See [Connectors, Nylas, and onboarding routes](#connectors-nylas-and-onboarding-routes) |
| `POST /api/nylas/agent/import` (the control plane pushes the companion grant) | Public, because the control plane pushes over HTTPS. Saves a grant only when the box has none or the pushed grant is the same; another grant gets `409` `grant_already_set` |
| `/api/teams/app`, `/api/teams/:slug/view`, `POST /api/teams/:slug/drafts/:taskId/approve` (Multiplayer app) | `verifyArozosDesktopSession`: the session cookie is checked with ArozOS. The approve route accepts only a `needs_input` task of board `team-<slug>` |

## Admin desktop login

A Joshu admin can open the desktop of the box owner for setup work, without the password of the owner. The admin clicks **Open desktop** in the control plane. The control plane sends the signed instance agent command `desktop_login` ([instance-agent-protocol.md](instance-agent-protocol.md)), and the agent asks `POST /api/desktop-login/code` for a one-time link. The ArozOS page `/system/auth/joshu-login` (Joshu patch of ArozOS, `src/auth_joshu.go`) sends the code to `POST /api/desktop-login/redeem` on loopback and signs the browser in as the owner for one hour.

- ArozOS makes the session cookie with its own login code (`LoginUserByRequest`, no remember-me). Joshu does not read `ao.db` or copy the cookie format. Rejected: a cookie made by the Joshu API with the session key (ArozOS holds the database open), the ArozOS autologin tokens (they never expire and only an ArozOS admin can make one), and a temporary password (`set_aroz_password` signs the owner out everywhere).
- A code works one time, within 2 minutes, and only for `JOSHU_AROZ_USER`. Both Joshu routes take only direct localhost requests, so only the agent and ArozOS on the box can call them, and only a signed command of the control plane can start a login.
- The owner gets no notice. The audit log of the control plane and the stack log of the box (`[desktop-login]` lines, without the code) record each login.

## Telephone settings

The Telephone settings hold the passphrase of the call gate, the owner mobile, the keypad PIN, and the switch that lets a verified call from the owner mobile skip the passphrase. A stranger who can change the owner mobile and turn on that switch can call the box as the owner, so only the owner may read or change the Telephone settings. Before the routes had a gate, anyone who knew the host name of a box could read the passphrase with `GET /api/telephone`.

- The routes use `verifyArozosDesktopSession`, the same gate as the Safety app. `isDesktopBrowserOrLocalRequest` was rejected, because it checks only that a cookie is present. A check that needs a valid ArozOS session also on localhost was rejected too. The companion runs in the same container and can read the Telephone settings file there, so the stricter check would not keep the companion out, and it would break local development, where the Vite server sends requests on loopback.
- The status that `GET` and `PUT` return has `thinkPasswordConfigured` and no passphrase, so the Welcome app and any log or cache of the status never hold the passphrase. Button Show calls a separate `POST /api/telephone/passphrase`. The route uses POST so that no prefetch and no browser cache keeps the passphrase. Dropping button Show was rejected, because on many boxes the passphrase comes from provisioning and the Telephone app is the only place where the owner can read it.
- The voice service does not call these routes. It reads the Telephone settings file and the environment, and it calls only `POST /api/telephone/owner-mobile/from-call`, with its own service key.

## Connectors, Nylas, and onboarding routes

Until 2026-11, the routes under `/api/connectors`, `/api/nylas`, and `/api/onboarding` had no gate (except `GET /api/onboarding/setup-status`), so anyone who knew the host name of a box could search the mail mirror of the owner, read the connector status with the emails of the owner accounts, read or change the Welcome draft, run Finish setup, disconnect a connection, or replace the companion grant. Now one middleware, mounted in `src/server.ts` before the first of these routes, calls `verifyArozosDesktopSession` for the three path prefixes.

- One middleware for both prefixes, not a check in each handler. The routes are spread over six files (`src/connectors/routes.ts`, `composioRoutes.ts`, `meteredProviderRoutes.ts`, `src/ownerChannel/routes.ts`, `src/nylas/routes.ts`, `src/onboardingApi.ts`), and a check in each handler is easy to forget in the next route.
- The desktop session or a direct localhost request, and no token. Every caller on the box calls over localhost: the connectors MCP, the Composio MCP guard, the app invoke API, scripts, and the `curl` lines of the skills. Every browser caller (jMail, the Connectors app, the Welcome app, and the ArozOS overlay `aroz-onboarding-launch.js`, which opens Welcome after login) sends the desktop session. The instance agent diagnostics call on localhost. A bearer token such as `JOSHU_READ_API_KEY` was rejected, because the browser apps don't have it and the control plane does not keep it.
- `POST /api/nylas/agent/import` stays public, because the control plane pushes the companion grant over HTTPS on each healthy heartbeat, and the control plane keeps only a hash of the instance agent token, so it can't prove itself to the box. The route saves a pushed grant only when the box has no companion grant or the pushed grant id and email are the same as the saved ones, so the repeated push keeps working, and nobody can point the box at another mailbox. A new box has no companion grant until the first push, so for that short time any caller can set one. The box logs each accepted import (`[nylas] companion grant imported grant=…`) and each refused push (`[nylas] companion grant push refused grant=…`). To remove that window, the push can move to a signed instance agent command and the route can need localhost.
- The 401 answer has no box data, and refused requests are not logged, so a scan can't fill the log.
- Scripts that call these routes over the public URL get 401, for example the control plane scripts that read `connectors/status`, `nylas/status`, or `onboarding/status`. They must call the box through the instance agent or SSH, like `scripts/repair-fleet-ea-cron-timezone.sh`.

## Remaining risk

Each gate that accepts a direct localhost request also accepts the companion, because the companion runs in the stack container. For example, the companion can call the Telephone routes and the Safety routes on loopback. A fix needs a box-wide change, for example a separate user for the companion.

`isDesktopBrowserOrLocalRequest` blocks **anonymous** probes (no Cookie / no Sec-Fetch-Site). It does **not** cryptographically verify an ArozOS session — a client that forges those headers still passes. Follow-up: validate ArozOS session server-side (or Bearer tied to owner login).

## Hermes Admin (separate hostname)

`hermes-admin.<slug>.<suffix>` is **not** gated by Joshu’s localhost helpers — it is a **separate Caddy vhost** to Hermes on `127.0.0.1:9119` with Caddy basic auth. Without `JOSHU_HERMES_DASHBOARD_PASSWORD`, the vhost must not be published (2026-09 fleet incident). **A password in `instance.env` is not the lock** — unauth GET must return **401**, and Caddy must run `caddy-entrypoint.sh` (Clara 2026-09-16: password set, static Aug 14 Caddyfile, unauth 200). Caddy sets `header_up Host 127.0.0.1:9119`, which bypasses Hermes’ DNS-rebinding Host check — so **live basic auth + MCP allowlist** are the production controls, not Hermes’ Host validation alone. See [agent-safety.md](../agent-safety.md#hermes-admin-incident-2026-09).
