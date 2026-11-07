"""Tools of Research reports, recurring reports, and report updates: the Joshu localhost API."""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request

from .schemas import (
    RESEARCH_RECURRING_LIST_SCHEMA,
    RESEARCH_RECURRING_SAVE_SCHEMA,
    RESEARCH_RECURRING_STATE_SCHEMA,
    RESEARCH_REPORT_FIND_SCHEMA,
    RESEARCH_REPORT_MAKE_SCHEMA,
    RESEARCH_UPDATE_MAKE_SCHEMA,
    RESEARCH_UPDATE_PDF_SCHEMA,
)

JOSHU_API_BASE = os.environ.get("JOSHU_API_BASE_URL", "http://127.0.0.1:8788/joshu").rstrip("/")
# A Research report takes at most 10 minutes (change research-reports, design decision D12).
MAKE_TIMEOUT_SECONDS = 11 * 60
FIND_TIMEOUT_SECONDS = 30
# Making a recurring report plans its parts with one model call (change recurring-research-reports).
SAVE_TIMEOUT_SECONDS = 90
# A report update and its PDF take at most 10 minutes (design decisions D8 and D9).
UPDATE_TIMEOUT_SECONDS = 11 * 60


def _request(method: str, path: str, body: dict | None, timeout: int) -> tuple[int, dict]:
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(
        f"{JOSHU_API_BASE}{path}",
        data=data,
        headers={"Content-Type": "application/json"} if data is not None else {},
        method=method,
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
            return resp.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as err:
        detail = err.read().decode("utf-8", errors="replace")
        try:
            parsed = json.loads(detail) if detail else {}
        except json.JSONDecodeError:
            parsed = {"error": detail or f"HTTP {err.code}"}
        return err.code, parsed
    except (urllib.error.URLError, TimeoutError) as err:
        return 599, {"error": f"Joshu API not reachable: {err}"}


def _hints(args: dict) -> list[str]:
    """The hints of the companion (change content-router): a list of short texts."""
    raw = args.get("hints") or []
    if isinstance(raw, str):
        raw = [raw]
    return [str(h).strip() for h in raw if str(h).strip()]


def research_report_make(args: dict, **kwargs) -> str:
    topic = str(args.get("topic") or "").strip()
    if not topic:
        return json.dumps({"ok": False, "error": "topic is required"})
    body: dict = {"topic": topic}
    notes = str(args.get("notes") or "").strip()
    if notes:
        body["notes"] = notes
    sections = [str(s).strip() for s in (args.get("sections") or []) if str(s).strip()]
    if sections:
        body["sections"] = sections
    hints = _hints(args)
    if hints:
        body["hints"] = hints
    # The web search provider (change research-web-provider): Exa unless the companion names You.com.
    web_provider = str(args.get("web_provider") or "").strip().lower()
    if web_provider:
        body["web_provider"] = web_provider
    status, data = _request("POST", "/api/research/reports", body, MAKE_TIMEOUT_SECONDS)
    if status >= 400:
        return json.dumps({"ok": False, "step": data.get("step", "collect"), **data})
    return json.dumps(data)


def research_report_find(args: dict, **kwargs) -> str:
    query = str(args.get("query") or "").strip()
    status, data = _request(
        "GET", f"/api/research/reports?q={urllib.parse.quote(query)}", None, FIND_TIMEOUT_SECONDS
    )
    if status >= 400:
        return json.dumps({"ok": False, **data})
    return json.dumps(data)


def _answer(status: int, data: dict) -> str:
    if status >= 400:
        return json.dumps({"ok": False, **data})
    return json.dumps(data)


def research_recurring_save(args: dict, **kwargs) -> str:
    body = {key: args[key] for key in ("topics", "days", "times", "sources", "channel", "notes", "name") if key in args}
    if "nothing_new_line" in args:
        body["nothingNewLine"] = bool(args["nothing_new_line"])
    if "hints" in args:
        body["hints"] = _hints(args)
    report_id = str(args.get("id") or "").strip()
    if report_id:
        status, data = _request("PATCH", f"/api/research/recurring/{urllib.parse.quote(report_id)}", body, SAVE_TIMEOUT_SECONDS)
    else:
        status, data = _request("POST", "/api/research/recurring", body, SAVE_TIMEOUT_SECONDS)
    return _answer(status, data)


def research_recurring_list(args: dict, **kwargs) -> str:
    status, data = _request("GET", "/api/research/recurring", None, FIND_TIMEOUT_SECONDS)
    return _answer(status, data)


def research_recurring_state(args: dict, **kwargs) -> str:
    report_id = urllib.parse.quote(str(args.get("id") or "").strip())
    action = str(args.get("action") or "").strip()
    if not report_id or action not in ("pause", "resume", "delete"):
        return json.dumps({"ok": False, "error": "id and action (pause, resume, or delete) are required"})
    if action == "delete":
        status, data = _request("DELETE", f"/api/research/recurring/{report_id}", None, FIND_TIMEOUT_SECONDS)
    else:
        status, data = _request("POST", f"/api/research/recurring/{report_id}/{action}", {}, FIND_TIMEOUT_SECONDS)
    return _answer(status, data)


def research_update_make(args: dict, **kwargs) -> str:
    report_id = str(args.get("report_id") or "").strip()
    if not report_id:
        return json.dumps({"ok": False, "error": "report_id is required"})
    body = {"channel": str(args.get("channel") or "email")}
    status, data = _request("POST", f"/api/research/reports/{urllib.parse.quote(report_id)}/updates", body, UPDATE_TIMEOUT_SECONDS)
    return _answer(status, data)


def research_update_pdf(args: dict, **kwargs) -> str:
    update = str(args.get("update") or "").strip()
    if not update:
        return json.dumps({"ok": False, "error": "update is required"})
    status, data = _request("POST", "/api/research/updates/pdf", {"update": update}, UPDATE_TIMEOUT_SECONDS)
    return _answer(status, data)


def register(ctx) -> None:
    ctx.register_tool(
        name="research_report_make",
        toolset="joshu-research",
        schema=RESEARCH_REPORT_MAKE_SCHEMA,
        handler=research_report_make,
        emoji="📰",
    )
    ctx.register_tool(
        name="research_report_find",
        toolset="joshu-research",
        schema=RESEARCH_REPORT_FIND_SCHEMA,
        handler=research_report_find,
        emoji="🔎",
    )
    for name, schema, handler, emoji in (
        ("research_recurring_save", RESEARCH_RECURRING_SAVE_SCHEMA, research_recurring_save, "🗓️"),
        ("research_recurring_list", RESEARCH_RECURRING_LIST_SCHEMA, research_recurring_list, "📋"),
        ("research_recurring_state", RESEARCH_RECURRING_STATE_SCHEMA, research_recurring_state, "⏯️"),
        ("research_update_make", RESEARCH_UPDATE_MAKE_SCHEMA, research_update_make, "🆕"),
        ("research_update_pdf", RESEARCH_UPDATE_PDF_SCHEMA, research_update_pdf, "📄"),
    ):
        ctx.register_tool(name=name, toolset="joshu-research", schema=schema, handler=handler, emoji=emoji)
