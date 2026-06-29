# Contributing to Joshu (open source)

Thank you for contributing to the Joshu open-source box stack.

**This repository (`joshu-oss`) is canonical for AGPL code.** Open pull requests here — not in the private fleet monorepo.

---

## Contributor License Agreement (CLA)

Joshu is dual-licensed (AGPL-3.0 + commercial). By submitting a pull request,
you agree that your contributions may be used under **both** licenses.

1. Open a pull request on **this repository** (`db-aeon/joshu-oss`).
2. The **CLA Assistant** bot will prompt you to sign the CLA (one-time per GitHub account).
3. We cannot merge external contributions without a signed CLA.

See [CLA.md](CLA.md) for the full text.

**Maintainers:** branch protection on `main` must require status checks **`check`**
(oss-boundaries) and **`cla`** (CLA signature) before merge. Org members with
write access are exempt from the CLA check; outside contributors are not.

---

## Development setup

- Local box stack: [docs/local-installation.md](docs/local-installation.md)
- ArozOS parity: `npm run dev:arozos`
- Self-host Docker: [docs/self-host.md](docs/self-host.md)
- Boundary check: `npm run check:oss-boundaries`

---

## Scope

This repository is the **AGPL box stack**. The control plane (`hello.joshu.me`)
and fleet-only operator scripts live in **private** repositories and are not
accepting public contributions.

Do not hardcode fleet customer names or emails in skills, docs, or factory defaults —
use generic owner/companion language and runtime identity (`identity.json`, env).

---

## Code style

Match surrounding code. Keep diffs focused.

## Multi-root workspace (Cursor)

When both `joshu-oss/` and `joshu/` are open:

- Edit **AGPL** files in `joshu-oss/`
- Edit **fleet-only** files in `joshu/proprietary/` and `joshu/docs/Joshu-SOP/`
- After OSS releases, fleet maintainers run `bash scripts/sync-from-oss.sh` in the private repo

---

## Security

Do not commit secrets. Report security issues to info@joshu.me rather than
opening public issues for sensitive findings.
