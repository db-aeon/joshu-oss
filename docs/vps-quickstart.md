# VPS Ubuntu quickstart (self-host)

Step-by-step: create a VPS, download Joshu from GitHub, set your hostname, run the installer, open the desktop. **API keys** (OpenRouter + Gemini) are added in the **Welcome** app after first login — not on the command line.

This is **standalone self-host** only.

**You need before you start:**

- A cloud provider account (e.g. AWS, DigitalOcean, Hetzner, Linode)
- A domain you control (for HTTPS), e.g. `mybox.example.com`

**Example values used below** (replace with yours):

| What | Example |
| --- | --- |
| VPS public IP | `203.0.113.50` |
| Hostname | `mybox.example.com` |
| Release image | `ghcr.io/db-aeon/joshu-oss:0.1.31` (see [`deploy/RELEASE.json`](../deploy/RELEASE.json)) |

---

## Step 1 — Create the server

1. Open your cloud provider's console and **Add a new server/droplet/instance**.
2. **Image:** Ubuntu **24.04**
3. **Size:** **8 GB RAM** or larger — **2 GB plans OOM** under Postgres + Hermes + Camofox
4. **Location:** pick a region close to you
5. **SSH key:** add your public key (so you can `ssh root@…`)
6. **Firewall (recommended):** allow inbound **22**, **80**, **443**
7. Click **Create**
8. Copy the server **IPv4** address from the dashboard.

---

## Step 2 — Point DNS at the server

The desktop and Joshu API use your main hostname. **Hermes Admin** (cron, skills, Kanban) uses a separate subdomain on the same VPS IP.

| Type | Name / host | Points to | Serves |
| --- | --- | --- | --- |
| A | `mybox` | `203.0.113.50` | `https://mybox.example.com/` (ArozOS desktop) |
| A | `hermes-admin.mybox` | `203.0.113.50` | `https://hermes-admin.mybox.example.com/` (Hermes Admin) |

If `CUSTOMER_DOMAIN` is itself a subdomain (e.g. `community.project-aeon.com`), the Hermes record is **`hermes-admin.community`** → same IP (full name `hermes-admin.community.project-aeon.com`).

Wait until both resolve:

```bash
dig +short mybox.example.com A
dig +short hermes-admin.mybox.example.com A
```

Both should return your VPS IPv4 before bootstrap finishes TLS.

---

## Step 3 — Log in to the VPS

```bash
ssh root@203.0.113.50
```

All remaining steps run on the server as `root`.

---

## Step 4 — Install `git` and clone Joshu

```bash
apt-get update && apt-get install -y git

git clone --depth 1 --branch main \
  https://github.com/db-aeon/joshu-oss.git \
  /opt/joshu
```

---

## Step 5 — Set your hostname (minimal `instance.env`)

Bootstrap needs your public hostname and image pin. Internal secrets (Hermes gateway keys, admin password) are **generated automatically**.

```bash
mkdir -p /etc/joshu/secrets
chmod 700 /etc/joshu /etc/joshu/secrets
cp /opt/joshu/deploy/.env.vps.example /etc/joshu/instance.env
chmod 600 /etc/joshu/instance.env
nano /etc/joshu/instance.env
```

Set **only** these (search with **Ctrl+W** in `nano`):

```dotenv
CUSTOMER_DOMAIN=mybox.example.com
VPS_IPV4=203.0.113.50
ACME_EMAIL=you@example.com

JOSHU_RELEASE_VERSION=0.1.31
JOSHU_IMAGE_REF=ghcr.io/db-aeon/joshu-oss:0.1.31
JOSHU_VOICE_IMAGE_REF=ghcr.io/db-aeon/joshu-oss-voice-realtime:0.1.31
```

Save: **Ctrl+O** Enter, **Ctrl+X**.

You do **not** need to set `OPENROUTER_API_KEY`, `HERMES_API_KEY`, or `API_SERVER_KEY` here — bootstrap generates gateway secrets; Welcome collects OpenRouter after login.

Pin versions from [`deploy/RELEASE.json`](../deploy/RELEASE.json) when upgrading an existing box.

---

## Step 6 — Run bootstrap

```bash
cd /opt/joshu
ENV_FILE=/etc/joshu/instance.env bash deploy/scripts/bootstrap-vps.sh
```

Bootstrap will:

1. Install Docker (if missing)
2. Generate `HERMES_API_KEY`, `API_SERVER_KEY`, and `JOSHU_HERMES_DASHBOARD_PASSWORD` if missing
3. Pull `JOSHU_IMAGE_REF` and start the stack
4. Sync `dist/` from the image when the host clone has no local build

First run takes **10–20 minutes**.

Optional — view Hermes admin password (auto-generated):

```bash
grep JOSHU_HERMES_DASHBOARD_PASSWORD /etc/joshu/instance.env
```

---

## Step 7 — Open the desktop

In a browser: `https://mybox.example.com/`

**First boot:** if the box has no users yet, you land on **Create your account** (`/user.html`) — not the login page. Create the owner account, then sign in.

**Welcome** opens automatically and walks through **Connect AI**:

1. **[OpenRouter](https://openrouter.ai/keys) API key** — jChat + Hindsight LLM
2. **[Google Gemini](https://aistudio.google.com/apikey) API key** — file search (gbrain), Hindsight embeddings, and jChat microphone (Gemini Live)

Both are required for a fully healthy OSS box when voice is enabled (default with `JOSHU_VOICE_IMAGE_REF`). Keys are stored in `.joshu/box-secrets/local-env.json` on your box — not sent to Joshu.

You can **Finish later** on Welcome and return from the desktop **Welcome** shortcut; Connect AI stays until all required keys are saved.

Health check (laptop) — may return **503** for a few minutes while Hermes finishes booting (common on small VPS plans):

```bash
curl -fsS https://mybox.example.com/joshu/api/instance/health
# when healthy: "healthy":true and HTTP 200
```

**Branding checks (0.1.31+):** login / setup pages say **Joshu**, favicon is the hand icon, System Settings → ☰ → **About** shows **About** + **Joshu** tabs (no Vendor tab). Hard-refresh (`Cmd+Shift+R`) if the browser cached an old favicon.

```bash
curl -fsSI https://mybox.example.com/img/public/joshu-icon.svg   # expect 200
curl -fsSI https://mybox.example.com/login.html | grep -i joshu  # page title / wordmark
```

`aroz-vanilla-shell.css` is served behind ArozOS auth — unauthenticated `curl` gets **307** to `/login.html` (that still means the theme file is present).

---

## Hermes Admin (desktop shortcut)

On a VPS, Hermes Admin is **not** at `/joshu/hermes-admin/` (that path is for **local dev** only). Bootstrap enables **direct mode** by default: Caddy serves the dashboard on its own hostname at site root.

| | |
| --- | --- |
| **URL** | `https://hermes-admin.mybox.example.com/` |
| **Open from** | Desktop **Hermes Admin** shortcut (url shortcut → full HTTPS URL) |
| **Login** | User `admin` (or `JOSHU_HERMES_DASHBOARD_USER`) + password from `instance.env` |
| **Requires** | DNS **A** record from [Step 2](#step-2--point-dns-at-the-server) |

View the auto-generated dashboard password:

```bash
grep JOSHU_HERMES_DASHBOARD_PASSWORD /etc/joshu/instance.env
```

Confirm the stack sees the dashboard:

```bash
curl -fsS https://mybox.example.com/joshu/api/hermes-dashboard/status
# expect: "directExposure":true, "publicUrl":"https://hermes-admin.mybox.example.com"
```

**Wrong URL symptom:** `Cannot GET /joshu/hermes-admin/` — you opened the local-dev path on a VPS. Use the `hermes-admin.*` subdomain instead.

**Alternative (no extra DNS):** set `JOSHU_HERMES_DASHBOARD_DIRECT=false` in `/etc/joshu/instance.env`, re-render Caddy (`bash deploy/scripts/render-caddyfile.sh /etc/joshu/instance.env`), and restart the stack. Joshu then proxies `https://mybox.example.com/joshu/hermes-admin/`. Direct subdomain mode is recommended for production parity.

`JOSHU_HERMES_DASHBOARD_PASSWORD` is **not** your ArozOS desktop login — only Hermes Admin / gateway dashboard access.

---

## Optional — voice in jChat

Voice is **on by default** for OSS self-host when `JOSHU_VOICE_IMAGE_REF` is set in `deploy/.env.vps.example` (bootstrap enables `voice-rt` and sets `JOSHU_VOICE_PROVIDER=gemini_live`). Add your **Gemini API key** in **Welcome → Connect AI** (same key powers voice + file brain). No manual `instance.env` edits required.

After changing `JOSHU_VOICE_PROVIDER` in `instance.env`, recreate the voice sidecar (not just restart):

```bash
cd /opt/joshu/deploy
docker compose --env-file /etc/joshu/instance.env --profile voice-rt up -d --force-recreate voice-realtime
```

If you disabled voice or run an older box, see [`deploy/README.md`](../deploy/README.md) for compose profile `voice-rt` and [`voice-realtime.md`](voice-realtime.md) for configuration, WSS URLs, and instant think ack.

---

## Forgot ArozOS password (self-host)

Joshu does **not** send email reset links. The **Forgot password?** link on the login page (`/reset.html`) expects an **administrator** to generate a **temporary password** first (System Settings → Users → edit user → **Reset password**), then you complete the flow in the browser.

On a **solo** self-host box you are usually both admin and user. If you are locked out but still have **SSH as root**:

### Option A — SSH reset (recommended when locked out)

```bash
ssh root@203.0.113.50
cd /opt/joshu

# List ArozOS usernames (folder names under the data volume)
docker volume inspect deploy_joshu_arozos --format '{{ .Mountpoint }}'
ls "$(docker volume inspect deploy_joshu_arozos --format '{{ .Mountpoint }}')/files/users/"

# Set a new login password (stops joshu-stack briefly, updates system/ao.db)
bash scripts/arozos-reset-password.sh YOUR_USERNAME 'your-new-strong-password'
```

First run pulls a small `golang:1.23-alpine` image and compiles the helper (~1–2 minutes). Later runs are faster.

Log in at `https://mybox.example.com/` with the new password.

### Option B — Browser reset (when another admin exists)

1. Admin: **System Settings → Users →** edit user → **Reset password** (copies a temporary password).
2. User: open `/reset.html` or the link with `acc` and `rkey` query params, enter username + temporary password, choose a new password.

### Not the same as Hermes admin

`JOSHU_HERMES_DASHBOARD_PASSWORD` in `/etc/joshu/instance.env` is only for [Hermes Admin](#hermes-admin-desktop-shortcut) — not your ArozOS desktop login.

---

## Upgrade or reinstall (existing VPS)

To move to a newer image (e.g. `0.1.31`):

```bash
cd /opt/joshu && git pull origin main
nano /etc/joshu/instance.env   # bump JOSHU_RELEASE_VERSION + JOSHU_IMAGE_REF (+ voice ref)
bash scripts/sync-dist-from-image.sh
cd deploy
docker compose -f docker-compose.yml --env-file /etc/joshu/instance.env pull joshu-stack voice-rt 2>/dev/null || true
docker compose -f docker-compose.yml --env-file /etc/joshu/instance.env up -d --force-recreate
```

**Full wipe** (factory-fresh data — destroys desktop files, Postgres, Hermes state):

```bash
cd /opt/joshu/deploy
docker compose -f docker-compose.yml --env-file /etc/joshu/instance.env down -v
cd /   # leave /opt/joshu before deleting it (otherwise git clone fails)
rm -rf /opt/joshu
docker volume rm deploy_joshu_arozos 2>/dev/null || true   # if down -v left a stray volume
# keep /etc/joshu/instance.env — update image pins, then repeat Steps 4–6
```

---

## Common problems

| Problem | What to check |
| --- | --- |
| `docker pull` → `registry: denied` | Image tag not published yet, or GHCR package still private. Confirm tag in [`deploy/RELEASE.json`](../deploy/RELEASE.json). After a release build, `docker pull` should work without login. |
| Certificate error in browser | DNS not pointing at VPS yet |
| Health `curl` returns 503 | Hermes still starting — wait 2–5 min; check `components.hermes.ok` in JSON. On **2 GB** plans boot can take longer or OOM — use **8 GB RAM**. |
| Health `curl` fails (connection error) | Ports 80/443 open; wait a few minutes after bootstrap |
| Chat empty / 401 | Add OpenRouter in **Welcome → Connect AI** |
| Voice hint / mic disabled | Add Gemini in **Welcome → Connect AI**; recreate `voice-realtime` after provider env changes |
| `healthy: false` after Welcome | Restart stack once keys are saved so gbrain/Hindsight pick up embeddings |
| Desktop icons broken (placeholder images) | Image **&lt; 0.1.30** or theme not applied — `git pull` + restart stack. **0.1.31+** bakes icons + vanilla chrome at build and re-applies on boot. |
| Desktop has icons but no window chrome | Same — after login, DevTools → Network should load `aroz-vanilla-shell.css` (unauthenticated curl gets 307; see Step 7) |
| Site works then **502** / box “down” for minutes | `joshu-stack` crash loop — `docker compose logs joshu-stack`. Use **8 GB RAM** or larger; 2 GB hosts OOM. |
| Locked out of ArozOS login | No email reset — use SSH script or admin temporary password. See [Forgot ArozOS password](#forgot-arozos-password-self-host). |
| Hermes Admin **Cannot GET /joshu/hermes-admin/** | VPS uses **direct mode** — open `https://hermes-admin.mybox.example.com/` (not `/joshu/`). Add DNS **A** record ([Step 2](#step-2--point-dns-at-the-server)). |
| System Settings still shows imuslab / old About tab | Close Settings window entirely, hard-refresh desktop. On **0.1.31+** branding is in the image; host bind-mounts `web-overlays-vanilla/` for faster iteration without rebuild. |
| `git clone` fails | Outbound HTTPS from VPS |

### Stack crash loop (502 / intermittent outage)

VPS instances do **not** sleep like a laptop. Intermittent **502** from Caddy almost always means `joshu-stack` is restarting (`docker inspect deploy-joshu-stack-1 --format '{{.RestartCount}}'`).

```bash
docker compose -f /opt/joshu/deploy/docker-compose.yml --env-file /etc/joshu/instance.env logs joshu-stack --tail 80
curl -fsS http://127.0.0.1:8788/joshu/api/instance/health | head -c 200
```

Use a server with **8 GB RAM** or larger — 2 GB hosts OOM under Postgres + Hermes + Camofox.

### Desktop icons or missing chrome (older images only)

On **0.1.31+** this should not be needed after a fresh bootstrap. For older boxes after `git pull`:

```bash
cd /opt/joshu/deploy
docker compose -f docker-compose.yml --env-file /etc/joshu/instance.env exec joshu-stack \
  python3 /opt/joshu/scripts/apply_arozos_joshu_theme.py /var/lib/arozos/web/
docker compose -f docker-compose.yml --env-file /etc/joshu/instance.env restart joshu-stack
```

Hard-refresh the browser (Cmd+Shift+R).

---

## Next steps

- [welcome-onboarding.md](welcome-onboarding.md) — Welcome wizard + Connect AI
- [connectors.md](connectors.md) — mail and calendar
- [self-host.md](self-host.md) · [deploy/README.md](../deploy/README.md)
