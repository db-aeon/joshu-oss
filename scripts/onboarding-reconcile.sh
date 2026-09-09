#!/usr/bin/env bash
# Daily onboarding reconcile — runs in-process (no Joshu HTTP).
set -euo pipefail

ROOT="${1:-${JOSHU_PROJECT_ROOT:-/opt/joshu}}"
cd "$ROOT"
if [[ -f "$ROOT/dist/onboarding/reconcileOnboardingBoard.js" ]]; then
  exec node scripts/run-onboarding-reconcile.mjs
fi
exec npx tsx scripts/run-onboarding-reconcile.mjs
