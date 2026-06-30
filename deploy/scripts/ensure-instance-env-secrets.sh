#!/usr/bin/env bash
# Idempotent internal secrets for /etc/joshu/instance.env (VPS bootstrap).
# User-facing keys (OpenRouter, etc.) are collected in Welcome on standalone boxes.
set -euo pipefail

ENV_FILE="${1:?usage: ensure-instance-env-secrets.sh /etc/joshu/instance.env}"

[[ -f "${ENV_FILE}" ]] || {
  echo "[ensure-instance-env-secrets] missing ${ENV_FILE}" >&2
  exit 1
}

get_env() {
  local key="$1"
  grep -m1 "^${key}=" "${ENV_FILE}" 2>/dev/null | cut -d= -f2- || true
}

is_placeholder() {
  local val="${1:-}"
  [[ -z "${val}" || "${val}" == change-me* ]]
}

upsert_env() {
  local key="$1" value="$2"
  if grep -q "^${key}=" "${ENV_FILE}" 2>/dev/null; then
    sed -i "s|^${key}=.*|${key}=${value}|" "${ENV_FILE}"
  else
    echo "${key}=${value}" >> "${ENV_FILE}"
  fi
}

# Standalone self-host unless explicitly fleet / control-plane managed.
if ! grep -q '^JOSHU_STANDALONE=' "${ENV_FILE}" 2>/dev/null; then
  if [[ -z "$(get_env INSTANCE_AGENT_TOKEN)" ]]; then
    echo "JOSHU_STANDALONE=1" >> "${ENV_FILE}"
    echo "[ensure-instance-env-secrets] set JOSHU_STANDALONE=1"
  fi
fi

if is_placeholder "$(get_env HERMES_API_KEY)" || is_placeholder "$(get_env API_SERVER_KEY)"; then
  gateway_secret="$(openssl rand -hex 32)"
  upsert_env HERMES_API_KEY "${gateway_secret}"
  upsert_env API_SERVER_KEY "${gateway_secret}"
  echo "[ensure-instance-env-secrets] generated HERMES_API_KEY / API_SERVER_KEY"
fi

if is_placeholder "$(get_env JOSHU_HERMES_DASHBOARD_PASSWORD)"; then
  dashboard_pw="$(openssl rand -base64 24 | tr -d '/+=' | head -c 24)"
  upsert_env JOSHU_HERMES_DASHBOARD_PASSWORD "${dashboard_pw}"
  echo "[ensure-instance-env-secrets] generated JOSHU_HERMES_DASHBOARD_PASSWORD"
fi

# OSS self-host: when a voice image is pinned, enable Gemini Live stack defaults (key from Welcome).
voice_image="$(get_env JOSHU_VOICE_IMAGE_REF)"
if [[ -n "${voice_image}" && "${voice_image}" != *your-org* ]]; then
  if [[ "$(get_env JOSHU_VOICE_MODE)" == "legacy" || -z "$(get_env JOSHU_VOICE_MODE)" ]]; then
    upsert_env JOSHU_VOICE_MODE realtime_s2s
    echo "[ensure-instance-env-secrets] set JOSHU_VOICE_MODE=realtime_s2s (voice image pinned)"
  fi
  if [[ "$(get_env JOSHU_WEB_VOICE_ENABLED)" != "true" ]]; then
    upsert_env JOSHU_WEB_VOICE_ENABLED true
    echo "[ensure-instance-env-secrets] set JOSHU_WEB_VOICE_ENABLED=true"
  fi
  if [[ -z "$(get_env JOSHU_VOICE_PROVIDER)" ]]; then
    upsert_env JOSHU_VOICE_PROVIDER gemini_live
    echo "[ensure-instance-env-secrets] set JOSHU_VOICE_PROVIDER=gemini_live"
  fi
fi
