# Self-hosting Joshu

Run the Joshu box stack on your own hardware **without** the proprietary control
plane (`hello.joshu.me`). Personal use, freelancers, and **internal commercial
use** are free under [AGPL-3.0](../AGPL-3.0.txt) (see [LICENSE](../LICENSE)).

Managed hosting with zero-touch provisioning: [joshu.me](https://joshu.me).

---

## Run a box

A box runs as one container from the sandbox image, in single-container mode. You need a machine or a container host that can run one container with one persistent disk, e.g. a Linux machine with Docker or Podman, or a sandbox host such as Agent37. The container serves the box on plain HTTP port 8080, and you give the box a public HTTPS hostname with a Cloudflare Tunnel or with a reverse proxy of your own. Twilio needs that hostname for calls and text messages.

The first public image that starts in single-container mode is `ghcr.io/db-aeon/joshu-oss:0.1.68`. Older public images need Docker Compose, which is deprecated (see "Move a box from Docker Compose" below).

### 1. Choose how the box gets its HTTPS hostname

You can use a Cloudflare Tunnel, which needs no public IP address and no open port:

1. Make a Cloudflare Tunnel for the hostname of the box in the Cloudflare dashboard, with one public hostname rule to `http://127.0.0.1:8080`.
2. Copy the token of the tunnel. You pass it to the container as `CLOUDFLARE_TUNNEL_TOKEN` in step 3.

Cloudflare ends TLS for the hostname, and the free certificate of a zone covers only one level below it, so use a hostname like `mybox.example.com`, not `mybox.box.example.com`, unless you add a certificate for the deeper level.

Or you can run a reverse proxy with TLS on the same machine, e.g. Caddy or nginx, and send every path of the hostname to `http://127.0.0.1:8080`. The proxy must pass WebSocket connections, because the voice service gets the audio of a call over a WebSocket on path `/voice-rt/`. Caddy does this with no extra setting:

```
mybox.example.com {
  reverse_proxy 127.0.0.1:8080
}
```

Don't publish port 8080 on a public address. The box expects TLS in front of it.

### 2. Write the instance config

The box keeps all owner data, the instance config, and the service logs in one folder on the persistent disk, the data root. These steps use `/srv/joshu` on the machine, which the container sees as `/data`.

```bash
sudo mkdir -p /srv/joshu/secrets
sudo cp deploy/.env.vps.example /srv/joshu/secrets/instance.env
sudo chmod 600 /srv/joshu/secrets/instance.env
```

Take `deploy/.env.vps.example` from a clone of this repository. Edit `/srv/joshu/secrets/instance.env` and set `CUSTOMER_DOMAIN` to the hostname of step 1, the identity fields (`JOSHU_NAME`, `JOSHU_OWNER_EMAIL`, and the others), and your API keys. Quote each value that has a space in it. The box reads the file as `/etc/joshu/instance.env`, which is a link to it.

### 3. Start the container

```bash
docker run -d --name joshu --restart unless-stopped \
  -v /srv/joshu:/data \
  -e JOSHU_DATA_ROOT=/data \
  -p 127.0.0.1:8080:8080 \
  ghcr.io/db-aeon/joshu-oss:0.1.68 \
  bash /opt/joshu/.image/scripts/vps-start.sh
```

With a Cloudflare Tunnel, add `-e CLOUDFLARE_TUNNEL_TOKEN=<token>`, and you can leave out `-p`. On a sandbox host or a container platform, give the same three things: the image, the start command `bash /opt/joshu/.image/scripts/vps-start.sh`, and the variables `JOSHU_DATA_ROOT=/data` and `CLOUDFLARE_TUNNEL_TOKEN`, with the persistent disk mounted at `/data`. Don't mount the disk at `/root`, because the image keeps bun and gbrain in `/root/.bun`.

On the first start, the start script copies what the image has at each data path to a folder under `/data`, and that takes some minutes. Then the box answers on port 8080:

```bash
curl -fsS http://127.0.0.1:8080/joshu/api/instance/health
```

The service logs are in `/srv/joshu/logs/`, one file for each service, and `docker logs joshu` shows the same lines.

### Update the box

To update the box, start a new container from the newer image with the same data root:

```bash
docker pull ghcr.io/db-aeon/joshu-oss:<version>
docker rm -f joshu
```

Then run the command of step 3 with the new version. A start from a newer image keeps each folder under the data root as it is. A box can't go back to an image older than 0.1.68, because older images don't know the data root. The hotfix overlay does not work in single-container mode.

### Box without a control plane

A self-hosted box has no control plane. The instance agent runs only when the instance config sets `CONTROL_PLANE_URL` and `JOSHU_INSTANCE_ID`, so a self-hosted box runs no instance agent, and it needs no `JOSHU_STANDALONE` setting.

### Move a box from Docker Compose

Docker Compose is deprecated, and a later release removes it. A box that runs with Docker Compose keeps working until then. To move it to single-container mode on the same machine, copy the named volumes of the box to the data root:

1. Check that the Hindsight database uses Postgres 17. The command `sudo cat /var/lib/docker/volumes/deploy_joshu_postgres/_data/data/PG_VERSION` must print `17`.
2. Stop the box: `docker compose -f /opt/joshu/deploy/docker-compose.yml --env-file /etc/joshu/instance.env stop`.
3. Copy each volume in the table to its folder, e.g. `sudo mkdir -p /srv/joshu/arozos && sudo cp -a /var/lib/docker/volumes/deploy_joshu_arozos/_data/. /srv/joshu/arozos/`. Then copy the config: `sudo mkdir -p /srv/joshu/secrets && sudo cp -a /etc/joshu/. /srv/joshu/secrets/`.
4. Remove these keys from `/srv/joshu/secrets/instance.env`, because only Docker Compose reads them: `JOSHU_COMPOSE_FILE`, `JOSHU_COMPOSE_ENV_FILE`, `ACME_EMAIL`, `JOSHU_INSTANCE_AGENT_IMAGE_REF`, and `JOSHU_VOICE_IMAGE_REF`.
5. Set up the HTTPS hostname of step 1, because the Caddy container of Docker Compose no longer serves ports 80 and 443. Then start the container as in step 3.

| Docker Compose volume | Folder under the data root |
|---|---|
| `deploy_joshu_arozos` | `arozos` |
| `deploy_joshu_hermes` | `hermes` |
| `deploy_joshu_gbrain` | `gbrain` |
| `deploy_joshu_postgres` | `postgres-hindsight` |
| `deploy_joshu_hindsight_home` | `hindsight-home` |
| `deploy_joshu_hindsight_cache` | `hindsight-cache` |
| `deploy_joshu_voice_clips` | `voice` |

Keep the volumes until the moved box works. You can then remove the old containers with `docker compose -f /opt/joshu/deploy/docker-compose.yml --env-file /etc/joshu/instance.env down`, which keeps the volumes.

---

## Identity without control plane

Box identity is configured via environment variables (`JOSHU_*` in `/etc/joshu/instance.env`)
and `.joshu/identity.json` on the ArozOS data volume.

See [`src/joshuIdentity.ts`](../src/joshuIdentity.ts) — sources `bootstrap` and
`local` work without CP metadata sync.

Optional CP sync paths in [`src/companionIdentitySync.ts`](../src/companionIdentitySync.ts)
are skipped when standalone.

---

## Theme

Public builds ship the **Vanilla Box Stack** shell: silver taskbar, classic pinstripe window
title bars, and neutral menus (not the private Joshu paper-shell brand pack). Official fleet
images inject branded chrome from private `joshu-design` via `JOSHU_DESIGN_PACK` at build time.

---

## Local development

See [local-installation.md](local-installation.md) and `npm run dev:arozos`.

---

## Offering Joshu to third parties

**Commercial use is allowed under AGPL-3.0**, including hosting Joshu as a
**product or service for third parties**, provided you fully comply with AGPL
obligations (including source availability for network-deployed modified
versions), do not use restricted Joshu trademarks/JDL assets, and do not imply
official affiliation.

A **commercial OEM/MSP agreement** (or Joshu managed service at
hello.joshu.me) is required for non-AGPL terms, white-label rights, official
branding/JDL assets, proprietary control-plane access, support/SLA, or partner
distribution rights. Contact **info@joshu.me** — see
[COMMERCIAL_LICENSE.md](../COMMERCIAL_LICENSE.md).

**Internal employee use** does not require payment or a commercial license,
provided you comply with AGPL-3.0.

---

## Related

- [deploy/README.md](../deploy/README.md) — image build and env reference
- [THIRD_PARTY.md](THIRD_PARTY.md) — ArozOS GPL, Hermes patches
- Control plane (proprietary)
