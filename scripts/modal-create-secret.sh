#!/usr/bin/env bash
set -euo pipefail

secret_name="${1:-joshu-hitl-secrets}"
app_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
hermes_home="${HERMES_HOME:-${HOME}/.hermes}"

read_env_value() {
  local name="$1"
  local env_file="$2"
  local line value

  [[ -f "${env_file}" ]] || return 1
  line="$(grep -E "^${name}=" "${env_file}" | tail -n 1 || true)"
  [[ -n "${line}" ]] || return 1

  value="${line#*=}"
  value="${value%$'\r'}"
  if [[ "${value}" == \"*\" && "${value}" == *\" ]]; then
    value="${value:1:${#value}-2}"
  elif [[ "${value}" == \'*\' && "${value}" == *\' ]]; then
    value="${value:1:${#value}-2}"
  fi

  printf '%s' "${value}"
}

add_secret_var() {
  local name="$1"
  local value="${!name-}"

  # Prefer explicitly exported values, then repo .env, then Hermes profile .env.
  if [[ -z "${value}" ]]; then
    value="$(read_env_value "${name}" "${app_root}/.env" || true)"
  fi
  if [[ -z "${value}" ]]; then
    value="$(read_env_value "${name}" "${hermes_home}/.env" || true)"
  fi

  if [[ -n "${value}" ]]; then
    args+=("${name}=${value}")
  fi
}

resolve_secret_file_path() {
  local file_value="$1"

  [[ -n "${file_value}" ]] || return 1

  if [[ "${file_value}" = /* && -f "${file_value}" ]]; then
    printf '%s' "${file_value}"
    return 0
  fi

  if [[ -f "${app_root}/${file_value}" ]]; then
    printf '%s' "${app_root}/${file_value}"
    return 0
  fi

  if [[ -f "${hermes_home}/${file_value}" ]]; then
    printf '%s' "${hermes_home}/${file_value}"
    return 0
  fi

  return 1
}

add_secret_file_b64() {
  local path_var="$1"
  local b64_var="$2"
  local file_value="${!path_var-}"
  local file_path

  if [[ -z "${file_value}" ]]; then
    file_value="$(read_env_value "${path_var}" "${app_root}/.env" || true)"
  fi
  if [[ -z "${file_value}" ]]; then
    file_value="$(read_env_value "${path_var}" "${hermes_home}/.env" || true)"
  fi

  if file_path="$(resolve_secret_file_path "${file_value}")"; then
    args+=("${b64_var}=$(base64 < "${file_path}" | tr -d '\n')")
  elif [[ -n "${file_value}" ]]; then
    echo "Warning: ${path_var} points to '${file_value}', but that file was not found locally." >&2
  fi
}

if ! command -v modal >/dev/null 2>&1; then
  echo "modal CLI not found. Install/authenticate it first:" >&2
  echo "  python3 -m pip install --user modal" >&2
  echo "  python3 -m modal setup" >&2
  exit 1
fi

# Reuse the local app key if present, but do not require sourcing all secrets.
if [[ -z "${HERMES_API_KEY:-}" && -f "${app_root}/.env" ]]; then
  HERMES_API_KEY="$(grep -E '^HERMES_API_KEY=' "${app_root}/.env" | tail -n 1 | cut -d= -f2- || true)"
fi

if [[ -z "${HERMES_API_KEY:-}" ]]; then
  HERMES_API_KEY="change-me-modal-dev"
  echo "HERMES_API_KEY was not set; using '${HERMES_API_KEY}' for the internal gateway bearer token."
fi

args=("${secret_name}" "HERMES_API_KEY=${HERMES_API_KEY}")

for var_name in \
  JOSHU_HINDSIGHT_ENABLED \
  HINDSIGHT_BANK_ID \
  HINDSIGHT_API_KEY \
  HINDSIGHT_API_LLM_PROVIDER \
  HINDSIGHT_API_LLM_API_KEY \
  HINDSIGHT_API_LLM_MODEL \
  HINDSIGHT_API_LLM_BASE_URL \
  HINDSIGHT_API_EMBEDDINGS_PROVIDER \
  HINDSIGHT_API_EMBEDDINGS_OPENAI_MODEL \
  HINDSIGHT_API_EMBEDDINGS_OPENAI_API_KEY \
  HINDSIGHT_API_EMBEDDINGS_OPENAI_BASE_URL \
  HINDSIGHT_API_EMBEDDINGS_GEMINI_API_KEY \
  HINDSIGHT_API_EMBEDDINGS_GEMINI_MODEL \
  HINDSIGHT_API_EMBEDDINGS_GEMINI_OUTPUT_DIMENSIONALITY \
  HINDSIGHT_API_EMBEDDINGS_VERTEXAI_PROJECT_ID \
  HINDSIGHT_API_EMBEDDINGS_VERTEXAI_REGION \
  HINDSIGHT_API_EMBEDDINGS_VERTEXAI_SERVICE_ACCOUNT_KEY \
  HINDSIGHT_API_RERANKER_PROVIDER \
  HINDSIGHT_API_RERANKER_COHERE_MODEL \
  HINDSIGHT_API_RERANKER_COHERE_API_KEY \
  HINDSIGHT_API_RERANKER_GOOGLE_PROJECT_ID \
  HINDSIGHT_API_RERANKER_GOOGLE_SERVICE_ACCOUNT_KEY
do
  add_secret_var "${var_name}"
done

add_secret_file_b64 \
  HINDSIGHT_API_RERANKER_GOOGLE_SERVICE_ACCOUNT_KEY \
  HINDSIGHT_API_RERANKER_GOOGLE_SERVICE_ACCOUNT_JSON_B64

add_secret_file_b64 \
  HINDSIGHT_API_EMBEDDINGS_VERTEXAI_SERVICE_ACCOUNT_KEY \
  HINDSIGHT_API_EMBEDDINGS_VERTEXAI_SERVICE_ACCOUNT_JSON_B64

if [[ -f "${hermes_home}/auth.json" ]]; then
  args+=("HERMES_AUTH_JSON_B64=$(base64 < "${hermes_home}/auth.json" | tr -d '\n')")
else
  echo "Warning: ${hermes_home}/auth.json not found; Hermes may need provider API keys in the secret." >&2
fi

if [[ -f "${hermes_home}/.env" ]]; then
  args+=("HERMES_ENV_B64=$(base64 < "${hermes_home}/.env" | tr -d '\n')")
fi

if [[ -f "${hermes_home}/config.yaml" ]]; then
  args+=("HERMES_CONFIG_YAML_B64=$(base64 < "${hermes_home}/config.yaml" | tr -d '\n')")
fi

modal secret create --force "${args[@]}"
