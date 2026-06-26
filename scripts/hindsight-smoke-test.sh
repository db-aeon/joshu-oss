#!/usr/bin/env bash
# Retain and recall a unique marker through the local Hindsight API.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HERMES_HOME="${HERMES_HOME:-${HOME}/.hermes}"

load_env_file() {
  local env_file="$1"
  if [[ -f "${env_file}" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "${env_file}"
    set +a
  fi
}

load_env_file "${ROOT_DIR}/.env"
load_env_file "${HERMES_HOME}/.env"

if [[ -n "${HINDSIGHT_PYTHON:-}" ]]; then
  python_bin="${HINDSIGHT_PYTHON}"
elif [[ -n "${HERMES_BIN:-}" && -x "$(dirname "${HERMES_BIN}")/python" ]]; then
  python_bin="$(dirname "${HERMES_BIN}")/python"
elif [[ -x "/Users/danbenyamin/Documents/dev/hermes-agent/venv/bin/python" ]]; then
  python_bin="/Users/danbenyamin/Documents/dev/hermes-agent/venv/bin/python"
else
  python_bin="python3"
fi

"${python_bin}" - <<'PY'
import os
import sys
import time
import uuid

try:
    from hindsight_client import Hindsight
except Exception as exc:
    print(f"[hindsight-smoke] could not import hindsight_client: {exc}", file=sys.stderr)
    print("[hindsight-smoke] install it in the selected Python env or set HINDSIGHT_PYTHON.", file=sys.stderr)
    raise SystemExit(1)

base_url = os.environ.get("HINDSIGHT_API_URL", "http://127.0.0.1:8888").rstrip("/")
bank_id = os.environ.get("HINDSIGHT_BANK_ID", "joshu")
api_key = os.environ.get("HINDSIGHT_API_KEY", "")
marker = f"joshu-hindsight-smoke-{uuid.uuid4().hex[:12]}"
content = (
    f"Smoke test marker: {marker}. "
    "This is a short-lived verification that Joshu can store and recall Hindsight memory."
)

kwargs = {"base_url": base_url}
if api_key:
    kwargs["api_key"] = api_key

print(f"[hindsight-smoke] base_url={base_url}")
print(f"[hindsight-smoke] bank_id={bank_id}")
print(f"[hindsight-smoke] marker={marker}")

client = Hindsight(**kwargs)

try:
    client.create_bank(
        bank_id=bank_id,
        name="Joshu Memory",
        reflect_mission="Remember durable user preferences, project facts, and useful cross-session context for Joshu.",
    )
    print("[hindsight-smoke] created memory bank")
except Exception as exc:
    print(f"[hindsight-smoke] create_bank skipped/failed: {exc}")

print("[hindsight-smoke] retaining marker...")
client.retain(bank_id=bank_id, content=content, context="joshu smoke test")

last_texts: list[str] = []
for attempt in range(1, 13):
    time.sleep(2)
    print(f"[hindsight-smoke] recall attempt {attempt}/12")
    result = client.recall(bank_id=bank_id, query=marker, budget="low")
    results = getattr(result, "results", None) or []
    last_texts = [getattr(item, "text", str(item)) for item in results]
    if any(marker in text for text in last_texts):
        print("[hindsight-smoke] success: marker was recalled")
        for idx, text in enumerate(last_texts[:5], start=1):
            print(f"\n--- memory {idx} ---\n{text}")
        raise SystemExit(0)

print("[hindsight-smoke] failed: marker was not recalled", file=sys.stderr)
if last_texts:
    print("[hindsight-smoke] last recall returned:", file=sys.stderr)
    for idx, text in enumerate(last_texts[:5], start=1):
        print(f"\n--- memory {idx} ---\n{text}", file=sys.stderr)
raise SystemExit(1)
PY
