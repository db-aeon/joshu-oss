#!/usr/bin/env bash
# Remove old release images after a successful upgrade (change prune-release-images).
#
# Each upgrade pulls new release images, and Docker keeps the old ones. A sandbox image is
# about 8 GB, so a box that gets many releases fills its disk.
#
# For each repository of the current release images, the script keeps:
#   - the image of each current release image reference,
#   - the newest other image (the image of the previous release, for a rollback),
#   - each image that a container uses, running or stopped.
# The script removes the other images of those repositories, then the dangling images.
# It never uses --force, so Docker refuses to remove an image that a container uses.
# It never touches volumes or images of other repositories that have a tag.
#
# Environment:
#   JOSHU_IMAGE_REF, JOSHU_VOICE_IMAGE_REF, JOSHU_INSTANCE_AGENT_IMAGE_REF
#                                 current release image references (read from ENV_FILE when unset)
#   ENV_FILE                      default /etc/joshu/instance.env
#   JOSHU_PRUNE_RELEASE_IMAGES=0  do nothing
#   DRY_RUN=1                     print what the script would remove, remove nothing
#
# Callers: the instance agent after the apply step of an update or rollback
# (packages/instance-agent/src/index.ts), and scripts/lib/upgrade-box-remote.sh.
# A failure of this script must not fail the upgrade; the callers only log it.
set -uo pipefail

ENV_FILE="${ENV_FILE:-/etc/joshu/instance.env}"

log() { echo "[prune-release-images] $*"; }

if [[ "${JOSHU_PRUNE_RELEASE_IMAGES:-1}" == "0" ]]; then
  log "JOSHU_PRUNE_RELEASE_IMAGES=0, skip"
  exit 0
fi

env_value() {
  local key="$1"
  local value="${!key:-}"
  if [[ -z "${value}" && -r "${ENV_FILE}" ]]; then
    value="$(grep -E "^${key}=" "${ENV_FILE}" | tail -1 | cut -d= -f2- | tr -d "\"'")"
  fi
  printf '%s' "${value}"
}

# Repository of an image reference: drop the digest, then a tag after the last slash.
repo_of() {
  local ref="${1%%@*}"
  local last="${ref##*/}"
  if [[ "${last}" == *:* ]]; then ref="${ref%:*}"; fi
  printf '%s' "${ref}"
}

keep=""
keep_id() {
  [[ -n "$1" ]] && keep="${keep}$1"$'\n'
}
is_kept() { printf '%s' "${keep}" | grep -Fxq "$1"; }

current_refs=""
for key in JOSHU_IMAGE_REF JOSHU_VOICE_IMAGE_REF JOSHU_INSTANCE_AGENT_IMAGE_REF; do
  ref="$(env_value "${key}")"
  [[ -n "${ref}" ]] && current_refs="${current_refs}${ref}"$'\n'
done
if [[ -z "${current_refs}" ]]; then
  log "no current release image reference, skip"
  exit 0
fi

# Images that a container uses (running or stopped).
for cid in $(docker ps -aq); do
  keep_id "$(docker inspect --format '{{.Image}}' "${cid}" 2>/dev/null)"
done

repos=""
while IFS= read -r ref; do
  [[ -z "${ref}" ]] && continue
  keep_id "$(docker image inspect --format '{{.Id}}' "${ref}" 2>/dev/null)"
  repo="$(repo_of "${ref}")"
  printf '%s' "${repos}" | grep -Fxq "${repo}" || repos="${repos}${repo}"$'\n'
done <<< "${current_refs}"

removed=0
while IFS= read -r repo; do
  [[ -z "${repo}" ]] && continue
  # One line per tag, newest first: "<created> <id> <tag>".
  rows="$(docker image ls --no-trunc --format '{{.CreatedAt}}|{{.ID}}|{{.Tag}}' "${repo}" 2>/dev/null | sort -r)"
  # Keep the newest image that is not kept yet: the previous release.
  while IFS='|' read -r _ id tag; do
    [[ -z "${id}" ]] && continue
    if ! is_kept "${id}"; then
      keep_id "${id}"
      log "keep ${repo}:${tag} for a rollback"
      break
    fi
  done <<< "${rows}"
  while IFS='|' read -r _ id tag; do
    [[ -z "${id}" ]] && continue
    is_kept "${id}" && continue
    target="${repo}:${tag}"
    [[ "${tag}" == "<none>" ]] && target="${id}"
    if [[ "${DRY_RUN:-0}" == "1" ]]; then
      log "would remove ${target}"
    elif docker image rm "${target}" >/dev/null 2>&1; then
      log "removed ${target}"
      removed=$((removed + 1))
    else
      log "could not remove ${target} (in use or already gone)"
    fi
  done <<< "${rows}"
done <<< "${repos}"

if [[ "${DRY_RUN:-0}" == "1" ]]; then
  log "would remove $(docker image ls -q --filter dangling=true | wc -l | tr -d ' ') dangling images"
else
  docker image prune -f >/dev/null 2>&1 || log "could not remove dangling images"
  log "removed ${removed} old release images and the dangling images"
fi
exit 0
