# Metered providers (paid MCP) — box side

Fleet boxes use a **prepaid usage wallet** on the control plane for paid vendor MCPs (fal.ai first). Vendor API keys stay on CP; the box only holds an **instance-agent token** and talks to a local MCP relay.

**Managed fleet:** prepaid wallet + CP relay are documented in the private control-plane tree (`joshu-control-plane/docs/metered-providers.md`). Self-hosters use **direct** mode with their own vendor key (below).

This page covers what runs **on the box / laptop**.

## Modes

| Mode | Who | Behavior |
|------|-----|----------|
| `JOSHU_FAL_MODE=relay` | Fleet (default) + local laptop with fleet env | Local `:8797` → CP relay → `mcp.fal.ai` with CP `FAL_KEY`. No `FAL_KEY` on box. |
| `direct` | OSS self-host | User pastes `FAL_KEY` in Connectors; Hermes → fal MCP directly. |
| `off` | Explicit disable | fal MCP not exposed. |

Resolved in [`src/meteredProviders/config.ts`](../src/meteredProviders/config.ts). Fleet bootstrap **strips** `FAL_KEY` even if present in CP env hydration.

## Request path (fleet)

```text
Hermes toolset mcp-fal
  → http://127.0.0.1:8797/mcp   (Streamable HTTP)
  → scripts/lib/metered-mcp-relay.mjs
  → POST {CONTROL_PLANE_URL}/api/instances/providers/fal/mcp
       Authorization: Bearer <JOSHU_INSTANCE_ID>.<INSTANCE_AGENT_TOKEN>
  → CP wallet preflight + fal upstream + debit
```

Start script: [`scripts/start-fal-mcp-relay.sh`](../scripts/start-fal-mcp-relay.sh) (supervised by [`src/mcpSupervisor.ts`](../src/mcpSupervisor.ts)). Health: `GET http://127.0.0.1:8797/health`.

Hermes only enables `mcp-fal` when:

1. User toggle `FAL_MCP_USER_ENABLED` is on (Connectors; default on in relay mode), and
2. Cached CP usage summary has **balanceUsd > 0** (`fetchUsageSummaryFromCp`).

If balance is zero, Connectors still shows the card + top-up link; tools stay off until credit.

## Env (fleet / local relay)

| Variable | Purpose |
|----------|---------|
| `JOSHU_FAL_MODE` | `relay` \| `direct` \| `off` |
| `JOSHU_FAL_RELAY_URL` | CP MCP relay URL |
| `JOSHU_FAL_USAGE_SUMMARY_URL` | CP balance/summary for Connectors + Hermes gate |
| `JOSHU_INSTANCE_ID` / `INSTANCE_AGENT_TOKEN` | Agent Bearer for relay + summary |
| `CONTROL_PLANE_URL` | Fallback to build relay/summary URLs |
| `JOSHU_FAL_MCP_HTTP_URL` | Override local MCP base (default `http://127.0.0.1:8797`) |
| `JOSHU_COMPOSE_ENV_FILE` | Path to provision/relay env (e.g. `.local/instance.env`) |

Provision vars are hydrated into `process.env` at Joshu boot ([`provisionInstanceEnv.ts`](../src/provisionInstanceEnv.ts)) and merged into MCP spawn env so start scripts see them.

OSS-only local file: `connectors-providers.env` in the Joshu state folder (`JOSHU_STATE_DIR`, `/var/lib/arozos/joshu-state` in the image; `.joshu/` of the repository in local development) (`FAL_KEY`, `FAL_MCP_USER_ENABLED`) — managed by Connectors setup API. In **relay** mode Joshu **ignores** any `FAL_KEY` there for Hermes (prevents accidental direct key use / bad keys).

## Connectors UI

- **AI providers** section → fal.ai card: enable/disable, fleet balance, link to portal `/joshu#usage-billing`.
- APIs: `GET/POST /joshu/api/connectors/providers`, `…/providers/:id/setup` (OSS key only), `…/providers/:id/status`.
- See [connectors-arozos-app.md](connectors-arozos-app.md#api-metered-providers).

## Local laptop = fleet relay (managed)

Mint env against production CP (no local CP required):

```bash
cd ../joshu-control-plane/apps/control-plane
npx tsx scripts/issue-local-dev-relay-env.ts <slug>   # --credit-usd defaults to 0
```

**Warning:** this script **rotates** the instance `agentTokenHash` in the control plane and writes a new `INSTANCE_AGENT_TOKEN` to the laptop path (e.g. `joshu/.local/instance.env`). Any **live box** for that slug still holding the old token will 401 on heartbeat, usage relay, and Langfuse ingest until `/etc/joshu/instance.env` is updated and `instance-agent` / `joshu-stack` recreated. Prefer a dedicated local-dev instance slug when possible.

Then in joshu `.env`:

```bash
JOSHU_COMPOSE_ENV_FILE=/absolute/path/to/joshu/.local/instance.env
```

Restart `npm run dev:arozos`. Self-hosters skip this and use **direct** mode + Connectors **Setup** instead.

## Security notes (box)

- Self-hosters who set `JOSHU_FAL_MODE=relay` **cannot** spend managed fal without a real instance agent token on the control plane.
- Disconnecting Composio / wiping Desktop does **not** affect a managed usage wallet (wallet is CP-side, customer-scoped).
- Rejected bad direct `FAL_KEY` values (401/403 from fal) should not be written when toggling providers — see Connectors metered provider routes.

## Code map (joshu)

| Area | Path |
|------|------|
| Provider config / modes | `src/meteredProviders/config.ts` |
| Connectors REST | `src/connectors/meteredProviderRoutes.ts` |
| Connectors UI | `apps/connectors/` (AI providers / fal card) |
| Local relay | `scripts/lib/metered-mcp-relay.mjs` |
| Start script | `scripts/start-fal-mcp-relay.sh` |
| Supervisor | `src/mcpSupervisor.ts` |
| Hermes toolset sync | `src/hermesApi.ts` (fal MCP apply) |
| Provision hydrate | `src/provisionInstanceEnv.ts` |

## Related

- Managed fleet wallet / Stripe / CP relay: private `joshu-control-plane` docs (`metered-providers.md`)
- [connectors.md](connectors.md) — fal bullet under MCP
- [connectors-arozos-app.md](connectors-arozos-app.md)
- [local-installation.md](local-installation.md)
