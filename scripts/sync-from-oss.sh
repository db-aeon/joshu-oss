#!/usr/bin/env bash
# Merge canonical AGPL tree from joshu-oss into this fleet superset repo.
# Usage:
#   bash scripts/sync-from-oss.sh          # fetch + merge oss/main
#   bash scripts/sync-from-oss.sh --check  # fail if behind oss/main
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

OSS_REMOTE="${JOSHU_OSS_REMOTE:-oss}"
OSS_BRANCH="${JOSHU_OSS_BRANCH:-main}"
CHECK_ONLY=0
if [[ "${1:-}" == "--check" ]]; then
  CHECK_ONLY=1
fi

if ! git remote get-url "${OSS_REMOTE}" >/dev/null 2>&1; then
  echo "[sync-from-oss] adding remote ${OSS_REMOTE} → https://github.com/db-aeon/joshu-oss.git"
  git remote add "${OSS_REMOTE}" "https://github.com/db-aeon/joshu-oss.git"
fi

echo "[sync-from-oss] fetching ${OSS_REMOTE}/${OSS_BRANCH}"
git fetch "${OSS_REMOTE}" "${OSS_BRANCH}"

BEHIND="$(git rev-list --count "HEAD..${OSS_REMOTE}/${OSS_BRANCH}" 2>/dev/null || echo 0)"
if [[ "${BEHIND}" -eq 0 ]]; then
  echo "[sync-from-oss] fleet main is up to date with ${OSS_REMOTE}/${OSS_BRANCH}"
  exit 0
fi

if [[ "${CHECK_ONLY}" -eq 1 ]]; then
  echo "[sync-from-oss] FAIL: fleet is ${BEHIND} commit(s) behind ${OSS_REMOTE}/${OSS_BRANCH}" >&2
  exit 1
fi

echo "[sync-from-oss] merging ${OSS_REMOTE}/${OSS_BRANCH} (${BEHIND} new commit(s))"
git merge --no-edit "${OSS_REMOTE}/${OSS_BRANCH}"
echo "[sync-from-oss] merge complete — resolve conflicts in fleet-only paths if any (proprietary/, docs/Joshu-SOP/, vendor/)"
