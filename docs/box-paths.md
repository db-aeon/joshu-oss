# Box filesystem paths

Reference for **where Joshu expects data on disk** — ArozOS user trees, `.joshu` config, Hermes state, and gbrain indexes. Use this when debugging Welcome (`draft path unavailable`), File Brain (`gbrain.ok: false`), or permission issues on a self-hosted box.

For **API keys and env vars without the Welcome wizard**, see [`env-without-wizard.md`](env-without-wizard.md).

---

## Quick checklist (self-host VPS)

After first ArozOS signup, confirm all of these exist:

| Requirement | Path or value |
|-------------|----------------|
| ArozOS data root | `/var/lib/arozos` (default in Docker image) |
| User folder name | **Exact** ArozOS login email (case-sensitive) |
| Desktop | `/var/lib/arozos/files/users/<email>/Desktop/` |
| Opinionated files root | `…/Desktop/joshu's files/` (created by bootstrap) |
| `JOSHU_AROZ_USER` in `instance.env` | Same `<email>` as ArozOS login |
| `.joshu` config dir | `/var/lib/arozos/files/users/<email>/.joshu/` |

```bash
# On the VPS (adjust email)
EMAIL='you@example.com'
ls -la "/var/lib/arozos/files/users/${EMAIL}/Desktop/joshu's files"
grep JOSHU_AROZ_USER /etc/joshu/instance.env
curl -fsS http://127.0.0.1:8788/joshu/api/instance/health | python3 -m json.tool
```

Health should show `components.gbrain.ok: true` once paths resolve and gbrain has indexed.

---

## Path resolution

Joshu resolves the active user Desktop via [`src/joshuFilesPaths.ts`](../src/joshuFilesPaths.ts):

1. Read `AROZ_DATA` (default `/var/lib/arozos` on VPS, `.local/arozos-data` in local dev).
2. Require `$AROZ_DATA/files/users/` to exist.
3. On VPS (`AROZ_DATA=/var/lib/arozos`), **`JOSHU_AROZ_USER` is mandatory** — without it, path resolution returns `null` (by design, so gbrain does not index the wrong user).
4. Pick user directory: `JOSHU_AROZ_USER` when set, otherwise the first non-`admin` user with a `Desktop/` folder (local dev only).
5. Derive `JOSHU_DESKTOP_ROOT` and `JOSHU_FILES_ROOT`.

When resolution fails, these features break:

- Welcome draft save → **`draft path unavailable`**
- File Brain / gbrain MCP
- Hermes `write_file` sandbox roots
- `.joshu/box-secrets/local-env.json` (Welcome Connect AI)

---

## Directory tree

```text
/etc/joshu/
├── instance.env              ← primary box config + secrets (mode 600)
└── secrets/                  ← optional GCP service-account JSON, etc.

/var/lib/arozos/              ← AROZ_DATA (persistent Docker volume on VPS)
├── files/
│   └── users/
│       └── <aroz-login-email>/     ← folder name MUST match login email
│           ├── Desktop/
│           │   ├── joshu's files/  ← JOSHU_FILES_ROOT (agent markdown, Projects/, connectors/)
│           │   │   ├── Projects/
│           │   │   ├── Triage/
│           │   │   ├── connectors/   ← mail/calendar mirrors (after Connectors sync)
│           │   │   └── …
│           │   └── …               ← other Desktop items (also indexed by gbrain)
│           └── .joshu/             ← per-user Joshu config (not on host macOS Desktop)
│               ├── identity.json
│               ├── onboarding.json
│               ├── onboarding.draft.json
│               ├── box-secrets/
│               │   └── local-env.json   ← Welcome Connect AI keys (standalone)
│               ├── nylas/
│               │   ├── agent.json
│               │   └── profile.json
│               └── connectors-registry.json
├── system/                   ← ArozOS system DB (ao.db)
└── web/                      ← themed ArozOS web assets

/root/.hermes/                ← HERMES_HOME (gateway config, skills, cron, sessions)
├── config.yaml
├── .env                      ← synced from instance.env + box-secrets on gateway start
├── skills/
└── cron/

/root/.gbrain/                ← GBRAIN_HOME (PGLite index, gbrain config)
└── joshu-files-paths.env     ← cached resolved paths (debug)
```

**Local dev** uses the same shape under the repo:

```text
.local/arozos-data/files/users/<user>/Desktop/joshu's files/
.local/gbrain/
~/.hermes/
```

Never point Hermes or gbrain at macOS `~/Desktop` — always the ArozOS tree under `AROZ_DATA`.

---

## `.joshu/` files (per ArozOS user)

| File | Purpose |
|------|---------|
| `identity.json` | Companion name, owner display name, avatar/voice hints |
| `onboarding.json` | `{ completed, completedAt }` — Welcome done flag |
| `onboarding.draft.json` | Wizard answers (auto-saved on each Continue) |
| `box-secrets/local-env.json` | Standalone API keys saved from Welcome Connect AI |
| `nylas/profile.json` | Timezone, working hours, urgent channel, emails |
| `nylas/agent.json` | Agent mailbox grant pointer |
| `connectors-registry.json` | Composio / connector sync status mirror |

Implementation: [`src/onboarding/paths.ts`](../src/onboarding/paths.ts), [`src/nylas/paths.ts`](../src/nylas/paths.ts).

---

## Environment variables that select paths

| Variable | Default (VPS) | Role |
|----------|---------------|------|
| `AROZ_DATA` | `/var/lib/arozos` | ArozOS + user file root |
| `JOSHU_AROZ_USER` | *(unset until you set it)* | **Required on VPS** — ArozOS username (owner email) |
| `JOSHU_OWNER_EMAIL` | same as above | Ops alias for owner email in identity |
| `JOSHU_FILES_DIR_NAME` | `joshu's files` | Subfolder under Desktop (quote in bash `.env`) |
| `JOSHU_DESKTOP_ROOT` | *(auto)* | Override Desktop path |
| `JOSHU_FILES_ROOT` | *(auto)* | Override `joshu's files` path |
| `GBRAIN_HOME` | `/root/.gbrain` | gbrain PGLite + config |
| `HERMES_HOME` | `/root/.hermes` | Hermes gateway state |

More gbrain/Hermes path env: [`file-brain.md`](file-brain.md#path-resolution).

---

## Bootstrap and repair

| Script | When |
|--------|------|
| [`scripts/bootstrap-joshu-files.sh`](../scripts/bootstrap-joshu-files.sh) | Boot — creates empty `joshu's files` for `JOSHU_AROZ_USER` or first user |
| [`scripts/rebind-gbrain-owner.sh`](../scripts/rebind-gbrain-owner.sh) | After setting/changing `JOSHU_AROZ_USER` in `instance.env` |
| [`scripts/start-gbrain.sh`](../scripts/start-gbrain.sh) | Boot — writes gbrain `sync.repo_path` + path cache |

**Standalone self-host workflow:**

1. Bootstrap stack (`bootstrap-vps.sh` or `bootstrap-self-host.sh`).
2. Open desktop → **Create your account** (first user).
3. Set in `/etc/joshu/instance.env`:

   ```dotenv
   JOSHU_AROZ_USER=you@example.com
   JOSHU_OWNER_EMAIL=you@example.com
   ```

   Use the **exact** email you registered with.

4. Restart the stack (or run `rebind-gbrain-owner.sh` inside the container).
5. Open Welcome — Continue should save the draft.

Inside Docker:

```bash
docker compose -f /opt/joshu/deploy/docker-compose.yml \
  --env-file /etc/joshu/instance.env exec joshu-stack \
  bash /opt/joshu/scripts/rebind-gbrain-owner.sh
```

---

## Docker volumes (VPS)

Typical compose bind mounts / named volumes:

| Volume | Host / container path | Holds |
|--------|------------------------|-------|
| `joshu_arozos` | → `/var/lib/arozos` | ArozOS users, Desktop, `.joshu` |
| Hermes home | → `/root/.hermes` | Gateway config, sessions, crons |
| gbrain | → `/root/.gbrain` | Search index |

Factory wipe removes personal data — see [`self-host.md`](self-host.md) upgrade section (compose `down -v`).

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Welcome **`draft path unavailable`** | `resolveJoshuFilesPaths()` returned null | Set `JOSHU_AROZ_USER`; complete ArozOS signup; ensure `Desktop/` exists; run bootstrap/rebind |
| Health `gbrain.ok: false` | Same path failure, or gbrain not started | Fix user path; check `curl http://127.0.0.1:8794/health` |
| Files under `admin` user | Wrong user picked before `JOSHU_AROZ_USER` set | Set owner email in `instance.env`, rebind, log in with that email |
| `EACCES` writing `.joshu` | Permissions on ArozOS volume | Ensure stack user owns `/var/lib/arozos/files/users/…` (container runs as root by default) |
| Plus-address email mismatch | Folder is literal `you+tag@domain.com` | `JOSHU_AROZ_USER` must include the `+tag` exactly |

---

## Related docs

- [`env-without-wizard.md`](env-without-wizard.md) — API keys via `instance.env` instead of Welcome
- [`file-brain.md`](file-brain.md) — gbrain layout and indexing
- [`welcome-onboarding.md`](welcome-onboarding.md) — Welcome wizard flow
- [`vps-quickstart.md`](vps-quickstart.md) — first boot and DNS
