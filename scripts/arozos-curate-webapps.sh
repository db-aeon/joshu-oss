#!/usr/bin/env bash
# Build-time curation: remove stock ArozOS WebApps from the runtime web/ tree.
# Usage: arozos-curate-webapps.sh /path/to/arozos/web
set -euo pipefail

WEB_ROOT="${1:?web root required}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DENYLIST="${SCRIPT_DIR}/lib/arozos-stock-webapps-denylist.txt"

if [[ ! -f "${DENYLIST}" ]]; then
  echo "[arozos-curate] no denylist at ${DENYLIST} — skipping" >&2
  exit 0
fi

while IFS= read -r app || [[ -n "${app}" ]]; do
  app="${app%%#*}"
  app="$(echo "${app}" | xargs)"
  [[ -z "${app}" ]] && continue
  target="${WEB_ROOT}/${app}"
  if [[ -d "${target}" ]]; then
    echo "[arozos-curate] removing stock web app: ${app}"
    rm -rf "${target}"
  fi
done < "${DENYLIST}"

echo "[arozos-curate] done"
