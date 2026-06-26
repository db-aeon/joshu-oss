#!/usr/bin/env bash
# Install pinned gbrain globally via Bun (local dev parity with deploy/Dockerfile).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RELEASE_JSON="${ROOT_DIR}/deploy/RELEASE.json"

read_gbrain_ref() {
  if [[ -n "${GBRAIN_REF:-}" ]]; then
    printf '%s' "${GBRAIN_REF}"
    return 0
  fi
  node -e "
    const fs = require('fs');
    const release = JSON.parse(fs.readFileSync('${RELEASE_JSON}', 'utf8'));
    if (!release.gbrainRef) throw new Error('deploy/RELEASE.json missing gbrainRef');
    process.stdout.write(release.gbrainRef);
  "
}

ensure_bun() {
  if command -v bun >/dev/null 2>&1; then
    return 0
  fi
  if [[ -x "${HOME}/.bun/bin/bun" ]]; then
    export PATH="${HOME}/.bun/bin:${PATH}"
    return 0
  fi
  echo "[install-gbrain] Bun not found; installing from https://bun.sh" >&2
  curl -fsSL https://bun.sh/install | bash
  export PATH="${HOME}/.bun/bin:${PATH}"
}

GBRAIN_REF="$(read_gbrain_ref)"
ensure_bun

SPEC="github:garrytan/gbrain#${GBRAIN_REF}"
echo "[install-gbrain] bun install -g ${SPEC}"
bun install -g "${SPEC}"

if command -v gbrain >/dev/null 2>&1; then
  echo "[install-gbrain] $(gbrain --version 2>/dev/null || gbrain version 2>/dev/null || echo gbrain installed)"
else
  echo "[install-gbrain] ERROR: gbrain not on PATH after install (check ~/.bun/bin)" >&2
  exit 1
fi
