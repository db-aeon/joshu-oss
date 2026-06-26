#!/usr/bin/env bash
# Launched by ArozOS with: -port :NNNN -rpt http://localhost:PARENT/api/ajgi/interface
set -euo pipefail
export JOSHU_UPSTREAM="${JOSHU_UPSTREAM:-http://127.0.0.1:8788}"
export JOSHU_UPSTREAM_BASE_PATH="${JOSHU_UPSTREAM_BASE_PATH:-/joshu}"
exec node "${JOSHU_APP_DIR:-/opt/joshu}/scripts/aroz-subproxy.mjs" "$@"
