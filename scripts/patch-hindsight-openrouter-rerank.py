#!/usr/bin/env python3
"""No-training routing for the Hindsight rerank request to OpenRouter.

Hindsight (hindsight-api-slim 0.7.2) calls https://openrouter.ai/api/v1/rerank when
HINDSIGHT_API_RERANKER_PROVIDER=openrouter. The rerank request has a fixed body, and
no Hindsight setting adds fields. This patch adds provider.data_collection "deny"
to the body when the rerank URL is OpenRouter. The Hindsight LLM calls get the same
value from HINDSIGHT_API_LLM_EXTRA_BODY (scripts/start-hindsight.sh).

Spec: openspec model-provider-privacy (change openrouter-data-collection-deny).
Idempotent. Stops with an error when the anchor is missing, so a Hindsight upgrade
that moves the code fails the image build.

Usage (with the Python that has hindsight_api installed):
  /opt/hermes-agent/venv/bin/python scripts/patch-hindsight-openrouter-rerank.py [path/to/cross_encoder.py]
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

MARKER = "Joshu: no-training routing"

OLD = """            if self.include_top_n:
                body["top_n"] = len(texts)

            response = await self._async_client.post(self.rerank_url, json=body)
"""
NEW = """            if self.include_top_n:
                body["top_n"] = len(texts)
            # Joshu: no-training routing for the OpenRouter rerank endpoint.
            if "openrouter.ai" in (self.rerank_url or ""):
                body["provider"] = {"data_collection": "deny"}

            response = await self._async_client.post(self.rerank_url, json=body)
"""


def log(msg: str) -> None:
    print(f"[hindsight-openrouter-rerank] {msg}")


def cross_encoder_path() -> Path:
    if len(sys.argv) > 1:
        return Path(sys.argv[1])
    spec = importlib.util.find_spec("hindsight_api")
    if spec is None or not spec.submodule_search_locations:
        raise SystemExit("[hindsight-openrouter-rerank] hindsight_api is not installed for this Python")
    return Path(list(spec.submodule_search_locations)[0]) / "engine" / "cross_encoder.py"


def main() -> int:
    path = cross_encoder_path()
    text = path.read_text(encoding="utf-8")
    if MARKER in text:
        log(f"already patched {path}")
        return 0
    if text.count(OLD) != 1:
        raise SystemExit(f"[hindsight-openrouter-rerank] rerank body anchor not found once in {path}")
    path.write_text(text.replace(OLD, NEW, 1), encoding="utf-8")
    log(f"patched {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
