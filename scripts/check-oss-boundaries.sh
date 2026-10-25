#!/usr/bin/env bash
# Fail if fleet-specific identifiers appear in AGPL-tracked paths.
# Run from repo root: bash scripts/check-oss-boundaries.sh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

SCAN_DIRS=(
  .env.example
  .hermes
  .joshu
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

# Paths that prepare-oss-snapshot.sh excludes (--exclude) or removes ("${OUT_DIR}/…") are not
# published, so this check skips them. Reading the list from that script keeps both in step.
# Names without a slash (dist, .git, …) match anywhere and are in EXCLUDE_PATHS above.
SNAPSHOT_EXCLUDES=()
while IFS= read -r excluded; do
  [[ -n "${excluded}" ]] && SNAPSHOT_EXCLUDES+=("${excluded}")
done < <(
  {
    grep -oE -- "--exclude +['\"]?[^'\" ]+" "${ROOT_DIR}/scripts/prepare-oss-snapshot.sh" | sed -E "s/^--exclude +['\"]?//"
    grep -oE '"\$\{OUT_DIR\}"?/[^" ]+' "${ROOT_DIR}/scripts/prepare-oss-snapshot.sh" | sed -E 's#^"\$\{OUT_DIR\}"?/##'
  } | sed -E 's#^/##; s#/$##' | grep '/' || true
)

is_snapshot_excluded() {
  local file="$1" excluded
  for excluded in ${SNAPSHOT_EXCLUDES[@]+"${SNAPSHOT_EXCLUDES[@]}"}; do
    # Unquoted right side: the entry is a glob (for example scripts/hotpatch-*).
    [[ "${file}" == ${excluded} || "${file}" == ${excluded}/* ]] && return 0
  done
  return 1
}

should_skip() {
  local file="$1"
  is_snapshot_excluded "${file}" && return 0
  for ex in "${EXCLUDE_PATHS[@]}"; do
    [[ "${file}" == "${ex}"/* || "${file}" == *"/${ex}/"* || "${file}" == *"/${ex}" ]] && return 0
  done
  # docs/<name>.md with a docs/<name>.oss.md twin: the twin replaces it in the OSS tree.
  [[ "${file}" == docs/*.md && "${file}" != *.oss.md && -f "${ROOT_DIR}/${file%.md}.oss.md" ]] && return 0
  # Private-only docs excluded from OSS snapshot.
  case "${file}" in
    docs/joshu-identity.md|docs/day0-cold-start.md|docs/hermes-customizations.md)
      return 0
      ;;
    docs/vps-sandbox/first-provisioning-notes.md|docs/vps-sandbox/troubleshooting-and-lessons.md|docs/vps-sandbox/hotpatch-running-box.md|docs/vps-sandbox/existing-box-image-vs-host.md|docs/vps-sandbox/twilio-a2p-sms.md|docs/vps-sandbox/provider-choices.md|docs/vps-sandbox/phone-voice-local-test.md|docs/vps-sandbox/credential-isolation-langfuse-relay.md|docs/vps-sandbox/control-plane.md)
      return 0
      ;;
    # Fleet release notes and fleet upgrade runbooks (excluded from OSS snapshot).
    docs/releases/*|docs/vps-sandbox/box-skill-reconcile-on-upgrade.md)
      return 0
      ;;
    docs/design/brand-guidelines.md)
      return 0
      ;;
    README.md|CONTRIBUTING.md|README.oss.md|CONTRIBUTING.oss.md)
      return 0
      ;;
    # Fleet-only export/sync pipeline (stripped from OSS snapshot).
    scripts/check-oss-boundaries.sh|scripts/prepare-oss-snapshot.sh|scripts/oss-doc-sanitize.sh|scripts/publish-oss-release.sh|scripts/sync-from-oss.sh|scripts/repair-fleet-*)
      return 0
      ;;
    # Fleet-only scripts that prepare-oss-snapshot.sh removes from the OSS tree.
    scripts/sync-hermes-to-vps.sh|scripts/patrick-travel-booking-owner-selection.md)
      return 0
      ;;
  esac
  return 1
}

# Fleet runtime files may reference proprietary/ paths (private fleet repo only).
PROPRIETARY_REF_ALLOW=(
  deploy/scripts/vps-start.sh
  docs/oss-fleet-sync.md
  scripts/ensure-vendor-for-build.sh
  scripts/stage-docker-design-pack.sh
  scripts/vps-build-image.sh
  src/hermesLearningGitCron.ts
  deploy/docker-compose.yml
  scripts/install-proprietary-apps.sh
  src/hermesLearning.ts
  src/proactive/proactiveCronJobs.ts
)

is_proprietary_ref_allowed() {
  local file="$1"
  for allowed in "${PROPRIETARY_REF_ALLOW[@]}"; do
    [[ "${file}" == "${allowed}" ]] && return 0
  done
  return 1
}

FAILED=0
# Search the scan directories as rg path arguments.
# An earlier unquoted $(...) of "dir/**/*" globs was expanded by the shell into file names,
# so rg searched only some files. With --glob alone and no path, rg reads stdin instead.
RG_PATHS=()
for dir in "${SCAN_DIRS[@]}"; do
  [[ -e "${ROOT_DIR}/${dir}" ]] && RG_PATHS+=("${dir}")
done

for pattern in "${PATTERNS[@]}"; do
  while IFS= read -r file; do
    should_skip "${file}" && continue
    # secret-scan.sh names apps/control-plane/.env.local only to fail when that file is in the OSS tree.
    [[ "${pattern}" == 'apps/control-plane/' && "${file}" == scripts/secret-scan.sh ]] && continue
    echo "[check-oss-boundaries] FAIL: '${pattern}' in ${file}" >&2
    FAILED=1
  done < <(rg -l --no-messages "${pattern}" "${RG_PATHS[@]}" 2>/dev/null </dev/null || true)
done

# Private identifiers from production (names, companies, mailbox keys, box addresses).
# The list is in proprietary/, which is not published, so this script does not leak it.
PRIVATE_IDENTIFIERS_FILE="${ROOT_DIR}/proprietary/oss-private-identifiers.txt"
if [[ -f "${PRIVATE_IDENTIFIERS_FILE}" ]]; then
  while IFS= read -r pattern; do
    [[ -z "${pattern}" || "${pattern}" == \#* ]] && continue
    while IFS= read -r file; do
      should_skip "${file}" && continue
      echo "[check-oss-boundaries] FAIL: private identifier /${pattern}/ in ${file}" >&2
      FAILED=1
    # rg reads stdin when it has no path argument; give it /dev/null, not the pattern file.
    done < <(rg -l -i --no-messages "${pattern}" "${RG_PATHS[@]}" 2>/dev/null </dev/null || true)
  done < "${PRIVATE_IDENTIFIERS_FILE}"
else
  echo "[check-oss-boundaries] note: ${PRIVATE_IDENTIFIERS_FILE} not found; private identifier check skipped" >&2
fi

# proprietary/ path references in scan dirs (not in proprietary itself)
while IFS= read -r file; do
  should_skip "${file}" && continue
  is_proprietary_ref_allowed "${file}" && continue
  echo "[check-oss-boundaries] FAIL: proprietary path reference in ${file}" >&2
  FAILED=1
done < <(rg -l --no-messages 'proprietary/' "${RG_PATHS[@]}" 2>/dev/null </dev/null | rg -v '^proprietary/' || true)

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
