# Contributing to Joshu

Thank you for contributing to the Joshu open-source box stack.

---

## Contributor License Agreement (CLA)

Joshu is dual-licensed (AGPL-3.0 + commercial). By submitting a pull request,
you agree that your contributions may be used under **both** licenses.

1. Open a pull request on GitHub.
2. The **CLA Assistant** bot will prompt you to sign the CLA (one-time per GitHub account).
3. We cannot merge external contributions without a signed CLA.

See [CLA.md](CLA.md) for the full text.

---

## Development setup

- Local box stack: [docs/local-installation.md](docs/local-installation.md)
- ArozOS parity: `npm run dev:arozos`
- Self-host Docker: [docs/self-host.md](docs/self-host.md)

---

## Scope

This repository is the **box stack only**. The control plane (hello.joshu.me)
is maintained in a separate private repository and is not accepting public
contributions.

---

## Code style

Match surrounding code. Keep diffs focused. See project `.cursorrules` and
[docs/design/brand-guidelines.md](docs/design/brand-guidelines.md) for product
context (brand assets in private `joshu-design` for official builds).

---

## Security

Do not commit secrets. Report security issues to security@joshu.me (or your
designated contact) rather than opening public issues for sensitive findings.
