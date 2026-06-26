# ArozOS Joshu patches

Joshu-specific modifications to upstream [ArozOS](https://github.com/tobychui/arozos).
Applied at build time by [`scripts/apply-arozos-patches.sh`](../../scripts/apply-arozos-patches.sh).

| Patch | Upstream base | Description |
|-------|---------------|-------------|
| `joshu-core.patch` | `8894ffe` | System settings hook, desktop.html splash/overlay fixes, media player |

**License:** These patches are **GPLv3** (derivative of ArozOS). They must ship
with source when you distribute a combined image containing modified ArozOS.

**Upstream pin:** Set `AROZOS_UPSTREAM_REF` in `.env` or CI (default in
`.gitmodules`).
