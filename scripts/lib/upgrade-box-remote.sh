#!/usr/bin/env bash
# Upgrade one box to a release. Runs ON THE HOST (scripts/upgrade-fleet-box-image.sh
# streams this file over SSH). Change image-owned-box-runtime: the release images are
# the only source of code; the host keeps config, data, the host bundle, and backups.
#
# Steps:
#   1. pull the sandbox, voice, and agent images (a failed pull stops before any change)
#   2. retire the host checkout (move it aside, remove credentials from its git config)
#   3. install the host bundle from the sandbox image (the installer also empties the hotfix overlay)
#   4. write the release pins to instance.env
#   5. copy the Joshu state of the running stack into its volume (carry-over-joshu-state.sh);
#      recreate caddy, joshu-stack, and voice-realtime; wait for health of the stack;
#      then recreate instance-agent and reconcile the box skills
#   6. when the stack is healthy, remove old release images (change prune-release-images;
#      the host bundle script keeps the current and the previous release)
#
# The first start of a new release can run the skills seed with LLM merges in vps-start.sh,
# before the Joshu API starts (change upgrade-waits-for-skills-seed). The stack is healthy
# only after the skills seed. The script does not start a second skills seed. The script
# starts instance-agent with --no-deps after the wait, so a slow stack does not stop compose.
#
# Environment: IMAGE_REF, VOICE_REF, AGENT_REF, VERSION (required).
#   STACK_HEALTH_WAIT_SEC (default 1200): maximum wait for health of the stack.
# Test hooks: INSTALL_DIR (default /opt/joshu), UPGRADE_ONLY=retire (run step 2 only).
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/joshu}"
ENV_FILE="${ENV_FILE:-/etc/joshu/instance.env}"
STACK_HEALTH_WAIT_SEC="${STACK_HEALTH_WAIT_SEC:-1200}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

log() { echo "[upgrade] $*"; }

# Step 2. Move the host checkout aside. Running containers keep their mounts (same
# file system, same inodes) until step 6 recreates them. Never delete: rollback needs it.
retire_host_checkout() {
  if [[ ! -d "${INSTALL_DIR}/.git" ]]; then
    log "no host checkout at ${INSTALL_DIR}"
    return 0
  fi
  local retired="${INSTALL_DIR}-checkout-retired-${STAMP}"
  log "retire host checkout ${INSTALL_DIR} -> ${retired}"
  mv "${INSTALL_DIR}" "${retired}"
  mkdir -p "${INSTALL_DIR}"
  # Remove user name and token from each remote URL (https://user:token@host/... -> https://host/...).
  if [[ -f "${retired}/.git/config" ]]; then
    sed -i.bak -E 's#^([[:space:]]*url = [a-z+]+://)[^/@[:space:]]+@#\1#' "${retired}/.git/config"
    rm -f "${retired}/.git/config.bak"
  fi
  echo "${retired}" > "${INSTALL_DIR}/.retired-host-checkout"
}

if [[ "${UPGRADE_ONLY:-}" == "retire" ]]; then
  retire_host_checkout
  exit 0
fi

: "${IMAGE_REF:?}" "${VOICE_REF:?}" "${AGENT_REF:?}" "${VERSION:?}"

log "1/5 pull release images"
for ref in "${IMAGE_REF}" "${VOICE_REF}" "${AGENT_REF}"; do
  docker pull -q "${ref}"
done

log "2/5 retire host checkout"
retire_host_checkout

log "3/5 install host bundle from ${IMAGE_REF}"
docker run --rm --entrypoint cat "${IMAGE_REF}" /opt/joshu/.image/host/deploy/scripts/install-host-bundle.sh \
  | JOSHU_IMAGE_REF="${IMAGE_REF}" JOSHU_RELEASE_VERSION="${VERSION}" JOSHU_INSTALL_DIR="${INSTALL_DIR}" \
    JOSHU_SKIP_PULL=1 bash -s

log "4/5 write release pins to ${ENV_FILE}"
docker run --rm -v /etc/joshu:/etc/joshu:rw --entrypoint node "${IMAGE_REF}" \
  /opt/joshu/scripts/patch-instance-env.mjs --file "${ENV_FILE}" \
  "JOSHU_IMAGE_REF=${IMAGE_REF}" \
  "JOSHU_RELEASE_VERSION=${VERSION}" \
  "JOSHU_VOICE_IMAGE_REF=${VOICE_REF}" \
  "JOSHU_INSTANCE_AGENT_IMAGE_REF=${AGENT_REF}"

log "5/5 recreate caddy, joshu-stack, voice-realtime; instance-agent after the stack is healthy"
COMPOSE=(docker compose -f "${INSTALL_DIR}/deploy/docker-compose.yml" --env-file "${ENV_FILE}")
set -a
# shellcheck source=/dev/null
source "${ENV_FILE}"
set +a
export COMPOSE_PROFILES="${COMPOSE_PROFILES:-fleet,voice-rt,voice}"
# Copy the Joshu state (teams, proactive, ...) out of the writable layer of the running
# stack into volume joshu_arozos before the recreate (change joshu-state-volume).
if "${COMPOSE[@]}" exec -T joshu-stack sh -s < "${INSTALL_DIR}/deploy/scripts/carry-over-joshu-state.sh"; then
  log "joshu state carried over"
else
  log "WARNING: joshu state carry-over failed (stack down?); state in /opt/joshu/.joshu of the old container is lost"
fi
"${COMPOSE[@]}" up -d --force-recreate caddy joshu-stack voice-realtime
CID="$("${COMPOSE[@]}" ps -q joshu-stack | head -1 || true)"

stack_healthy() {
  curl -fsS --max-time 8 http://127.0.0.1:8788/joshu/api/instance/health 2>/dev/null \
    | python3 -c "import sys, json; sys.exit(0 if json.load(sys.stdin).get('healthy') is True else 1)" 2>/dev/null
}
log "wait for health of the stack (the skills seed of vps-start runs first; at most ${STACK_HEALTH_WAIT_SEC} seconds)"
healthy=""
deadline=$((SECONDS + ${STACK_HEALTH_WAIT_SEC}))
while (( SECONDS < deadline )); do
  if stack_healthy; then
    healthy=1
    break
  fi
  sleep 10
done
log "skills seed of vps-start:"
if [[ -n "${CID}" ]]; then
  docker logs "${CID}" 2>&1 | grep -E '\[hermes-learning-seed\]|hermes learning skills seed failed' | sed 's/^/  /' || true
fi

# --no-deps: without it, compose recreates joshu-stack again (--force-recreate applies to
# dependencies) and fails when the stack is not healthy yet.
"${COMPOSE[@]}" up -d --no-deps --force-recreate instance-agent

# The reconcile edits box skills. Run the reconcile only after the skills seed (stack healthy).
if [[ -z "${healthy}" ]]; then
  echo "[upgrade] WARN: stack not healthy after ${STACK_HEALTH_WAIT_SEC} seconds; instance-agent started," \
    "box skills not reconciled. When the stack is healthy, run:" \
    "docker exec ${CID:-deploy-joshu-stack-1} bash /opt/joshu/scripts/reconcile-box-skills-on-upgrade.sh" >&2
elif [[ -n "${CID}" ]] && docker exec "${CID}" test -x /opt/joshu/scripts/reconcile-box-skills-on-upgrade.sh 2>/dev/null; then
  log "reconcile box skills"
  docker exec "${CID}" bash /opt/joshu/scripts/reconcile-box-skills-on-upgrade.sh
fi

# Keep the old images while the stack is not healthy: a rollback needs them.
if [[ -n "${healthy}" && -x "${INSTALL_DIR}/deploy/scripts/prune-release-images.sh" ]]; then
  log "remove old release images"
  ENV_FILE="${ENV_FILE}" bash "${INSTALL_DIR}/deploy/scripts/prune-release-images.sh" || true
fi

log "vitals"
curl -fsS --max-time 12 http://127.0.0.1:8788/joshu/api/instance/health \
  | python3 -c "
import sys, json
d = json.load(sys.stdin)
print('  healthy:', d.get('healthy'), 'release:', d.get('releaseVersion'))
c = d.get('components') or {}
for k in ['joshu','camofox','hermes','hindsight','gbrain','connectorsMcp','twilio','dist','arozos','edge','last30days']:
  print(f'  {k}: {c.get(k) or {}}')
" || echo "  health: unavailable"
log "stack bind mounts at or below /opt/joshu (expect only the hotfix overlay):"
docker inspect -f '{{range .Mounts}}{{if eq .Type "bind"}}{{.Destination}}{{"\n"}}{{end}}{{end}}' "${CID}" \
  | grep -E '^/opt/joshu(/|$)' | sed 's/^/  /' || true
log "host bundle: $(cat "${INSTALL_DIR}/deploy/.host-bundle.json" 2>/dev/null | tr -d '\n ')"
grep -E '^(JOSHU_IMAGE_REF|JOSHU_RELEASE_VERSION|JOSHU_VOICE_IMAGE_REF|JOSHU_INSTANCE_AGENT_IMAGE_REF)=' "${ENV_FILE}"
"${COMPOSE[@]}" ps --format 'table {{.Name}}\t{{.Status}}\t{{.Image}}'
if [[ -f "${INSTALL_DIR}/.retired-host-checkout" ]]; then
  log "retired host checkout: $(cat "${INSTALL_DIR}/.retired-host-checkout") (rollback: design of change image-owned-box-runtime)"
fi
