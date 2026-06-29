#!/usr/bin/env bash
# Publish OSS release — legacy one-way snapshot (pre-OSS-canonical flip).
# Prefer: develop in joshu-oss, merge into fleet via scripts/sync-from-oss.sh.
# This script remains for occasional bulk refresh until fully retired.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${1:-${ROOT_DIR}/../joshu-oss}"

bash "${ROOT_DIR}/scripts/check-oss-boundaries.sh"
bash "${ROOT_DIR}/scripts/prepare-oss-snapshot.sh" "${OUT_DIR}"

echo "[publish-oss-release] verify:"
echo "  - npm run check:oss-boundaries passed"
echo "  - LICENSE, COMMERCIAL_LICENSE.md, TRADEMARK.md, NOTICE present"
echo "  - docs/THIRD_PARTY.md complete"
echo "  - CLA Assistant workflow enabled on GitHub"
echo "  - Push joshu-oss and tag v*-oss for image build"
