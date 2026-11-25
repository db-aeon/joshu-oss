#!/usr/bin/env python3
"""Tests of the Hermes plugin joshu-web-you (change you-web-provider).

The web backend `you` posts to a fake Joshu API. The test checks the search request and the
result shape of Hermes, the extract request, the order and the URL of the pages, a page that no
provider could read, and the Exa backend of Hermes when the Joshu API does not answer.

With HERMES_AGENT_DIR set to a Hermes checkout, the test uses the real base class of Hermes
(agent/web_search_provider.py). Without it (CI), the test uses a small stand-in with the same
names. The Exa backend is always a stand-in, so the test needs no key and no network.
"""

from __future__ import annotations

import abc
import importlib
import json
import os
import sys
import threading
import types
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
ENV = {}


def install_stand_ins() -> None:
    """A stand-in for agent.web_search_provider of Hermes."""
    agent = types.ModuleType("agent")
    agent.__path__ = []
    module = types.ModuleType("agent.web_search_provider")

    class WebSearchProvider(abc.ABC):
        @property
        @abc.abstractmethod
        def name(self) -> str: ...

        @abc.abstractmethod
        def is_available(self) -> bool: ...

    module.WebSearchProvider = WebSearchProvider
    module.get_provider_env = lambda key: ENV.get(key, "")
    sys.modules["agent"] = agent
    sys.modules["agent.web_search_provider"] = module


class FakeExa:
    """The Exa backend of Hermes, as plugin joshu-web-you imports it."""

    calls = []

    def search(self, query, limit=5):
        FakeExa.calls.append(("search", query, limit))
        return {"success": True, "data": {"web": [{"url": "https://exa.example/hit", "title": "Exa hit", "description": "", "position": 1}]}}

    def extract(self, urls, **kwargs):
        FakeExa.calls.append(("extract", list(urls)))
        return [{"url": u, "title": "From Exa", "content": "exa text", "raw_content": "exa text", "metadata": {}} for u in urls]


def install_fake_exa() -> None:
    for name in ("plugins", "plugins.web", "plugins.web.exa"):
        module = types.ModuleType(name)
        module.__path__ = []
        sys.modules[name] = module
    provider = types.ModuleType("plugins.web.exa.provider")
    provider.ExaWebSearchProvider = FakeExa
    sys.modules["plugins.web.exa.provider"] = provider


class JoshuApiHandler(BaseHTTPRequestHandler):
    """The two web routes of the Joshu API."""

    requests = []
    mode = "ok"

    def log_message(self, *args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)))
        JoshuApiHandler.requests.append((self.path, body, dict(self.headers)))
        if JoshuApiHandler.mode == "no-provider":
            return self.answer(503, {"ok": False, "error": "the box has no You.com access and no Exa key for web search"})
        if JoshuApiHandler.mode == "down":
            return self.answer(502, {"ok": False, "error": "web search failed: You.com /v1/search answered 500"})
        if self.path == "/joshu/api/web/search":
            return self.answer(
                200,
                {
                    "ok": True,
                    "provider": "you.com",
                    "web": [
                        {"url": "https://a.example/1", "title": "One", "description": "first second", "position": 1},
                        {"url": "https://a.example/2", "title": "Two", "description": "desc two", "position": 2},
                        {"title": "no url"},
                    ],
                },
            )
        if self.path == "/joshu/api/web/extract":
            pages = []
            for url in body["urls"]:
                if "unreadable" in url:
                    continue
                # A provider can return another form of the URL.
                pages.append({"url": url.rstrip("/") if "canonical" in url else url, "title": "Page", "content": f"text of {url}"})
            return self.answer(200, {"ok": True, "provider": "you.com", "pages": list(reversed(pages))})
        return self.answer(404, {"ok": False, "error": "not found"})

    def answer(self, status, data):
        raw = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


def load_plugin():
    hermes_dir = os.environ.get("HERMES_AGENT_DIR")
    if hermes_dir:
        sys.path.insert(0, hermes_dir)
        real = importlib.import_module("agent.web_search_provider")
        real.get_provider_env = lambda key: ENV.get(key, "")
    else:
        install_stand_ins()
    install_fake_exa()
    package = types.ModuleType("joshu_web_you")
    package.__path__ = [str(REPO / ".hermes" / "plugins" / "joshu-web-you")]
    sys.modules["joshu_web_you"] = package
    return importlib.import_module("joshu_web_you.provider")


def main() -> None:
    server = HTTPServer(("127.0.0.1", 0), JoshuApiHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    os.environ["JOSHU_API_BASE_URL"] = f"http://127.0.0.1:{server.server_port}/joshu"
    plugin = load_plugin()

    registered = []
    plugin.register(types.SimpleNamespace(register_web_search_provider=registered.append))
    assert len(registered) == 1
    you = registered[0]
    assert you.name == "you"
    assert you.supports_search() and you.supports_extract()
    assert you.is_available(), "the plugin needs no key"

    # Search: the request to the Joshu API, with no key, and the result shape of Hermes.
    found = you.search("ebike subscriptions", limit=3)
    path, body, headers = JoshuApiHandler.requests[-1]
    assert (path, body) == ("/joshu/api/web/search", {"query": "ebike subscriptions", "limit": 3}), (path, body)
    assert not any(k.lower() in ("x-api-key", "authorization") for k in headers), "the plugin sends no key"
    assert found == {
        "success": True,
        "data": {
            "web": [
                {"url": "https://a.example/1", "title": "One", "description": "first second", "position": 1},
                {"url": "https://a.example/2", "title": "Two", "description": "desc two", "position": 2},
            ]
        },
    }, found

    # Extract: one request with all pages. The results keep the order and the URLs of the request.
    JoshuApiHandler.requests.clear()
    urls = ["https://a.example/1", "https://b.example/canonical/", "https://c.example/unreadable"]
    pages = you.extract(urls)
    assert [(r[0], r[1]) for r in JoshuApiHandler.requests] == [("/joshu/api/web/extract", {"urls": urls})]
    assert [p["url"] for p in pages] == urls
    assert pages[0]["content"] == "text of https://a.example/1" and pages[0]["title"] == "Page" and "error" not in pages[0]
    assert pages[0]["metadata"] == {"sourceURL": "https://a.example/1", "title": "Page"}
    assert pages[1]["content"].startswith("text of") and "error" not in pages[1], "another form of the URL is still matched"
    assert pages[2]["error"] == "The page could not be read" and pages[2]["content"] == ""
    assert FakeExa.calls == [], "the Joshu API answered: no call of the Exa backend of Hermes"

    # The Joshu API fails and the box has no Exa key: the error reaches the companion.
    JoshuApiHandler.mode = "down"
    failed = you.search("q")
    assert failed["success"] is False and "HTTP 502" in failed["error"] and "answered 500" in failed["error"], failed
    pages = you.extract(["https://a.example/1"])
    assert "HTTP 502" in pages[0]["error"], pages

    # The Joshu API fails and the box has an Exa key: the Exa backend of Hermes answers.
    ENV["EXA_API_KEY"] = "exa-key"
    assert you.search("q", limit=4)["data"]["web"][0]["url"] == "https://exa.example/hit"
    assert FakeExa.calls[-1] == ("search", "q", 4)
    assert you.extract(["https://a.example/1"])[0]["title"] == "From Exa"
    assert FakeExa.calls[-1] == ("extract", ["https://a.example/1"])

    # The Joshu API cannot be reached at all.
    server.shutdown()
    server.server_close()
    assert you.search("q")["data"]["web"][0]["url"] == "https://exa.example/hit"
    ENV.pop("EXA_API_KEY")
    unreachable = you.search("q")
    assert unreachable["success"] is False and "could not be reached" in unreachable["error"], unreachable

    print("ok plugin joshu-web-you: search, extract, no key, Exa backend when the Joshu API fails")


if __name__ == "__main__":
    main()
