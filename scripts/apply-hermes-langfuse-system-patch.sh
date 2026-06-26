#!/usr/bin/env bash
# Back-compat wrapper — applies all Langfuse Hermes patches (system prompt + user_id).
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec bash "${ROOT_DIR}/scripts/apply-hermes-langfuse-patches.sh"
