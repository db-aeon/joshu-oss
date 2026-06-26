#!/usr/bin/env bash
# Align /etc/joshu/instance.env release keys with dist/.release-provenance.json.
# Use when health shows dist drift (version N in provenance, expected N-1 in env).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${JOSHU_COMPOSE_ENV_FILE:-/etc/joshu/instance.env}"
PROVENANCE="${ROOT_DIR}/dist/.release-provenance.json"
COMPOSE_FILE="${JOSHU_COMPOSE_FILE:-${ROOT_DIR}/deploy/docker-compose.yml}"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "[repair-env-drift] missing ${ENV_FILE}" >&2
  exit 1
fi
if [[ ! -f "${PROVENANCE}" ]]; then
  echo "[repair-env-drift] missing ${PROVENANCE} — run sync-dist-from-image.sh first" >&2
  exit 1
fi

read -r VERSION IMAGE_REF < <(python3 - <<'PY' "${PROVENANCE}"
import json, sys
p = json.load(open(sys.argv[1]))
print(p.get("version", ""), p.get("imageRef", ""))
PY
)

if [[ -z "${VERSION}" || -z "${IMAGE_REF}" ]]; then
  echo "[repair-env-drift] invalid provenance in ${PROVENANCE}" >&2
  exit 1
fi

VOICE_REF="${IMAGE_REF/joshu-sandbox:/joshu-voice-realtime:}"

echo "[repair-env-drift] setting JOSHU_RELEASE_VERSION=${VERSION} JOSHU_IMAGE_REF=${IMAGE_REF}"

python3 - <<'PY' "${ENV_FILE}" "${VERSION}" "${IMAGE_REF}" "${VOICE_REF}"
import re, sys
path, version, image_ref, voice_ref = sys.argv[1:5]
keys = {
    "JOSHU_RELEASE_VERSION": version,
    "JOSHU_IMAGE_REF": image_ref,
    "JOSHU_VOICE_IMAGE_REF": voice_ref,
}
try:
    text = open(path, encoding="utf-8").read()
except FileNotFoundError:
    text = ""
lines = text.splitlines()
drop = set(keys)
kept = [ln for ln in lines if not re.match(r"^(" + "|".join(drop) + r")=", ln)]
for k, v in keys.items():
    kept.append(f"{k}={v}")
open(path, "w", encoding="utf-8").write("\n".join(kept).rstrip() + "\n")
PY

chmod 600 "${ENV_FILE}"

echo "[repair-env-drift] recreating joshu-stack"
docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" up -d --force-recreate joshu-stack

echo "[repair-env-drift] health:"
curl -fsS http://127.0.0.1:8788/joshu/api/instance/health | python3 -m json.tool | head -30
