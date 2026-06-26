#!/usr/bin/env bash
# Patch an existing Joshu box with Hermes learning GitHub backup.
# Usage: bash scripts/patch-box-learning-github.sh patrick.box.joshu.me
#        bash scripts/patch-box-learning-github.sh patrick
set -euo pipefail

HOST_INPUT="${1:-}"
if [[ -z "${HOST_INPUT}" ]]; then
  echo "usage: $0 <hostname-or-slug>" >&2
  echo "example: $0 patrick.box.joshu.me" >&2
  exit 1
fi

if [[ "${HOST_INPUT}" == *.* ]]; then
  HOST="${HOST_INPUT}"
  SLUG="${HOST_INPUT%%.*}"
else
  SLUG="${HOST_INPUT}"
  HOST="${SLUG}.box.joshu.me"
fi

ORG="${JOSHU_GITHUB_LEARNING_ORG:-${DEFAULT_JOSHU_GITHUB_ORG:-db-aeon}}"
REPO_NAME="joshu-learning-${SLUG}"
REPO_FULL="${ORG}/${REPO_NAME}"
REMOTE="git@github.com:${REPO_FULL}.git"
DEPLOY_KEY_PATH="/etc/joshu/secrets/hermes-learning-github-deploy-key"
SSH_TARGET="root@${HOST}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

log() { printf '[patch-learning] %s\n' "$*"; }

log "box slug=${SLUG} host=${HOST} repo=${REPO_FULL}"

if ! gh repo view "${REPO_FULL}" >/dev/null 2>&1; then
  log "creating private repo ${REPO_FULL}"
  gh repo create "${REPO_FULL}" --private --add-readme \
    --description "Hermes learning loop state for Joshu box ${SLUG}"
else
  log "repo ${REPO_FULL} already exists"
fi

KEY_PATH="${TMP_DIR}/deploy-key"
ssh-keygen -t ed25519 -f "${KEY_PATH}" -N "" -q
PUB_KEY="$(cat "${KEY_PATH}.pub")"
KEY_TITLE="joshu-box-${SLUG}-$(date +%s)"

log "registering deploy key ${KEY_TITLE}"
gh api "repos/${REPO_FULL}/keys" \
  -f title="${KEY_TITLE}" \
  -f key="${PUB_KEY}" \
  -F read_only=false >/dev/null

log "building dist locally (learning overlay only — do not replace full dist)"
(cd "${ROOT_DIR}" && npm run build >/dev/null)

log "rsync scripts + selective dist to ${SSH_TARGET}"
rsync -az \
  "${ROOT_DIR}/scripts/bootstrap-hermes-learning-skills.sh" \
  "${ROOT_DIR}/scripts/merge-hermes-factory-skill.mjs" \
  "${ROOT_DIR}/scripts/hermes-learning-github-sync.sh" \
  "${ROOT_DIR}/scripts/apply-hermes-skill-evolution-patch.sh" \
  "${ROOT_DIR}/scripts/hermes-skill-evolution.patch" \
  "${SSH_TARGET}:/opt/joshu/scripts/"
rsync -az "${ROOT_DIR}/scripts/lib/ensure-hermes-learning-git.sh" "${SSH_TARGET}:/opt/joshu/scripts/lib/"
rsync -az "${ROOT_DIR}/deploy/scripts/vps-start.sh" "${SSH_TARGET}:/opt/joshu/deploy/scripts/vps-start.sh"
rsync -az "${ROOT_DIR}/deploy/docker-compose.yml" "${SSH_TARGET}:/opt/joshu/deploy/docker-compose.yml"
rsync -az "${ROOT_DIR}/factory/manifest.yaml" "${SSH_TARGET}:/opt/joshu/factory/manifest.yaml"
rsync -az "${ROOT_DIR}/packages/email-signature/" "${SSH_TARGET}:/opt/joshu/packages/email-signature/"
for f in hermesLearning.js hermesLearningGitCron.js hermesApi.js hermesSkillsConfig.js; do
  rsync -az "${ROOT_DIR}/dist/${f}" "${SSH_TARGET}:/opt/joshu/dist/"
done

scp -q "${KEY_PATH}" "${SSH_TARGET}:${DEPLOY_KEY_PATH}.tmp"

ssh "${SSH_TARGET}" bash -s -- "${REPO_FULL}" "${REMOTE}" "${DEPLOY_KEY_PATH}" <<'REMOTE_PATCH'
set -euo pipefail
REPO_FULL="$1"
REMOTE="$2"
DEPLOY_KEY_PATH="$3"
ENV_FILE="/etc/joshu/instance.env"

patch_env() {
  local key="$1"
  local value="$2"
  if grep -q "^${key}=" "${ENV_FILE}" 2>/dev/null; then
    sed -i "s|^${key}=.*|${key}=${value}|" "${ENV_FILE}"
  else
    echo "${key}=${value}" >> "${ENV_FILE}"
  fi
}

mkdir -p /etc/joshu/secrets
mv "${DEPLOY_KEY_PATH}.tmp" "${DEPLOY_KEY_PATH}"
chmod 600 "${DEPLOY_KEY_PATH}"
# Keep secrets traversable for hindsight user (gid 1001 in container). Do not chmod 700.
if [[ -f /etc/joshu/secrets/google-reranker-service-account.json ]]; then
  chown 0:1001 /etc/joshu/secrets /etc/joshu/secrets/google-reranker-service-account.json 2>/dev/null || true
  chmod 750 /etc/joshu/secrets
  chmod 640 /etc/joshu/secrets/google-reranker-service-account.json
else
  chmod 750 /etc/joshu/secrets
fi

patch_env "JOSHU_HERMES_LEARNING_GITHUB_REPO" "${REPO_FULL}"
patch_env "JOSHU_HERMES_LEARNING_GITHUB_REMOTE" "${REMOTE}"
patch_env "JOSHU_HERMES_LEARNING_DEPLOY_KEY" "${DEPLOY_KEY_PATH}"

chmod +x /opt/joshu/scripts/bootstrap-hermes-learning-skills.sh \
  /opt/joshu/scripts/hermes-learning-github-sync.sh \
  /opt/joshu/scripts/apply-hermes-skill-evolution-patch.sh \
  /opt/joshu/scripts/lib/ensure-hermes-learning-git.sh

cd /opt/joshu/deploy
docker compose -f docker-compose.yml --env-file /etc/joshu/instance.env up -d --force-recreate joshu-stack

echo "[patch-learning] waiting for health..."
for _ in $(seq 1 45); do
  if curl -fsS http://127.0.0.1:8788/joshu/api/instance/health >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

CID="$(docker ps -qf name=joshu-stack)"
docker exec "${CID}" bash -lc '
  set -euo pipefail
  export HERMES_HOME=/root/.hermes
  export APP_DIR=/opt/joshu
  command -v ssh >/dev/null 2>&1 || (apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq openssh-client)
  bash /opt/joshu/scripts/apply-hermes-skill-evolution-patch.sh
  bash /opt/joshu/scripts/bootstrap-hermes-learning-skills.sh
  bash /opt/joshu/scripts/lib/ensure-hermes-learning-git.sh
  mkdir -p /root/.hermes/scripts
  cp /opt/joshu/scripts/hermes-learning-github-sync.sh /root/.hermes/scripts/
  chmod +x /root/.hermes/scripts/hermes-learning-github-sync.sh
  bash /opt/joshu/scripts/hermes-learning-github-sync.sh || true
  source /etc/joshu/instance.env
  /opt/hermes-agent/venv/bin/python3 /opt/joshu/scripts/hermes-cron-bridge.py <<PY || true
{"action":"create","schedule":"0 * * * *","name":"Hermes learning GitHub sync","script":"hermes-learning-github-sync.sh","no_agent":true,"workdir":"/opt/joshu"}
PY
'

echo "[patch-learning] instance.env:"
grep JOSHU_HERMES_LEARNING "${ENV_FILE}"
echo "[patch-learning] git remote:"
docker exec "${CID}" git -C /root/.hermes remote -v 2>/dev/null || true
echo "[patch-learning] skills/joshu sample:"
docker exec "${CID}" ls /root/.hermes/skills/joshu 2>/dev/null | head -8 || true
REMOTE_PATCH

log "done — https://github.com/${REPO_FULL}"
