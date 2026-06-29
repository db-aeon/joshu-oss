# Hetzner Ubuntu quickstart (self-host)

Step-by-step: create a Hetzner VPS, download Joshu from GitHub, configure secrets, run the installer, open the desktop.

No proprietary control plane — this is **standalone self-host** only.

**You need before you start:**

- A [Hetzner Cloud](https://console.hetzner.cloud/) account
- A domain you control (for HTTPS), e.g. `mybox.example.com`
- An [OpenRouter](https://openrouter.ai/) API key (for Hermes chat)

**Example values used below** (replace with yours):

| What | Example |
| --- | --- |
| VPS public IP | `203.0.113.50` |
| Hostname | `mybox.example.com` |
| Release image | `ghcr.io/db-aeon/joshu-oss:0.1.29` (see [`deploy/RELEASE.json`](../../deploy/RELEASE.json)) |

Voice (browser/phone) is **off** for first boot. Enable later — see [Optional: enable voice](#optional--enable-voice) below.

---

## Step 1 — Create the Hetzner server

1. Open [Hetzner Cloud Console](https://console.hetzner.cloud/) → your project → **Add server**.
2. **Image:** Ubuntu **24.04**
3. **Type:** **CPX31** (8 GB RAM) or larger
4. **Location:** pick a region close to you (`ash` US, `nbg1` / `fsn1` EU)
5. **SSH key:** add your public key (so you can `ssh root@…`)
6. **Firewall (recommended):** allow inbound **22**, **80**, **443**
7. Click **Create & buy now**
8. Copy the server **IPv4** address from the dashboard — you will use it in DNS and SSH.

---

## Step 2 — Point DNS at the server

In your DNS provider (Cloudflare, Route53, etc.), create **A records** pointing at the VPS IPv4:

| Type | Name / host | Points to |
| --- | --- | --- |
| A | `mybox` | `203.0.113.50` |
| A | `hermes-admin.mybox` | `203.0.113.50` |

That gives you:

- `https://mybox.example.com` — main desktop
- `https://hermes-admin.mybox.example.com` — Hermes admin (optional)

Wait until DNS resolves (can take a few minutes):

```bash
# Run on your laptop
dig +short mybox.example.com A
```

You should see `203.0.113.50` (your real IP).

---

## Step 3 — Log in to the VPS

From your **laptop** (not the server yet):

```bash
ssh root@203.0.113.50
```

You are now on the server. **All remaining steps run here** as `root` unless noted.

---

## Step 4 — Install `git`

The server needs `git` to download Joshu from GitHub.

```bash
apt-get update
apt-get install -y git
```

Check it worked:

```bash
git --version
```

---

## Step 5 — Download Joshu from GitHub

Clone the public OSS repository into `/opt/joshu`:

```bash
git clone --depth 1 --branch main \
  https://github.com/db-aeon/joshu-oss.git \
  /opt/joshu
```

Check the files are there:

```bash
ls /opt/joshu/deploy/docker-compose.yml
ls /opt/joshu/deploy/scripts/bootstrap-vps.sh
```

Both paths should exist.

---

## Step 6 — Create the config directory

Joshu reads secrets from `/etc/joshu/` (outside the git clone).

```bash
mkdir -p /etc/joshu/secrets
chmod 700 /etc/joshu /etc/joshu/secrets
```

---

## Step 7 — Copy the env template

```bash
cp /opt/joshu/deploy/.env.vps.example /etc/joshu/instance.env
chmod 600 /etc/joshu/instance.env
```

---

## Step 8 — Collect secrets

You need four values before editing `instance.env`. Generate two on the VPS; copy one from OpenRouter.

**A. On the VPS** — run and **copy each output**:

```bash
# Shared Hermes gateway secret (you will paste this twice in step 9)
echo "HERMES_GATEWAY_SECRET=$(openssl rand -hex 32)"

# Hermes admin UI password
echo "HERMES_ADMIN_PASSWORD=$(openssl rand -base64 24)"
```

**B. On your laptop** — open [openrouter.ai/keys](https://openrouter.ai/keys), create or copy an API key. It looks like `sk-or-v1-…`.

**Where each value goes in `instance.env` (step 9):**

| You have | Paste into this line in `/etc/joshu/instance.env` |
| --- | --- |
| `HERMES_GATEWAY_SECRET` (from command above) | `HERMES_API_KEY=` **and** `API_SERVER_KEY=` (same value in both) |
| `HERMES_ADMIN_PASSWORD` (from command above) | `JOSHU_HERMES_DASHBOARD_PASSWORD=` |
| OpenRouter key (`sk-or-v1-…`) | `OPENROUTER_API_KEY=` (powers Hermes chat) |
| Same OpenRouter key again | `HINDSIGHT_API_LLM_API_KEY=` (powers memory / Hindsight — can be the same key) |

You can use one OpenRouter key for both `OPENROUTER_API_KEY` and `HINDSIGHT_API_LLM_API_KEY`.

---

## Step 9 — Edit `instance.env`

Open the file:

```bash
nano /etc/joshu/instance.env
```

Find and set **at least** these lines. The template already has most names — search in `nano` with **Ctrl+W** (e.g. type `OPENROUTER`):

```dotenv
JOSHU_STANDALONE=1

CUSTOMER_DOMAIN=mybox.example.com
VPS_IPV4=203.0.113.50
ACME_EMAIL=you@example.com

JOSHU_RELEASE_VERSION=0.1.29
JOSHU_IMAGE_REF=ghcr.io/db-aeon/joshu-oss:0.1.29

HERMES_API_KEY=paste-HERMES_GATEWAY_SECRET-here
API_SERVER_KEY=paste-the-same-HERMES_GATEWAY_SECRET-here

OPENROUTER_API_KEY=sk-or-v1-paste-your-openrouter-key-here

JOSHU_HERMES_DASHBOARD_PASSWORD=paste-HERMES_ADMIN_PASSWORD-here

HINDSIGHT_API_LLM_API_KEY=sk-or-v1-paste-your-openrouter-key-here
```

**Critical:** `HERMES_API_KEY` and `API_SERVER_KEY` must be **exactly the same string** (the gateway secret from step 8 — not your OpenRouter key).

Leave voice disabled for first boot (`JOSHU_VOICE_MODE=legacy`, `JOSHU_WEB_VOICE_ENABLED=false` — already the default in the template).

In `nano`: edit, then **Ctrl+O** Enter to save, **Ctrl+X** to exit.

Image tags must match [`deploy/RELEASE.json`](../../deploy/RELEASE.json). CI publishes `ghcr.io/db-aeon/joshu-oss:<version>` and `ghcr.io/db-aeon/joshu-voice-realtime:<version>` on each `v*-oss` git tag.

---

## Optional — enable voice

After the box is healthy, you can turn on browser/phone voice. OSS publishes a separate sidecar image (same version tag as the main stack).

1. In `/etc/joshu/instance.env`, set:

```dotenv
JOSHU_VOICE_IMAGE_REF=ghcr.io/db-aeon/joshu-voice-realtime:0.1.29
JOSHU_VOICE_MODE=realtime_s2s
JOSHU_WEB_VOICE_ENABLED=true
OPENAI_API_KEY=sk-...
```

2. Recreate the stack with the voice profile:

```bash
cd /opt/joshu/deploy
export COMPOSE_PROFILES=voice-rt
docker compose -f docker-compose.yml --env-file /etc/joshu/instance.env up -d --force-recreate
```

`JOSHU_VOICE_IMAGE_REF` must match `JOSHU_IMAGE_REF` version (both from `deploy/RELEASE.json`).

---

## Step 10 — Run the bootstrap installer

This script (already in your clone) will:

1. Install Docker
2. Pull the Joshu Docker image from GitHub Container Registry
3. Sync compiled `dist/` files from that image
4. Configure Caddy (HTTPS)
5. Start the stack

```bash
cd /opt/joshu
ENV_FILE=/etc/joshu/instance.env bash deploy/scripts/bootstrap-vps.sh
```

First run takes **10–20 minutes** (Docker install, image download, database init).

---

## Step 11 — Watch startup (optional)

If you want to see progress:

```bash
docker logs -f deploy-joshu-stack-1
```

Press **Ctrl+C** to stop following logs (the box keeps running).

Check containers are up:

```bash
docker compose -f /opt/joshu/deploy/docker-compose.yml \
  --env-file /etc/joshu/instance.env ps
```

You should see `caddy` and `joshu-stack` running.

---

## Step 12 — Verify it works

**On your laptop** (after DNS has propagated):

```bash
curl -fsS https://mybox.example.com/joshu/api/instance/health
```

You want JSON with `"healthy": true`.

**In a browser:** open `https://mybox.example.com/` — you should see the ArozOS login / desktop.

**Hermes chat smoke test** (laptop):

```bash
curl -N -H 'Content-Type: application/json' \
  -d '{"sessionId":"smoke","messages":[{"role":"user","content":"Say: hello from VPS"}]}' \
  https://mybox.example.com/joshu/api/hermes-chat/stream
```

You should see streaming JSON with text in `delta` events.

---

## Done — what you have

| URL | What |
| --- | --- |
| `https://mybox.example.com/` | ArozOS desktop |
| `https://mybox.example.com/joshu/api/instance/health` | Health check |
| `https://hermes-admin.mybox.example.com/` | Hermes admin (user `admin`, password from step 8) |

Code on disk: `/opt/joshu` (from GitHub).  
Config: `/etc/joshu/instance.env`.

---

## Common problems

| Problem | What to check |
| --- | --- |
| Browser shows certificate error | DNS A record not pointing at VPS yet; wait and retry |
| `curl` health fails | Firewall must allow 80 and 443; bootstrap still starting — wait 5 min |
| Chat returns `401 Invalid API key` | `HERMES_API_KEY` and `API_SERVER_KEY` must match in `instance.env`, then restart: `cd /opt/joshu/deploy && docker compose -f docker-compose.yml --env-file /etc/joshu/instance.env up -d --force-recreate joshu-stack` |
| `git clone` fails | Server needs outbound HTTPS; run `apt-get update` again |

---

## Next steps

- Stop stack (keeps your data): `cd /opt/joshu/deploy && docker compose -f docker-compose.yml --env-file /etc/joshu/instance.env down`
- Start again: same command with `up -d` instead of `down`
- Mail / connectors: [connectors.md](../connectors.md)
- More detail: [self-host.md](../self-host.md) · [deploy/README.md](../../deploy/README.md)

Managed Joshu hosting (zero-touch Hetzner via control plane) is separate — [control-plane.md](control-plane.md).
