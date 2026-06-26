#!/usr/bin/env bash
# Apply Joshu skill evolution ledger patch to Hermes skill_manager_tool.py (idempotent).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HERMES_DIR="${HERMES_DIR:-/opt/hermes-agent}"
TARGET="${HERMES_DIR}/tools/skill_manager_tool.py"
PATCH="${SCRIPT_DIR}/hermes-skill-evolution.patch"

if [[ ! -f "${TARGET}" ]]; then
  echo "[hermes-skill-evolution-patch] skip: ${TARGET} not found"
  exit 0
fi

if rg -q "_append_skill_evolution_record" "${TARGET}" 2>/dev/null; then
  echo "[hermes-skill-evolution-patch] already applied"
  exit 0
fi

apply_with_python() {
  python3 - "${TARGET}" <<'PY'
import sys
from pathlib import Path

path = Path(sys.argv[1])
text = path.read_text()
if "_append_skill_evolution_record" in text:
    print("[hermes-skill-evolution-patch] already applied (python)")
    sys.exit(0)

helper = '''

def _append_skill_evolution_record(action: str, name: str, message: str) -> None:
    """Append one JSON line to ~/.hermes/skills/.evolution.jsonl (best-effort)."""
    try:
        import os
        from datetime import datetime, timezone
        from tools.skill_provenance import get_current_write_origin
        record = {
            "ts": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "session_id": os.environ.get("HERMES_SESSION_ID") or "",
            "origin": get_current_write_origin(),
            "skill": name,
            "action": action,
            "message": (message or "")[:500],
        }
        path = SKILLS_DIR / ".evolution.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\\n")
    except Exception:
        logger.debug("skill evolution record append failed", exc_info=True)


'''

needle = "def skill_manage(\n"
if needle not in text:
    print("[hermes-skill-evolution-patch] error: skill_manage entry point not found", file=sys.stderr)
    sys.exit(1)

text = text.replace(needle, helper + needle, 1)

call = '''        try:
            _append_skill_evolution_record(
                action,
                name,
                str(result.get("message", "")) if isinstance(result, dict) else "",
            )
        except Exception:
            pass

    return json.dumps(result, ensure_ascii=False)'''

old_return = "    return json.dumps(result, ensure_ascii=False)"
if old_return not in text:
    print("[hermes-skill-evolution-patch] error: skill_manage return not found", file=sys.stderr)
    sys.exit(1)

text = text.replace(old_return, call, 1)
path.write_text(text)
print("[hermes-skill-evolution-patch] applied via python")
PY
}

if [[ -f "${PATCH}" ]]; then
  echo "[hermes-skill-evolution-patch] applying from ${PATCH}"
  if (cd "${HERMES_DIR}" && patch --forward -p1 --batch < "${PATCH}" 2>/dev/null); then
    echo "[hermes-skill-evolution-patch] done"
    exit 0
  fi
  echo "[hermes-skill-evolution-patch] patch failed; falling back to python"
fi

apply_with_python
echo "[hermes-skill-evolution-patch] done"
