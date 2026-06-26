#!/usr/bin/env bash
# Checkout vendor/arozos at the pinned upstream commit before applying patches.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REF_FILE="${ROOT_DIR}/patches/arozos/UPSTREAM_REF"
AROZOS_DIR="${ROOT_DIR}/vendor/arozos"

REF="$(grep -E '^AROZOS_UPSTREAM_REF=' "${REF_FILE}" | cut -d= -f2- | tr -d '[:space:]')"
if [[ -z "${REF}" ]]; then
  echo "[pin-arozos] missing AROZOS_UPSTREAM_REF in ${REF_FILE}" >&2
  exit 1
fi

if [[ ! -d "${AROZOS_DIR}/.git" ]]; then
  echo "[pin-arozos] init submodule: git submodule update --init vendor/arozos" >&2
  exit 1
fi

(
  cd "${AROZOS_DIR}"
  git fetch origin --tags 2>/dev/null || git fetch upstream --tags 2>/dev/null || true
  git checkout "${REF}"
)

echo "[pin-arozos] vendor/arozos at ${REF}"
bash "${ROOT_DIR}/scripts/apply-arozos-patches.sh"
