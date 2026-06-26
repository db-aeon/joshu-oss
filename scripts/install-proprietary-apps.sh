#!/usr/bin/env bash
# Copy proprietary ArozOS subservices into a runtime or template tree.
# Used by dev:arozos and fleet Docker builds — skipped when proprietary/ is empty.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="${ROOT_DIR}/proprietary/arozos/subservice"
TARGET="${1:-${ROOT_DIR}/arozos/subservice}"

if [[ ! -d "${SRC}" ]]; then
  exit 0
fi

shopt -s nullglob
entries=("${SRC}"/*)
if [[ ${#entries[@]} -eq 0 ]]; then
  exit 0
fi

for app_dir in "${entries[@]}"; do
  [[ -d "${app_dir}" ]] || continue
  id="$(basename "${app_dir}")"
  if [[ "${id}" == ".gitkeep" ]]; then
    continue
  fi
  echo "[proprietary-apps] installing ${id} -> ${TARGET}/${id}"
  mkdir -p "${TARGET}/${id}"
  rsync -a "${app_dir}/" "${TARGET}/${id}/"
  if [[ -f "${TARGET}/${id}/start.sh" ]]; then
    chmod +x "${TARGET}/${id}/start.sh"
  fi
done

echo "[proprietary-apps] done"
