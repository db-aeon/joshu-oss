#!/usr/bin/env bash
# Initialize git in $HERMES_HOME for learning-state sync to GitHub (scoped paths only).
set -euo pipefail

HERMES_HOME="${HERMES_HOME:-${HOME}/.hermes}"
DEPLOY_KEY="${JOSHU_HERMES_LEARNING_DEPLOY_KEY:-/etc/joshu/secrets/hermes-learning-github-deploy-key}"
GITHUB_REPO="${JOSHU_HERMES_LEARNING_GITHUB_REPO:-}"
GITHUB_REMOTE="${JOSHU_HERMES_LEARNING_GITHUB_REMOTE:-}"

log() { printf '[hermes-learning-git] %s\n' "$*"; }

if [[ -z "${GITHUB_REPO}" && -z "${GITHUB_REMOTE}" ]]; then
  log "skip: JOSHU_HERMES_LEARNING_GITHUB_REPO not set"
  exit 0
fi

if [[ -z "${GITHUB_REMOTE}" ]]; then
  GITHUB_REMOTE="git@github.com:${GITHUB_REPO}.git"
fi

write_gitignore() {
  cat > "${HERMES_HOME}/.gitignore" <<'EOF'
# Hermes learning sync — track only personal procedural state.
/*
!/.gitignore
!/skills/
!/skills/**
!/cron/
!/cron/**
!/memories/
!/memories/**
!/config.user.yaml
EOF
}

mkdir -p "${HERMES_HOME}/skills" "${HERMES_HOME}/cron" "${HERMES_HOME}/memories"
write_gitignore

if [[ ! -d "${HERMES_HOME}/.git" ]]; then
  log "git init ${HERMES_HOME}"
  git -C "${HERMES_HOME}" init -q -b main
  git -C "${HERMES_HOME}" \
    -c user.email="${JOSHU_HERMES_LEARNING_GIT_EMAIL:-hermes-learning@joshu.local}" \
    -c user.name="${JOSHU_HERMES_LEARNING_GIT_NAME:-Joshu Hermes Learning}" \
    add .gitignore skills cron memories config.user.yaml 2>/dev/null || true
  if ! git -C "${HERMES_HOME}" diff --cached --quiet 2>/dev/null; then
    git -C "${HERMES_HOME}" \
      -c user.email="${JOSHU_HERMES_LEARNING_GIT_EMAIL:-hermes-learning@joshu.local}" \
      -c user.name="${JOSHU_HERMES_LEARNING_GIT_NAME:-Joshu Hermes Learning}" \
      commit -q -m "joshu: hermes learning baseline"
  fi
fi

current_remote="$(git -C "${HERMES_HOME}" remote get-url origin 2>/dev/null || true)"
if [[ "${current_remote}" != "${GITHUB_REMOTE}" ]]; then
  if git -C "${HERMES_HOME}" remote get-url origin >/dev/null 2>&1; then
    git -C "${HERMES_HOME}" remote set-url origin "${GITHUB_REMOTE}"
  else
    git -C "${HERMES_HOME}" remote add origin "${GITHUB_REMOTE}"
  fi
  log "origin -> ${GITHUB_REMOTE}"
fi

if [[ -f "${DEPLOY_KEY}" ]]; then
  chmod 600 "${DEPLOY_KEY}" 2>/dev/null || true
  mkdir -p "${HERMES_HOME}/.ssh"
  cat > "${HERMES_HOME}/.ssh/config" <<EOF
Host github.com
  HostName github.com
  User git
  IdentityFile ${DEPLOY_KEY}
  IdentitiesOnly yes
  StrictHostKeyChecking accept-new
EOF
  chmod 600 "${HERMES_HOME}/.ssh/config" 2>/dev/null || true
  export GIT_SSH_COMMAND="ssh -F ${HERMES_HOME}/.ssh/config"
  log "configured SSH deploy key"
fi

# Pull if remote has commits (e.g. auto_init README); best-effort on first boot.
if [[ -n "${GIT_SSH_COMMAND:-}" || -f "${DEPLOY_KEY}" ]]; then
  git -C "${HERMES_HOME}" pull --rebase --allow-unrelated-histories origin main 2>/dev/null \
    || git -C "${HERMES_HOME}" pull --rebase origin main 2>/dev/null \
    || true
fi

log "ready"
