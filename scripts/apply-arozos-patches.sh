#!/usr/bin/env bash
# Apply Joshu patches to a checked-out ArozOS source tree (vendor/arozos or clone).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
PATCH_DIR="${ROOT_DIR}/patches/arozos"
AROZOS_DIR="${AROZOS_DIR:-${ROOT_DIR}/vendor/arozos}"

if [[ ! -d "${AROZOS_DIR}/src" ]]; then
  echo "[arozos-patch] missing ArozOS source at ${AROZOS_DIR}/src" >&2
  exit 1
fi

if [[ ! -d "${PATCH_DIR}" ]]; then
  echo "[arozos-patch] no patch directory: ${PATCH_DIR}" >&2
  exit 1
fi

shopt -s nullglob
patches=("${PATCH_DIR}"/*.patch)
if [[ ${#patches[@]} -eq 0 ]]; then
  echo "[arozos-patch] no *.patch files in ${PATCH_DIR}" >&2
  exit 1
fi

(
  cd "${AROZOS_DIR}"
  for patch in "${patches[@]}"; do
    echo "[arozos-patch] applying $(basename "${patch}")"
    if git apply --check "${patch}" 2>/dev/null; then
      git apply "${patch}"
    elif git apply --reverse --check "${patch}" 2>/dev/null; then
      echo "[arozos-patch] already applied: $(basename "${patch}")"
    else
      echo "[arozos-patch] failed to apply ${patch}" >&2
      exit 1
    fi
  done
)

echo "[arozos-patch] done"
