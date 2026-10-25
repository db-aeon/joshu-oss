#!/usr/bin/env bash
# LEGACY: only for boxes that still have a host checkout (before change image-owned-box-runtime).
# On a box with the host bundle, the instance agent runs from the agent image; ship a release instead.
# Hotpatch CP send_owner_email (localhost route + instance-agent) onto a running box.
# Safe for older release dist trees: does not replace server.js wholesale.
#
# Usage:
#   bash scripts/hotpatch-owner-email.sh root@box.example.com
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${1:-}"
if [[ -z "${TARGET}" ]]; then
  echo "usage: $0 user@host" >&2
  exit 1
fi

echo "[owner-email-hotpatch] ensuring local builds…"
(cd "${ROOT_DIR}" && npx tsc -p tsconfig.json) || true
(cd "${ROOT_DIR}" && npm run build -w @joshu/instance-agent)
if [[ ! -f "${ROOT_DIR}/dist/instanceOwnerEmail.js" ]]; then
  echo "[owner-email-hotpatch] missing dist/instanceOwnerEmail.js" >&2
  exit 1
fi
# instanceOwnerEmail.js substitutes live telephone facts, so its resolver must ship too.
if [[ ! -f "${ROOT_DIR}/dist/telephoneSettings/emailPlaceholders.js" ]]; then
  echo "[owner-email-hotpatch] missing dist/telephoneSettings/emailPlaceholders.js" >&2
  exit 1
fi
if ! grep -q 'send_owner_email' "${ROOT_DIR}/packages/instance-agent/dist/index.js"; then
  echo "[owner-email-hotpatch] instance-agent dist missing send_owner_email" >&2
  exit 1
fi

REMOTE_TMP="/tmp/joshu-owner-email-hotpatch-$$"
echo "[owner-email-hotpatch] uploading to ${TARGET}:${REMOTE_TMP}…"
ssh "${TARGET}" "mkdir -p '${REMOTE_TMP}/nylas' '${REMOTE_TMP}/agent-dist' '${REMOTE_TMP}/telephoneSettings'"
rsync -az \
  "${ROOT_DIR}/dist/instanceOwnerEmail.js" \
  "${ROOT_DIR}/dist/instanceOwnerEmail.js.map" \
  "${ROOT_DIR}/dist/provisionInstanceEnv.js" \
  "${TARGET}:${REMOTE_TMP}/"
rsync -az \
  "${ROOT_DIR}/dist/telephoneSettings/" \
  "${TARGET}:${REMOTE_TMP}/telephoneSettings/"
rsync -az \
  "${ROOT_DIR}/dist/nylas/config.js" "${ROOT_DIR}/dist/nylas/config.js.map" \
  "${ROOT_DIR}/dist/nylas/client.js" "${ROOT_DIR}/dist/nylas/client.js.map" \
  "${ROOT_DIR}/dist/nylas/relayTransport.js" "${ROOT_DIR}/dist/nylas/relayTransport.js.map" \
  "${TARGET}:${REMOTE_TMP}/nylas/"
rsync -az \
  "${ROOT_DIR}/packages/instance-agent/dist/" \
  "${TARGET}:${REMOTE_TMP}/agent-dist/"

echo "[owner-email-hotpatch] installing on box…"
ssh "${TARGET}" "REMOTE_TMP='${REMOTE_TMP}' bash -s" <<'EOF'
set -euo pipefail
ENV_FILE=/etc/joshu/instance.env

# Overlay modules
cp "${REMOTE_TMP}/instanceOwnerEmail.js" /opt/joshu/dist/instanceOwnerEmail.js
cp "${REMOTE_TMP}/instanceOwnerEmail.js.map" /opt/joshu/dist/instanceOwnerEmail.js.map 2>/dev/null || true
cp "${REMOTE_TMP}/provisionInstanceEnv.js" /opt/joshu/dist/provisionInstanceEnv.js
mkdir -p /opt/joshu/dist/telephoneSettings
cp "${REMOTE_TMP}/telephoneSettings/"* /opt/joshu/dist/telephoneSettings/
mkdir -p /opt/joshu/dist/nylas
cp "${REMOTE_TMP}/nylas/"*.js /opt/joshu/dist/nylas/
cp "${REMOTE_TMP}/nylas/"*.map /opt/joshu/dist/nylas/ 2>/dev/null || true
mkdir -p /opt/joshu/packages/instance-agent/dist
rsync -a --delete "${REMOTE_TMP}/agent-dist/" /opt/joshu/packages/instance-agent/dist/

# Patch server.js: import + register AFTER express.json (JSON body required)
SERVER=/opt/joshu/dist/server.js
python3 - <<'PY'
from pathlib import Path
p = Path("/opt/joshu/dist/server.js")
text = p.read_text()
# Strip any prior insertions (including pre-json mistakes)
text = text.replace('import { registerInstanceOwnerEmailRoutes } from "./instanceOwnerEmail.js";\n', "")
text = text.replace("    registerInstanceOwnerEmailRoutes(router, { projectRoot: process.cwd() });\n", "")
text = text.replace("  registerInstanceOwnerEmailRoutes(router, { projectRoot: process.cwd() });\n", "")
imp_needle = 'import { registerInstanceHealthRoutes } from "./instanceHealth.js";\n'
if imp_needle not in text:
    raise SystemExit("import needle missing: registerInstanceHealthRoutes")
text = text.replace(
    imp_needle,
    imp_needle + 'import { registerInstanceOwnerEmailRoutes } from "./instanceOwnerEmail.js";\n',
    1,
)
json_candidates = [
    '    router.use(express.json({ limit: "12mb" }));\n',
    '  router.use(express.json({ limit: "12mb" }));\n',
]
json_line = next((c for c in json_candidates if c in text), None)
if not json_line:
    raise SystemExit("express.json registration not found")
indent = "    " if json_line.startswith("    ") else "  "
call = f"{indent}registerInstanceOwnerEmailRoutes(router, {{ projectRoot: process.cwd() }});\n"
text = text.replace(
    json_line,
    json_line + f"\n{indent}// CP-initiated owner email (needs JSON body).\n" + call,
    1,
)
p.write_text(text)
print("[owner-email-hotpatch] patched server.js")
PY

grep -n 'registerInstanceOwnerEmailRoutes\|express.json' "$SERVER" | head -20

echo "[owner-email-hotpatch] recreate joshu-stack + instance-agent…"
cd /opt/joshu/deploy
docker compose -f docker-compose.yml --env-file "${ENV_FILE}" up -d --force-recreate --no-deps joshu-stack
docker compose -f docker-compose.yml --env-file "${ENV_FILE}" up -d --force-recreate --no-deps instance-agent

rm -rf "${REMOTE_TMP}"
echo "[owner-email-hotpatch] done"
EOF
