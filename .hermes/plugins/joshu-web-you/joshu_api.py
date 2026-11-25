"""The calls of plugin joshu-web-you to the Joshu API on localhost. This module does not import Hermes.

- Search: `POST /api/web/search` with `{"query", "limit"}`. The reply has the web results in `web`,
  each with `url`, `title`, `description`, and `position`.
- Extract: `POST /api/web/extract` with `{"urls"}`. The reply has the pages that could be read in
  `pages`, each with `url`, `title`, and `content`.

The Joshu API chooses the provider (You.com, with Exa as the fallback) and holds the access. A
call that fails raises `JoshuWebError`.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Any, Dict, List

# The Joshu API waits up to 30 seconds for a search and up to 60 seconds for the pages.
SEARCH_TIMEOUT_SECONDS = 40
EXTRACT_TIMEOUT_SECONDS = 75


class JoshuWebError(Exception):
    """A call to the Joshu API failed: no answer, an HTTP error, or a reply that is not JSON."""


def api_base() -> str:
    return os.environ.get("JOSHU_API_BASE_URL", "http://127.0.0.1:8788/joshu").rstrip("/")


def post(path: str, body: Dict[str, Any], timeout: int) -> Dict[str, Any]:
    request = urllib.request.Request(
        f"{api_base()}{path}",
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            reply = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = str(json.loads(exc.read().decode("utf-8", errors="replace")).get("error") or "")
        except Exception:  # noqa: BLE001 - the error body is optional
            detail = ""
        raise JoshuWebError(f"the Joshu API answered HTTP {exc.code}{': ' + detail if detail else ''}") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise JoshuWebError(f"the Joshu API could not be reached: {exc}") from exc
    except ValueError as exc:
        raise JoshuWebError("the Joshu API answered with text that is not JSON") from exc
    if not isinstance(reply, dict) or not reply.get("ok"):
        raise JoshuWebError(str(reply.get("error") if isinstance(reply, dict) else "") or "the Joshu API answered with an error")
    return reply


def search(query: str, limit: int) -> List[Dict[str, Any]]:
    reply = post("/api/web/search", {"query": query, "limit": int(limit or 5)}, SEARCH_TIMEOUT_SECONDS)
    web = reply.get("web")
    return [r for r in web if isinstance(r, dict) and r.get("url")] if isinstance(web, list) else []


def extract(urls: List[str]) -> List[Dict[str, Any]]:
    reply = post("/api/web/extract", {"urls": list(urls)}, EXTRACT_TIMEOUT_SECONDS)
    pages = reply.get("pages")
    return [p for p in pages if isinstance(p, dict) and p.get("url")] if isinstance(pages, list) else []
