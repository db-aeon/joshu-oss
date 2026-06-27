# Joshu Commercial License — Notice

The Joshu box stack is dual-licensed. Community use is available under
[AGPL-3.0](LICENSE). This file is an **informational notice** about the
commercial license option — **not** the full license text, and **not** an
exhaustive list of rights, restrictions, or use cases.

**To obtain a commercial license**, contact **info@joshu.me**. Terms are
negotiated in a written agreement with Project Aeon Inc.; nothing in this
notice grants commercial rights by itself.

---

## What a commercial license may cover

Executed commercial agreements may grant rights to **copyright owned by
Project Aeon Inc.** in this repository, including (non-exhaustive):

- `src/` — Joshu Express backend and APIs
- `apps/*` — Joshu Vite desktop applications (unless marked otherwise in `joshu.app.json`)
- `arozos/subservice/*` — Joshu subservices
- `deploy/` — deployment tooling
- `patches/arozos/*` — Joshu patches to ArozOS (still subject to GPLv3 when distributed with ArozOS)
- `integrations/hermes/skills/*` — Joshu Hermes skills (subject to Hermes upstream terms)

The commercial license does **not** include the **control plane** (`hello.joshu.me`
provisioning, portal, fleet admin). That software is proprietary and is not
licensed for redistribution.

---

## Critical: ArozOS remains GPLv3

**A commercial license does not exempt you from the GNU General Public License
on ArozOS.**

When you distribute a combined image or binary that includes modified ArozOS
(from `vendor/arozos` + `patches/arozos/`), you must comply with **GPLv3** for
that portion: provide corresponding source, preserve copyright notices, and
honor GPLv3 obligations.

Commercial license value is for **Joshu-owned layers** (closed-source modifications,
enterprise legal comfort, JDL brand pack, support/SLA) — **not** exemption from
upstream GPL on the desktop engine core.

---

## Permitted use without a commercial license (AGPL)

Under AGPL-3.0, **no payment is required** for:

| Use case | Allowed |
|----------|---------|
| Personal hobby / learning | Yes |
| Freelancer or solo operator — **your own** box for **your own** work | Yes |
| Any organization — boxes used **only by employees** (internal tool) | Yes |
| Self-host with Vanilla theme from the public repository | Yes |
| Forking and modifying — if you comply with AGPL (publish changes when required) | Yes |

---

## Common cases that require a commercial license or Joshu managed service

This table is illustrative, not complete. When in doubt, contact **info@joshu.me**.

| Use case | Requirement |
|----------|-------------|
| Offering Joshu boxes as a **product or service to third parties** (managed SaaS, MSP hosting for clients, white-label fleet) | **Commercial OEM/MSP agreement** with Project Aeon Inc., or use **hello.joshu.me** |
| Closed-source modifications of **Joshu-owned** code without AGPL compliance | Commercial license — contact **info@joshu.me** |
| Full **Joshu Design License (JDL)** brand pack (paper-shell, official icons) at scale | Commercial license or official fleet image — contact **info@joshu.me** |
| Implying **official Joshu hosting** without permission | Prohibited — see TRADEMARK.md |

**Internal commercial use** (your company runs boxes for employees only) does
**not** require a commercial license.

---

## Commercial tiers (summary)

Examples only — actual scope and pricing are set in executed agreements.
Contact **info@joshu.me** to discuss options.

| Tier | Buyer | Includes |
|------|-------|----------|
| **Commercial On-Prem** | Enterprise needing non-AGPL terms for Joshu layers | Joshu code on commercial terms; optional JDL; ArozOS still GPL |
| **Commercial OEM / MSP** | Hosts Joshu for third parties or white-labels | OEM addendum + JDL; official partner program |
| **Joshu Managed** | End customers | Proprietary control plane + branded fleet at hello.joshu.me — not sublicensable |

---

## Disclaimer

This notice summarizes product licensing posture for convenience. It is **not**
a legal contract and does **not** replace the AGPL-3.0 text in [LICENSE](LICENSE)
or any executed commercial agreement with Project Aeon Inc. Only a signed
agreement grants commercial rights. Have your counsel review before signing.

For commercial licensing inquiries: **info@joshu.me**
