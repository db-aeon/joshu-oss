#!/usr/bin/env bash
# Start a local Hindsight API server for Joshu and wait until it is healthy.
set -euo pipefail

enabled="${JOSHU_HINDSIGHT_ENABLED:-auto}"
enabled_lc="$(printf '%s' "${enabled}" | tr '[:upper:]' '[:lower:]')"

case "${enabled_lc}" in
  0|false|off|no)
    echo "[hindsight] disabled by JOSHU_HINDSIGHT_ENABLED=${enabled}"
    exit 0
    ;;
esac

api_host="${HINDSIGHT_API_HOST:-127.0.0.1}"
api_port="${HINDSIGHT_API_PORT:-8888}"
api_url="${HINDSIGHT_API_URL:-http://${api_host}:${api_port}}"
health_url="${api_url%/}/health"
api_bin="${HINDSIGHT_API_BIN:-hindsight-api}"
log_file="${HINDSIGHT_LOG_FILE:-${HOME}/.hindsight/hindsight-api.log}"
pid_file="${HINDSIGHT_PID_FILE:-}"
run_as_user="${HINDSIGHT_RUN_AS_USER:-}"
process_home="${HINDSIGHT_PROCESS_HOME:-${HOME}}"

if [[ -z "${HINDSIGHT_API_LLM_API_KEY:-}" && "${HINDSIGHT_API_LLM_PROVIDER:-openrouter}" == "openrouter" && -n "${OPENROUTER_API_KEY:-}" ]]; then
  export HINDSIGHT_API_LLM_API_KEY="${OPENROUTER_API_KEY}"
fi

# No-training routing (openspec/glossary.md) for retain, reflect, and consolidation.
# Merge provider.data_collection=deny into the JSON object of the operator, if any.
# Only for OpenRouter: other LLM providers reject field "provider".
if [[ "${HINDSIGHT_API_LLM_PROVIDER:-}" == "openrouter" ]]; then
  HINDSIGHT_API_LLM_EXTRA_BODY="$(python3 -c '
import json, sys
body = json.loads(sys.argv[1] or "{}") or {}
if not isinstance(body, dict):
    sys.exit("[hindsight] HINDSIGHT_API_LLM_EXTRA_BODY must be a JSON object")
provider = body.get("provider") if isinstance(body.get("provider"), dict) else {}
body["provider"] = {**provider, "data_collection": "deny"}
print(json.dumps(body, separators=(",", ":")))
' "${HINDSIGHT_API_LLM_EXTRA_BODY:-}")"
  export HINDSIGHT_API_LLM_EXTRA_BODY
fi

has_llm_config=false
if [[ -n "${HINDSIGHT_API_LLM_API_KEY:-}" || -n "${HINDSIGHT_API_LLM_PROVIDER:-}" || -n "${HINDSIGHT_API_LLM_BASE_URL:-}" ]]; then
  has_llm_config=true
fi

if curl -fsS "${health_url}" >/dev/null 2>&1; then
  echo "[hindsight] already healthy at ${health_url}"
  exit 0
fi

if [[ "${enabled_lc}" == "auto" && "${has_llm_config}" != "true" ]]; then
  echo "[hindsight] auto mode: no HINDSIGHT_API_LLM_* config found, skipping local Hindsight startup"
  exit 0
fi

if [[ "${HINDSIGHT_REQUIRE_EXTERNAL_ML:-false}" =~ ^(1|true|yes|on)$ ]]; then
  missing_external_ml=()
  if [[ -z "${HINDSIGHT_API_EMBEDDINGS_PROVIDER:-}" ]]; then
    missing_external_ml+=("HINDSIGHT_API_EMBEDDINGS_PROVIDER")
  fi
  if [[ -z "${HINDSIGHT_API_RERANKER_PROVIDER:-}" ]]; then
    missing_external_ml+=("HINDSIGHT_API_RERANKER_PROVIDER")
  fi
  if (( ${#missing_external_ml[@]} > 0 )); then
    if [[ "${enabled_lc}" == "auto" ]]; then
      echo "[hindsight] auto mode: missing external ML config (${missing_external_ml[*]}), skipping local Hindsight startup"
      exit 0
    fi
    echo "[hindsight] missing external ML config required by slim install: ${missing_external_ml[*]}" >&2
    exit 1
  fi
fi

if ! command -v "${api_bin}" >/dev/null 2>&1; then
  if [[ "${enabled_lc}" == "auto" ]]; then
    echo "[hindsight] auto mode: ${api_bin} not found, skipping local Hindsight startup"
    exit 0
  fi
  echo "[hindsight] ${api_bin} not found. Install Hindsight or set HINDSIGHT_API_BIN." >&2
  exit 1
fi

mkdir -p "$(dirname "${log_file}")"

# Give Hindsight a private copy of the Google reranker key.
# On a box, the key is on the host in /etc/joshu/secrets, and the stack mounts /etc/joshu read-only.
# The host owner and mode of the key cannot follow the uid and gid of user hindsight, which can
# change with each image (clara, 0.1.51). Root reads the key here, and Hindsight reads the copy.
stage_google_reranker_key() {
  local src="${HINDSIGHT_API_RERANKER_GOOGLE_SERVICE_ACCOUNT_KEY:-}"
  [[ -n "${src}" ]] || return 0
  if [[ ! -r "${src}" ]]; then
    echo "[hindsight] WARNING: cannot read the Google reranker key ${src} as $(id -un); Hindsight will fail to start the reranker" >&2
    return 0
  fi
  [[ -n "${run_as_user}" ]] && id "${run_as_user}" >/dev/null 2>&1 || return 0
  local dir="${HINDSIGHT_PRIVATE_SECRETS_DIR:-/run/joshu-hindsight}"
  local dst="${dir}/google-reranker-service-account.json"
  [[ "${src}" == "${dst}" ]] && return 0
  local owner=()
  if [[ "$(id -u)" == "0" ]]; then
    owner=(-o "${run_as_user}" -g "$(id -g "${run_as_user}")")
  fi
  if ! install -d -m 700 ${owner[@]+"${owner[@]}"} "${dir}" || ! install -m 600 ${owner[@]+"${owner[@]}"} "${src}" "${dst}"; then
    echo "[hindsight] WARNING: cannot copy the Google reranker key to ${dst}; Hindsight reads ${src}" >&2
    return 0
  fi
  export HINDSIGHT_API_RERANKER_GOOGLE_SERVICE_ACCOUNT_KEY="${dst}"
  echo "[hindsight] Google reranker key: private copy for ${run_as_user} at ${dst}"
}
stage_google_reranker_key

export HINDSIGHT_API_HOST="${api_host}"
export HINDSIGHT_API_PORT="${api_port}"
export HINDSIGHT_API_URL="${api_url}"
export HINDSIGHT_API_WORKER_ID="${HINDSIGHT_API_WORKER_ID:-joshu-hindsight}"
export HINDSIGHT_API_LOG_LEVEL="${HINDSIGHT_API_LOG_LEVEL:-info}"

echo "[hindsight] starting ${api_bin} on ${api_url} (log: ${log_file})"
if [[ -n "${run_as_user}" && "$(id -u)" == "0" ]] && id "${run_as_user}" >/dev/null 2>&1; then
  runuser -u "${run_as_user}" -- env HOME="${process_home}" "${api_bin}" --host "${api_host}" --port "${api_port}" >>"${log_file}" 2>&1 &
else
  "${api_bin}" --host "${api_host}" --port "${api_port}" >>"${log_file}" 2>&1 &
fi
hindsight_pid=$!

if [[ -n "${pid_file}" ]]; then
  mkdir -p "$(dirname "${pid_file}")"
  printf '%s\n' "${hindsight_pid}" > "${pid_file}"
fi

for _ in $(seq 1 "${HINDSIGHT_STARTUP_ATTEMPTS:-120}"); do
  if curl -fsS "${health_url}" >/dev/null 2>&1; then
    echo "[hindsight] healthy at ${health_url}"
    exit 0
  fi
  if ! kill -0 "${hindsight_pid}" >/dev/null 2>&1; then
    echo "[hindsight] exited before becoming healthy; recent log follows" >&2
    tail -n 80 "${log_file}" >&2 || true
    wait "${hindsight_pid}"
    exit 1
  fi
  sleep 1
done

echo "[hindsight] timed out waiting for ${health_url}; recent log follows" >&2
tail -n 80 "${log_file}" >&2 || true
exit 1
