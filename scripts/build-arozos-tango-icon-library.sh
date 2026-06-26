#!/usr/bin/env bash
# Import the full Tango 256×256 PNG set into the repo (used + unused icons).
#
# Source: tango-icons-for-windows (zip from GitHub releases / user Downloads).
# Output: arozos/tango-icons/<category>/<name>.png  (230 icons)
#         arozos/tango-icons/manifest.json
#
# Served on the box as web/img/tango/ via apply_arozos_joshu_theme.py.
#
# Usage:
#   TANGO_ICONS_ZIP=~/Downloads/tango-icons-for-windows-main.zip \
#     bash scripts/build-arozos-tango-icon-library.sh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ZIP="${TANGO_ICONS_ZIP:-${HOME}/Downloads/tango-icons-for-windows-main.zip}"
CACHE="/tmp/tango-icons"
SRC="${CACHE}/tango-icons-for-windows-main/256x256"
OUT="${ROOT_DIR}/arozos/tango-icons"

if [[ ! -f "${ZIP}" ]]; then
  echo "[build-arozos-tango-icon-library] missing zip: ${ZIP}" >&2
  echo "[build-arozos-tango-icon-library] set TANGO_ICONS_ZIP or place the file in ~/Downloads" >&2
  exit 1
fi

if [[ ! -d "${SRC}" ]]; then
  mkdir -p "${CACHE}"
  unzip -q -o "${ZIP}" -d "${CACHE}"
fi

if [[ ! -d "${SRC}" ]]; then
  echo "[build-arozos-tango-icon-library] expected 256x256 tree under ${SRC}" >&2
  exit 1
fi

# Fresh import — drop stale categories if Tango pack changes.
rm -rf "${OUT}"
mkdir -p "${OUT}"

count=0
while IFS= read -r -d '' png; do
  rel="${png#"${SRC}/"}"
  dest="${OUT}/${rel}"
  mkdir -p "$(dirname "${dest}")"
  cp -f "${png}" "${dest}"
  count=$((count + 1))
done < <(find "${SRC}" -name '*.png' -print0 | sort -z)

python3 - "${OUT}" <<'PY'
import json
import sys
from pathlib import Path

out = Path(sys.argv[1])
entries = []
for png in sorted(out.rglob("*.png")):
    rel = png.relative_to(out)
    category = rel.parts[0] if len(rel.parts) > 1 else ""
    entries.append(
        {
            "path": rel.as_posix(),
            "category": category,
            "name": png.stem,
        }
    )

manifest = {
    "source": "tango-icons-for-windows 256x256",
    "count": len(entries),
    "categories": sorted({e["category"] for e in entries if e["category"]}),
    "icons": entries,
}
(out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
print(f"[build-arozos-tango-icon-library] manifest -> {out / 'manifest.json'} ({len(entries)} icons)")
PY

echo "[build-arozos-tango-icon-library] imported ${count} PNGs -> ${OUT}"
