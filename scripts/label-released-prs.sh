#!/usr/bin/env bash
# Label and comment each merged pull request with the GitHub Release that first contains it.
#
# Usage: bash scripts/label-released-prs.sh <tag> [--dry-run]
#   <tag>      Release tag, for example v0.1.48. The tag must have a published GitHub Release.
#   --dry-run  Print the pull requests. Do not change GitHub.
#
# A pull request belongs to release <tag> when <tag> is the lowest version tag
# (vMAJOR.MINOR.PATCH) that contains the merge commit of the pull request.
# The script skips pull requests that already have a label "release:*".
# Needs: git with full history and tags, gh (authenticated), jq.
set -euo pipefail

TAG="${1:-}"
DRY_RUN=false
[[ "${2:-}" == "--dry-run" ]] && DRY_RUN=true

if [[ ! "${TAG}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "[label-released-prs] tag must look like v1.2.3, got '${TAG}'" >&2
  exit 2
fi

REPO="${GITHUB_REPOSITORY:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}"
LABEL="release:${TAG}"

RELEASE_JSON="$(gh release view "${TAG}" --repo "${REPO}" --json url,isDraft,isPrerelease)"
if [[ "$(jq -r .isDraft <<<"${RELEASE_JSON}")" == "true" ]]; then
  echo "[label-released-prs] release ${TAG} is a draft; nothing to do"
  exit 0
fi
RELEASE_URL="$(jq -r .url <<<"${RELEASE_JSON}")"

git rev-parse --verify --quiet "refs/tags/${TAG}" >/dev/null || {
  echo "[label-released-prs] tag ${TAG} not found locally; fetch tags first" >&2
  exit 2
}

# Lowest version tag that contains a commit, or empty.
first_release_tag() {
  git tag --contains "$1" --list 'v*' --sort=v:refname 2>/dev/null \
    | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -1 || true
}

PRS_JSON="$(gh pr list --repo "${REPO}" --state merged --limit 1000 \
  --json number,title,mergeCommit,labels)"

MATCHED=()
while IFS=$'\t' read -r number sha has_release_label title; do
  [[ -z "${sha}" || "${has_release_label}" == "true" ]] && continue
  git cat-file -e "${sha}^{commit}" 2>/dev/null || continue
  [[ "$(first_release_tag "${sha}")" == "${TAG}" ]] || continue
  MATCHED+=("${number}")
  echo "[label-released-prs] #${number} ${title}"
done < <(jq -r '.[] | [
    .number,
    (.mergeCommit.oid // ""),
    ([.labels[].name | startswith("release:")] | any),
    .title
  ] | @tsv' <<<"${PRS_JSON}")

echo "[label-released-prs] ${#MATCHED[@]} pull request(s) for ${TAG}"
if [[ "${DRY_RUN}" == "true" || ${#MATCHED[@]} -eq 0 ]]; then
  exit 0
fi

gh label create "${LABEL}" --repo "${REPO}" --color 0e8a16 \
  --description "Shipped in GitHub Release ${TAG}" --force >/dev/null

for number in "${MATCHED[@]}"; do
  gh pr edit "${number}" --repo "${REPO}" --add-label "${LABEL}" >/dev/null
  # A locked pull request (for example a merged release pull request) takes no comment.
  # The label is the record, so a failed comment is only a warning.
  gh pr comment "${number}" --repo "${REPO}" \
    --body "Released in [${TAG}](${RELEASE_URL})." >/dev/null \
    || echo "[label-released-prs] warning: no comment on #${number} (locked?)" >&2
done
echo "[label-released-prs] labeled ${#MATCHED[@]} pull request(s) with ${LABEL}"
