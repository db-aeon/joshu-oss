# Shared helpers for Twilio local dev scripts. Source from bash only.
twilio_local_root() {
  cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd
}

twilio_local_load_env() {
  local root="$1"
  local env_file="${root}/.env"
  if [[ -f "${env_file}" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "${env_file}"
    set +a
  fi
}

twilio_local_ensure_secret() {
  if [[ -z "${TWILIO_MEDIA_STREAM_SECRET:-}" ]]; then
    if command -v openssl >/dev/null 2>&1; then
      export TWILIO_MEDIA_STREAM_SECRET="$(openssl rand -hex 32)"
      echo "[twilio-local] generated TWILIO_MEDIA_STREAM_SECRET (add to .env)"
    else
      echo "[twilio-local] error: set TWILIO_MEDIA_STREAM_SECRET or install openssl" >&2
      return 1
    fi
  fi
  if [[ "${TWILIO_MEDIA_STREAM_SECRET}" =~ [+/=] ]]; then
    echo "[twilio-local] error: use hex secret (openssl rand -hex 32), not base64" >&2
    return 1
  fi
}

twilio_local_voice_mode() {
  echo "${JOSHU_VOICE_MODE:-legacy}"
}

twilio_local_base_path() {
  local p="${PUBLIC_BASE_PATH:-/joshu}"
  p="${p%/}"
  [[ -n "${p}" ]] || p="/joshu"
  echo "${p}"
}

twilio_local_proxy_port() {
  echo "${TWILIO_LOCAL_PROXY_PORT:-8790}"
}

# Media WSS URL with secret in path (ngrok-safe).
twilio_local_media_wss_url() {
  local origin="$1"
  local secret="$2"
  local mode
  mode="$(twilio_local_voice_mode)"
  origin="${origin%/}"
  origin="${origin#https://}"
  origin="${origin#http://}"

  case "${mode}" in
    realtime_s2s)
      echo "wss://${origin}/voice-rt/media/${secret}"
      ;;
    realtime)
      echo "wss://${origin}/voice/media/${secret}"
      ;;
    *)
      local base
      base="$(twilio_local_base_path)"
      echo "wss://${origin}${base}/api/twilio/media-stream/${secret}"
      ;;
  esac
}

twilio_local_webhook_url() {
  local origin="$1"
  local base
  base="$(twilio_local_base_path)"
  origin="${origin%/}"
  origin="${origin#https://}"
  origin="${origin#http://}"
  echo "https://${origin}${base}/api/twilio/voice/inbound"
}
