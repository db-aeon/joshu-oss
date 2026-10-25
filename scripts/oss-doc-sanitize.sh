#!/usr/bin/env bash
# Post-process docs/ in an OSS snapshot tree — fix links and paths excluded from private canon.
set -euo pipefail

OUT_DIR="${1:?usage: oss-doc-sanitize.sh <snapshot-root>}"

if [[ ! -d "${OUT_DIR}/docs" ]]; then
  echo "[oss-doc-sanitize] no docs/ under ${OUT_DIR}" >&2
  exit 1
fi

echo "[oss-doc-sanitize] sanitizing ${OUT_DIR}/docs"

# Portable in-place sed (macOS + Linux).
sed_inplace() {
  if sed --version >/dev/null 2>&1; then
    sed -i "$@"
  else
    sed -i '' "$@"
  fi
}

find "${OUT_DIR}/docs" -type f \( -name '*.md' -o -name '*.json' \) -print0 |
  while IFS= read -r -d '' file; do
    sed_inplace \
      -e 's|hermes-customizations\.md|hermes-integration.md|g' \
      -e 's|hermes-customizations —|hermes-integration —|g' \
      -e 's|docs/hermes-customizations\.md|docs/hermes-integration.md|g' \
      -e 's|https://github.com/your-org/joshu\.git|https://github.com/db-aeon/joshu-oss.git|g' \
      -e 's|ghcr.io/your-org/joshu-oss|ghcr.io/db-aeon/joshu-oss|g' \
      -e 's|ghcr.io/your-org/joshu-sandbox|ghcr.io/db-aeon/joshu-sandbox|g' \
      -e 's|arozos/web-overlays/aroz-paper-shell\.css|arozos/web-overlays-vanilla/aroz-vanilla-shell.css|g' \
      -e 's|arozos/web-overlays/aroz-jchat-tray\.js|arozos/web-overlays-vanilla/aroz-jchat-tray.js|g' \
      -e 's|arozos/web-overlays/|arozos/web-overlays-vanilla/|g' \
      -e 's|vps-sandbox/control-plane-portal\.md|vps-sandbox/control-plane.md|g' \
      -e 's|apps/control-plane/|joshu-control-plane/|g' \
      -e 's|joshu-identity\.md|self-host.md#identity-without-control-plane|g' \
      -e 's|Joshu-SOP/ea-for-joshu\.md|hermes-integration.md|g' \
      -e 's|Joshu-SOP/time-block-planning\.md|excalidraw-sandbox.md|g' \
      -e 's|Joshu-SOP/gtd-workspace-linking\.md|file-brain.md|g' \
      -e 's|Joshu-SOP/executive-assistant\.md|welcome-onboarding.md|g' \
      -e 's|docs/Joshu-SOP/|docs/|g' \
      -e 's|/Users/danbenyamin/Documents/dev/joshu|~/joshu-oss|g' \
      -e 's|/Users/danbenyamin/Documents/dev/hermes-agent|~/hermes-agent|g' \
      -e 's|/Users/danbenyamin/Documents/dev/hermes-agent-next|~/hermes-agent-next|g' \
      -e 's|/Users/danbenyamin/Documents/dev|~/dev|g' \
      -e 's|/Users/danbenyamin/hermes-workspace|~/hermes-workspace|g' \
      -e 's|bash scripts/sync-local-portal-profile\.sh|configure identity in /etc/joshu/instance.env (see self-host.md)|g' \
      -e 's|\[`twilio-a2p-sms\.md`\]([^)]*)|managed fleet A2P runbook (not in OSS)|g' \
      -e 's|\[twilio-a2p-sms\.md\]([^)]*)|managed fleet A2P runbook (not in OSS)|g' \
      -e 's|twilio-a2p-sms\.md|twilio-self-host.md|g' \
      -e 's|private `twilio-a2p-sms` runbook|private fleet A2P runbook (not in OSS)|g' \
      -e 's|Fleet US SMS / A2P: private fleet A2P runbook (not in OSS)|SMS / A2P: see [twilio-self-host.md](vps-sandbox/twilio-self-host.md)|g' \
      "$file"
  done

# Drop internal-only doc trees if they slipped through rsync excludes.
rm -rf "${OUT_DIR}/docs/Joshu-SOP" 2>/dev/null || true

# A relative Markdown link to a file that is not in the OSS tree (a private doc, openspec/,
# vendor/, a fleet script) becomes plain text, so the public docs have no broken links.
python3 - "${OUT_DIR}" <<'PY'
import os, re, sys, urllib.parse

root = sys.argv[1]
link = re.compile(r'\[([^\]\n]*)\]\(([^)\s]+)(\s+"[^"]*")?\)')
# Fenced code blocks, and inline code that holds a link example, keep their text as it is.
# Inline code without "](" is left to the link pattern, because a link text such as
# [`a.md`](a.md) has backticks of its own.
code_span = re.compile(r'```.*?```|`[^`\n]*`', re.S)

def code_blocks(text):
    for m in code_span.finditer(text):
        if m.group(0).startswith("```") or "](" in m.group(0):
            yield m

for folder, _, files in os.walk(os.path.join(root, "docs")):
    for name in files:
        if not name.endswith(".md"):
            continue
        path = os.path.join(folder, name)
        with open(path, encoding="utf-8", errors="surrogateescape") as f:
            text = f.read()
        changed = []

        def unlink(match):
            target = match.group(2)
            if re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*:", target) or target.startswith(("#", "/", "<")):
                return match.group(0)
            file_part = urllib.parse.unquote(target.split("#")[0])
            if not file_part or os.path.exists(os.path.normpath(os.path.join(folder, file_part))):
                return match.group(0)
            changed.append(target)
            return match.group(1)

        parts, last = [], 0
        for m in code_blocks(text):
            parts.append(link.sub(unlink, text[last:m.start()]))
            parts.append(m.group(0))
            last = m.end()
        parts.append(link.sub(unlink, text[last:]))
        if changed:
            with open(path, "w", encoding="utf-8", errors="surrogateescape") as f:
                f.write("".join(parts))
            rel = os.path.relpath(path, root)
            for target in changed:
                print(f"[oss-doc-sanitize] unlinked {rel} -> {target}")
PY

echo "[oss-doc-sanitize] done"
