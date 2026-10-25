#!/usr/bin/env python3
"""
No-training routing for the OpenRouter requests of the vendored last30days engine.

The engine calls OpenRouter for the planner and rerank (OpenRouterClient in
lib/providers.py) and for the Perplexity Sonar fallback (lib/perplexity.py). Both
build a fixed payload. This patch adds provider.data_collection "deny" to both
payloads.

Spec: openspec model-provider-privacy (change openrouter-data-collection-deny).
Idempotent — safe to re-run after sync-last30days-skill.sh. Stops with an error
when an anchor is missing, so a new engine pin cannot drop the setting silently.

Usage: python3 scripts/patch-last30days-openrouter-data-collection.py [path/to/scripts/lib]
"""
from __future__ import annotations

import sys
from pathlib import Path

MARKER = "joshu: no-training routing"

PROVIDERS_OLD = """        payload = {
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": 0,
        }
        response = http.post(
            os.environ.get("OPENROUTER_BASE_URL", OPENROUTER_URL),
"""
PROVIDERS_NEW = """        payload = {
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": 0,
            # joshu: no-training routing (patch-last30days-openrouter-data-collection.py)
            "provider": {"data_collection": "deny"},
        }
        response = http.post(
            os.environ.get("OPENROUTER_BASE_URL", OPENROUTER_URL),
"""

PERPLEXITY_OLD = """    if provider != "perplexity":
        json_data.pop("web_search_options", None)
        json_data.pop("reasoning_effort", None)
"""
PERPLEXITY_NEW = """    if provider != "perplexity":
        json_data.pop("web_search_options", None)
        json_data.pop("reasoning_effort", None)
        # joshu: no-training routing (patch-last30days-openrouter-data-collection.py)
        json_data["provider"] = {"data_collection": "deny"}
"""


def log(msg: str) -> None:
    print(f"[patch-last30days-openrouter-data-collection] {msg}")


def patch(path: Path, old: str, new: str) -> None:
    text = path.read_text(encoding="utf-8")
    if MARKER in text:
        log(f"already patched {path}")
        return
    if text.count(old) != 1:
        raise SystemExit(f"[patch-last30days-openrouter-data-collection] anchor not found once in {path}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")
    log(f"patched {path}")


def main() -> int:
    if len(sys.argv) > 1:
        lib = Path(sys.argv[1])
    else:
        root = Path(__file__).resolve().parents[1]
        lib = root / "integrations" / "last30days-skill" / "skills" / "last30days" / "scripts" / "lib"
    providers = lib / "providers.py"
    perplexity = lib / "perplexity.py"
    if not providers.is_file() or not perplexity.is_file():
        print(f"[patch-last30days-openrouter-data-collection] skip — missing {lib}", file=sys.stderr)
        return 0
    patch(providers, PROVIDERS_OLD, PROVIDERS_NEW)
    patch(perplexity, PERPLEXITY_OLD, PERPLEXITY_NEW)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
