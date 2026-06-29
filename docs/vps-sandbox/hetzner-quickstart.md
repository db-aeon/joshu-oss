# Hetzner Ubuntu quickstart (self-host)

Step-by-step: create a Hetzner VPS, download Joshu from GitHub, set your hostname, run the installer, open the desktop. **API keys** (OpenRouter) are added in the **Welcome** app after first login — not on the command line.

No proprietary control plane — this is **standalone self-host** only. Control-plane managed boxes skip Welcome's Connect AI step (keys are provisioned automatically).

**You need before you start:**

- A [Hetzner Cloud](https://console.hetzner.cloud/) account
- A domain you control (for HTTPS), e.g. `mybox.example.com`

**Example values used below** (replace with yours):

| What | Example |
| --- | --- |
| VPS public IP | `203.0.113.50` |
| Hostname | `mybox.example.com` |
| Release image | `ghcr.io/db-aeon/joshu-oss:0.1.29` (see [`deploy/RELEASE.json`](../../deploy/RELEASE.json)) |

---

## Step 1 — Create the Hetzner server

1. Open [Hetzner Cloud Console](https://console.hetzner.cloud/) → your project → **Add server**.
2. **Image:** Ubuntu **24.04**
3. **Type:** **CPX31** (8 GB RAM) or larger
4. **Location:** pick a region close to you (`ash` US, `nbg1` / `fsn1` EU)
5. **SSH key:** add your public key (so you can `ssh root@…`)
6. **Firewall (recommended):** allow inbound **22**, **80**, **443**
7. Click **Create & buy now**
8. Copy the server **IPv4** address from the dashboard.

---

## Step 2 — Point DNS at the server

| Type | Name / host | Points to |
| --- | --- | --- |
| A | `mybox` | `203.0.113.50` |
| A | `hermes-admin.mybox` | `203.0.113.50` |

Wait until DNS resolves:

```bash
dig +short mybox.example.com A
```

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

JOSHU_RELEASE_VERSION=0.1.29
JOSHU_IMAGE_REF=ghcr.io/db-aeon/joshu-oss:0.1.29
```

Save: **Ctrl+O** Enter, **Ctrl+X**.

You do **not** need to set `OPENROUTER_API_KEY`, `HERMES_API_KEY`, or `API_SERVER_KEY` here — bootstrap generates gateway secrets; Welcome collects OpenRouter after login.

---

## Step 6 — Run bootstrap

```bash
cd /opt/joshu
ENV_FILE=/etc/joshu/instance.env bash deploy/scripts/bootstrap-vps.sh
```

Bootstrap will:

1. Install Docker
2. Generate `HERMES_API_KEY`, `API_SERVER_KEY`, and `JOSHU_HERMES_DASHBOARD_PASSWORD` if missing
3. Pull the Joshu image and start the stack

First run takes **10–20 minutes**.

Optional — view Hermes admin password (auto-generated):

```bash
grep JOSHU_HERMES_DASHBOARD_PASSWORD /etc/joshu/instance.env
```

---

## Step 7 — Open the desktop

In a browser: `https://mybox.example.com/`

Log in to ArozOS. **Welcome** opens automatically and asks for your **OpenRouter** API key (Connect AI step). Paste a key from [openrouter.ai/keys](https://openrouter.ai/keys) to enable jChat.

You can skip Connect AI and add the key later by reopening **Welcome** from the desktop.

Health check (laptop):

```bash
curl -fsS https://mybox.example.com/joshu/api/instance/health
```

---

## Optional — enable voice

After the box is healthy, edit `/etc/joshu/instance.env`:

```dotenv
JOSHU_VOICE_IMAGE_REF=ghcr.io/db-aeon/joshu-voice-realtime:0.1.29
JOSHU_VOICE_MODE=realtime_s2s
JOSHU_WEB_VOICE_ENABLED=true
OPENAI_API_KEY=sk-...
```

```bash
cd /opt/joshu/deploy
export COMPOSE_PROFILES=voice-rt
docker compose -f docker-compose.yml --env-file /etc/joshu/instance.env up -d --force-recreate
```

---

## Common problems

| Problem | What to check |
| --- | --- |
| Certificate error in browser | DNS not pointing at VPS yet |
| Health `curl` fails | Ports 80/443 open; wait a few minutes after bootstrap |
| Chat empty / 401 | Add OpenRouter in **Welcome → Connect AI**, or check gateway keys in `instance.env` |
| `git clone` fails | Outbound HTTPS from VPS |

---

## Next steps

- [welcome-onboarding.md](../welcome-onboarding.md) — Welcome wizard + Connect AI
- [connectors.md](../connectors.md) — mail and calendar
- [self-host.md](../self-host.md) · [deploy/README.md](../../deploy/README.md)

Managed hosting (control plane) — [control-plane.md](control-plane.md).
