#!/usr/bin/env bash
# Pull portal companion profile + quiz from control-plane Supabase into local ArozOS user data.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EMAIL="${1:-db@project-aeon.com}"

ENV_FILE="${ROOT_DIR}/apps/control-plane/.env.local"
if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Missing ${ENV_FILE} — need DATABASE_URL for hello.joshu Supabase." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "${ENV_FILE}"
set +a

export AROZ_DATA="${AROZ_DATA:-${ROOT_DIR}/.local/arozos-data}"
export HERMES_HOME="${HERMES_HOME:-${HOME}/.hermes}"

cd "${ROOT_DIR}"
exec npx tsx scripts/sync-local-portal-profile.ts "${EMAIL}"
