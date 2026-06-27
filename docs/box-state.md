# Box state (self-host)

Joshu boxes have **factory** defaults (repo seeds) and **personal** state (files, Hermes memory, connectors). Self-hosters manage both via the CLI, HTTP API, or **Settings → Joshu → Box State** in ArozOS.

Managed fleet snapshot wiring (GCS namespaces, control plane env) lives in the private **`joshu`** and **`joshu-control-plane`** repositories — not in this OSS tree.

## CLI

```bash
npm run box -- status
npm run box -- factory-apply          # soft — seed missing templates only
npm run box -- factory-reset --mode hard --confirm
```

## Hard factory reset

Clears personal Desktop files, Hermes user config (`~/.hermes/skills/`, `cron/`, sessions), Hindsight memories, gbrain index contents, and **Composio OAuth connections** (cloud-side disconnect so mail mirrors do not re-sync).

**Does not clear:** product secrets in `.env` / `instance.env`, repo factory seeds, or GCS backups (restore explicitly with `box restore`).

Also available:

- `POST /joshu/api/box/factory-reset` with `{ "mode": "hard", "confirm": true }`
- **Settings → Joshu → Box State** in the ArozOS System Setting app

After hard reset, start a **new jChat** session. Companion persona (`SOUL.md`) is reset to factory defaults from [`factory/manifest.yaml`](../factory/manifest.yaml) unless you set identity fields in `/etc/joshu/instance.env` — see [`self-host.md`](self-host.md).

### Manual connector disconnect (without full reset)

```bash
npx tsx scripts/box-wipe-connectors.ts
```

Requires `COMPOSIO_API_KEY` in the running stack environment.

## Related docs

- [`connectors.md`](connectors.md#hard-factory-reset) — Composio + mail mirrors
- [`welcome-onboarding.md`](welcome-onboarding.md) — Welcome app after reset
- [`file-brain.md`](file-brain.md) — gbrain re-init after wipe
- [`hermes-integration.md`](hermes-integration.md) — Hermes config split

Implementation: [`packages/box-state/`](../packages/box-state/).
