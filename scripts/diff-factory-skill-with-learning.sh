#!/usr/bin/env bash
# Diff a factory Hermes skill against joshu-learning-{slug} on GitHub.
# Usage: scripts/diff-factory-skill-with-learning.sh executive-assistant/ea-scheduling [slug]
set -euo pipefail

REL="${1:?skill path under integrations/hermes/skills, e.g. executive-assistant/ea-scheduling}"
SLUG="${2:-patrick}"
ORG="${JOSHU_LEARNING_ORG:-db-aeon}"
REPO="${ORG}/joshu-learning-${SLUG}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FACTORY="${ROOT}/integrations/hermes/skills/${REL}/SKILL.md"
REMOTE_PATH="skills/joshu/${REL}/SKILL.md"
TMP="$(mktemp)"

if [[ ! -f "$FACTORY" ]]; then
  echo "Factory skill not found: $FACTORY" >&2
  exit 1
fi

echo "Factory:  $FACTORY"
echo "Learning: ${REPO}/${REMOTE_PATH}"
echo "---"

gh api "repos/${REPO}/contents/${REMOTE_PATH}?ref=main" --jq '.content' | base64 -d >"$TMP"
diff -u "$FACTORY" "$TMP" || true
rm -f "$TMP"
