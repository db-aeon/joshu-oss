#!/usr/bin/env bash
# Copy a clean OSS tree for fresh git init (v1.0.0-oss). Does NOT scrub monorepo history.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${1:-${ROOT_DIR}/../joshu-oss}"

echo "[prepare-oss-snapshot] source: ${ROOT_DIR}"
echo "[prepare-oss-snapshot] output: ${OUT_DIR}"

rm -rf "${OUT_DIR}"
mkdir -p "${OUT_DIR}"

rsync -a \
  --exclude .git \
  --exclude node_modules \
  --exclude .next \
  --exclude dist \
  --exclude .local \
  --exclude apps/control-plane \
  --exclude .env \
  --exclude .env.local \
  --exclude '**/.env' \
  --exclude '**/.env.local' \
  --exclude '**/.env.*.local' \
  --exclude aeon-page-to-speech-config.json \
  --exclude vendor \
  "${ROOT_DIR}/" "${OUT_DIR}/"

bash "${ROOT_DIR}/scripts/secret-scan.sh" "${OUT_DIR}"

cat <<EOF

[prepare-oss-snapshot] clean tree ready at ${OUT_DIR}

Next steps:
  cd ${OUT_DIR}
  git init
  git add -A
  git commit -m "Joshu box stack v1.0.0-oss"
  git tag v1.0.0-oss
  git remote add origin git@github.com:your-org/joshu.git
  git push -u origin main --tags

EOF
