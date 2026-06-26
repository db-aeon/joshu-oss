# Self-hosting Joshu (standalone box stack)

Run the Joshu box stack on your own hardware **without** the proprietary control
plane (`hello.joshu.me`). Personal use, freelancers, and **internal commercial
use** are free under [AGPL-3.0](../LICENSE).

Managed hosting with zero-touch provisioning: [joshu.me](https://joshu.me).

---

## Quick start

### Option A — bootstrap script (Linux VPS)

```bash
git clone https://github.com/your-org/joshu.git
cd joshu
sudo bash scripts/bootstrap-self-host.sh
```

Edit `/etc/joshu/instance.env` — set `CUSTOMER_DOMAIN`, API keys, and identity
fields (`JOSHU_NAME`, `JOSHU_OWNER_EMAIL`, etc.).

### Option B — Docker Compose

```bash
cp deploy/.env.vps.example /etc/joshu/instance.env
# Add JOSHU_STANDALONE=1 to skip control plane agent
export JOSHU_COMPOSE_ENV_FILE=/etc/joshu/instance.env
docker compose -f deploy/docker-compose.yml up -d
```

Pull a public image instead of building locally:

```bash
JOSHU_IMAGE_REF=ghcr.io/your-org/joshu-oss:latest
```

---

## Standalone vs fleet profiles

| Profile | Services | Use case |
|---------|----------|----------|
| **`standalone`** | Caddy + joshu-stack (default `docker compose up`) | Self-host |
| **`fleet`** | + instance-agent (`--profile fleet`) | Joshu-managed fleet |

The instance agent **exits cleanly** when `JOSHU_STANDALONE=1` is set.

---

## Identity without control plane

Box identity is configured via environment variables and
[`.joshu/identity.json`](../joshu-identity.md) on the ArozOS data volume.

See [`src/joshuIdentity.ts`](../src/joshuIdentity.ts) — sources `bootstrap` and
`local` work without CP metadata sync.

Optional CP sync paths in [`src/companionIdentitySync.ts`](../src/companionIdentitySync.ts)
are skipped when standalone.

---

## Theme

Public builds ship the **Vanilla Box Stack** (unbranded). Official Joshu fleet
images inject the branded design pack from private `joshu-design` via
`JOSHU_DESIGN_PACK` at build time.

---

## Local development

See [local-installation.md](local-installation.md) and `npm run dev:arozos`.

---

## Offering Joshu to third parties

Hosting Joshu as a **product or service for other organizations** requires a
[Joshu commercial license](../COMMERCIAL_LICENSE.md). Internal employee use does not.

---

## Related

- [deploy/README.md](../deploy/README.md) — image build and env reference
- [THIRD_PARTY.md](THIRD_PARTY.md) — ArozOS GPL, Hermes patches
- [Control plane (proprietary)](vps-sandbox/control-plane.md)
