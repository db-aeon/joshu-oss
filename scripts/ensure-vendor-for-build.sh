#!/usr/bin/env bash
# AGPL checkouts omit vendor/ and proprietary/ (see scripts/prepare-oss-snapshot.sh).
# CI and shallow clones need upstream trees before build:deploy / Docker COPY.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

# Must match fleet vendor/arozos pin so patches/arozos/*.patch apply cleanly.
AROZOS_REF="${AROZOS_REF:-8894ffe205f3078b8ead9f9591ec4ce073cc0a07}"

auth_url() {
  local url="$1"
  if [[ -n "${GITHUB_TOKEN:-}" ]] && [[ "${url}" == https://github.com/* ]]; then
    echo "https://x-access-token:${GITHUB_TOKEN}@${url#https://}"
  else
    echo "${url}"
  fi
}

clone_if_missing() {
  local dest="$1"
  local url="$2"
  local branch="${3:-}"
  local marker="${4:-}"

  if [[ -e "${dest}/.git" ]] || [[ -n "${marker}" && -e "${dest}/${marker}" ]]; then
    return 0
  fi

  local clone_url
  clone_url="$(auth_url "${url}")"

  echo "[ensure-vendor-for-build] cloning ${url} -> ${dest}"
  mkdir -p "$(dirname "${dest}")"
  if [[ -n "${branch}" ]]; then
    git clone --depth 1 --branch "${branch}" "${clone_url}" "${dest}"
  else
    git clone --depth 1 "${clone_url}" "${dest}"
  fi
}

ensure_arozos_vendor() {
  local dest="vendor/arozos"
  if [[ -f "${dest}/src/main.go" ]]; then
    return 0
  fi

  local url="https://github.com/tobychui/arozos.git"
  local clone_url
  clone_url="$(auth_url "${url}")"

  echo "[ensure-vendor-for-build] fetching arozos@${AROZOS_REF} -> ${dest}"
  rm -rf "${dest}"
  mkdir -p "${dest}"
  git init "${dest}"
  git -C "${dest}" remote add origin "${clone_url}"
  git -C "${dest}" fetch --depth 1 origin "${AROZOS_REF}"
  git -C "${dest}" checkout --detach FETCH_HEAD
}

# Fork with Joshu markdown WYSIWYG patches (see .gitmodules).
clone_if_missing "vendor/excalidraw" "https://github.com/db-aeon/excalidraw.git" "joshu-markdown-wysiwyg" \
  "packages/element/src/markdownText.ts"

# Upstream ArozOS — pinned commit + Joshu patches at image build.
ensure_arozos_vendor

# Dockerfile COPY proprietary — fleet-only content; empty dir is fine for AGPL images.
mkdir -p proprietary

echo "[ensure-vendor-for-build] vendor trees ready"
