#!/usr/bin/env bash
# Publish checklist wrapper — prepares snapshot and prints release steps.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${1:-${ROOT_DIR}/../joshu-oss}"

bash "${ROOT_DIR}/scripts/prepare-oss-snapshot.sh" "${OUT_DIR}"

echo "[publish-oss-release] verify:"
echo "  - LICENSE, COMMERCIAL_LICENSE.md, TRADEMARK.md, NOTICE present"
echo "  - docs/THIRD_PARTY.md complete"
echo "  - CLA Assistant workflow enabled on GitHub"
echo "  - Counsel reviewed commercial terms"
echo "  - Push triggers joshu-oss-image workflow on tag v*"
