# Third-Party Software

The Joshu box stack combines Joshu-owned code with upstream and vendored
dependencies. This document lists major components and their licenses.

---

## ArozOS (desktop engine)

| | |
|--|--|
| **Upstream** | [tobychui/arozos](https://github.com/tobychui/arozos) |
| **License** | GNU General Public License v3.0 |
| **In this repo** | `vendor/arozos` (git submodule, pinned ref) |
| **Joshu changes** | `patches/arozos/*.patch` — must ship with source per GPLv3 |

Joshu patches cover splash behavior, media player fixes, System Settings hooks,
and related web shell adjustments (~280 lines across 8 files).

**You cannot relicense ArozOS under Joshu Commercial License terms.**

---

## Hermes Agent

| | |
|--|--|
| **Upstream** | [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) |
| **Pin** | See `hermesRef` in `deploy/RELEASE.json` |
| **Joshu changes** | `scripts/hermes-*.patch`, applied by `scripts/apply-hermes-*.sh` |

See [hermes-integration.md](hermes-integration.md) for the patch inventory.

---

## Excalidraw (jWhiteboard)

| | |
|--|--|
| **Fork** | [db-aeon/excalidraw](https://github.com/db-aeon/excalidraw) branch `joshu-markdown-wysiwyg` |
| **In this repo** | `vendor/excalidraw` submodule |
| **License** | MIT (upstream Excalidraw) + fork modifications |

See [excalidraw-sandbox.md](excalidraw-sandbox.md).

---

## npm dependencies

Runtime and build dependencies are listed in `package.json` with their
respective licenses (MIT, Apache-2.0, etc.). Run `npx license-checker --summary`
before release for a full report.

---

## patch-package

| | |
|--|--|
| **Patch** | `patches/http-proxy+1.18.1.patch` |
| **Reason** | Removes deprecated `util._extend` noise from http-proxy 1.18.1 |

Applied automatically via `npm run prepare`.

---

## Design assets

| Asset | License |
|-------|---------|
| **Vanilla Box Stack** (`arozos/web-overlays-vanilla/`) | AGPL (functional, unbranded) |
| **Joshu brand pack** (paper-shell, icons) | **JDL** — private `joshu-design` repo; not in public OSS tree |
| **Tango PNG library** | Public domain |

---

## Control plane (not included)

Provisioning, portal, and fleet admin (`hello.joshu.me`) are **proprietary**
and are **not** distributed in this repository.
