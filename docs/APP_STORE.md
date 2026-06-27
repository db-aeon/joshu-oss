# Joshu App Store — Architecture & Policy (Draft)

This document describes how **desktop apps** are distributed on Joshu boxes: open
source defaults, first-party proprietary fleet apps, third-party publishers, and
(future) a signed catalog with free and paid offerings.

It is a **product and legal outline**, not a contract. Engine licensing remains
[AGPL-3.0](../LICENSE) / [COMMERCIAL_LICENSE.md](../COMMERCIAL_LICENSE.md).
Third-party apps are licensed **by their publisher** under the terms declared in
`joshu.app.json`.

Contact Project Aeon Inc.: **info@joshu.me** (catalog, OEM, publisher onboarding).

---

## Goals

1. **Self-hosters** can run the OSS engine and install apps manually (sideload).
2. **Project Aeon** can ship AGPL default apps in [joshu-oss](https://github.com/db-aeon/joshu-oss) and proprietary apps via [`proprietary/`](../proprietary/README.md).
3. **Third-party developers** can ship **free or paid** apps without open-sourcing them, when distributed as separate installable bundles (not merged into AGPL engine source).
4. **Managed fleet** (`hello.joshu.me`) can offer a curated catalog, payments, and entitlements — control plane stays proprietary and out of the OSS snapshot.

Naming and brand rules: [TRADEMARK.md](../TRADEMARK.md).

---

## What counts as a “Joshu app”

A Joshu app is an **ArozOS subservice** plus a **Joshu manifest**:

```text
arozos/subservice/<id>/
  moduleInfo.json     # ArozOS registry (name, icon, window size)
  joshu.app.json      # License, publisher, entry, API prefix
  start.sh            # Launcher (required for script-based apps)
  .startscript        # Marker so ArozOS runs start.sh (static apps)
  app/                # Built UI (static bundle) — optional for binary-only apps
  bin/                # Optional native binary (publisher-provided)
```

See [app-sdk.md](app-sdk.md) for the default Vite/static pipeline.

Apps appear on the ArozOS desktop via `.shortcut` files installed by
`scripts/lib/arozos-desktop-shortcuts.sh` (OSS/fleet) or the sideload installer
(planned).

---

## Distribution tiers

| Tier | Who | Where it lives | OSS snapshot | Typical license |
|------|-----|----------------|--------------|-----------------|
| **Built-in OSS** | Project Aeon + community | `apps/` + `arozos/subservice/` | Yes (`joshu-oss`) | `AGPL-3.0` |
| **First-party fleet** | Project Aeon | `proprietary/arozos/subservice/` | No | `proprietary` |
| **Third-party sideload** | Any publisher | User drops bundle on box | N/A | Publisher choice |
| **Official catalog** (future) | Project Aeon + approved publishers | Control plane + signed CDN | Catalog metadata only | Per listing |

Fleet Docker images today: OSS engine + [`install-proprietary-apps.sh`](../scripts/install-proprietary-apps.sh) + optional JDL brand pack.

---

## Can publishers ship binaries? (Yes)

Joshu apps run as **separate ArozOS subservices** — typically a child process, not
code linked into AGPL `src/`. Publishers may ship:

| Packaging | Closed source OK? | Notes |
|-----------|-------------------|--------|
| **Static UI** (`app/` + `aroz-static-subservice.mjs`) | Yes | Minified/bundled JS is normal; source not required in bundle |
| **Native binary** in `bin/` launched from `start.sh` | Yes | Same pattern as many desktop “app store” apps |
| **Sidecar HTTP service** (separate port, proxied) | Yes | Keep proprietary logic out of AGPL `src/` |
| **Patches to Joshu Express** (`src/`) shipped in OSS tree | No* | *Becomes AGPL if distributed in `joshu-oss`; use commercial license or keep private fork |

**Do not** put closed-source logic in the public monorepo paths that feed
`joshu-oss` unless you intend to license it as AGPL or under a separate
commercial grant.

### Example `start.sh` (binary app)

```bash
#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
exec "${DIR}/bin/my-app-linux-amd64" "$@"
```

ArozOS may also launch a native binary named `<id>_<os>_<arch>` when `.startscript`
is absent — prefer explicit `start.sh` for clarity.

---

## `.joshu-app` bundle format (planned)

Phase 2 install unit — a zip or tar archive installed by `scripts/install-joshu-app.sh` (planned):

```text
my-app-1.2.0.joshu-app/
  manifest.json          # copy of joshu.app.json + bundle metadata
  subservice/            # tree merged into arozos/subservice/<id>/
  signature.ed25519      # optional: publisher signature over manifest + file hashes
  publisher.pem          # optional: embedded public key for offline verify
```

**Install flow (self-host):**

1. User or admin copies `.joshu-app` to the box.
2. `install-joshu-app.sh my-app-1.2.0.joshu-app` verifies hash/signature (when enabled), extracts to runtime subservice dir, refreshes desktop shortcut.
3. Joshu/ArozOS restart or subservice refresh picks up the app.

Managed fleet may pull the same bundle from the control plane when entitlement checks pass.

---

## `joshu.app.json` — current and extended fields

Canonical schema: [`joshu.app.schema.json`](joshu.app.schema.json).

### Required today

| Field | Purpose |
|-------|---------|
| `id` | Stable slug (`hermes-chat`) |
| `name` | Desktop label (`jChat`) |
| `version` | Semver |
| `license` | `AGPL-3.0` \| `MIT` \| `proprietary` |
| `publisher` | Display publisher id (`joshu`, `acme-corp`) |
| `entry` | HTML entry path under subservice |

### Optional today

| Field | Purpose |
|-------|---------|
| `apiPrefix` | Joshu API mount (`/joshu/api/...`) when UI calls Express backend |
| `description` | Catalog / about text |

### Phase 2 (catalog / store — optional in manifest)

| Field | Purpose |
|-------|---------|
| `publisherId` | Stable publisher account id (catalog FK) |
| `publisherUrl` | Support or product page |
| `pricing.model` | `free` \| `paid` \| `subscription` |
| `pricing.sku` | Store SKU / Stripe price id |
| `runtime` | `static` \| `binary` \| `proxy` |
| `minJoshuVersion` | Minimum box stack semver |
| `bundleSha256` | Integrity check for sideload |
| `copyright` | `Copyright (c) …` line for About screen |

Example proprietary fleet app (today):

```json
{
  "id": "my-paid-app",
  "name": "My App",
  "version": "0.1.0",
  "license": "proprietary",
  "publisher": "project-aeon",
  "entry": "my-paid-app/index.html",
  "apiPrefix": "/joshu/api/my-paid-app",
  "runtime": "static",
  "pricing": { "model": "paid", "sku": "my-paid-app-monthly" },
  "copyright": "Copyright (c) Project Aeon Inc."
}
```

---

## Free vs paid

| Model | Self-host OSS | Managed fleet |
|-------|---------------|---------------|
| **Free OSS app** | Ship source in `joshu-oss`; bundle optional | Preinstalled in image |
| **Free third-party** | Sideload `.joshu-app`; publisher license applies | Catalog listing; no payment |
| **Paid first-party** | Not in OSS; fleet/proprietary or sideload with license key | CP entitlement + Stripe |
| **Paid third-party** | Sideload + publisher license key (honor system or local key file) | CP rev-share; entitlement on box |

**Engine** (Joshu + default apps in OSS) stays free under AGPL for self-host use.
**Payment** is for apps, support, hosting, JDL brand pack, and commercial engine
terms — see [COMMERCIAL_LICENSE.md](../COMMERCIAL_LICENSE.md) (notice only).

---

## Legal boundaries (summary)

| Component | Owner | Typical license | In `joshu-oss`? |
|-----------|-------|-----------------|-----------------|
| Box engine (`src/`, default `apps/`) | Project Aeon Inc. | AGPL-3.0 OR commercial | Yes (AGPL snapshot) |
| ArozOS (`vendor/arozos` + patches) | Upstream + patches | GPLv3 | Yes (source/patches) |
| First-party proprietary apps | Project Aeon Inc. | Proprietary | No |
| Third-party apps | Publisher | Publisher’s choice | No (unless OSS author submits PR) |
| Brand (JDL) | Project Aeon Inc. | JDL | No |
| Control plane / catalog | Project Aeon Inc. | Proprietary | No |

**Trademark:** Publishers may say *“for Joshu”* or *“runs on Joshu boxes”*;
they may not imply **official** Project Aeon affiliation without agreement.
See [TRADEMARK.md](../TRADEMARK.md).

**Disclaimer (show in future store UI):** Listing in an official catalog does not
transfer copyright; apps are provided by the named publisher under the declared
license. Project Aeon Inc. is not responsible for third-party app behavior except
as stated in a publisher agreement.

---

## Publisher agreement (outline — not legal text)

When opening the catalog to third parties, a written **Joshu Publisher Agreement**
should cover at least:

1. **Grant** — Publisher retains IP; grants Project Aeon a distribution license for catalog/hosting.
2. **License to users** — EULA or open license named in `joshu.app.json`; refunds/support responsibility.
3. **Trademark** — No confusing use of Joshu marks; accurate “published by” attribution.
4. **Security** — No malware; vulnerability disclosure; right to revoke signed bundles.
5. **Payments** — Revenue share, chargebacks, tax (Stripe Connect or similar).
6. **Privacy** — What data the app may access on a box (filesystem, mail, connectors).
7. **AGPL boundary** — Publisher will not distribute proprietary code as part of the OSS engine repo without a separate license.

Until that agreement exists, third-party distribution is **sideload at your own risk** on self-host; fleet catalog is **Project Aeon first-party only**.

---

## Security (Phase 2)

| Control | Self-host | Managed fleet |
|---------|-----------|---------------|
| SHA-256 of bundle | Recommended | Required |
| Ed25519 publisher signature | Optional | Required for catalog |
| TLS download | Recommended | Required |
| Entitlement check | Optional license file | CP → instance-agent |
| Manual review | User responsibility | Project Aeon review before listing |

---

## Roadmap

| Phase | Deliverable | Status |
|-------|-------------|--------|
| **0** | OSS apps + `joshu.app.json` + proprietary fleet folder | **Done** |
| **1** | `install-joshu-app.sh` sideload + docs | Planned |
| **2** | `.joshu-app` bundle + hash verify + extended manifest | Planned |
| **3** | Publisher keys + signed catalog in control plane | Planned |
| **4** | Paid entitlements + Stripe on managed boxes | Planned |

---

## Related

- [app-sdk.md](app-sdk.md) — build pipeline and manifest basics
- [proprietary/README.md](../proprietary/README.md) — first-party closed apps
- [COMMERCIAL_LICENSE.md](../COMMERCIAL_LICENSE.md) — engine commercial terms (notice)
- [TRADEMARK.md](../TRADEMARK.md) — naming and wordmark
- [THIRD_PARTY.md](THIRD_PARTY.md) — engine dependencies (not app catalog)
- [control-plane.md](vps-sandbox/control-plane.md) — managed catalog (proprietary)
