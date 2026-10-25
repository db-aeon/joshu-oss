#!/usr/bin/env bash
# Fetch / refresh the vendored last30days-skill tree used by the Joshu last30days app.
# Pin file: integrations/last30days-skill.pin (full commit SHA).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PIN_FILE="${ROOT_DIR}/integrations/last30days-skill.pin"
DEST="${ROOT_DIR}/integrations/last30days-skill"
REPO_URL="${LAST30DAYS_SKILL_REPO:-https://github.com/mvanhorn/last30days-skill.git}"

if [[ ! -f "${PIN_FILE}" ]]; then
  echo "missing pin file: ${PIN_FILE}" >&2
  exit 1
fi

PIN="$(tr -d '[:space:]' < "${PIN_FILE}")"
if [[ -z "${PIN}" ]]; then
  echo "empty pin in ${PIN_FILE}" >&2
  exit 1
fi

TMP="$(mktemp -d "${TMPDIR:-/tmp}/last30days-skill.XXXXXX")"
cleanup() { rm -rf "${TMP}"; }
trap cleanup EXIT

echo "[last30days-skill] cloning ${REPO_URL} @ ${PIN}"
git clone --filter=blob:none --no-checkout "${REPO_URL}" "${TMP}/repo"
git -C "${TMP}/repo" fetch --depth 1 origin "${PIN}"
git -C "${TMP}/repo" checkout --detach FETCH_HEAD

rm -rf "${DEST}"
mkdir -p "$(dirname "${DEST}")"
mv "${TMP}/repo" "${DEST}"
rm -rf "${DEST}/.git"

echo "[last30days-skill] installed → ${DEST}"
test -f "${DEST}/skills/last30days/scripts/last30days.py"

python3 "${ROOT_DIR}/scripts/patch-last30days-sc-relay.py"
python3 "${ROOT_DIR}/scripts/patch-last30days-xquik-relay.py"
python3 "${ROOT_DIR}/scripts/patch-last30days-watch-window.py"
python3 "${ROOT_DIR}/scripts/patch-last30days-clustering.py"
python3 "${ROOT_DIR}/scripts/patch-last30days-share-dir.py"
python3 "${ROOT_DIR}/scripts/patch-last30days-openrouter-data-collection.py"
