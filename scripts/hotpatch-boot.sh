#!/usr/bin/env bash
# Overlay a boot script onto a live box without GHCR or host git credentials.
#
# Usage:
#   bash scripts/hotpatch-boot.sh root@patrick.box.joshu.me scripts/lib/arozos-desktop-shortcuts.sh
#   bash scripts/hotpatch-boot.sh root@box deploy/scripts/vps-start.sh
#
# Copies into /opt/joshu/hotfix/scripts/<rel> (survives recreate when compose
# binds that dir). If the box still has old compose (no hotfix mount), falls
# back to docker cp into the running container's .image/scripts and warns.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${1:-}"
SRC_ARG="${2:-}"

if [[ -z "${TARGET}" || -z "${SRC_ARG}" ]]; then
  echo "usage: $0 user@host <repo-relative-path>" >&2
  echo "  e.g. $0 root@box.example.com scripts/lib/arozos-desktop-shortcuts.sh" >&2
  exit 1
fi

# Map repo path → path under hotfix/scripts/ (same layout as .image/scripts/).
normalize_rel() {
  local src="${1#./}"
  case "${src}" in
    deploy/scripts/vps-start.sh|scripts/vps-start.sh) echo "vps-start.sh" ;;
    scripts/*) echo "${src#scripts/}" ;;
    *) echo "${src}" ;;
  esac
}

REL="$(normalize_rel "${SRC_ARG}")"
LOCAL=""
for cand in "${ROOT_DIR}/${SRC_ARG}" "${ROOT_DIR}/scripts/${REL}" "${ROOT_DIR}/deploy/scripts/${REL}"; do
  if [[ -f "${cand}" ]]; then
    LOCAL="${cand}"
    break
  fi
done
if [[ -z "${LOCAL}" ]]; then
  echo "[hotpatch-boot] local file not found: ${SRC_ARG}" >&2
  exit 1
fi

echo "[hotpatch-boot] ${LOCAL} → ${TARGET}:/opt/joshu/hotfix/scripts/${REL}"

ssh "${TARGET}" "mkdir -p /opt/joshu/hotfix/scripts/$(dirname "${REL}")"
rsync -az "${LOCAL}" "${TARGET}:/opt/joshu/hotfix/scripts/${REL}"

HAS_MOUNT="$(ssh "${TARGET}" bash -s <<'EOF' || true
set -euo pipefail
cd /opt/joshu/deploy
CID="$(docker compose -f docker-compose.yml --env-file /etc/joshu/instance.env ps -q joshu-stack | head -1)"
if [[ -z "${CID}" ]]; then
  echo "none"
  exit 0
fi
if docker inspect "${CID}" --format '{{range .Mounts}}{{.Destination}}{{"\n"}}{{end}}' | grep -qx '/opt/joshu/hotfix/scripts'; then
  echo "yes"
else
  echo "no"
fi
EOF
)"

if [[ "${HAS_MOUNT}" == "yes" ]]; then
  echo "[hotpatch-boot] hotfix bind present — restarting joshu-stack"
  ssh "${TARGET}" bash -s <<'EOF'
set -euo pipefail
cd /opt/joshu/deploy
docker compose -f docker-compose.yml --env-file /etc/joshu/instance.env restart joshu-stack
EOF
  echo "[hotpatch-boot] done — overlay survives recreate. Delete /opt/joshu/hotfix/scripts/${REL} to revert to image."
  exit 0
fi

echo "[hotpatch-boot] WARN: no hotfix bind on this box (old compose). docker cp into .image — recreate will wipe it." >&2
ssh "${TARGET}" bash -s <<EOF
set -euo pipefail
cd /opt/joshu/deploy
CID="\$(docker compose -f docker-compose.yml --env-file /etc/joshu/instance.env ps -q joshu-stack | head -1)"
if [[ -z "\${CID}" ]]; then
  echo "[hotpatch-boot] joshu-stack not running" >&2
  exit 1
fi
docker exec "\${CID}" mkdir -p "/opt/joshu/.image/scripts/$(dirname "${REL}")"
docker cp "/opt/joshu/hotfix/scripts/${REL}" "\${CID}:/opt/joshu/.image/scripts/${REL}"
docker compose -f docker-compose.yml --env-file /etc/joshu/instance.env restart joshu-stack
EOF
echo "[hotpatch-boot] done (ephemeral .image copy). Rsync deploy/docker-compose.yml for a durable hotfix/ bind."
