#!/usr/bin/env bash
# AGPL checkouts omit vendor/ and proprietary/ (see scripts/prepare-oss-snapshot.sh).
# CI and shallow clones need upstream trees before build:deploy / Docker COPY.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

clone_if_missing() {
  local dest="$1"
  local url="$2"
  local branch="${3:-}"
  local marker="${4:-}"

  if [[ -e "${dest}/.git" ]] || [[ -n "${marker}" && -e "${dest}/${marker}" ]]; then
    return 0
  fi

  local clone_url="${url}"
  # Private forks in the same org (e.g. db-aeon/excalidraw) need a token in CI.
  if [[ -n "${GITHUB_TOKEN:-}" ]] && [[ "${url}" == https://github.com/* ]]; then
    clone_url="https://x-access-token:${GITHUB_TOKEN}@${url#https://}"
  fi

  echo "[ensure-vendor-for-build] cloning ${url} -> ${dest}"
  mkdir -p "$(dirname "${dest}")"
  if [[ -n "${branch}" ]]; then
    git clone --depth 1 --branch "${branch}" "${clone_url}" "${dest}"
  else
    git clone --depth 1 "${clone_url}" "${dest}"
  fi
}

# Fork with Joshu markdown WYSIWYG patches (see .gitmodules).
clone_if_missing "vendor/excalidraw" "https://github.com/db-aeon/excalidraw.git" "joshu-markdown-wysiwyg" \
  "packages/element/src/markdownText.ts"

# Upstream ArozOS — patched at image build via scripts/apply-arozos-patches.sh.
clone_if_missing "vendor/arozos" "https://github.com/tobychui/arozos.git" "" "src/main.go"

# Dockerfile COPY proprietary — fleet-only content; empty dir is fine for AGPL images.
mkdir -p proprietary

echo "[ensure-vendor-for-build] vendor trees ready"
