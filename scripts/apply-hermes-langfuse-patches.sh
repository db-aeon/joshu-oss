#!/usr/bin/env bash
# Apply Joshu Langfuse patches to the Hermes observability/langfuse plugin (idempotent).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HERMES_DIR="${HERMES_DIR:-/opt/hermes-agent}"
LANGFUSE_PLUGIN="${HERMES_DIR}/plugins/observability/langfuse/__init__.py"

if [[ ! -f "${LANGFUSE_PLUGIN}" ]]; then
  echo "[hermes-langfuse-patch] skip: ${LANGFUSE_PLUGIN} not found"
  exit 0
fi

apply_patch() {
  local label="$1"
  local patch_file="$2"
  local already_marker="$3"

  if rg -q "${already_marker}" "${LANGFUSE_PLUGIN}" 2>/dev/null; then
    echo "[hermes-langfuse-patch] ${label} already applied"
    return 0
  fi

  if [[ ! -f "${patch_file}" ]]; then
    echo "[hermes-langfuse-patch] error: missing ${patch_file}" >&2
    return 1
  fi

  echo "[hermes-langfuse-patch] applying ${label} from ${patch_file}"
  (cd "${HERMES_DIR}" && patch --forward -p1 < "${patch_file}")
}

# user_id patch must run before system-prompt (which inserts ~50 lines above _start_root_trace).
apply_patch "per-box user_id" \
  "${SCRIPT_DIR}/hermes-langfuse-user-id.patch" \
  "langfuse_user_id = _env"

apply_patch "system-prompt tracing" \
  "${SCRIPT_DIR}/hermes-langfuse-system-prompt.patch" \
  "_messages_for_langfuse_input"

apply_patch "OpenRouter usage.include requests" \
  "${SCRIPT_DIR}/hermes-openrouter-usage-include.patch" \
  '"usage": {"include": True}'

apply_patch "OpenRouter cost in Langfuse" \
  "${SCRIPT_DIR}/hermes-langfuse-openrouter-cost.patch" \
  "_openrouter_cost_details"

echo "[hermes-langfuse-patch] done — restart Hermes gateway to load plugin changes"
