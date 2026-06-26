#!/usr/bin/env bash
# gbrain sync requires git-initialized paths:
#   - ${AROZ_DATA}/files/users/ for Joshu stage commits (git add -A before sync_brain)
#   - each user Desktop/ for federated source sync (gbrain 0.40+ requires .git at --path)
# Never the joshu application repo.
set -euo pipefail

resolve_gbrain_git_root() {
  local path="$1"
  if [[ -n "${JOSHU_GBRAIN_GIT_ROOT:-}" ]]; then
    echo "${JOSHU_GBRAIN_GIT_ROOT}"
    return 0
  fi
  if [[ "$(basename "${path}")" == "users" && "$(basename "$(dirname "${path}")")" == "files" ]]; then
    echo "$(cd "${path}" && pwd)"
    return 0
  fi
  if [[ "$(basename "${path}")" == "Desktop" ]]; then
    echo "$(cd "${path}/../.." && pwd)"
    return 0
  fi
  echo "${path}"
}

gbrain_git_root_is_safe() {
  local git_root="$1"
  case "${git_root}" in
    */.local/arozos-data/files/users | */var/lib/arozos/files/users)
      return 0
      ;;
  esac
  local app_root="${JOSHU_APP_ROOT:-${APP_DIR:-}}"
  if [[ -n "${app_root}" && -f "${app_root}/package.json" && -f "${app_root}/scripts/start-gbrain.sh" ]]; then
    app_root="$(cd "${app_root}" && pwd)"
    if [[ "${git_root}" == "${app_root}" || "${git_root}" == "${app_root}/"* ]]; then
      echo "[gbrain-git] refusing git at ${git_root}: use .local/arozos-data/files/users, not joshu app root" >&2
      return 1
    fi
  fi
  return 0
}

# Empty or partial .git (mkdir without git init) makes git add/commit fail with
# "not a git repository". Drop broken roots so init + baseline can proceed.
gbrain_git_repair_broken_root() {
  local git_root="$1"
  [[ -n "${git_root}" && -e "${git_root}/.git" ]] || return 0
  if git -C "${git_root}" rev-parse --git-dir >/dev/null 2>&1; then
    return 0
  fi
  echo "[gbrain-git] removing invalid .git at ${git_root}" >&2
  rm -rf "${git_root}/.git"
}

gbrain_git_commit_at() {
  local root="$1"
  local msg="$2"
  git -C "${root}" add -A
  if git -C "${root}" diff --cached --quiet; then
    git -C "${root}" \
      -c user.email="${GBRAIN_GIT_EMAIL:-gbrain@joshu.local}" \
      -c user.name="${GBRAIN_GIT_NAME:-Joshu gbrain}" \
      commit --allow-empty -q -m "${msg}"
  else
    git -C "${root}" \
      -c user.email="${GBRAIN_GIT_EMAIL:-gbrain@joshu.local}" \
      -c user.name="${GBRAIN_GIT_NAME:-Joshu gbrain}" \
      commit -q -m "${msg}"
  fi
}

# gbrain federated sources use --path <Desktop>; sync requires .git at that directory.
ensure_desktop_source_git() {
  local desktop="$1"
  [[ -n "${desktop}" && -d "${desktop}" && "$(basename "${desktop}")" == "Desktop" ]] || return 0

  gbrain_git_repair_broken_root "${desktop}"

  if git -C "${desktop}" rev-parse HEAD >/dev/null 2>&1; then
    return 0
  fi

  if [[ ! -e "${desktop}/.git" ]]; then
    echo "[gbrain-git] initializing federated git at ${desktop}"
    git -C "${desktop}" init -q
  fi

  echo "[gbrain-git] creating Desktop baseline commit at ${desktop}"
  gbrain_git_commit_at "${desktop}" "gbrain Desktop sync baseline"
}

ensure_gbrain_git_repo() {
  local repo_path="$1"
  [[ -n "${repo_path}" && -d "${repo_path}" ]] || return 0

  local git_root
  git_root="$(resolve_gbrain_git_root "${repo_path}")"
  gbrain_git_root_is_safe "${git_root}" || return 1

  gbrain_git_repair_broken_root "${git_root}"

  if [[ -e "${git_root}/.git" ]]; then
    :
  elif git -C "${git_root}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    local toplevel git_abs
    toplevel="$(git -C "${git_root}" rev-parse --show-toplevel 2>/dev/null || true)"
    git_abs="$(cd "${git_root}" && pwd)"
    if [[ "${toplevel}" != "${git_abs}" ]]; then
      echo "[gbrain-git] files/users inside ${toplevel}; initializing nested git at ${git_root}" >&2
      git -C "${git_root}" init -q
    fi
  else
    echo "[gbrain-git] initializing git at ${git_root}"
    git -C "${git_root}" init -q
  fi

  if git -C "${git_root}" rev-parse HEAD >/dev/null 2>&1; then
    return 0
  fi

  echo "[gbrain-git] creating baseline commit at ${git_root}"
  gbrain_git_commit_at "${git_root}" "gbrain sync baseline"

  if [[ "$(basename "${repo_path}")" == "Desktop" ]]; then
    ensure_desktop_source_git "${repo_path}"
  fi
}
