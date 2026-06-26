#!/usr/bin/env bash
# Hourly (or manual) commit+push of Hermes learning state to private GitHub.
set -euo pipefail

HERMES_HOME="${HERMES_HOME:-${HOME}/.hermes}"
# Cron runs from ~/.hermes/scripts/; resolve repo root for bundled helpers.
APP_DIR="${APP_DIR:-${JOSHU_REPO_ROOT:-/opt/joshu}}"
if [[ -f /etc/joshu/instance.env ]]; then
  set -a
  # shellcheck disable=SC1091
  source /etc/joshu/instance.env
  set +a
fi

log() { printf '[hermes-learning-sync] %s\n' "$*"; }

if [[ -z "${JOSHU_HERMES_LEARNING_GITHUB_REPO:-}" && -z "${JOSHU_HERMES_LEARNING_GITHUB_REMOTE:-}" ]]; then
  log "skip: no GitHub repo configured"
  exit 0
fi

# Ensure git repo + remote exist.
bash "${APP_DIR}/scripts/lib/ensure-hermes-learning-git.sh"

if [[ ! -d "${HERMES_HOME}/.git" ]]; then
  log "skip: git not initialized"
  exit 0
fi

export GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-}"
if [[ -z "${GIT_SSH_COMMAND}" && -f "${HERMES_HOME}/.ssh/config" ]]; then
  export GIT_SSH_COMMAND="ssh -F ${HERMES_HOME}/.ssh/config"
fi

git -C "${HERMES_HOME}" add -A skills cron memories config.user.yaml .gitignore 2>/dev/null || true

if git -C "${HERMES_HOME}" diff --cached --quiet; then
  log "no changes"
  exit 0
fi

git -C "${HERMES_HOME}" \
  -c user.email="${JOSHU_HERMES_LEARNING_GIT_EMAIL:-hermes-learning@joshu.local}" \
  -c user.name="${JOSHU_HERMES_LEARNING_GIT_NAME:-Joshu Hermes Learning}" \
  commit -q -m "joshu: hermes learning sync $(date -u +%Y-%m-%dT%H:%M:%SZ)"

if ! git -C "${HERMES_HOME}" push origin main 2>/dev/null; then
  git -C "${HERMES_HOME}" pull --rebase --allow-unrelated-histories origin main 2>/dev/null \
    || git -C "${HERMES_HOME}" pull --rebase origin main 2>/dev/null \
    || true
fi

if git -C "${HERMES_HOME}" push origin main; then
  log "pushed to origin main"
else
  log "WARN: git push failed (auth/network?)" >&2
  exit 1
fi
