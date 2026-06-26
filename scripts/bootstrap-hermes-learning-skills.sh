#!/usr/bin/env bash
# Seed factory Joshu Hermes skills into writable $HERMES_HOME/skills/joshu/.
# Idempotent: skips when seed version stamp matches factory release.
#
# On release bump:
#   JOSHU_HERMES_SKILLS_SEED_MODE=merge (default) — LLM-merge each changed SKILL.md with box copy
#   JOSHU_HERMES_SKILLS_SEED_MODE=overwrite — rsync --delete from factory (hard reset only)
set -euo pipefail

HERMES_HOME="${HERMES_HOME:-${HOME}/.hermes}"
APP_DIR="${APP_DIR:-${JOSHU_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}}"
SOURCE_DIR="${JOSHU_HERMES_SKILLS_DIR:-${APP_DIR}/integrations/hermes/skills}"
TARGET_DIR="${HERMES_HOME}/skills/joshu"
STAMP_FILE="${TARGET_DIR}/.joshu-seed-version"
FACTORY_MANIFEST="${APP_DIR}/factory/manifest.yaml"
SEED_MODE="${JOSHU_HERMES_SKILLS_SEED_MODE:-merge}"
MERGE_SCRIPT="${APP_DIR}/scripts/merge-hermes-factory-skill.mjs"
NODE_BIN="${NODE_BIN:-node}"

log() { printf '[hermes-learning-seed] %s\n' "$*"; }

if [[ ! -d "${SOURCE_DIR}" ]]; then
  log "skip: source skills dir missing (${SOURCE_DIR})"
  exit 0
fi

desired_version=""
if [[ -f "${FACTORY_MANIFEST}" ]]; then
  desired_version="$(python3 - "${FACTORY_MANIFEST}" <<'PY'
import re
import sys
from pathlib import Path
text = Path(sys.argv[1]).read_text(encoding="utf-8")
m = re.search(r'^release:\s*"?([^"\n]+)"?\s*$', text, re.M)
print(m.group(1).strip() if m else "0")
PY
)"
fi
[[ -n "${desired_version}" ]] || desired_version="0"

current_version=""
if [[ -f "${STAMP_FILE}" ]]; then
  current_version="$(tr -d '[:space:]' < "${STAMP_FILE}")"
fi

if [[ -d "${TARGET_DIR}" && "${current_version}" == "${desired_version}" ]]; then
  log "up to date (${desired_version})"
  exit 0
fi

mkdir -p "${TARGET_DIR}"

seed_overwrite() {
  log "overwrite: rsync factory -> ${TARGET_DIR}"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete --exclude '.joshu-seed-version' "${SOURCE_DIR}/" "${TARGET_DIR}/"
  else
    rm -rf "${TARGET_DIR:?}"/*
    cp -a "${SOURCE_DIR}/." "${TARGET_DIR}/"
  fi
}

seed_merge() {
  log "merge: integrating factory release ${desired_version} into box skills"
  local merged=0 skipped=0 copied=0 failed=0

  while IFS= read -r -d '' skill_md; do
    local rel="${skill_md#${SOURCE_DIR}/}"
    local skill_dir
    skill_dir="$(dirname "${rel}")"
    local factory_skill="${SOURCE_DIR}/${skill_dir}"
    local target_skill="${TARGET_DIR}/${skill_dir}"
    local target_file="${TARGET_DIR}/${rel}"
    local factory_file="${SOURCE_DIR}/${rel}"

    mkdir -p "${target_skill}"

    if [[ ! -f "${target_file}" ]]; then
      if command -v rsync >/dev/null 2>&1; then
        rsync -a "${factory_skill}/" "${target_skill}/"
      else
        cp -a "${factory_skill}/." "${target_skill}/"
      fi
      copied=$((copied + 1))
      continue
    fi

    if cmp -s "${factory_file}" "${target_file}"; then
      skipped=$((skipped + 1))
      continue
    fi

    if [[ ! -f "${MERGE_SCRIPT}" ]]; then
      log "WARN: merge script missing — keeping box ${rel}"
      failed=$((failed + 1))
      continue
    fi

    local tmp="${target_file}.factory-merge.$$"
    if "${NODE_BIN}" "${MERGE_SCRIPT}" --factory "${factory_file}" --box "${target_file}" --out "${tmp}"; then
      mv "${tmp}" "${target_file}"
      merged=$((merged + 1))
      # Copy new factory reference files alongside SKILL.md (never delete box-only paths).
      if command -v rsync >/dev/null 2>&1; then
        rsync -a --ignore-existing "${factory_skill}/" "${target_skill}/"
      fi
    else
      rm -f "${tmp}"
      log "WARN: merge failed for ${rel} — keeping box version"
      failed=$((failed + 1))
    fi
  done < <(find "${SOURCE_DIR}" -name 'SKILL.md' -print0)

  log "merge done: ${merged} merged, ${copied} new, ${skipped} unchanged, ${failed} kept box on failure"
}

target_has_skills=false
if [[ -d "${TARGET_DIR}" ]]; then
  if find "${TARGET_DIR}" -mindepth 1 -maxdepth 3 -name 'SKILL.md' -print -quit | grep -q .; then
    target_has_skills=true
  fi
fi

if [[ "${SEED_MODE}" == "overwrite" ]]; then
  seed_overwrite
elif [[ "${target_has_skills}" != "true" ]]; then
  log "fresh install — copy factory (no box evolution to merge)"
  seed_overwrite
else
  seed_merge
fi

printf '%s\n' "${desired_version}" > "${STAMP_FILE}"
log "seeded ${SOURCE_DIR} -> ${TARGET_DIR} (release ${desired_version}, mode ${SEED_MODE})"
