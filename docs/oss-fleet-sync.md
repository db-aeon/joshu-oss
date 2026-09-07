# OSS ↔ fleet sync

How the public **[joshu-oss](https://github.com/db-aeon/joshu-oss)** tree and this private **joshu** fleet repo stay aligned.

## Two repos, one AGPL surface

| Repo | Role |
|------|------|
| **joshu-oss** | **Canonical AGPL** — community PRs, self-host image (`joshu-oss`), public docs |
| **joshu** (this repo) | **Fleet superset** — AGPL copy + `proprietary/`, `vendor/`, `docs/`, branded design pack |

**Rule:** Shared engine, deploy scripts, vanilla overlays, and generic docs are edited in **joshu-oss** first. Fleet picks them up with [`scripts/sync-from-oss.sh`](../scripts/sync-from-oss.sh).

Fleet-only work stays here: `proprietary/`, `vendor/arozos`, `arozos/web-overlays-vanilla/` (paper shell), `docs/`, control-plane integration, learning-loop scripts.

## Why `git merge` does not work

`joshu-oss` was created from fleet via [`scripts/prepare-oss-snapshot.sh`](../scripts/prepare-oss-snapshot.sh) with a **fresh git history** (rsync + new `git init`). The repos have **no common ancestor**.

Running `git merge oss/main` fails with:

```text
fatal: refusing to merge unrelated histories
```

**Fix (2026-06-30):** [`scripts/sync-from-oss.sh`](../scripts/sync-from-oss.sh) extracts `oss/main` with `git archive` and **rsyncs** into fleet — the inverse of `prepare-oss-snapshot.sh`, preserving fleet-only paths.

## Day-to-day workflow

```bash
# 1. Land AGPL change in joshu-oss (PR → main)
cd ../joshu-oss && git pull

# 2. Pull into fleet
cd ../joshu
bash scripts/sync-from-oss.sh        # apply file updates
git status && git diff               # review
git commit -am "Sync OSS main (<short-sha>)"
git push origin main

# 3. Fleet-only follow-ups (if any)
#    proprietary/, vendor patches, Joshu-SOP, image build
```

**Dry-run / CI:** `bash scripts/sync-from-oss.sh --check` exits non-zero when fleet AGPL files differ from `oss/main` (rsync itemize, not commit counts).

**Traceability:** A successful apply writes [`.oss-sync-ref`](../.oss-sync-ref) with the full `oss/main` SHA (safe to commit).

### `oss` remote

The script adds `oss` → `https://github.com/db-aeon/joshu-oss.git` if missing, then `git fetch oss main`.

## What sync updates vs preserves

**Updated from OSS** (non-exhaustive): `arozos/web-overlays-vanilla/`, `deploy/`, `patches/`, most `scripts/`, AGPL `apps/`, `packages/`, engine `src/` paths that ship in OSS.

**Never overwritten** (fleet-only):

| Path | Reason |
|------|--------|
| `proprietary/` | Paid apps, fleet ops |
| `vendor/` | ArozOS submodule |
| `arozos/web-overlays-vanilla/` | Branded paper shell (`JOSHU_DESIGN_PACK`) |
| `docs/` | **Fleet canon** — OSS gets a sanitized export via `prepare-oss-snapshot.sh` + `oss-doc-sanitize.sh`; pulling OSS docs back would strip control-plane, fleet, and SOP references |
| `README.md`, `CONTRIBUTING.md`, `*.oss.md` | Fleet vs OSS curated copies |
| `scripts/prepare-oss-snapshot.sh`, `oss-doc-sanitize.sh`, `publish-oss-release.sh`, `check-oss-boundaries.sh` | OSS export pipeline — assumes fleet `docs/vps-sandbox/` layout |
| `.github/workflows/joshu-oss-image.yml`, `oss-boundaries.yml` | OSS CI (fleet uses `joshu-sandbox-image.yml`) |
| `scripts/sync-from-oss.sh` | Fleet-only (stripped from OSS snapshot) |
| `.github/workflows/fleet-sync-check.yml`, `joshu-sandbox-image.yml` | Fleet CI |

### Docs: one-way export, not rsync back

| Direction | Tool | What happens |
|-----------|------|----------------|
| Fleet → OSS | `prepare-oss-snapshot.sh` + `oss-doc-sanitize.sh` | Full fleet docs are copied, fleet-only trees removed, links/paths rewritten for self-host |
| OSS → Fleet | **not synced** | `sync-from-oss.sh` excludes `docs/` entirely |

**Editing docs:** change fleet `docs/` (or `*.oss.md` indexes) here, then publish to OSS with `prepare-oss-snapshot.sh`. Community PRs that land only in **joshu-oss** need a **manual backport** of substantive edits into fleet canon — do not blind-rsync OSS docs into fleet.

**Local image / code updates:** `bash scripts/sync-from-oss.sh` is safe for code and deploy pins; fleet docs stay untouched.

Full exclude list: [`scripts/sync-from-oss.sh`](../scripts/sync-from-oss.sh).

## Legacy: fleet → OSS export

Prefer developing in **joshu-oss** directly. When bulk-exporting from fleet is still needed:

```bash
bash scripts/prepare-oss-snapshot.sh ../joshu-oss   # rsync fleet → OSS clone
bash scripts/oss-doc-sanitize.sh <oss-tree>         # (called by prepare)
# commit + push in joshu-oss
```

[`scripts/publish-oss-release.sh`](../scripts/publish-oss-release.sh) wraps `prepare-oss-snapshot.sh` + boundary checks.

## ArozOS branding at runtime

Vanilla self-host and fleet **without** a design pack use `arozos/web-overlays-vanilla/` applied by [`scripts/apply_arozos_joshu_theme.py`](../scripts/apply_arozos_joshu_theme.py):

| Area | Mechanism |
|------|-----------|
| Login / first account | Overlay `login.html`, `user.html`, `joshu-auth-pages.css` |
| Desktop favicon | `arozos/icons/icon.svg` (from [`joshu-public/app/icon.svg`](https://github.com/db-aeon/joshu-public)) → `img/public/joshu-icon.svg` |
| System Settings | Wordmark sidebar, About/Overview HTML, **Joshu** tab under About, Vendor tab hidden, `en-us` locale alias |
| VPS hot refresh | Image-baked `vps-start.sh` (`.image/scripts`) re-runs theme apply; `web-overlays-vanilla/` still host-mounted |

**Gotcha:** `applocale` uses `navigator.language.toLowerCase()` → `en-us`, but stock ArozOS locale files only define `en-US`. Theme apply merges a Joshu overlay and mirrors `en-US` → `en-us`.

**Gotcha:** System Settings caches `index.html` / locale JSON — close the settings window entirely and hard-refresh the desktop after deploy.

Details: [`design/README.md`](design/README.md), self-host [Hetzner quickstart](vps-sandbox/hetzner-quickstart.md) (OSS path: `joshu-oss/docs/vps-sandbox/hetzner-quickstart.md`).

## Images: fleet vs OSS

| | Fleet | OSS self-host |
|---|--------|----------------|
| Image | `ghcr.io/db-aeon/joshu-sandbox:<tag>` | `ghcr.io/db-aeon/joshu-oss:<tag>` |
| Built from | This repo + `proprietary/` + design pack | `joshu-oss` only |

Shared deploy fixes: **OSS first**, then `sync-from-oss.sh`, then fleet image build if needed.

## Related

- [`README.md`](../README.md) — fleet workflow summary
- [`CONTRIBUTING.md`](../CONTRIBUTING.md) — where to open PRs
- [`proprietary/README.md`](../proprietary/README.md) — fleet-only layer
- [Session 2026-06-30 — image 0.1.30](vps-sandbox/session-2026-06-30-fleet-image-0.1.30-patrick.md) — bootstrap / Camofox lessons
