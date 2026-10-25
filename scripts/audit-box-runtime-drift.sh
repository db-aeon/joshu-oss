#!/usr/bin/env bash
# Read-only audit of runtime drift on fleet boxes (change image-owned-box-runtime).
# For each box it prints what runs from the host instead of from the release images:
# host mounts into the stack container, the host checkout, credentials in git remote
# URLs (yes or no, never the value), hotfix overlay files, the host bundle version,
# the compose project and volumes, and the instance agent image. It changes nothing.
#
# Usage: bash scripts/audit-box-runtime-drift.sh [slug ...]
#   Default slugs: the live boxes from scripts/fleet-boxes.mjs (control plane, or JOSHU_FLEET_SLUGS).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if (($# > 0)); then
  SLUGS=("$@")
else
  LIVE="$(node "${ROOT_DIR}/scripts/fleet-boxes.mjs")"
  read -r -d '' -a SLUGS <<<"${LIVE}" || true
fi

read -r -d '' REMOTE <<'REMOTE' || true
set -u
I=/opt/joshu
CID="$(docker ps -q --filter label=com.docker.compose.project=deploy --filter label=com.docker.compose.service=joshu-stack | head -1)"
echo "release:        $(sed -n 's/^JOSHU_RELEASE_VERSION=//p' /etc/joshu/instance.env 2>/dev/null | tail -1)"
echo "host bundle:    $(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$I/deploy/.host-bundle.json" 2>/dev/null || true)"
if [ -d "$I/.git" ]; then
  echo "host checkout:  yes ($(git -C "$I" log -1 --format='%h %cs' 2>/dev/null), $(git -C "$I" status --porcelain 2>/dev/null | wc -l | tr -d ' ') changed files)"
  if grep -Eq '^[[:space:]]*url = [a-z+]+://[^/@[:space:]]+@' "$I/.git/config" 2>/dev/null; then
    echo "credentials in git remote URL: YES"
  else
    echo "credentials in git remote URL: no"
  fi
else
  echo "host checkout:  no"
fi
for r in /opt/joshu-checkout-retired-*; do
  [ -d "$r" ] || continue
  if grep -Eq '^[[:space:]]*url = [a-z+]+://[^/@[:space:]]+@' "$r/.git/config" 2>/dev/null; then c=YES; else c=no; fi
  echo "retired checkout: $r (credentials in git remote URL: $c)"
done
echo "hotfix overlay files:"
find "$I/hotfix/scripts" -mindepth 1 -type f ! -name .gitkeep 2>/dev/null | sed "s|^$I/hotfix/scripts/|  |" | head -20
if [ -n "$CID" ]; then
  echo "stack bind mounts at or below /opt/joshu (only the hotfix overlay is expected):"
  docker inspect -f '{{range .Mounts}}{{if eq .Type "bind"}}{{.Source}} -> {{.Destination}}{{"\n"}}{{end}}{{end}}' "$CID" \
    | grep -E -- '-> /opt/joshu(/|$)' | sed 's/^/  /'
  echo "stack volumes:  $(docker inspect -f '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}} {{end}}{{end}}' "$CID")"
  echo "stack image:    $(docker inspect -f '{{.Config.Image}}' "$CID")"
else
  echo "stack container: NOT FOUND"
fi
echo "compose files:  $(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$CID" 2>/dev/null)"
AID="$(docker ps -q --filter label=com.docker.compose.project=deploy --filter label=com.docker.compose.service=instance-agent | head -1)"
if [ -n "$AID" ]; then
  echo "agent image:    $(docker inspect -f '{{.Config.Image}} {{json .Config.Cmd}}' "$AID")"
else
  echo "agent:          not running"
fi
REMOTE

for slug in "${SLUGS[@]}"; do
  echo "== ${slug}"
  ssh -o BatchMode=yes -o ConnectTimeout=10 "root@${slug}.box.joshu.me" "bash -s" <<<"${REMOTE}" 2>&1 | sed 's/^/  /' \
    || echo "  SSH failed"
done
