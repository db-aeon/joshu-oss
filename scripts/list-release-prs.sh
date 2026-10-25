#!/usr/bin/env bash
# Print, as JSON, the merged pull requests that HEAD contains and tag <base-tag> does not.
# The release workflow gives this list to the release notes step.
#
# Usage: bash scripts/list-release-prs.sh <base-tag>   # for example v0.1.51
#
# Each item: number, title, url, author, mergedAt, labels, files (paths), body.
# Needs: git with full history and tags, gh (authenticated), jq.
set -euo pipefail

BASE="${1:-}"
git rev-parse --verify --quiet "refs/tags/${BASE}" >/dev/null || {
  echo "[list-release-prs] tag '${BASE}' not found; fetch tags first" >&2
  exit 2
}

REPO="${GITHUB_REPOSITORY:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}"
COMMITS="$(git rev-list "${BASE}..HEAD" | jq -R . | jq -s .)"

gh pr list --repo "${REPO}" --state merged --base main --limit 300 \
  --json number,title,url,author,mergedAt,mergeCommit,labels,files,body \
  | jq --argjson commits "${COMMITS}" '
      map(select(.mergeCommit.oid as $sha | $commits | index($sha)))
      | sort_by(.mergedAt)
      | map({
          number, title, url, mergedAt,
          author: .author.login,
          labels: [.labels[].name],
          files: [.files[].path],
          body
        })'
