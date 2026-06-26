#!/usr/bin/env bash
# Scan a clean tree for likely secrets before OSS publish.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${1:-${ROOT_DIR}}"

echo "[secret-scan] scanning ${TARGET}"

found=0
while IFS= read -r pat; do
  [[ -z "${pat}" ]] && continue
  if rg -n --hidden \
    -g '!.git' -g '!node_modules' -g '!dist' -g '!.next' -g '!vendor' \
    -g '!deploy/.env.vps.example' -g '!**/*.example' \
    -e "${pat}" "${TARGET}" 2>/dev/null; then
    found=1
  fi
done <<'PATS'
sk-[a-zA-Z0-9]{24,}
BEGIN (RSA |OPENSSH )?PRIVATE KEY
PATS

for f in .env .env.local apps/control-plane/.env.local; do
  if [[ -f "${TARGET}/${f}" ]]; then
    echo "[secret-scan] FAIL: ${f} present"
    found=1
  fi
done

if [[ "${found}" -eq 1 ]]; then
  echo "[secret-scan] potential secrets found — fix before publish" >&2
  exit 1
fi

echo "[secret-scan] OK"
