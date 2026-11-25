"""Web backend `you` of Hermes: the web search and page reading of the Joshu API.

Config keys that select this backend (the Joshu API writes `web.backend` when the box can reach
You.com)::

    web:
      backend: "you"

The backend posts each call to the Joshu API on localhost (`joshu_api.py`). The Joshu API runs
the call with You.com and uses Exa when You.com fails, so this plugin needs no key. Only when the
Joshu API itself does not answer, and the box has `EXA_API_KEY`, the Exa backend of Hermes answers.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from agent.web_search_provider import WebSearchProvider, get_provider_env

from . import joshu_api

logger = logging.getLogger(__name__)


def _interrupted() -> bool:
    try:
        from tools.interrupt import is_interrupted

        return bool(is_interrupted())
    except Exception:  # noqa: BLE001 - the interrupt module is optional here
        return False


def _url_key(url: Any) -> str:
    """A URL without its scheme, a leading `www.`, its fragment, and a trailing slash, in lower case."""
    text = str(url or "").strip().lower().split("#", 1)[0]
    for prefix in ("https://", "http://", "www."):
        if text.startswith(prefix):
            text = text[len(prefix):]
    return text.rstrip("/")


def _exa_fallback() -> Optional[Any]:
    """The Exa backend of Hermes, or None when the box has no Exa key or Hermes has no Exa backend."""
    if not get_provider_env("EXA_API_KEY"):
        return None
    try:
        from plugins.web.exa.provider import ExaWebSearchProvider

        return ExaWebSearchProvider()
    except Exception as exc:  # noqa: BLE001 - a Hermes without the Exa backend has no fallback
        logger.warning("joshu-web-you fallback: the Exa backend could not be loaded: %s", exc)
        return None


class YouWebSearchProvider(WebSearchProvider):
    """Search and extract through the Joshu API. Both methods are synchronous, as in the Exa backend."""

    @property
    def name(self) -> str:
        return "you"

    @property
    def display_name(self) -> str:
        return "You.com"

    def is_available(self) -> bool:
        # The plugin needs no key. The Joshu API selects this backend only when the box can reach You.com.
        return True

    def supports_search(self) -> bool:
        return True

    def supports_extract(self) -> bool:
        return True

    def search(self, query: str, limit: int = 5) -> Dict[str, Any]:
        if _interrupted():
            return {"success": False, "error": "Interrupted"}
        try:
            logger.info("You.com search: '%s' (limit=%d)", query, limit)
            web = [
                {
                    "url": r["url"],
                    "title": str(r.get("title") or ""),
                    "description": str(r.get("description") or ""),
                    "position": i + 1,
                }
                for i, r in enumerate(joshu_api.search(query, limit))
            ]
            return {"success": True, "data": {"web": web}}
        except Exception as exc:  # noqa: BLE001 - any failure of the call goes to the fallback
            logger.warning("You.com search error: %s", exc)
            exa = _exa_fallback()
            if exa is not None:
                return exa.search(query, limit)
            return {"success": False, "error": f"Web search failed: {exc}"}

    def extract(self, urls: List[str], **kwargs: Any) -> List[Dict[str, Any]]:
        if _interrupted():
            return [{"url": u, "error": "Interrupted", "title": ""} for u in urls]
        logger.info("You.com extract: %d URL(s)", len(urls))
        try:
            pages = joshu_api.extract(urls)
        except Exception as exc:  # noqa: BLE001 - any failure of the call goes to the fallback
            logger.warning("You.com extract error: %s", exc)
            exa = _exa_fallback()
            if exa is not None:
                return exa.extract(urls, **kwargs)
            return [{"url": u, "title": "", "content": "", "error": f"Web extract failed: {exc}"} for u in urls]

        # The Joshu API leaves out a page that no provider could read. A provider can return another
        # form of a URL (for example without the trailing slash), so the pages are matched by a
        # normalized URL, and each result keeps the requested URL, in the order of the request.
        by_url = {_url_key(p.get("url")): p for p in pages}
        results: List[Dict[str, Any]] = []
        for url in urls:
            page = by_url.get(_url_key(url))
            content = str(page.get("content") or "") if page else ""
            if not content.strip():
                results.append({"url": url, "title": "", "content": "", "error": "The page could not be read"})
                continue
            title = str(page.get("title") or "")
            results.append(
                {
                    "url": url,
                    "title": title,
                    "content": content,
                    "raw_content": content,
                    "metadata": {"sourceURL": url, "title": title},
                }
            )
        return results

    def get_setup_schema(self) -> Dict[str, Any]:
        return {
            "name": "You.com",
            "badge": "paid",
            "tag": "You.com web search and page extraction through the Joshu API, with Exa as the fallback.",
            "env_vars": [],
        }


def register(ctx) -> None:
    """Register the You.com provider with the plugin context."""
    ctx.register_web_search_provider(YouWebSearchProvider())
