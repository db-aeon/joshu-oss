#!/usr/bin/env bash
# Patch an existing VPS instance.env + GCP service account from the repo root .env.
# Usage: ./scripts/sync-hindsight-to-vps.sh root@joshu-11-21-10-igjalo
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ROOT_DIR}/.env"
SA_FILE="${ROOT_DIR}/aeon-page-to-speech-config.json"
VPS_TARGET="${1:-}"

if [[ -z "${VPS_TARGET}" ]]; then
  echo "usage: $0 root@<ip-or-hostname>" >&2
  echo "  examples: $0 root@161.35.185.52" >&2
  echo "            $0 root@11-21-10.box.joshu.me" >&2
  echo "  (DO droplet names like joshu-11-21-10-igjalo are not DNS hostnames)" >&2
  exit 1
fi

# Accept root@host or bare host; resolve customer hostnames to an IP for SSH.
VPS_HOST="${VPS_TARGET}"
if [[ "${VPS_HOST}" != *@* ]]; then
  VPS_HOST="root@${VPS_HOST}"
fi
host_part="${VPS_HOST#*@}"
if [[ "${host_part}" =~ ^[0-9.]+$ ]]; then
  :
elif command -v dig >/dev/null 2>&1; then
  resolved="$(dig +short "${host_part}" A 2>/dev/null | head -n 1)"
  if [[ -n "${resolved}" ]]; then
    VPS_HOST="root@${resolved}"
    echo "Resolved ${host_part} -> ${resolved}"
  fi
fi

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "missing ${ENV_FILE}" >&2
  exit 1
fi

# shellcheck disable=SC1090
set -a && source "${ENV_FILE}" && set +a

if [[ ! -f "${SA_FILE}" ]]; then
  echo "missing ${SA_FILE}" >&2
  exit 1
fi

ssh "${VPS_HOST}" 'mkdir -p /etc/joshu/secrets && chmod 700 /etc/joshu'
scp "${SA_FILE}" "${VPS_HOST}:/etc/joshu/secrets/google-reranker-service-account.json"
# hindsight user/group exist in the container image, not on the Ubuntu host — use its gid for the bind mount.
ssh "${VPS_HOST}" 'bash -s' <<'REMOTE'
set -euo pipefail
IMAGE="${JOSHU_IMAGE_REF:-ghcr.io/db-aeon/joshu-sandbox:0.1.1}"
H_GID="$(docker run --rm --entrypoint id "${IMAGE}" hindsight -g)"
chown "root:${H_GID}" /etc/joshu/secrets /etc/joshu/secrets/google-reranker-service-account.json
chmod 750 /etc/joshu/secrets
chmod 640 /etc/joshu/secrets/google-reranker-service-account.json
REMOTE

tmp="$(mktemp)"
{
  echo "JOSHU_HINDSIGHT_ENABLED=${JOSHU_HINDSIGHT_ENABLED:-true}"
  echo "JOSHU_HINDSIGHT_OPTIONAL=${JOSHU_HINDSIGHT_OPTIONAL:-true}"
  echo "HINDSIGHT_API_URL=${HINDSIGHT_API_URL:-http://127.0.0.1:8888}"
  echo "HINDSIGHT_API_DATABASE_URL=${HINDSIGHT_API_DATABASE_URL:-postgresql://hindsight:hindsight@127.0.0.1:5432/hindsight}"
  echo "HINDSIGHT_API_LLM_PROVIDER=${HINDSIGHT_API_LLM_PROVIDER:-openrouter}"
  echo "HINDSIGHT_API_LLM_API_KEY=${HINDSIGHT_API_LLM_API_KEY:-${OPENROUTER_API_KEY:-}}"
  echo "HINDSIGHT_API_LLM_MODEL=${HINDSIGHT_API_LLM_MODEL:-google/gemini-3.1-flash-lite}"
  echo "HINDSIGHT_REQUIRE_EXTERNAL_ML=${HINDSIGHT_REQUIRE_EXTERNAL_ML:-true}"
  echo "HINDSIGHT_API_EMBEDDINGS_PROVIDER=${HINDSIGHT_API_EMBEDDINGS_PROVIDER:-}"
  echo "HINDSIGHT_API_EMBEDDINGS_GEMINI_API_KEY=${HINDSIGHT_API_EMBEDDINGS_GEMINI_API_KEY:-}"
  echo "HINDSIGHT_API_RERANKER_PROVIDER=${HINDSIGHT_API_RERANKER_PROVIDER:-}"
  echo "HINDSIGHT_API_RERANKER_GOOGLE_PROJECT_ID=${HINDSIGHT_API_RERANKER_GOOGLE_PROJECT_ID:-}"
  echo "HINDSIGHT_API_RERANKER_GOOGLE_SERVICE_ACCOUNT_KEY=/etc/joshu/secrets/google-reranker-service-account.json"
  echo "HINDSIGHT_RUN_AS_USER=hindsight"
  echo "HINDSIGHT_PROCESS_HOME=/home/hindsight/.hindsight"
  echo "HINDSIGHT_LOG_FILE=/home/hindsight/.hindsight/hindsight-api.log"
} >"${tmp}"

scp "${tmp}" "${VPS_HOST}:/tmp/joshu-hindsight.env"
rm -f "${tmp}"

ssh "${VPS_HOST}" 'bash -s' <<'REMOTE'
set -euo pipefail
touch /etc/joshu/instance.env
chmod 600 /etc/joshu/instance.env
grep -v -E '^(JOSHU_HINDSIGHT_|HINDSIGHT_)' /etc/joshu/instance.env > /tmp/instance.env.clean || true
cat /tmp/instance.env.clean /tmp/joshu-hindsight.env > /etc/joshu/instance.env
rm -f /tmp/instance.env.clean /tmp/joshu-hindsight.env
cd /opt/joshu/deploy
docker compose -f docker-compose.yml --env-file /etc/joshu/instance.env up -d --force-recreate joshu-stack
REMOTE

echo "Hindsight env synced; joshu-stack restarted on ${VPS_HOST}"
