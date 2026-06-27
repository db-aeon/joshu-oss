# Control plane (proprietary)

The Joshu **control plane** — provisioning, customer portal, fleet admin at
`hello.joshu.me` — is **not part of this open-source repository**.

It lives in a separate private repository (`joshu-control-plane`) maintained by
Project Aeon Inc.

## Self-host without the control plane

Use the standalone box stack:

- [Self-host guide](../self-host.md)
- [Local installation](../local-installation.md)
- [Instance agent protocol](instance-agent-protocol.md) — optional; omit in standalone mode

## Managed hosting

For Joshu-managed boxes with zero-touch provisioning, visit [joshu.me](https://joshu.me).

## Fleet operators

If you are a Joshu fleet operator with access to the private control plane repo,
see its `docs/` directory for:

- `control-plane-portal.md`
- `control-plane-local-provisioning.md`
- `zero-touch-provisioning.md`
- `control-plane-schema.md`
