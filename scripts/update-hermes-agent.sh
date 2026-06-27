#!/usr/bin/env bash
# Safely update the external Hermes Agent checkout and keep deploy/RELEASE.json in sync.
#
# See docs/hermes-customizations.md and docs/local-installation.md.
#
# Usage:
#   scripts/update-hermes-agent.sh update [--tag v2026.5.7] [--dry-run] [--force]
#   scripts/update-hermes-agent.sh rollback [snapshot-id]
#   scripts/update-hermes-agent.sh status
#   scripts/update-hermes-agent.sh list
#   scripts/update-hermes-agent.sh verify
#
# Snapshots live under .local/hermes-update-snapshots/ (gitignored).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HERMES_DIR="${HERMES_DIR:-/Users/danbenyamin/Documents/dev/hermes-agent}"
HERMES_UPSTREAM_REPO="${HERMES_UPSTREAM_REPO:-https://github.com/NousResearch/hermes-agent.git}"
HERMES_UPSTREAM_REMOTE="${HERMES_UPSTREAM_REMOTE:-upstream}"
SNAPSHOT_ROOT="${SNAPSHOT_ROOT:-${ROOT_DIR}/.local/hermes-update-snapshots}"
LATEST_LINK="${SNAPSHOT_ROOT}/latest"

RELEASE_JSON="${ROOT_DIR}/deploy/RELEASE.json"
ENV_EXAMPLE="${ROOT_DIR}/.env.example"
HITL_PATCH_SCRIPT="${ROOT_DIR}/scripts/apply-hermes-hitl-patch.sh"
LANGFUSE_SYSTEM_PATCH_SCRIPT="${ROOT_DIR}/scripts/apply-hermes-langfuse-system-patch.sh"
CONTENT_FILTER_PATCH_SCRIPT="${ROOT_DIR}/scripts/apply-hermes-content-filter-patch.sh"
INVOKE_TOOL_POST_HOOK_PATCH_SCRIPT="${ROOT_DIR}/scripts/apply-hermes-invoke-tool-post-hook-patch.sh"

# Match deploy/Dockerfile image extras; local dev may use broader extras via HERMES_LOCAL_EXTRAS.
HERMES_IMAGE_EXTRAS="${HERMES_IMAGE_EXTRAS:-cli,pty,mcp,acp,google,bedrock,web,youtube,voice,messaging}"
# Default to image parity for fast, reliable installs. Override with all,dev for full Hermes dev.
HERMES_LOCAL_EXTRAS="${HERMES_LOCAL_EXTRAS:-${HERMES_IMAGE_EXTRAS}}"
HERMES_AIOHTTP_CONSTRAINT="${HERMES_AIOHTTP_CONSTRAINT:-aiohttp>=3.13.3,<4}"

# Joshu expects these after Hermes dependency refreshes (docs/local-installation.md).
HINDSIGHT_PIP_SPECS=(
  "hindsight-api-slim[embedded-db]==0.7.2"
  "hindsight-client==0.7.2"
  "pg0-embedded==0.14.2"
)
# Optional Hermes bundled plugin (observability/langfuse); not in [all] extras.
HERMES_OBSERVABILITY_PIP_SPECS=(langfuse)

log() {
  printf '[hermes-update] %s\n' "$*"
}

die() {
  printf '[hermes-update] error: %s\n' "$*" >&2
  exit 1
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    die "missing required command: $1"
  fi
}

timestamp_id() {
  date -u +"%Y%m%dT%H%M%SZ"
}

read_deploy_hermes_ref() {
  python3 - "${RELEASE_JSON}" <<'PY'
import json
import sys
from pathlib import Path

data = json.loads(Path(sys.argv[1]).read_text())
ref = (data.get("hermesRef") or "").strip()
if not ref:
    raise SystemExit("Could not read hermesRef from deploy/RELEASE.json")
print(ref)
PY
}

write_deploy_hermes_ref() {
  local new_ref="$1"
  python3 - "${RELEASE_JSON}" "${new_ref}" <<'PY'
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

path = Path(sys.argv[1])
new_ref = sys.argv[2]
data = json.loads(path.read_text())
data["hermesRef"] = new_ref
data["builtAt"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
path.write_text(json.dumps(data, indent=2) + "\n")
PY
}

write_env_example_hermes_ref() {
  local new_ref="$1"
  if [[ ! -f "${ENV_EXAMPLE}" ]]; then
    return 0
  fi
  python3 - "${ENV_EXAMPLE}" "${new_ref}" <<'PY'
import re
import sys
from pathlib import Path

path = Path(sys.argv[1])
new_ref = sys.argv[2]
text = path.read_text()
pattern = r'(# HERMES_AGENT_REF=)[^\n]+'
if not re.search(pattern, text):
    raise SystemExit("Could not find commented HERMES_AGENT_REF in .env.example")

def replace_ref(match: re.Match[str]) -> str:
    return f"{match.group(1)}{new_ref}"

updated = re.sub(pattern, replace_ref, text, count=1)
path.write_text(updated)
PY
}

resolve_release() {
  local requested_tag="${1:-}"
  local tag_name commit_sha published_at

  if [[ -n "${requested_tag}" ]]; then
    tag_name="${requested_tag}"
    if command -v gh >/dev/null 2>&1; then
      require_command git
      commit_sha="$(git ls-remote "${HERMES_UPSTREAM_REPO}" "refs/tags/${tag_name}^{}" | awk '{print $1}' | head -n1)"
    fi
    if [[ -z "${commit_sha:-}" ]]; then
      require_command git
      # Peel annotated tags so we always resolve to a commit SHA.
      commit_sha="$(git ls-remote "${HERMES_UPSTREAM_REPO}" "refs/tags/${tag_name}^{}" | awk '{print $1}' | head -n1)"
    fi
    [[ -n "${commit_sha:-}" ]] || die "could not resolve tag ${tag_name} on ${HERMES_UPSTREAM_REPO}"
    published_at="(requested tag)"
  else
    require_command gh
    tag_name="$(gh api repos/NousResearch/hermes-agent/releases/latest --jq '.tag_name')"
    published_at="$(gh api repos/NousResearch/hermes-agent/releases/latest --jq '.published_at')"
    require_command git
    commit_sha="$(git ls-remote "${HERMES_UPSTREAM_REPO}" "refs/tags/${tag_name}^{}" | awk '{print $1}' | head -n1)"
  fi

  printf '%s\n%s\n%s\n' "${tag_name}" "${commit_sha}" "${published_at}"
}

load_release_info() {
  local requested_tag="${1:-}"
  local info
  info="$(resolve_release "${requested_tag}")"
  RELEASE_TAG="$(printf '%s\n' "${info}" | sed -n '1p')"
  RELEASE_COMMIT="$(printf '%s\n' "${info}" | sed -n '2p')"
  RELEASE_PUBLISHED_AT="$(printf '%s\n' "${info}" | sed -n '3p')"
  [[ -n "${RELEASE_TAG}" && -n "${RELEASE_COMMIT}" ]] || die "could not resolve Hermes release metadata"
}

hermes_git_head() {
  git -C "${HERMES_DIR}" rev-parse HEAD
}

hermes_has_adoption_support() {
  rg -q "adopt_existing_tab" "${HERMES_DIR}/tools/browser_camofox.py" 2>/dev/null
}

create_snapshot() {
  local snapshot_id="$1"
  local target_tag="$2"
  local target_sha="$3"
  local snapshot_dir="${SNAPSHOT_ROOT}/${snapshot_id}"

  mkdir -p "${snapshot_dir}"

  local deploy_ref hermes_head hermes_branch hermes_status
  deploy_ref="$(read_deploy_hermes_ref)"
  hermes_head="$(hermes_git_head)"
  hermes_branch="$(git -C "${HERMES_DIR}" branch --show-current 2>/dev/null || true)"
  hermes_status="$(git -C "${HERMES_DIR}" status --porcelain || true)"

  cp "${RELEASE_JSON}" "${snapshot_dir}/RELEASE.json"
  if [[ -f "${ENV_EXAMPLE}" ]]; then
    cp "${ENV_EXAMPLE}" "${snapshot_dir}/.env.example"
  fi

  if [[ -x "${HERMES_DIR}/venv/bin/pip" ]]; then
    "${HERMES_DIR}/venv/bin/pip" freeze > "${snapshot_dir}/hermes-venv.freeze.txt"
  else
    : > "${snapshot_dir}/hermes-venv.freeze.txt"
  fi

  local hermes_dirty_flag="0"
  if [[ -n "${hermes_status}" ]]; then
    hermes_dirty_flag="1"
  fi

  HERMES_SNAPSHOT_DIR="${snapshot_dir}" \
  HERMES_SNAPSHOT_ID="${snapshot_id}" \
  HERMES_SNAPSHOT_DEPLOY_REF="${deploy_ref}" \
  HERMES_SNAPSHOT_HEAD="${hermes_head}" \
  HERMES_SNAPSHOT_BRANCH="${hermes_branch}" \
  HERMES_SNAPSHOT_DIRTY="${hermes_dirty_flag}" \
  HERMES_SNAPSHOT_TARGET_TAG="${target_tag}" \
  HERMES_SNAPSHOT_TARGET_SHA="${target_sha}" \
  HERMES_SNAPSHOT_ROOT_DIR="${ROOT_DIR}" \
  HERMES_SNAPSHOT_HERMES_DIR="${HERMES_DIR}" \
  HERMES_SNAPSHOT_UPSTREAM_REPO="${HERMES_UPSTREAM_REPO}" \
  HERMES_SNAPSHOT_UPSTREAM_REMOTE="${HERMES_UPSTREAM_REMOTE}" \
  python3 - <<'PY'
import json
import os
from datetime import datetime, timezone
from pathlib import Path

snapshot_dir = Path(os.environ["HERMES_SNAPSHOT_DIR"])
snapshot_dir.mkdir(parents=True, exist_ok=True)
snapshot_dir.joinpath("manifest.json").write_text(
    json.dumps(
        {
            "snapshot_id": os.environ["HERMES_SNAPSHOT_ID"],
            "created_at_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "joshu_root": os.environ["HERMES_SNAPSHOT_ROOT_DIR"],
            "hermes_dir": os.environ["HERMES_SNAPSHOT_HERMES_DIR"],
            "hermes_upstream_repo": os.environ["HERMES_SNAPSHOT_UPSTREAM_REPO"],
            "hermes_upstream_remote": os.environ["HERMES_SNAPSHOT_UPSTREAM_REMOTE"],
            "before": {
                "deploy_hermes_agent_ref": os.environ["HERMES_SNAPSHOT_DEPLOY_REF"],
                "hermes_git_head": os.environ["HERMES_SNAPSHOT_HEAD"],
                "hermes_git_branch": os.environ["HERMES_SNAPSHOT_BRANCH"],
                "hermes_git_dirty": os.environ["HERMES_SNAPSHOT_DIRTY"] == "1",
            },
            "planned": {
                "release_tag": os.environ["HERMES_SNAPSHOT_TARGET_TAG"],
                "release_commit": os.environ["HERMES_SNAPSHOT_TARGET_SHA"],
            },
        },
        indent=2,
    )
    + "\n"
)
PY

  ln -sfn "${snapshot_id}" "${LATEST_LINK}"
  printf '%s\n' "${snapshot_dir}"
}

restore_snapshot() {
  local snapshot_id="${1:-}"
  local snapshot_dir

  if [[ -z "${snapshot_id}" ]]; then
    [[ -L "${LATEST_LINK}" || -d "${LATEST_LINK}" ]] || die "no snapshots found under ${SNAPSHOT_ROOT}"
    snapshot_dir="$(cd "${LATEST_LINK}" && pwd)"
    snapshot_id="$(basename "${snapshot_dir}")"
  else
    snapshot_dir="${SNAPSHOT_ROOT}/${snapshot_id}"
  fi

  [[ -f "${snapshot_dir}/manifest.json" ]] || die "snapshot not found: ${snapshot_dir}"

  log "rolling back to snapshot ${snapshot_id}"

  cp "${snapshot_dir}/RELEASE.json" "${RELEASE_JSON}"
  if [[ -f "${snapshot_dir}/.env.example" ]]; then
    cp "${snapshot_dir}/.env.example" "${ENV_EXAMPLE}"
  fi

  local hermes_head
  hermes_head="$(python3 - "${snapshot_dir}/manifest.json" <<'PY'
import json
import sys
from pathlib import Path
data = json.loads(Path(sys.argv[1]).read_text())
print(data["before"]["hermes_git_head"])
PY
)"

  git -C "${HERMES_DIR}" fetch "${HERMES_UPSTREAM_REMOTE}" --tags --prune || true
  git -C "${HERMES_DIR}" checkout --detach "${hermes_head}"

  if [[ -s "${snapshot_dir}/hermes-venv.freeze.txt" && -x "${HERMES_DIR}/venv/bin/pip" ]]; then
    log "restoring Hermes virtualenv packages from snapshot freeze"
    "${HERMES_DIR}/venv/bin/pip" install -r "${snapshot_dir}/hermes-venv.freeze.txt"
  fi

  if [[ -x "${HITL_PATCH_SCRIPT}" ]]; then
    HERMES_DIR="${HERMES_DIR}" bash "${HITL_PATCH_SCRIPT}" || true
  fi
  if [[ -x "${LANGFUSE_SYSTEM_PATCH_SCRIPT}" ]]; then
    HERMES_DIR="${HERMES_DIR}" bash "${LANGFUSE_SYSTEM_PATCH_SCRIPT}" || true
  fi

  if command -v node >/dev/null 2>&1; then
    node "${ROOT_DIR}/scripts/sync-vps-hermes-pin.mjs" || true
  fi

  log "rollback complete"
  log "deploy pin: $(read_deploy_hermes_ref)"
  log "hermes HEAD: $(hermes_git_head)"
}

install_hermes_dependencies() {
  local mode="$1" # local | image-parity
  local extras

  [[ -d "${HERMES_DIR}/venv" ]] || die "missing ${HERMES_DIR}/venv; create a venv before updating"

  extras="${HERMES_LOCAL_EXTRAS}"
  if [[ "${mode}" == "image-parity" ]]; then
    extras="${HERMES_IMAGE_EXTRAS}"
  fi

  log "reinstalling Hermes editable install (.[${extras}]) in ${HERMES_DIR}"
  (
    cd "${HERMES_DIR}"
    ./venv/bin/pip install --upgrade pip setuptools wheel
    ./venv/bin/pip install -e ".[${extras}]" "${HERMES_AIOHTTP_CONSTRAINT}"
    log "restoring Joshu Hindsight packages in Hermes venv"
    ./venv/bin/pip install "${HINDSIGHT_PIP_SPECS[@]}"
    log "restoring Langfuse SDK for observability/langfuse plugin"
    ./venv/bin/pip install "${HERMES_OBSERVABILITY_PIP_SPECS[@]}"
  )
}

checkout_release_commit() {
  local commit_sha="$1"

  if ! git -C "${HERMES_DIR}" remote get-url "${HERMES_UPSTREAM_REMOTE}" >/dev/null 2>&1; then
    git -C "${HERMES_DIR}" remote add "${HERMES_UPSTREAM_REMOTE}" "${HERMES_UPSTREAM_REPO}"
  fi

  git -C "${HERMES_DIR}" fetch "${HERMES_UPSTREAM_REMOTE}" --tags --prune
  git -C "${HERMES_DIR}" checkout --detach "${commit_sha}"
}

apply_hitl_patch_if_needed() {
  [[ -x "${HITL_PATCH_SCRIPT}" ]] || die "missing patch helper: ${HITL_PATCH_SCRIPT}"
  HERMES_DIR="${HERMES_DIR}" bash "${HITL_PATCH_SCRIPT}"
}

apply_langfuse_system_patch_if_needed() {
  if [[ -x "${LANGFUSE_SYSTEM_PATCH_SCRIPT}" ]]; then
    HERMES_DIR="${HERMES_DIR}" bash "${LANGFUSE_SYSTEM_PATCH_SCRIPT}" || true
  fi
}

apply_skill_evolution_patch_if_needed() {
  local script="${ROOT_DIR}/scripts/apply-hermes-skill-evolution-patch.sh"
  if [[ -x "${script}" ]]; then
    HERMES_DIR="${HERMES_DIR}" bash "${script}" || true
  fi
}

apply_content_filter_patch_if_needed() {
  if [[ -x "${CONTENT_FILTER_PATCH_SCRIPT}" ]]; then
    HERMES_DIR="${HERMES_DIR}" bash "${CONTENT_FILTER_PATCH_SCRIPT}" || true
  fi
  if [[ -x "${INVOKE_TOOL_POST_HOOK_PATCH_SCRIPT}" ]]; then
    HERMES_DIR="${HERMES_DIR}" bash "${INVOKE_TOOL_POST_HOOK_PATCH_SCRIPT}" || true
  fi
}

verify_hermes_checkout() {
  hermes_has_adoption_support || die "Hermes checkout is missing tools/browser_camofox.py adopt_existing_tab support (required for Joshu)"
  log "verified generic Camofox adopt_existing_tab support"
}

cmd_status() {
  local deploy_ref hermes_head
  deploy_ref="$(read_deploy_hermes_ref)"
  hermes_head="$(hermes_git_head)"

  log "Joshu deploy pin (deploy/RELEASE.json hermesRef): ${deploy_ref}"
  log "Local Hermes checkout HEAD: ${hermes_head}"

  if [[ -x "${HERMES_DIR}/venv/bin/hermes" ]]; then
  log "hermes update --check:"
    (cd "${HERMES_DIR}" && "${HERMES_DIR}/venv/bin/hermes" update --check) || true
  fi

  if command -v gh >/dev/null 2>&1; then
    load_release_info ""
    log "latest upstream release: ${RELEASE_TAG} @ ${RELEASE_COMMIT} (${RELEASE_PUBLISHED_AT})"
    if [[ "${deploy_ref}" == "${RELEASE_COMMIT}" || "${hermes_head}" == "${RELEASE_COMMIT}" ]]; then
      log "local/deploy pin matches latest release commit"
    else
      log "latest release is ahead of current pin/checkout"
    fi
  fi
}

cmd_list() {
  [[ -d "${SNAPSHOT_ROOT}" ]] || die "no snapshots yet (${SNAPSHOT_ROOT})"
  ls -1dt "${SNAPSHOT_ROOT}"/* 2>/dev/null | while read -r dir; do
    [[ "$(basename "${dir}")" == "latest" ]] && continue
    if [[ -f "${dir}/manifest.json" ]]; then
      python3 - "${dir}/manifest.json" <<'PY'
import json
import sys
from pathlib import Path
data = json.loads(Path(sys.argv[1]).read_text())
before = data["before"]
planned = data.get("planned", {})
print(
    f"{data['snapshot_id']}  deploy={before.get('deploy_hermes_agent_ref', before.get('modal_hermes_agent_ref', '?'))[:12]}  "
    f"hermes={before['hermes_git_head'][:12]}  "
    f"-> {planned.get('release_tag', '?')}@{planned.get('release_commit', '?')[:12]}"
)
PY
    fi
  done
}

cmd_verify() {
  verify_hermes_checkout
  if [[ -x "${HERMES_DIR}/venv/bin/hermes" ]]; then
    "${HERMES_DIR}/venv/bin/hermes" --version || true
  fi
  log "optional local checks:"
  log "  cd ${ROOT_DIR} && npm run dev:arozos"
  log "  cd ${ROOT_DIR} && npm run hindsight:smoke"
  log "  cd ${ROOT_DIR} && npm run vps:build-image"
}

cmd_update() {
  local requested_tag="" dry_run=0 force=0 skip_deploy_pin=0

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --tag)
        requested_tag="${2:-}"
        shift 2
        ;;
      --dry-run)
        dry_run=1
        shift
        ;;
      --force)
        force=1
        shift
        ;;
      --skip-deploy-pin)
        skip_deploy_pin=1
        shift
        ;;
      *)
        die "unknown update flag: $1"
        ;;
    esac
  done

  require_command git
  require_command python3
  [[ -d "${HERMES_DIR}/.git" ]] || die "Hermes checkout not found: ${HERMES_DIR}"

  load_release_info "${requested_tag}"

  local deploy_ref hermes_head dirty
  deploy_ref="$(read_deploy_hermes_ref)"
  hermes_head="$(hermes_git_head)"
  dirty="$(git -C "${HERMES_DIR}" status --porcelain || true)"

  log "target release: ${RELEASE_TAG} (${RELEASE_PUBLISHED_AT})"
  log "target commit: ${RELEASE_COMMIT}"
  log "current deploy pin: ${deploy_ref}"
  log "current hermes HEAD: ${hermes_head}"

  if [[ -n "${dirty}" && "${force}" -ne 1 && "${dry_run}" -ne 1 ]]; then
    die "Hermes checkout has local changes; commit/stash them or pass --force"
  fi
  if [[ -n "${dirty}" && "${dry_run}" -eq 1 ]]; then
    log "warning: Hermes checkout has local changes (dry run continues)"
  fi

  if [[ "${deploy_ref}" == "${RELEASE_COMMIT}" && "${hermes_head}" == "${RELEASE_COMMIT}" ]]; then
    log "already on requested release commit; refreshing dependencies only"
  fi

  if [[ "${dry_run}" -eq 1 ]]; then
    log "dry run only; no changes made"
    exit 0
  fi

  local snapshot_id snapshot_dir
  snapshot_id="$(timestamp_id)"
  snapshot_dir="$(create_snapshot "${snapshot_id}" "${RELEASE_TAG}" "${RELEASE_COMMIT}")"
  log "snapshot saved: ${snapshot_dir}"
  log "rollback with: scripts/update-hermes-agent.sh rollback ${snapshot_id}"

  checkout_release_commit "${RELEASE_COMMIT}"
  install_hermes_dependencies local
  apply_hitl_patch_if_needed
  apply_langfuse_system_patch_if_needed
  apply_skill_evolution_patch_if_needed
  apply_content_filter_patch_if_needed
  verify_hermes_checkout

  if [[ "${skip_deploy_pin}" -ne 1 ]]; then
    write_deploy_hermes_ref "${RELEASE_COMMIT}"
    write_env_example_hermes_ref "${RELEASE_COMMIT}"
    log "updated deploy/RELEASE.json hermesRef and .env.example"
    if command -v node >/dev/null 2>&1; then
      node "${ROOT_DIR}/scripts/sync-vps-hermes-pin.mjs"
      log "synced deploy/Dockerfile from deploy/RELEASE.json"
    fi
  fi

  log "update complete"
  log "next steps:"
  log "  1. Restart local stack and exercise HITL Camofox adoption"
  log "  2. cd ${ROOT_DIR} && npm run hindsight:smoke"
  log "  3. cd ${ROOT_DIR} && npm run vps:build-image"
  log "If testing fails: scripts/update-hermes-agent.sh rollback ${snapshot_id}"
}

usage() {
  cat <<EOF
Usage:
  scripts/update-hermes-agent.sh update [--tag TAG] [--dry-run] [--force] [--skip-deploy-pin]
  scripts/update-hermes-agent.sh rollback [snapshot-id]
  scripts/update-hermes-agent.sh status
  scripts/update-hermes-agent.sh list
  scripts/update-hermes-agent.sh verify

Environment:
  HERMES_DIR                 Local Hermes checkout (default: ${HERMES_DIR})
  HERMES_UPSTREAM_REPO       Upstream git URL (default: NousResearch/hermes-agent)
  HERMES_UPSTREAM_REMOTE     Remote name for upstream fetches (default: upstream)
  SNAPSHOT_ROOT              Snapshot directory (default: ${SNAPSHOT_ROOT})
  HERMES_IMAGE_EXTRAS        pip extras; must match deploy/Dockerfile install line
  HERMES_LOCAL_EXTRAS        pip extras for local venv (defaults to HERMES_IMAGE_EXTRAS)
EOF
}

main() {
  local cmd="${1:-update}"
  shift || true

  case "${cmd}" in
    update)
      cmd_update "$@"
      ;;
    rollback)
      restore_snapshot "${1:-}"
      ;;
    status)
      cmd_status
      ;;
    list)
      cmd_list
      ;;
    verify)
      cmd_verify
      ;;
    -h|--help|help)
      usage
      ;;
    *)
      usage >&2
      die "unknown command: ${cmd}"
      ;;
  esac
}

main "$@"
