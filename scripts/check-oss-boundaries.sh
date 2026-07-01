#!/usr/bin/env bash
# Fail if fleet-specific identifiers appear in AGPL-tracked paths.
# Run from repo root: bash scripts/check-oss-boundaries.sh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

SCAN_DIRS=(
  apps
  arozos
  deploy
  docs
  factory
  integrations
  packages
  patches
  public
  scripts
  src
  templates
)

EXCLUDE_PATHS=(
  docs/Joshu-SOP
  proprietary
  vendor
  node_modules
  dist
  .git
  .cursor
  arozos/web-overlays
)

# Patterns that must not appear in AGPL paths (case-sensitive where noted).
PATTERNS=(
  'Patrick'
  'Dan B'
  'db@project-aeon'
  'patrick@joshu'
  'dbenyamin@gmail'
  'docs/Joshu-SOP/'
  'apps/control-plane/'
)

build_rg_globs() {
  local args=()
  for dir in "${SCAN_DIRS[@]}"; do
    [[ -d "${ROOT_DIR}/${dir}" ]] && args+=(--glob "${dir}/**/*")
  done
  printf '%s\n' "${args[@]}"
}

should_skip() {
  local file="$1"
  for ex in "${EXCLUDE_PATHS[@]}"; do
    [[ "${file}" == "${ex}"/* || "${file}" == *"/${ex}/"* || "${file}" == *"/${ex}" ]] && return 0
  done
  # Private-only docs excluded from OSS snapshot.
  case "${file}" in
    docs/README.md|docs/joshu-identity.md|docs/day0-cold-start.md|docs/hermes-customizations.md|docs/box-state.md)
      return 0
      ;;
    docs/first-provisioning-notes.md|docs/troubleshooting-and-lessons.md|docs/session-*|docs/hotpatch-running-box.md|docs/provider-choices.md|docs/voice-*|docs/web-voice.md|docs/phone-voice-local-test.md)
      return 0
      ;;
    docs/design/brand-guidelines.md|docs/README.oss.md|docs/box-state.oss.md|docs/design/README.oss.md)
      return 0
      ;;
    README.md|CONTRIBUTING.md|README.oss.md|CONTRIBUTING.oss.md)
      return 0
      ;;
    scripts/check-oss-boundaries.sh|scripts/prepare-oss-snapshot.sh|scripts/oss-doc-sanitize.sh|scripts/publish-oss-release.sh)
      return 0
      ;;
  esac
  return 1
}

# Fleet runtime files may reference proprietary/ paths (private fleet repo only).
PROPRIETARY_REF_ALLOW=(
  deploy/scripts/vps-start.sh
  deploy/docker-compose.yml
  scripts/install-proprietary-apps.sh
  src/hermesLearning.ts
)

is_proprietary_ref_allowed() {
  local file="$1"
  for allowed in "${PROPRIETARY_REF_ALLOW[@]}"; do
    [[ "${file}" == "${allowed}" ]] && return 0
  done
  return 1
}

FAILED=0
RG_GLOBS=($(build_rg_globs))

for pattern in "${PATTERNS[@]}"; do
  while IFS= read -r file; do
    should_skip "${file}" && continue
    echo "[check-oss-boundaries] FAIL: '${pattern}' in ${file}" >&2
    FAILED=1
  done < <(rg -l --no-messages "${pattern}" "${RG_GLOBS[@]}" 2>/dev/null || true)
done

# proprietary/ path references in scan dirs (not in proprietary itself)
while IFS= read -r file; do
  should_skip "${file}" && continue
  is_proprietary_ref_allowed "${file}" && continue
  echo "[check-oss-boundaries] FAIL: proprietary path reference in ${file}" >&2
  FAILED=1
done < <(rg -l --no-messages 'proprietary/' "${RG_GLOBS[@]}" 2>/dev/null | rg -v '^proprietary/' || true)

if [[ "${FAILED}" -eq 1 ]]; then
  echo "[check-oss-boundaries] AGPL boundary violations found — fix before OSS publish." >&2
  exit 1
fi

# License layout: full AGPL text in AGPL-3.0.txt; LICENSE is a short dual-license selector.
if [[ ! -f "${ROOT_DIR}/AGPL-3.0.txt" ]]; then
  echo "[check-oss-boundaries] FAIL: missing AGPL-3.0.txt (full AGPL license text)" >&2
  FAILED=1
elif [[ "$(wc -l < "${ROOT_DIR}/AGPL-3.0.txt")" -lt 600 ]]; then
  echo "[check-oss-boundaries] FAIL: AGPL-3.0.txt looks truncated (expected full GPLv3/AGPL text)" >&2
  FAILED=1
fi
if rg -q 'GNU AFFERO GENERAL PUBLIC LICENSE' "${ROOT_DIR}/LICENSE" 2>/dev/null; then
  echo "[check-oss-boundaries] FAIL: LICENSE must be a short dual-license selector — full AGPL belongs in AGPL-3.0.txt" >&2
  FAILED=1
fi

if [[ "${FAILED}" -eq 1 ]]; then
  exit 1
fi

echo "[check-oss-boundaries] OK — no fleet-specific leaks in AGPL paths."
