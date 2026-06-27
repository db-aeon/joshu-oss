# First Hetzner Provisioning Notes

These notes capture what we learned during the first end-to-end VPS sandbox
provisioning run:

```text
control plane: https://hello.joshu.me
customer host: demo.box.joshu.me
provider: Hetzner Cloud
registry image: ghcr.io/db-aeon/joshu-sandbox:0.1.0
```

The architecture worked: the Vercel control plane created a Hetzner server,
DNS pointed a customer hostname to the VPS, Caddy obtained TLS, ArozOS served
the login page, Joshu health returned `200`, and the instance agent reported
healthy heartbeats back to the control plane.

The main lesson is that the design is sound, but first-boot automation needs
stronger preflight checks, clearer progress reporting, and less dependence on
manual SSH repair.

## Successful End State

The first working instance reached:

```text
hostname: demo.box.joshu.me
instance status: active
public desktop: https://demo.box.joshu.me/
health endpoint: https://demo.box.joshu.me/joshu/api/instance/health
```

Expected verification:

```bash
curl -fsS https://demo.box.joshu.me/joshu/api/instance/health
```

The control plane should show `lastHeartbeatAt` updating and `status=active`.

## Issues Encountered

### Vercel and pnpm Lockfiles

Vercel detected the repository as a pnpm workspace because the root
`packageManager` points at pnpm and `pnpm-lock.yaml` exists. The control-plane
dependencies had been updated with npm during local iteration, so Vercel failed
with `ERR_PNPM_OUTDATED_LOCKFILE`.

Fix:

- Control plane lives in the separate `joshu-control-plane` repository.
- Regenerate `pnpm-lock.yaml` with `pnpm install --lockfile-only`.
- Verify with `pnpm install --frozen-lockfile`.
- Build the app locally with `pnpm --filter @joshu/control-plane build` (compiles `@joshu/email-signature` first).

### Supabase Connection URLs

Prisma CLI does not automatically load Next.js `.env.local`. Local Prisma
commands need the control-plane env exported first:

```bash
set -a
source apps/control-plane/.env.local
set +a
npm run db:push -w @joshu/control-plane
```

For Vercel/serverless runtime:

```dotenv
DATABASE_URL=postgresql://postgres.<project-ref>:...@aws-1-us-west-2.pooler.supabase.com:6543/postgres?pgbouncer=true
DIRECT_URL=postgresql://postgres.<project-ref>:...@aws-1-us-west-2.pooler.supabase.com:5432/postgres
```

Use transaction mode (`6543`) for runtime and session/direct mode (`5432`) for
Prisma schema pushes and migrations.

### Hetzner Numeric IDs

Hetzner's UI names are not always valid API values. `firewall-1` is a display
name, but the create-server API expects numeric firewall IDs.

Use numeric values:

```dotenv
HETZNER_SSH_KEY_IDS=12345678
HETZNER_FIREWALL_IDS=23456789
```

Find SSH key IDs:

```bash
curl -H "Authorization: Bearer $HETZNER_API_TOKEN" \
  https://api.hetzner.cloud/v1/ssh_keys
```

Find firewall IDs:

```bash
curl -H "Authorization: Bearer $HETZNER_API_TOKEN" \
  https://api.hetzner.cloud/v1/firewalls
```

### Server Type and Location Compatibility

`cpx32` was not available in Hetzner's Ashburn location (`ash`). The working
Ashburn standard size was `cpx31`.

Working default for US East:

```dotenv
HETZNER_LOCATION=ash
HETZNER_SERVER_TYPE=cpx31
```

The provisioner should preflight `server_types` before creating a server so
invalid type/location pairs fail before billing resources are touched.

### DNS Setup

The hostname pattern is:

```text
<customer-slug>.<CUSTOMER_DOMAIN_SUFFIX>
```

For example:

```dotenv
CUSTOMER_DOMAIN_SUFFIX=box.joshu.me
```

creates:

```text
demo.box.joshu.me
```

Manual DNS for the first run:

```text
Type: A
Name: demo.box
Value: <Hetzner IPv4>
```

Caddy can complete ACME once DNS points at the VPS and ports `80` and `443`
are open.

The control plane now creates or updates this DNS record automatically through
Cloudflare after Hetzner returns the server IPv4, then stores the Cloudflare
record ID on the `Domain` row. Destroy/recreate paths use that record ID to
remove or update DNS without manual cleanup.

### Cloud-init Docker Install

Ubuntu's default apt repos did not reliably provide `docker-compose-plugin`.
Cloud-init failed during package installation before the repo clone or compose
startup ran.

Fix:

- Install Docker from Docker's official Ubuntu apt repository.
- Install `docker-ce`, `docker-ce-cli`, `containerd.io`,
  `docker-buildx-plugin`, and `docker-compose-plugin`.
- Ensure both `docker.socket` and `docker.service` can start.

If repairing a machine manually:

```bash
systemctl reset-failed docker.service || true
systemctl enable --now docker.socket
systemctl start docker.service
docker version
```

### Private GitHub and GHCR Access

The first VPS could not clone the private GitHub repository:

```text
fatal: could not read Username for 'https://github.com': No such device or address
```

It also could not pull the GHCR image:

```text
error from registry: unauthorized
```

For the first test, we repaired manually by uploading deploy files over SSH and
streaming the local image:

```bash
tar -czf - deploy packages | ssh root@<ip> 'tar -xzf - -C /opt/joshu'
docker save ghcr.io/db-aeon/joshu-sandbox:0.1.0 | ssh root@<ip> 'docker load'
```

Production uses private GHCR and a private GitHub repo. Set these on the control plane:

```dotenv
GHCR_READ_USER=<github-user-or-bot>
GHCR_READ_TOKEN=<fine-grained-token-with-packages-read>
GITHUB_REPO_READ_TOKEN=<fine-grained-token-with-contents-read>
GITHUB_REPO_READ_USER=<optional-github-user>
```

Cloud-init logs into GHCR, clones the private repo with a read-only token, pulls
`JOSHU_IMAGE_REF`, and starts Compose. Credentials are not written to ProvisionJob
payloads in the database.

### Caddy Networking

Joshu runs with `network_mode: host`, but Caddy initially ran in bridge
networking. That made `127.0.0.1:8788` from Caddy point at the Caddy container
instead of the host-network Joshu process.

Fix:

```yaml
caddy:
  image: caddy:2-alpine
  restart: unless-stopped
  network_mode: host
```

After this, Caddy can reverse proxy:

```text
/joshu/* -> 127.0.0.1:8788
/voice/* -> 127.0.0.1:8791
/       -> 127.0.0.1:8787
```

### ArozOS Boot

ArozOS initially crashed with:

```text
WEB FOLDER NOT FOUND
```

The image did contain `/opt/arozos-template/web`, and the persistent ArozOS
volume also had `web/` and `system/`. The real bug was launch cwd: ArozOS checks
for `web/` relative to its current working directory, but `vps-start.sh` launched
the binary from `/opt/joshu`.

Fix:

```bash
cd "${AROZ_DATA}"
"${AROZ_TEMPLATE}/arozos" \
  -port="${PUBLIC_AROZ_PORT}" \
  -disable_ip_resolver=true \
  -hostname="${AROZ_HOSTNAME:-Joshu}" \
  -tmp="${AROZ_DATA}" \
  -root="${AROZ_DATA}/files"
```

`-tmp` must be the parent data dir; ArozOS appends `tmp/` itself. Passing
`${AROZ_DATA}/tmp` breaks with `tmp/tmp` / "Mount point not exists!".

`AROZOS_ENABLED=true` can be used once the boot path is validated. Keeping an
enable flag is useful because ArozOS is the public desktop, but it should not
take down the whole Joshu API during early boot repairs.

### Camofox Fetch Cache

The stack still logged:

```text
Version information not found at /root/.cache/camoufox/version.json.
Please run `camoufox fetch` to install.
```

This did not block ArozOS, the health endpoint, or instance heartbeats, but it
will affect browser session creation.

**Fixed (2026-05):** `deploy/Dockerfile` no longer deletes `/root/.cache/camoufox`
(only `/root/.cache/pip`). `vps-start.sh` runs `npx camoufox-js fetch` when
`version.json` is missing. Hotfix on a live box:
`docker exec deploy-joshu-stack-1 bash -lc 'cd /app && npx --yes camoufox-js fetch'`.

### Hindsight Runtime Parity

Hindsight did not work on the first Hetzner boot even though local `.env`
contained the required LLM variables. The VPS needed the same runtime contract
that the legacy stack had been injecting implicitly:

```dotenv
JOSHU_HINDSIGHT_ENABLED=true
HINDSIGHT_API_URL=http://127.0.0.1:8888
HINDSIGHT_API_DATABASE_URL=postgresql://hindsight:hindsight@127.0.0.1:5432/hindsight
HINDSIGHT_API_LLM_PROVIDER=openai
HINDSIGHT_API_LLM_API_KEY=...
HINDSIGHT_API_LLM_MODEL=gpt-4o-mini
HINDSIGHT_REQUIRE_EXTERNAL_ML=true
```

Additional fixes needed for parity:

- Build and copy `pgvector` into the runtime image so `CREATE EXTENSION vector`
  succeeds inside the local Hindsight Postgres.
- Mount `/etc/joshu/secrets` into `joshu-stack` read-only so service account
  files referenced by env vars are visible in the container.
- Keep Hindsight's durable state in named volumes:
  `joshu_hindsight_home`, `joshu_hindsight_cache`, and `joshu_postgres`.

The health endpoint can report `components.hindsight.ok=true` once the API
starts, the vector extension is available, and LLM/reranker credentials resolve.

### Hermes Chat Auth

Hermes chat reached the API server but initially produced an empty response, then
returned:

```text
Hermes chat request failed: 401 {"error":{"message":"Invalid API key",...}}
```

There were two separate auth layers:

- Provider auth: `OPENROUTER_API_KEY` in `/root/.hermes/.env` (OpenRouter default).
- Hermes API server auth: bearer token checked by the gateway's
  `API_SERVER_KEY`.

The Anthropic key from local `~/.hermes/.env` was valid; a direct VPS request to
Anthropic returned `200`. The real bug was gateway-token drift:

```text
Joshu client sent: HERMES_API_KEY
Hermes gateway expected: API_SERVER_KEY
```

Working fix:

```dotenv
HERMES_API_KEY=<same-random-secret>
API_SERVER_KEY=<same-random-secret>
OPENROUTER_API_KEY=<customer-or-instance-openrouter-key>
```

`vps-start.sh` loads `/etc/joshu/instance.env` first and then
`/root/.hermes/.env`. After aligning both gateway-token variables and restarting
`joshu-stack`, public SSE streaming worked through Caddy:

```bash
curl -N -H 'Content-Type: application/json' \
  -d '{"sessionId":"smoke","messages":[{"role":"user","content":"Reply with exactly: VPS Hermes is working."}]}' \
  https://demo.box.joshu.me/joshu/api/hermes-chat/stream
```

Expected response shape:

```text
event: status
event: session
event: delta
event: done
```

Do not use a hardcoded value such as `change-me-production` in production. The
control plane should generate a per-instance gateway secret, write both
`HERMES_API_KEY` and `API_SERVER_KEY`, and rotate them together.

## Operational Checklist

Before creating a VPS:

- Vercel env is deployed, not just edited.
- `CONTROL_PLANE_URL` points at the deployed Vercel URL or stable admin domain.
- `CUSTOMER_DOMAIN_SUFFIX` is a domain namespace we control.
- `HETZNER_SSH_KEY_IDS` and `HETZNER_FIREWALL_IDS` are numeric IDs.
- `HETZNER_SERVER_TYPE` is available in `HETZNER_LOCATION`.
- GHCR image is pullable by the VPS, or cloud-init has registry credentials.
- `DNS_PROVIDER=cloudflare`, `CLOUDFLARE_API_TOKEN`, and `CLOUDFLARE_ZONE_ID`
  are configured, unless explicitly running with `DNS_PROVIDER=manual`.
- The control plane can generate a per-instance Hermes API secret and assign it
  to both `HERMES_API_KEY` and `API_SERVER_KEY`.
- Provider secrets are present for enabled subsystems, especially
  `OPENROUTER_API_KEY` for Hermes chat and Hindsight LLM/reranker keys when
  `JOSHU_HINDSIGHT_ENABLED=true`.

After creating a VPS:

```bash
dig +short <customer-hostname> A
curl -fsS https://<customer-hostname>/joshu/api/instance/health
```

On the VPS:

```bash
cloud-init status --long
docker ps
docker compose -f /opt/joshu/deploy/docker-compose.yml --env-file /etc/joshu/instance.env ps
docker logs --tail 100 deploy-joshu-stack-1
docker logs --tail 100 deploy-instance-agent-1
docker logs --tail 100 deploy-caddy-1
```

Smoke-test Hermes chat:

```bash
curl -N -H 'Content-Type: application/json' \
  -d '{"sessionId":"smoke","messages":[{"role":"user","content":"Reply with exactly: VPS Hermes is working."}]}' \
  https://<customer-hostname>/joshu/api/hermes-chat/stream
```

In the control plane, verify:

- `Instance.status` becomes `active`.
- `lastHeartbeatAt` updates.
- `lastHealth.healthy` is `true`.

## Recommended Improvements

### Provisioning Preflight

Add a preflight endpoint or worker step that validates:

- Hetzner token can list locations, server types, SSH keys, and firewalls.
- SSH key IDs exist.
- Firewall IDs exist and are numeric.
- Server type is available in the selected location.
- `CONTROL_PLANE_URL` is reachable publicly.
- `CUSTOMER_DOMAIN_SUFFIX` is configured.
- Registry image is pullable from a clean environment.

This should run before creating a server.

### DNS Automation

Cloudflare support exists in the control plane to create/update:

```text
<customer-slug>.<CUSTOMER_DOMAIN_SUFFIX> A <vps-ip>
```

It stores the provider record ID on the `Domain` row so destroy/recreate can
update or remove it safely. Remaining hardening is around background retries and
surfacing DNS operation failures in a richer bootstrap timeline.

### Registry Authentication

Do not require SSH image streaming. Use a production-grade image pull path:

- public or internal GHCR package visibility, or
- read-only `GHCR_READ_TOKEN`, or
- image copied to a registry designed for server pulls.

Cloud-init should run:

```bash
echo "$GHCR_READ_TOKEN" | docker login ghcr.io -u "$GHCR_READ_USER" --password-stdin
docker pull "$JOSHU_IMAGE_REF"
```

### Remove Repo Clone Dependency

The VPS should not need to clone the private source repository. Options:

- Bake compose files and startup scripts into the image.
- Publish a small signed deploy bundle per release.
- Split `instance-agent` and `voice-gateway` into published images so compose
  never builds from source on the VPS.

### Better First-boot Telemetry

Cloud-init failures are currently visible only through SSH or the Hetzner web
console. Add a bootstrap reporter that posts:

- `cloud-init started`
- `docker installed`
- `repo/deploy bundle ready`
- `image pulled`
- `compose started`
- final error text on failure

This can be a small shell function that `curl`s a control-plane event endpoint.

### Service Boundaries

The current `joshu-sandbox` image is good for parity, but it is heavy and mixes
several concerns. Longer term:

- `joshu-stack` image for Joshu + Hermes runtime.
- `arozos` image or separate process with explicit volume seeding.
- `instance-agent` published image.
- `voice-gateway` published image.
- Camofox cache/browser assets baked explicitly.

This will make updates smaller and failures easier to isolate.

### Admin Operations

Add control-plane actions for:

- retry failed provision job
- destroy server
- recreate server
- rotate instance token
- update release/image
- view bootstrap logs

Manual database resets and direct Hetzner deletes should be replaced by audited
admin actions.

### Secrets and Config Hardening

Manual copying from local `~/.hermes` is acceptable for a first smoke test but
should not be part of production provisioning. Product Hermes YAML (model,
`skills.disabled`, plugins, Camofox) is applied from the **repo + `instance.env`**
via Joshu startup — see
[hermes-customizations.md — Hermes runtime config](../hermes-customizations.md#hermes-runtime-config-local-hermes-vs-vps--image).
The control plane should own a typed secret contract per instance:

- gateway auth secret: generate once per instance and write to both
  `HERMES_API_KEY` and `API_SERVER_KEY`
- model provider keys: `OPENROUTER_API_KEY`, OpenAI, Gemini, or customer-specific
  provider credentials
- Hindsight provider keys and service account files
- Twilio webhook/auth secrets
- registry pull credentials

Recommended implementation:

1. Store encrypted secrets in the control-plane database or a managed secret
   store.
2. Render `/etc/joshu/instance.env` from typed fields rather than ad hoc string
   concatenation.
3. Add a `rotate_secrets` command that rewrites the env file, validates it with
   a smoke check, and restarts only the affected services.
4. Add a boot preflight that fails fast if enabled subsystems are missing their
   required secrets.

### Health and Smoke Checks

The current health endpoint marks core health as Joshu + Camofox + Hermes. That
is useful for boot gating, but production needs richer checks:

- distinguish required and optional components per customer plan
- expose Hindsight, voice, Twilio, DNS, Caddy certificate, disk, memory, and
  image version status separately
- include actionable error strings in `lastHealth`, with secrets redacted
- run a post-boot synthetic check for HTTPS, `/joshu/api/instance/health`, Hermes
  chat SSE, Hindsight search/write, and Camofox tab creation
- surface these checks in the control plane instead of requiring SSH

### Update and Rollback Path

Frequent Joshu updates should move through immutable releases:

- CI builds versioned images and records `imageRef`, `hermesRef`, migration
  notes, and required env schema version on a `Release` row.
- Instance agent receives an `update` command, pulls the new image, starts it,
  waits for health and smoke checks, then acks success.
- If health fails, agent rolls back to the previous image and reports the failed
  release with logs.
- Keep per-instance volumes compatible across releases; when a migration is
  required, make it explicit in release metadata.

### Scaling Model

One VPS per customer scales operationally if the control plane treats instances
as cattle:

- queue provisioning/update/destroy jobs instead of doing long work inside
  Vercel request handlers
- use provider tags/labels for `customerId`, `instanceId`, `releaseVersion`, and
  environment
- automate DNS, registry login, cloud-init reporting, and teardown
- add fleet views for outdated releases, degraded health, missing heartbeats,
  disk pressure, and failed bootstraps
- add regional capacity rules so voice-sensitive customers are provisioned near
  their users and Twilio edge region
- keep instance images small enough that updates are bandwidth- and
  time-predictable across the fleet

### Legacy Modal removal (done)

The repository still contains legacy deploy files and docs:

- `deploy/RELEASE.json`
- `deploy/scripts/vps-start.sh`
- `deploy/.env.vps.example`
- `docs/hitl-camofox-notes.md`
- `docs/vps-sandbox/runtime-topology.md`
- npm scripts such as `build:deploy`, `vps:build-image`, and
  `vps:build-image`

Do not treat these as the production path for new customer sandboxes. Production
should use the VPS control-plane flow, `deploy/`, and the instance agent.

Removed Modal deployment path for:

- historical reference while the VPS image reaches parity
- internal demos if needed
- migration comparison against `deploy/scripts/vps-start.sh`

Recommended cleanup sequence:

1. Rename the shared bundle build step from `build:deploy` to a neutral name
   such as `build:bundles` or `sandbox:prebuild`.
2. Make `vps:predeploy` call that neutral script.
3. Update VPS docs to use VPS naming for production builds.
4. Removed Modal docs as legacy/demo-only.
5. Remove `vps:build-image`, `vps:build-image`, `vps:predeploy`,
   `deploy/.env.vps.example`, and eventually `deploy/RELEASE.json` after at
   least one clean CI image build, push, provision, and update cycle succeeds.
