#!/usr/bin/env bash
# Prefetch skill evolution changes from a learning GitHub repo for manual Cursor review.
# Usage: scripts/skill-evolution-review-prefetch.sh [--slug patrick] [--since <sha>]
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ORG="${JOSHU_GITHUB_LEARNING_ORG:-db-aeon}"
SLUG="patrick"
SINCE=""
STATE_FILE="${ROOT_DIR}/.joshu/skill-review-state.json"

usage() {
  echo "Usage: $0 [--slug SLUG] [--since SHA]" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --slug) SLUG="${2:?}"; shift 2 ;;
    --since) SINCE="${2:?}"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "Unknown arg: $1" >&2; usage ;;
  esac
done

REPO="${ORG}/joshu-learning-${SLUG}"
log() { printf '[skill-evolution-prefetch] %s\n' "$*"; }

if ! command -v gh >/dev/null 2>&1; then
  log "ERROR: gh CLI not found (install and run gh auth login)" >&2
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  log "ERROR: gh not authenticated (run gh auth login)" >&2
  exit 1
fi

# Resolve base SHA from --since or state file.
if [[ -z "${SINCE}" && -f "${STATE_FILE}" ]]; then
  SINCE="$(python3 -c "
import json, sys
try:
    d = json.load(open('${STATE_FILE}'))
    print(d.get('${SLUG}', {}).get('lastReviewedSha', '') or '')
except Exception:
    print('')
" 2>/dev/null || true)"
fi

HEAD="$(gh api "repos/${REPO}/commits?sha=main&per_page=1" --jq '.[0].sha')"
HEAD_MSG="$(gh api "repos/${REPO}/commits?sha=main&per_page=1" --jq '.[0].commit.message' | head -1)"
HEAD_DATE="$(gh api "repos/${REPO}/commits?sha=main&per_page=1" --jq '.[0].commit.committer.date')"

log "repo: ${REPO}"
log "head: ${HEAD} (${HEAD_DATE})"
log "     ${HEAD_MSG}"

if [[ -n "${SINCE}" && "${SINCE}" == "${HEAD}" ]]; then
  log "no new commits since ${SINCE}"
  exit 0
fi

# Langfuse host for UI links (optional project id).
LANGFUSE_HOST="${HERMES_LANGFUSE_BASE_URL:-${LANGFUSE_BASE_URL:-https://us.cloud.langfuse.com}}"
LANGFUSE_PROJECT_ID="${LANGFUSE_PROJECT_ID:-}"

echo ""
echo "=== Commits since last review ==="
if [[ -n "${SINCE}" ]]; then
  gh api "repos/${REPO}/compare/${SINCE}...${HEAD}" \
    --jq '.commits[] | "\(.sha[0:7]) \(.commit.committer.date) \(.commit.message | split("\n")[0])"'
  COMPARE_JSON="$(gh api "repos/${REPO}/compare/${SINCE}...${HEAD}")"
else
  log "no base SHA (--since or state file); showing last 5 commits"
  gh api "repos/${REPO}/commits?sha=main&per_page=5" \
    --jq '.[] | "\(.sha[0:7]) \(.commit.committer.date) \(.commit.message | split("\n")[0])"'
  # Compare oldest of last 5 to HEAD for file diffs.
  OLDEST="$(gh api "repos/${REPO}/commits?sha=main&per_page=5" --jq '.[-1].sha')"
  COMPARE_JSON="$(gh api "repos/${REPO}/compare/${OLDEST}...${HEAD}")"
fi

echo ""
echo "=== Changed skill files ==="
echo "${COMPARE_JSON}" | python3 -c "
import json, sys
data = json.load(sys.stdin)
for f in data.get('files', []):
    name = f.get('filename', '')
    if 'SKILL.md' in name or name.endswith('.evolution.jsonl'):
        print(f\"{f.get('status')}: {name} (+{f.get('additions',0)} -{f.get('deletions',0)})\")
"

echo ""
echo "=== New evolution.jsonl entries (added lines) ==="
EVO_PATCH="$(echo "${COMPARE_JSON}" | python3 -c "
import json, sys
data = json.load(sys.stdin)
for f in data.get('files', []):
    if f.get('filename', '').endswith('.evolution.jsonl'):
        print(f.get('patch') or '')
        break
" 2>/dev/null || true)"

if [[ -z "${EVO_PATCH}" ]]; then
  log "no .evolution.jsonl diff in range (may be SKILL-only changes or first fetch)"
else
  echo "${EVO_PATCH}" | grep '^+' | grep -v '^+++' | sed 's/^+//' | while IFS= read -r line; do
    [[ -z "${line}" ]] && continue
    echo "${line}"
    SID="$(echo "${line}" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d.get('session_id',''))" 2>/dev/null || true)"
    if [[ -n "${SID}" ]]; then
      if [[ -n "${LANGFUSE_PROJECT_ID}" ]]; then
        echo "  langfuse: ${LANGFUSE_HOST}/project/${LANGFUSE_PROJECT_ID}/traces?filter=sessionId%3D${SID}"
      else
        echo "  langfuse: search sessionId=${SID} userId=${SLUG} at ${LANGFUSE_HOST}"
      fi
    fi
    echo ""
  done
fi

echo ""
echo "=== Next steps ==="
echo "1. In Cursor: review skill evolution for ${SLUG}"
echo "2. npx langfuse-cli api traces list --sessionId \"<session_id>\" --limit 10 --json"
echo "3. Append findings to docs/Joshu-SOP/skill-evolution-reviews.md"
echo "4. Update ${STATE_FILE} with lastReviewedSha: ${HEAD}"
