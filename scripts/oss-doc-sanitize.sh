#!/usr/bin/env bash
# Post-process docs/ in an OSS snapshot tree — fix links and paths excluded from private canon.
set -euo pipefail

OUT_DIR="${1:?usage: oss-doc-sanitize.sh <snapshot-root>}"

if [[ ! -d "${OUT_DIR}/docs" ]]; then
  echo "[oss-doc-sanitize] no docs/ under ${OUT_DIR}" >&2
  exit 1
fi

echo "[oss-doc-sanitize] sanitizing ${OUT_DIR}/docs"

# Portable in-place sed (macOS + Linux).
sed_inplace() {
  if sed --version >/dev/null 2>&1; then
    sed -i "$@"
  else
    sed -i '' "$@"
  fi
}

find "${OUT_DIR}/docs" -type f \( -name '*.md' -o -name '*.json' \) -print0 |
  while IFS= read -r -d '' file; do
    sed_inplace \
      -e 's|hermes-customizations\.md|hermes-integration.md|g' \
      -e 's|hermes-customizations —|hermes-integration —|g' \
      -e 's|docs/hermes-customizations\.md|docs/hermes-integration.md|g' \
      -e 's|https://github.com/your-org/joshu\.git|https://github.com/db-aeon/joshu-oss.git|g' \
      -e 's|ghcr.io/your-org/joshu-oss|ghcr.io/db-aeon/joshu-oss|g' \
      -e 's|ghcr.io/your-org/joshu-sandbox|ghcr.io/db-aeon/joshu-sandbox|g' \
      -e 's|arozos/web-overlays/aroz-paper-shell\.css|arozos/web-overlays-vanilla/aroz-vanilla-shell.css|g' \
      -e 's|arozos/web-overlays/aroz-jchat-tray\.js|arozos/web-overlays-vanilla/aroz-jchat-tray.js|g' \
      -e 's|arozos/web-overlays/|arozos/web-overlays-vanilla/|g' \
      -e 's|apps/control-plane/|joshu-control-plane/|g' \
      -e 's|joshu-identity\.md|self-host.md#identity-without-control-plane|g' \
      -e 's|Joshu-SOP/ea-for-joshu\.md|hermes-integration.md|g' \
      -e 's|Joshu-SOP/time-block-planning\.md|excalidraw-sandbox.md|g' \
      -e 's|Joshu-SOP/gtd-workspace-linking\.md|file-brain.md|g' \
      -e 's|Joshu-SOP/executive-assistant\.md|welcome-onboarding.md|g' \
      -e 's|Joshu-SOP/ea-skill-future-fixes\.md|hermes-integration.md|g' \
      -e 's|docs/Joshu-SOP/|docs/|g' \
      -e 's|/Users/danbenyamin/Documents/dev/joshu|~/joshu-oss|g' \
      -e 's|/Users/danbenyamin/Documents/dev/hermes-agent|~/hermes-agent|g' \
      -e 's|/Users/danbenyamin/Documents/dev/hermes-agent-next|~/hermes-agent-next|g' \
      -e 's|/Users/danbenyamin/Documents/dev|~/dev|g' \
      -e 's|/Users/danbenyamin/hermes-workspace|~/hermes-workspace|g' \
      -e 's|bash scripts/sync-local-portal-profile\.sh|configure identity in /etc/joshu/instance.env (see self-host.md)|g' \
      "$file"
  done

# Drop internal-only doc trees if they slipped through rsync excludes.
rm -rf "${OUT_DIR}/docs/Joshu-SOP" 2>/dev/null || true

echo "[oss-doc-sanitize] done"
