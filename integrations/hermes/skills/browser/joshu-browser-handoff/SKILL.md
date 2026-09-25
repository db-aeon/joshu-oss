---
name: joshu-browser-handoff
description: Live browser HITL — hand the shared browser tab to the owner on mobile for login, payment, 2FA, or owner-only steps.
metadata:
  hermes:
    category: browser
    version: "1.8.0"
---

# Joshu browser handoff (live HITL)

Use when the **owner must take over the shared browser tab** on their phone — payment, login, 2FA, irreversible confirms, or any step that is **sensitive, policy-bound, or explicitly owner-only**.

This is **sustained live HITL**: the owner gets a signed link, the live tab (Browser Use Cloud iframe on fleet boxes, CDP screencast or noVNC on local Chromium), your brief, the form overlay, and time to finish. It is **not** a single-click SMS approval (see action guard below).

**Handoff tools:** `browser_handoff_request`, `browser_handoff_status`, `browser_handoff_complete` (plugin `joshu-browser-handoff`).

**Owner SMS:** any inbound owner text auto-completes a pending handoff for that SMS session before your turn (browser already unlocked). **jChat/voice:** call **`browser_handoff_complete`** when the owner says they are finished — no need to tap **I'm done** on the link.

---

## Browser backend (read this first)

Joshu boxes use **one** shared browser session. The backend is chosen at stack start (Safety Settings or `JOSHU_CLOUD_BROWSER` in `instance.env`). **Never mix backends in one task.**

| Backend | How you drive the page | Live view on handoff link | Do **not** |
|---------|------------------------|---------------------------|------------|
| **Browser Use Cloud** (fleet default) | Hermes **`browser_navigate`**, `browser_snapshot`, `browser_click`, `browser_type`, … | Browser Use iframe (`/api/browser/live-frame`) | Call **`browser_task`**, curl **Camofox :9377**, or open a second browser |
| **Local Chromium** (OSS default) | **`browser_task`** (plugin `joshu-browser-agent`) on the shared CDP tab | CDP screencast or noVNC | Assume Camofox Firefox APIs — current local path is Chromium on `:9222` |

**Cloud fleet rule:** stage pages with **`browser_navigate`** only, then **`browser_handoff_request`**. Handoff reads the **same** cloud CDP session Hermes used. If you get `no_active_browser_tab`, **`browser_navigate`** again to the handoff URL on the **same** Hermes browser tools — do **not** fall back to localhost Camofox, `browser_task`, or `:9377` REST.

**Local rule:** call **`browser_task`** for autonomous browsing. Stop before payment, CAPTCHA, or secrets, then **`browser_handoff_request`**. While handoff is `pending`, `browser_task` is refused.

**Browser down = system problem.** Joshu wakes the shared browser automatically on every `browser_*` call. If a browser tool still fails with **`browser_unavailable`** or a CDP / WebSocket error (e.g. `502 Bad Gateway`): retry that tool **once**, then **`kanban_block("system: browser unavailable")`** and stop. **Never** investigate the box — no `ps` / `ss` / port scans, no reading `/opt/joshu/dist` or Hermes source, no changing Hermes config (`hermes config`, `config.yaml`), no curling local Joshu or Camofox APIs to drive the page. Joshu owns that recovery.

---

## When to use

| Use handoff | Do not use handoff |
|-------------|-------------------|
| Payment, card entry, 3DS, bank auth | Still browsing, comparing, or gathering options |
| Site login, SSO, CAPTCHA, OTP the agent cannot complete | Owner is already at desktop jWeb and asked you to wait |
| Irreversible confirm (book, buy, submit application, cancel subscription) | Informational read-only pages |
| Sensitive form (legal attest, medical, government ID upload) | One trivial click — use action guard if enabled |
| Owner said "I'll finish this" / "send me the link" | You can safely continue autonomously |
| Task policy says **ask before paying** or **owner must approve in browser** | Desktop-only flow with no need to preserve this tab session |

**Rule of thumb:** if the **next meaningful browser actions belong to the owner** (credentials, money, or binding consent), stage the page and hand off.

### Account-specific web data (Amazon orders, bank, portals, RapidAPI)

**Use the browser + handoff** — not Composio/Gmail search alone — when the answer lives behind the owner's login:

| Ask | Wrong first move | Right move |
|-----|------------------|------------|
| "My most recent Amazon order" | Gmail order-confirmation search only | `browser_navigate` → Amazon sign-in/orders → `browser_handoff_request` → send link |
| "My paid RapidAPI subscriptions" | Guess or public docs | `browser_navigate` → RapidAPI login/billing → `browser_handoff_request` |
| "What's in my cart?" | Guess or stale snapshot | Hand off on cart or login page |
| "Did my refund post?" | Mail thread only | Browser account order history after owner login |

Gmail may help **after** the fact (confirmation emails), but it is not a substitute for an authenticated session.

### SMS / owner texted you

When the channel is **SMS**, still **`browser_handoff_request`** and **include the full handoff URL** in your reply. Joshu splits long texts across multiple SMS — do not omit the link to stay under 500 characters.

**After handoff on SMS:** `browser_snapshot`, then put the answer in your **assistant reply text** (order details, confirmation, etc.). Joshu sends that as SMS automatically.

**Never** call `nylas_send_message` or email the owner to deliver SMS-originated handoff results — that triggers action-guard approval and skips the SMS reply path.

---

## Workflow

1. **Do prep work autonomously** — search, compare, fill non-sensitive fields, verify constraints in **`browser_snapshot`** (dates, price, terms, correct account, etc.).
2. **`browser_navigate`** (cloud) or **`browser_task`** then navigate (local) to the page where the owner should start.
3. **`browser_snapshot`** — confirm the staged state matches what you will describe in the brief.
4. **`browser_handoff_request(instructions=…)`** — short owner brief: what site, what to check, what to do, any caps or policies.
5. Include the returned **`url`** in your outbound message (email, jChat, or SMS). On SMS, always send the link — splitting is automatic.
6. **`kanban_block("awaiting owner browser handoff")`** (or equivalent wait state).
7. Poll **`browser_handoff_status(handoff_id=…)`** until `status` is `completed`, or call **`browser_handoff_complete`** as soon as the owner says they are done (SMS/jChat/voice).
8. **`browser_snapshot`** — verify the outcome (confirmation page, logged-in state, success message).
9. **Deliver results on the same channel** — SMS → assistant reply text only; email/jChat → normal outbound for that channel.
10. **`kanban_complete`** or continue the task.

During **pending handoff**, do **not** navigate away — the server pins `pageUrl` and blocks agent writes.

---

## Handoff vs action guard

| | **Browser handoff** | **Action guard (SMS Y/N)** |
|--|---------------------|----------------------------|
| **Best for** | Owner drives the browser for a while | Agent proposes one write; owner approves/denies |
| **Owner UI** | Mobile link + live browser + instructions | SMS reply Y/N |
| **Agent during wait** | Locked out of navigate/click/type | Can still navigate; only gated writes blocked |
| **Session** | Pins current tab URL until done | No session pin |

---

## Cold browser (local Chromium only)

On **local Chromium** boxes, the browser may idle-shutdown. Before the first heavy `browser_navigate` or `browser_task`:

```bash
curl -fsS -X POST http://127.0.0.1:8788/joshu/api/camofox/warm
```

Cloud fleet boxes skip this — the first `browser_*` call wakes (or recreates) the Browser Use session itself. Logins saved to the browser profile usually survive a recreate; open tabs, carts, and half-filled forms do not — re-navigate.

---

## Owner experience

Owner opens the handoff link on their phone → **signs in with the box username and password** (a desktop session is not enough) → compact Joshu header + embedded live browser → types in native fields (**Fill** enables after an edit) or **More Options** for scan/paste → **I'm done** (bottom right).

If desktop jWeb is also connected on a **local** box, only one viewer may hold the VNC session — ask the owner to close desktop jWeb if the phone viewer disconnects. Cloud handoff uses iframe streaming and does not share this limitation.

---

## Errors

| Signal | Action |
|--------|--------|
| `browser_handoff_already_pending` | Poll existing handoff or `browser_handoff_status`; do not create a second request |
| `browser_handoff_locked` on navigate/click | Wait for owner completion |
| `expired` | Re-stage the page and mint a new link, or ask the owner to retry |
| `no_active_browser_tab` | **`browser_navigate`** to the handoff page on Hermes browser tools (cloud), then request handoff. **Never** curl Camofox `:9377` or spawn `browser_task` on cloud boxes |
| `browser_unavailable`, CDP `502` / WebSocket connect failed | Retry the tool once. Still failing → **`kanban_block("system: browser unavailable")`**. Do not debug the box or edit config — see *Browser down = system problem* above |

**Never patch this skill** with Camofox REST workarounds after a handoff failure — that indicates an infrastructure mismatch, not missing procedure.

---

## Related

- Browser backends: [`docs/hitl-camofox-notes.md`](../../../../docs/hitl-camofox-notes.md#browser-backend-local-chromium-vs-browser-use-cloud)
- Action guard (single-click HITL): [`docs/agent-safety.md`](../../../../docs/agent-safety.md)
- Travel checkout after owner picks: [`realtime-goal`](../realtime/realtime-goal/SKILL.md) booking phase
