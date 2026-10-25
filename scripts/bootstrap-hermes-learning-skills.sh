#!/usr/bin/env bash
# Seed factory Joshu Hermes skills into writable $HERMES_HOME/skills/joshu/.
#
# The seed key is a content hash of the factory skills tree, not a hand-bumped field.
# Each change to a factory skill changes the key, so the next boot or upgrade re-seeds.
# The script also keeps one hash per factory skill folder (.joshu-seed-skills.tsv),
# so it merges only the skills whose factory copy changed since the last seed.
# Box-evolved skills whose factory copy did not change stay as they are.
#
# Idempotent: exits early when the stamp .joshu-seed-version equals the seed key.
# One run at a time: vps-start.sh, the Hermes gateway warm-up, and operator scripts all run
# this script. A second run waits for the lock, then finds the stamp up to date.
#   JOSHU_HERMES_SKILLS_SEED_MODE=merge (default) — LLM-merge each changed SKILL.md with box copy
#   JOSHU_HERMES_SKILLS_SEED_MODE=overwrite — rsync --delete from factory (hard reset only)
set -euo pipefail

HERMES_HOME="${HERMES_HOME:-${HOME}/.hermes}"
APP_DIR="${APP_DIR:-${JOSHU_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}}"
SOURCE_DIR="${JOSHU_HERMES_SKILLS_DIR:-${APP_DIR}/integrations/hermes/skills}"
TARGET_DIR="${HERMES_HOME}/skills/joshu"
STAMP_FILE="${TARGET_DIR}/.joshu-seed-version"
STATE_FILE="${TARGET_DIR}/.joshu-seed-skills.tsv"
SEED_MODE="${JOSHU_HERMES_SKILLS_SEED_MODE:-merge}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MERGE_SCRIPT="${APP_DIR}/scripts/merge-hermes-factory-skill.mjs"
NODE_BIN="${NODE_BIN:-node}"

log() { printf '[hermes-learning-seed] %s\n' "$*"; }

if [[ ! -d "${SOURCE_DIR}" ]]; then
  log "skip: source skills dir missing (${SOURCE_DIR})"
  exit 0
fi

# Lock file at the root of $HERMES_HOME: the learning git ignores the root (only skills/,
# cron/, and memories/ go to GitHub). macOS has no flock; the tests run there without a lock.
LOCK_FILE="${HERMES_HOME}/.joshu-skills-seed.lock"
LOCK_WAIT_SEC="${JOSHU_HERMES_SKILLS_SEED_LOCK_WAIT_SEC:-1200}"
if command -v flock >/dev/null 2>&1; then
  mkdir -p "${HERMES_HOME}"
  exec 9>"${LOCK_FILE}"
  if ! flock -w "${LOCK_WAIT_SEC}" 9; then
    log "skip: a different skills seed holds ${LOCK_FILE} after ${LOCK_WAIT_SEC} seconds"
    exit 0
  fi
fi

# Prints "<skill dir>\t<hash>" for each factory skill folder, then "*\t<seed key>".
factory_hashes="$(python3 "${SCRIPT_DIR}/hermes-skills-seed-key.py" "${SOURCE_DIR}")"
seed_key="$(printf '%s\n' "${factory_hashes}" | awk -F'\t' '$1 == "*" { print $2 }')"

current_key=""
if [[ -f "${STAMP_FILE}" ]]; then
  current_key="$(tr -d '[:space:]' < "${STAMP_FILE}")"
fi

if [[ -d "${TARGET_DIR}" && "${current_key}" == "${seed_key}" ]]; then
  log "up to date (${seed_key})"
  exit 0
fi

mkdir -p "${TARGET_DIR}"

# State of the last seed, one line per skill folder:
#   <skill dir>\t<factory folder hash>\t<sha256 of the box SKILL.md when it is the factory copy>
# The third field is "merged" when the box SKILL.md holds box evolution (after an LLM merge).
seeded_field() {
  [[ -f "${STATE_FILE}" ]] || return 0
  awk -F'\t' -v d="$1" -v f="$2" '$1 == d { print $f; exit }' "${STATE_FILE}"
}
file_sha() { python3 -c 'import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$1"; }

NEW_STATE="${STATE_FILE}.new.$$"
: > "${NEW_STATE}"
trap 'rm -f "${NEW_STATE}"' EXIT
record() { printf '%s\t%s\t%s\n' "$1" "$2" "${3:-$(file_sha "${TARGET_DIR}/$1/SKILL.md")}" >> "${NEW_STATE}"; }

copy_dir() {
  if command -v rsync >/dev/null 2>&1; then
    rsync -a "$@"
  else
    cp -a "${1%/}/." "${2}"
  fi
}

seed_overwrite() {
  log "overwrite: rsync factory -> ${TARGET_DIR}"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete --exclude '.joshu-seed-version' --exclude '.joshu-seed-skills.tsv' \
      "${SOURCE_DIR}/" "${TARGET_DIR}/"
  else
    find "${TARGET_DIR}" -mindepth 1 -maxdepth 1 \
      ! -name '.joshu-seed-version' ! -name '.joshu-seed-skills.tsv' -exec rm -rf {} +
    cp -a "${SOURCE_DIR}/." "${TARGET_DIR}/"
  fi
  while IFS=$'\t' read -r skill_dir hash; do
    [[ "${skill_dir}" == "*" ]] || record "${skill_dir}" "${hash}"
  done <<< "${factory_hashes}"
}

failed=0

seed_merge() {
  log "merge: integrating factory skills ${seed_key} into box skills"
  local merged=0 skipped=0 copied=0 unchanged=0 updated=0

  while IFS=$'\t' read -r skill_dir hash; do
    [[ "${skill_dir}" == "*" ]] && continue
    local factory_skill="${SOURCE_DIR}/${skill_dir}"
    local target_skill="${TARGET_DIR}/${skill_dir}"
    local factory_file="${factory_skill}/SKILL.md"
    local target_file="${target_skill}/SKILL.md"

    if [[ ! -f "${target_file}" ]]; then
      mkdir -p "${target_skill}"
      copy_dir "${factory_skill}/" "${target_skill}/"
      record "${skill_dir}" "${hash}"
      copied=$((copied + 1))
      continue
    fi

    # Factory copy not changed since the last seed: keep the box copy (it can be box-evolved).
    if [[ "$(seeded_field "${skill_dir}" 2)" == "${hash}" ]]; then
      awk -F'\t' -v d="${skill_dir}" '$1 == d { print; exit }' "${STATE_FILE}" >> "${NEW_STATE}"
      unchanged=$((unchanged + 1))
      continue
    fi

    # Box copy is the one the last seed wrote (no box evolution): take the factory copy.
    if [[ "$(seeded_field "${skill_dir}" 3)" == "$(file_sha "${target_file}")" ]]; then
      copy_dir "${factory_skill}/" "${target_skill}/"
      record "${skill_dir}" "${hash}"
      updated=$((updated + 1))
      continue
    fi

    if cmp -s "${factory_file}" "${target_file}"; then
      copy_dir --ignore-existing "${factory_skill}/" "${target_skill}/"
      record "${skill_dir}" "${hash}"
      skipped=$((skipped + 1))
      continue
    fi

    if [[ ! -f "${MERGE_SCRIPT}" ]]; then
      log "WARN: merge script missing — keeping box ${skill_dir}/SKILL.md"
      failed=$((failed + 1))
      continue
    fi

    local tmp="${target_file}.factory-merge.$$"
    if "${NODE_BIN}" "${MERGE_SCRIPT}" --factory "${factory_file}" --box "${target_file}" --out "${tmp}"; then
      mv "${tmp}" "${target_file}"
      # Copy new factory reference files alongside SKILL.md (never delete box-only paths).
      copy_dir --ignore-existing "${factory_skill}/" "${target_skill}/"
      record "${skill_dir}" "${hash}" merged
      merged=$((merged + 1))
    else
      rm -f "${tmp}"
      log "WARN: merge failed for ${skill_dir}/SKILL.md — keeping box version (retry on next run)"
      failed=$((failed + 1))
    fi
  done <<< "${factory_hashes}"

  log "merge done: ${merged} merged, ${updated} updated from factory, ${copied} new, ${skipped} same as factory, ${unchanged} factory unchanged, ${failed} kept box on failure"
}

target_has_skills=false
if find "${TARGET_DIR}" -mindepth 1 -maxdepth 3 -name 'SKILL.md' -print -quit | grep -q .; then
  target_has_skills=true
fi

if [[ "${SEED_MODE}" == "overwrite" ]]; then
  seed_overwrite
elif [[ "${target_has_skills}" != "true" ]]; then
  log "fresh install — copy factory (no box evolution to merge)"
  seed_overwrite
else
  seed_merge
fi

mv "${NEW_STATE}" "${STATE_FILE}"

# A failed merge leaves the old stamp, so the next run retries only the failed skills.
if [[ "${failed}" -gt 0 ]]; then
  log "seeded with ${failed} failure(s); stamp not updated (mode ${SEED_MODE})"
  exit 0
fi

printf '%s\n' "${seed_key}" > "${STAMP_FILE}"
log "seeded ${SOURCE_DIR} -> ${TARGET_DIR} (seed key ${seed_key}, mode ${SEED_MODE})"
