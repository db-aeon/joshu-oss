#!/usr/bin/env bash
# Fire Langfuse post_tool_call for agent-loop tools (session_search, hindsight_*, etc.)
# that bypass handle_function_call when run concurrently via _invoke_tool.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HERMES_DIR="${HERMES_DIR:-/opt/hermes-agent}"
RUN_AGENT="${HERMES_DIR}/run_agent.py"
PATCH_FILE="${SCRIPT_DIR}/hermes-invoke-tool-post-hook.patch"
MARKER="_emit_joshu_agent_loop_post_tool_call"

if [[ ! -f "${RUN_AGENT}" ]]; then
  echo "[hermes-invoke-tool-post-hook] skip: ${RUN_AGENT} not found"
  exit 0
fi

if rg -q "${MARKER}" "${RUN_AGENT}" 2>/dev/null; then
  echo "[hermes-invoke-tool-post-hook] already applied"
  exit 0
fi

if [[ ! -f "${PATCH_FILE}" ]]; then
  echo "[hermes-invoke-tool-post-hook] error: missing ${PATCH_FILE}" >&2
  exit 1
fi

echo "[hermes-invoke-tool-post-hook] applying patch from ${PATCH_FILE}"
(cd "${HERMES_DIR}" && patch --forward -p1 < "${PATCH_FILE}")
echo "[hermes-invoke-tool-post-hook] done — restart Hermes gateway"
