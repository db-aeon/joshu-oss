#!/usr/bin/env bash
# Proactive Joshu hourly tick — calls Joshu REST (no Hermes agent, no LLM tokens).
set -euo pipefail

PORT="${JOSHU_API_PORT:-8788}"
BASE="${JOSHU_API_BASE:-http://127.0.0.1:${PORT}/joshu}"

curl -sf -X POST "${BASE}/api/proactive/tick" \
  -H "Content-Type: application/json" \
  -d '{}' \
  || exit 1
