#!/usr/bin/env bash
# Launched by ArozOS with: -port :NNNN -rpt http://localhost:PARENT/api/ajgi/interface
set -euo pipefail

SUBSERVICE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export AROZ_STATIC_APP_NAME="${AROZ_STATIC_APP_NAME:-joshu-schedules}"
export AROZ_STATIC_DIR="${AROZ_STATIC_DIR:-${SUBSERVICE_DIR}/app}"

exec node "${JOSHU_APP_DIR:-/opt/joshu}/scripts/aroz-static-subservice.mjs" "$@"
