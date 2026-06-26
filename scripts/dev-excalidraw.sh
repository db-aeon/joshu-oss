#!/usr/bin/env bash
# Run the fork's full excalidraw-app dev server from vendor/excalidraw (git submodule).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDORED_EXCALIDRAW_SOURCE="${ROOT_DIR}/vendor/excalidraw"
EXCALIDRAW_REPO="${EXCALIDRAW_REPO:-https://github.com/db-aeon/excalidraw.git}"
EXCALIDRAW_REF="${EXCALIDRAW_REF:-joshu-markdown-wysiwyg}"
EXCALIDRAW_PORT="${EXCALIDRAW_PORT:-3002}"
EXCALIDRAW_HOST="${EXCALIDRAW_HOST:-127.0.0.1}"

BOOTSTRAP="${EXCALIDRAW_BOOTSTRAP:-}"
INSTALL="${EXCALIDRAW_YARN_INSTALL:-}"
EXCALIDRAW_SOURCE_DIR="${EXCALIDRAW_SOURCE_DIR:-${VENDORED_EXCALIDRAW_SOURCE}}"

for arg in "$@"; do
  case "${arg}" in
    --bootstrap)
      BOOTSTRAP=1
      ;;
    --install)
      INSTALL=1
      ;;
    *)
      echo "[dev-excalidraw] unknown argument: ${arg}" >&2
      echo "[dev-excalidraw] supported arguments: --bootstrap --install" >&2
      exit 1
      ;;
  esac
done

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[dev-excalidraw] missing required command: $1" >&2
    exit 1
  fi
}

run_yarn() {
  if command -v yarn >/dev/null 2>&1; then
    yarn "$@"
    return
  fi

  require_command corepack
  corepack yarn "$@"
}

require_command git
require_command node

if [[ ! -f "${EXCALIDRAW_SOURCE_DIR}/package.json" ]]; then
  if [[ "${BOOTSTRAP}" == "1" && "${EXCALIDRAW_SOURCE_DIR}" == "${VENDORED_EXCALIDRAW_SOURCE}" ]]; then
    echo "[dev-excalidraw] initializing vendor/excalidraw submodule"
    (
      cd "${ROOT_DIR}"
      git submodule update --init --recursive vendor/excalidraw
    )
  elif [[ "${BOOTSTRAP}" == "1" ]]; then
    echo "[dev-excalidraw] cloning ${EXCALIDRAW_REPO} (${EXCALIDRAW_REF}) into ${EXCALIDRAW_SOURCE_DIR}"
    rm -rf "${EXCALIDRAW_SOURCE_DIR}"
    git clone --depth 1 --branch "${EXCALIDRAW_REF}" "${EXCALIDRAW_REPO}" "${EXCALIDRAW_SOURCE_DIR}"
  else
    echo "[dev-excalidraw] Excalidraw source not found at ${EXCALIDRAW_SOURCE_DIR}" >&2
    echo "[dev-excalidraw] run: git submodule update --init --recursive vendor/excalidraw" >&2
    echo "[dev-excalidraw] or: npm run dev:excalidraw:upstream -- --bootstrap" >&2
    exit 1
  fi
else
  echo "[dev-excalidraw] using Excalidraw source at ${EXCALIDRAW_SOURCE_DIR}"
fi

(
  cd "${EXCALIDRAW_SOURCE_DIR}"

  if [[ ! -d node_modules || "${INSTALL}" == "1" ]]; then
    echo "[dev-excalidraw] installing Excalidraw dependencies with yarn"
    run_yarn install
  fi

  export HOST="${HOST:-${EXCALIDRAW_HOST}}"
  export PORT="${PORT:-${EXCALIDRAW_PORT}}"
  export BROWSER="${BROWSER:-none}"

  echo "[dev-excalidraw] starting Excalidraw at http://${HOST}:${PORT}"
  run_yarn start
)
