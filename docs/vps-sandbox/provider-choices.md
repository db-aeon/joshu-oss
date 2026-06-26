# Provider Choices (Recommended Defaults)

Concrete vendor picks for the Joshu VPS sandbox platform. Override per environment; document changes in the control-plane `Organization.settings` JSON.

## Summary

| Concern | Recommended | Rationale |
| --- | --- | --- |
| **VPS** | Hetzner Cloud (CX22/CX32) or Vultr | Cheap always-on EU/US VMs, API for provisioning, predictable pricing |
| **DNS** | Cloudflare | Per-customer A records; **`CLOUDFLARE_PROXIED=true`** recommended for production sandboxes |
| **TLS** | Caddy on-instance (ACME) or Cloudflare origin certs | Per-customer subdomain; Caddy auto-HTTPS fits Compose |
| **Container registry** | GitHub Container Registry (`ghcr.io`) | Same org as repo; OIDC publish from GitHub Actions |
| **Control plane host** | Vercel (Next.js) | Admin UI + webhooks; short-lived API routes |
| **Control DB** | Neon Postgres or Supabase | Serverless Postgres compatible with Prisma on Vercel |
| **Queue / workflows** | Inngest or Trigger.dev | Long VPS provision jobs exceed Vercel timeout; retries + dashboards |
| **Billing** | Stripe | Customers, subscriptions, webhooks → entitlements |
| **Telephony** | Twilio Programmable Voice | Already integrated in Joshu (`twilioPhoneGateway.ts`) |
| **Email (inbound)** | Cloudflare Email Routing → webhook **or** Migadu/Forward Email | Per-customer `agent@customer.example.com` aliases |
| **Email (outbound)** | Resend or Postmark | Transactional + agent replies via API |
| **Messaging** | Hermes native (Discord/Telegram) + future Matrix bridge | Gateway already in Hermes `[messaging]` extras |
| **Observability** | Better Stack (logs) + Uptime Kuma (self-hosted) or Checkly | Per-instance heartbeat + external HTTPS checks |
| **Secrets** | Control-plane encrypted columns + VPS `.env` (600) | Instance-agent delivers rotation payloads signed |

## VPS sizing (per customer)

| Tier | vCPU | RAM | Disk | Typical load |
| --- | --- | --- | --- | --- |
| **Starter** | 2 | 4 GB | 40 GB | Chat + light browser HITL |
| **Standard** | 4 | 8 GB | 80 GB | Camofox + Hindsight + voice |
| **Pro** | 8 | 16 GB | 160 GB | Heavy browser sessions, larger memory bank |

CPU-only VPS is sufficient for orchestration; voice uses OpenAI Realtime S2S per [voice-realtime.md](voice-realtime.md).

## Provisioning API flow

```
Stripe webhook → Vercel API → Inngest job
  → VPS API (Hetzner or DigitalOcean per Instance.vpsProvider)
  → Cloudflare API (A record customer.sandbox.example.com, optional proxy)
  → cloud-init: bootstrap-vps.sh (clone repo → `/opt/joshu`)
  → instance-agent register
  → Twilio buy number + set voice URL
  → Resend domain/alias (optional)
```

## VPS provider selection

The control plane supports **Hetzner Cloud** and **DigitalOcean Droplets**. Each
`Instance` row stores `vpsProvider` (`hetzner` or `digitalocean`). New sandboxes
default from `VPS_PROVIDER` (env); override per create with `"vpsProvider"` in the
admin API body or UI.

## Cloudflare DNS and Safe Browsing

The control plane creates/updates **A records** via `CloudflareClient.upsertARecord()`. Set in control-plane env:

```dotenv
DNS_PROVIDER=cloudflare
CLOUDFLARE_API_TOKEN=
CLOUDFLARE_ZONE_ID=
# Strongly recommended for customer-facing sandboxes (e.g. *.box.joshu.me):
CLOUDFLARE_PROXIED=true
```

| `CLOUDFLARE_PROXIED` | Visitor sees | Use when |
| --- | --- | --- |
| `false` (default) | Droplet **public IPv4** directly | Dev/debug; highest risk of recycled-IP Safe Browsing flags |
| `true` | **Cloudflare** edge IP | Production customer URLs; masks DO IP reputation |

When proxied is enabled, configure the zone for Joshu stacks:

- **SSL/TLS → Full (strict)** — origin (Caddy on the VPS) already has a valid Let's Encrypt cert for the customer hostname.
- **Network → WebSockets: On** — Hermes chat SSE and noVNC paths through `/joshu/`.
- Register **`sc-domain:<your-suffix>`** in [Google Search Console](https://search.google.com/search-console) for security-issue alerts and false-positive reviews.

Optional hardening: check new droplet IPv4 on VirusTotal / MXToolbox before pointing DNS; use **DigitalOcean reserved IPv4** for a clean pool.

See [troubleshooting-and-lessons.md](troubleshooting-and-lessons.md#chrome-dangerous-site-safe-browsing).

Orchestration lives in:

- `apps/control-plane/src/lib/providers/hetzner.ts`
- `apps/control-plane/src/lib/providers/digitalocean.ts`
- `apps/control-plane/src/lib/providers/vpsProvider.ts` (routing + plan sizing)
- `provisionQueuedInstance(instanceId)` in `apps/control-plane/src/lib/provisioner.ts`

## Hetzner control-plane setup

Hetzner Cloud can be orchestrated directly from the control plane. The adapter in
`apps/control-plane/src/lib/providers/hetzner.ts` uses the REST API to create,
inspect, and delete servers. The create path supports:

- `server_type` (`cpx21`, `cpx31`, `cpx41`, or env override)
- `image` (`ubuntu-24.04` by default)
- `location` (`ash`, `hil`, `fsn1`, `nbg1`, `hel1`, `sin`)
- SSH keys (`HETZNER_SSH_KEY_IDS`)
- Firewalls (`HETZNER_FIREWALL_IDS`)
- labels for `instanceId`, `customerId`, and environment
- `user_data` cloud-init generated by `buildJoshuCloudInit`

Required control-plane env:

```dotenv
VPS_PROVIDER=hetzner
HETZNER_API_TOKEN=
HETZNER_LOCATION=ash
HETZNER_IMAGE=ubuntu-24.04
HETZNER_SERVER_TYPE=cpx31
HETZNER_SSH_KEY_IDS=123456
HETZNER_FIREWALL_IDS=123456
DNS_PROVIDER=cloudflare
CLOUDFLARE_API_TOKEN=
CLOUDFLARE_ZONE_ID=
CLOUDFLARE_PROXIED=false
CUSTOMER_DOMAIN_SUFFIX=sandbox.example.com
CONTROL_PLANE_URL=https://admin.example.com
JOSHU_REPO_URL=https://github.com/your-org/joshu.git
JOSHU_IMAGE_REF=ghcr.io/your-org/joshu-sandbox:0.1.0
ACME_EMAIL=ops@example.com
INSTANCE_AGENT_SIGNING_SECRET=
GHCR_READ_USER=
GHCR_READ_TOKEN=
GITHUB_REPO_READ_USER=
GITHUB_REPO_READ_TOKEN=
```

Use a fine-grained GitHub token scoped to the Joshu repo with `Contents: Read` and `Packages: Read`.
The control plane injects these only into cloud-init at provision time; they are not stored in database job payloads.

Manual/dev flow:

```bash
# One-call CRUD create: create/reuse customer, queue an instance, and optionally
# create the Hetzner server immediately. Omit "provision" to only queue the DB job.
curl -X POST "$CONTROL_PLANE_URL/api/admin/instances" \
  -H "x-admin-key: $ADMIN_API_KEY" \
  -H "content-type: application/json" \
  -d '{
    "organizationSlug": "joshu-dev",
    "customerName": "Acme Demo",
    "customerSlug": "acme-demo",
    "planId": "standard",
    "vpsProvider": "hetzner",
    "provision": true
  }'

# Legacy two-step flow: queue an instance row + create job for an existing customer.
curl -X POST "$CONTROL_PLANE_URL/api/admin/customers/$CUSTOMER_ID/instances" \
  -H "x-admin-key: $ADMIN_API_KEY" \
  -H "content-type: application/json" \
  -d '{"planId":"standard"}'

# Execute the queued VPS create job. Production should do this from Inngest.
curl -X POST "$CONTROL_PLANE_URL/api/admin/instances/$INSTANCE_ID/provision" \
  -H "x-admin-key: $ADMIN_API_KEY"

# List and inspect sandboxes.
curl "$CONTROL_PLANE_URL/api/admin/instances" \
  -H "x-admin-key: $ADMIN_API_KEY"
curl "$CONTROL_PLANE_URL/api/admin/instances/$INSTANCE_ID" \
  -H "x-admin-key: $ADMIN_API_KEY"

# Queue agent-driven deprovision, or force provider teardown if the agent is gone.
curl -X POST "$CONTROL_PLANE_URL/api/admin/instances/$INSTANCE_ID/destroy" \
  -H "x-admin-key: $ADMIN_API_KEY" \
  -H "content-type: application/json" \
  -d '{"force":false}'

# Equivalent DELETE form. `force=true` deletes the VPS server and Cloudflare
# DNS record directly from the control plane without waiting for the agent.
curl -X DELETE "$CONTROL_PLANE_URL/api/admin/instances/$INSTANCE_ID?force=true" \
  -H "x-admin-key: $ADMIN_API_KEY"
```

Production flow should call `provisionQueuedInstance(instanceId)` from an
Inngest/Trigger.dev worker so server creation, DNS, Twilio, and email setup can
retry independently from Vercel request timeouts.

## DigitalOcean control-plane setup

DigitalOcean Droplets use the same cloud-init bootstrap as Hetzner. The adapter in
`apps/control-plane/src/lib/providers/digitalocean.ts` base64-encodes `user_data`
per DO API requirements, polls for a public IPv4, and optionally attaches
firewalls after create.

- `region` (`nyc3`, `sfo3`, `ams3`, …)
- `size` (`s-2vcpu-4gb`, `s-4vcpu-8gb`, `s-8vcpu-16gb`, or `DIGITALOCEAN_SIZE`)
- `image` slug (`ubuntu-24-04-x64` by default)
- SSH keys (`DIGITALOCEAN_SSH_KEY_IDS` — numeric IDs or fingerprints)
- Optional firewalls (`DIGITALOCEAN_FIREWALL_IDS`)

Required control-plane env (when using DO):

```dotenv
VPS_PROVIDER=digitalocean
DIGITALOCEAN_API_TOKEN=
DIGITALOCEAN_REGION=nyc3
DIGITALOCEAN_IMAGE=ubuntu-24-04-x64
DIGITALOCEAN_SIZE=s-4vcpu-8gb
DIGITALOCEAN_SSH_KEY_IDS=12345678
DIGITALOCEAN_FIREWALL_IDS=
```

Plan defaults: `starter` → `s-2vcpu-4gb`, `standard` → `s-4vcpu-8gb`, `pro` → `s-8vcpu-16gb`.

Example create with DO:

```bash
curl -X POST "$CONTROL_PLANE_URL/api/admin/instances" \
  -H "x-admin-key: $ADMIN_API_KEY" \
  -H "content-type: application/json" \
  -d '{
    "customerSlug": "acme-do",
    "customerName": "Acme DO",
    "planId": "standard",
    "vpsProvider": "digitalocean",
    "provision": true
  }'
```

## Alternatives considered

| Area | Alternative | When to use |
| --- | --- | --- |
| VPS | Linode | Additional API twin if needed |
| Queue | BullMQ on a small Railway worker | If you want self-hosted Redis |
| DB | PlanetScale | If you need branching (less ideal for Prisma enums) |
| Voice STT | AssemblyAI streaming | Strong telephony latency |
| Realtime LLM | OpenAI Realtime API | Sub-second duplex when budget allows |

## Environment variables (control plane)

Store in Vercel / Inngest secrets:

- `VPS_PROVIDER` (default for new instances)
- `HETZNER_API_TOKEN`, `HETZNER_SSH_KEY_IDS`, `HETZNER_FIREWALL_IDS`
- `DIGITALOCEAN_API_TOKEN`, `DIGITALOCEAN_SSH_KEY_IDS`, `DIGITALOCEAN_REGION`
- `DNS_PROVIDER`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ZONE_ID`, `CLOUDFLARE_PROXIED`
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`
- `INNGEST_EVENT_KEY`
- `DATABASE_URL` (Supabase shared pooler transaction mode, port `6543`, with `pgbouncer=true`)
- `DIRECT_URL` (Supabase shared pooler session/direct mode, port `5432`, for Prisma migrations)
- `INSTANCE_AGENT_SIGNING_SECRET` (HMAC for commands)
- `GHCR_READ_USER` and `GHCR_READ_TOKEN` if the sandbox image is private
- Optional per-instance defaults such as `DEFAULT_OPENROUTER_API_KEY`,
  `DEFAULT_JOSHU_HERMES_MODEL`, and `DEFAULT_JOSHU_HERMES_PROVIDER=openrouter`,
  `DEFAULT_HINDSIGHT_API_LLM_API_KEY`, and voice provider keys. The control
  plane generates `HERMES_API_KEY`/`API_SERVER_KEY` per instance automatically.

For local Prisma commands, remember that Prisma CLI does not automatically load
Next.js `.env.local`. Either export/source `apps/control-plane/.env.local` before
running workspace scripts, or mirror the database URLs into an ignored
`apps/control-plane/.env` file for local development.
