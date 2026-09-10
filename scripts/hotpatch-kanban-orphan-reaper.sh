#!/usr/bin/env bash
# Hotpatch Kanban zombie fix onto a live fleet box (no image rebuild).
set -euo pipefail

HOST="${1:-}"
if [[ -z "${HOST}" ]]; then
  echo "usage: $0 root@<slug>.box.joshu.me" >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE_JOSHU="/opt/joshu"
REMOTE_SCRIPTS="${REMOTE_JOSHU}/scripts"

echo "[hotpatch-kanban-orphan] syncing scripts to ${HOST}:${REMOTE_SCRIPTS}"
rsync -az \
  "${ROOT_DIR}/scripts/patch-hermes-kanban-worker-terminate-on-complete.py" \
  "${ROOT_DIR}/scripts/apply-hermes-kanban-worker-terminate-on-complete.sh" \
  "${ROOT_DIR}/scripts/hermes-kanban-orphan-reaper.py" \
  "${ROOT_DIR}/scripts/hotpatch-kanban-orphan-reaper.sh" \
  "${HOST}:${REMOTE_SCRIPTS}/"

# Joshu-side reaper timer + EA runtime caps (requires local `npm run build` first).
DIST_OVERLAY=(
  "dist/hermesApi.js"
  "dist/hermesKanbanBridge.js"
  "dist/ea/ownerReplyCron.js"
  "dist/ea/schedulingCron.js"
  "dist/ea/mailCron.js"
  "dist/ea/triageRoutes.js"
  "dist/onboarding/reconcileOnboardingBoard.js"
)
for rel in "${DIST_OVERLAY[@]}"; do
  if [[ ! -f "${ROOT_DIR}/${rel}" ]]; then
    echo "[hotpatch-kanban-orphan] skip dist overlay (missing ${rel}; run npm run build)" >&2
    continue
  fi
  rsync -az "${ROOT_DIR}/${rel}" "${HOST}:${REMOTE_JOSHU}/${rel}"
done

echo "[hotpatch-kanban-orphan] applying Hermes patch inside container"
ssh "${HOST}" bash -s <<'EOF'
set -euo pipefail
CID="$(docker ps -q --filter name=joshu-stack | head -1)"
if [[ -z "${CID}" ]]; then
  echo "[hotpatch-kanban-orphan] error: joshu-stack container not found" >&2
  exit 1
fi
docker exec "${CID}" mkdir -p /opt/joshu/scripts
docker cp /opt/joshu/scripts/patch-hermes-kanban-worker-terminate-on-complete.py \
  "${CID}:/opt/joshu/scripts/patch-hermes-kanban-worker-terminate-on-complete.py"
docker cp /opt/joshu/scripts/apply-hermes-kanban-worker-terminate-on-complete.sh \
  "${CID}:/opt/joshu/scripts/apply-hermes-kanban-worker-terminate-on-complete.sh"
docker cp /opt/joshu/scripts/hermes-kanban-orphan-reaper.py \
  "${CID}:/opt/joshu/scripts/hermes-kanban-orphan-reaper.py"
for rel in dist/hermesApi.js dist/hermesKanbanBridge.js dist/ea/ownerReplyCron.js dist/ea/schedulingCron.js dist/ea/mailCron.js dist/ea/triageRoutes.js dist/onboarding/reconcileOnboardingBoard.js; do
  if [[ ! -f "/opt/joshu/${rel}" ]]; then
    continue
  fi
  if ! docker exec "${CID}" mkdir -p "/opt/joshu/$(dirname "${rel}")" 2>/dev/null; then
    echo "[hotpatch-kanban-orphan] warn: cannot overlay ${rel} (read-only /opt/joshu); use next image" >&2
    continue
  fi
  docker cp "/opt/joshu/${rel}" "${CID}:/opt/joshu/${rel}" \
    || echo "[hotpatch-kanban-orphan] warn: dist overlay skipped for ${rel}" >&2
done
docker exec "${CID}" chmod +x /opt/joshu/scripts/apply-hermes-kanban-worker-terminate-on-complete.sh
docker exec "${CID}" bash -lc 'HERMES_DIR=/opt/hermes-agent bash /opt/joshu/scripts/apply-hermes-kanban-worker-terminate-on-complete.sh'
docker exec "${CID}" grep -q "_joshu_kanban_worker_terminate_on_complete" /opt/hermes-agent/tools/kanban_tools.py
docker exec "${CID}" grep -q "_joshu_reap_orphan_kanban_workers" /opt/hermes-agent/hermes_cli/kanban_db.py
echo "[hotpatch-kanban-orphan] patch markers verified"
EOF

echo "[hotpatch-kanban-orphan] restarting joshu-stack (gateway + reaper timer)"
ssh "${HOST}" bash -s <<'EOF'
set -euo pipefail
cd /opt/joshu
docker compose restart joshu-stack
sleep 5
curl -fsS http://127.0.0.1:8788/joshu/api/hermes-chat/status >/dev/null || true
echo "[hotpatch-kanban-orphan] joshu-stack restarted"
EOF

echo "[hotpatch-kanban-orphan] done"
