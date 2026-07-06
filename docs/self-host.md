# Self-hosting Joshu (standalone box stack)

Run the Joshu box stack on your own hardware. Personal use, freelancers, and **internal commercial use** are free under [AGPL-3.0](../AGPL-3.0.txt) (see [LICENSE](../LICENSE)).

---

## Quick start

### Option A — Ubuntu VPS (recommended)

Full numbered walkthrough: [vps-quickstart.md](vps-quickstart.md) (create server → DNS → `git clone` → configure → bootstrap).

```bash
# On the VPS as root — see quickstart for every step
git clone --depth 1 --branch main https://github.com/db-aeon/joshu-oss.git /opt/joshu
cp /opt/joshu/deploy/.env.vps.example /etc/joshu/instance.env
# edit /etc/joshu/instance.env (CUSTOMER_DOMAIN, ACME_EMAIL, image pin — see quickstart)
cd /opt/joshu && ENV_FILE=/etc/joshu/instance.env bash deploy/scripts/bootstrap-vps.sh
```

### Option B — bootstrap script (same host as clone)

```bash
git clone https://github.com/db-aeon/joshu-oss.git
cd joshu-oss
sudo bash scripts/bootstrap-self-host.sh
```

Edit `/etc/joshu/instance.env` — set `CUSTOMER_DOMAIN`, API keys, and identity fields (`JOSHU_NAME`, `JOSHU_OWNER_EMAIL`, etc.).

### Option C — Docker Compose

```bash
cp deploy/.env.vps.example /etc/joshu/instance.env
export JOSHU_COMPOSE_ENV_FILE=/etc/joshu/instance.env
docker compose -f deploy/docker-compose.yml up -d
```

Pull a public image instead of building locally:

```bash
JOSHU_IMAGE_REF=ghcr.io/db-aeon/joshu-oss:latest
```

---

## Identity

Box identity is configured via environment variables (`JOSHU_*` in `/etc/joshu/instance.env`) and `.joshu/identity.json` on the ArozOS data volume.

See [`src/joshuIdentity.ts`](../src/joshuIdentity.ts) — sources `bootstrap` and `local`.

---

## Theme

Public builds ship the **Vanilla Box Stack** shell: silver taskbar, classic pinstripe window title bars, and neutral menus.

---

## Local development

See [local-installation.md](local-installation.md) and `npm run dev:arozos`.

---

## Offering Joshu to third parties

**Commercial use is allowed under AGPL-3.0**, including hosting Joshu as a **product or service for third parties**, provided you fully comply with AGPL obligations (including source availability for network-deployed modified versions), do not use restricted Joshu trademarks/JDL assets, and do not imply official affiliation.

**Internal employee use** does not require payment or a commercial license, provided you comply with AGPL-3.0.

---

## Configuration without Welcome

- [box-paths.md](box-paths.md) — required ArozOS user paths (`JOSHU_AROZ_USER`, Desktop, `.joshu`)
- [env-without-wizard.md](env-without-wizard.md) — API keys and secrets via `/etc/joshu/instance.env`

---

## Related

- [deploy/README.md](../deploy/README.md) — image build and env reference
- [vps-quickstart.md](vps-quickstart.md) — step-by-step VPS install
- [THIRD_PARTY.md](THIRD_PARTY.md) — ArozOS GPL, Hermes patches
