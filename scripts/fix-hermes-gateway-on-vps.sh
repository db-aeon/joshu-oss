#!/usr/bin/env bash
# Repair Hermes gateway on a running VPS: sync OpenRouter key + restart gateway with env.
# Usage: ./scripts/fix-hermes-gateway-on-vps.sh root@11-21-11.box.joshu.me
set -euo pipefail

TARGET="${1:-}"
if [[ -z "${TARGET}" ]]; then
  echo "usage: $0 root@<host-or-ip>" >&2
  exit 1
fi

ssh -o ConnectTimeout=15 "${TARGET}" 'bash -s' <<'REMOTE'
set -euo pipefail
echo "[1/5] sync /root/.hermes/.env from instance.env"
docker exec deploy-joshu-stack-1 bash -lc '
  set -a; source /etc/joshu/instance.env; set +a
  H=/root/.hermes/.env
  grep -v -E "^(OPENROUTER_API_KEY|ANTHROPIC_API_KEY|HERMES_API_KEY|API_SERVER_KEY)=" "$H" 2>/dev/null > /tmp/hermes.clean || true
  { cat /tmp/hermes.clean 2>/dev/null || true
    echo "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}"
    echo "HERMES_API_KEY=${HERMES_API_KEY}"
    echo "API_SERVER_KEY=${API_SERVER_KEY}"
  } > "$H"
  chmod 600 "$H"
  echo "OPENROUTER len=${#OPENROUTER_API_KEY}"
'

echo "[2/5] stop old gateway"
docker exec deploy-joshu-stack-1 bash -lc '
  pkill -f "hermes gateway" 2>/dev/null || true
  rm -f /root/.hermes/gateway.pid /root/.hermes/gateway.lock
  sleep 2
  pgrep -af "hermes gateway" || echo "no gateway process"
'

echo "[3/5] verify OpenRouter key + fix config"
docker exec deploy-joshu-stack-1 bash -lc '
  set -a; source /etc/joshu/instance.env; set +a
  cfg=/root/.hermes/config.yaml
  model="${JOSHU_HERMES_MODEL:-deepseek/deepseek-v4-flash}"
  provider="${JOSHU_HERMES_PROVIDER:-openrouter}"
  if [[ ${#OPENROUTER_API_KEY} -lt 20 ]]; then
    echo "OPENROUTER_API_KEY too short — check /etc/joshu/instance.env and /root/.hermes/.env" >&2
    exit 1
  fi
  if grep -q "^model:" "$cfg" 2>/dev/null; then
    sed -i "s|^  default:.*|  default: ${model}|" "$cfg"
    sed -i "s|^  provider:.*|  provider: ${provider}|" "$cfg"
  fi
  sed -i "/^toolsets:/c\\
toolsets:\\
  - hermes-cli\\
  - browser" "$cfg"
  pkill -f "hermes gateway" 2>/dev/null || true
  rm -f /root/.hermes/gateway.pid /root/.hermes/gateway.lock
  export API_SERVER_ENABLED=true API_SERVER_HOST=127.0.0.1 API_SERVER_PORT=8642
  export API_SERVER_KEY="${HERMES_API_KEY}"
  export OPENROUTER_API_KEY="${OPENROUTER_API_KEY}"
  /opt/hermes-agent/venv/bin/hermes gateway run --quiet --accept-hooks </dev/null >>/root/.hermes/gateway.log 2>&1 &
  sleep 5
  echo "gateway pid=$(pgrep -f hermes.*gateway | head -1 || echo none)"
'

echo "[4/5] gateway health"
docker exec deploy-joshu-stack-1 bash -lc '
  source /etc/joshu/instance.env
  curl -m 5 -fsS -H "Authorization: Bearer ${HERMES_API_KEY}" http://127.0.0.1:8642/health
  echo
'

echo "[5/5] stream smoke test"
docker exec deploy-joshu-stack-1 bash -lc '
  source /etc/joshu/instance.env
  curl -m 15 -sS -N http://127.0.0.1:8642/v1/chat/completions \
    -H "Authorization: Bearer ${HERMES_API_KEY}" \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"hermes-agent\",\"messages\":[{\"role\":\"user\",\"content\":\"Say OK only\"}],\"stream\":true}"' | head -12

echo "done"
REMOTE
