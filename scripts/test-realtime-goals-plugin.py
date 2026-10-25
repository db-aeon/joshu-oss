#!/usr/bin/env python3
"""Contract tests for the Hermes Slack/Telegram admission hook."""

from __future__ import annotations

import asyncio
import importlib.util
import json
import os
from pathlib import Path
from types import SimpleNamespace


ROOT = Path(__file__).resolve().parent.parent
TOOLS = ROOT / ".hermes/plugins/joshu-realtime-goals/tools.py"
SPEC = importlib.util.spec_from_file_location("joshu_realtime_goals_tools", TOOLS)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

GUARD_PATH = ROOT / ".hermes/plugins/joshu-realtime-goals/cron_guard.py"
GUARD_SPEC = importlib.util.spec_from_file_location("joshu_realtime_goals_cron_guard", GUARD_PATH)
assert GUARD_SPEC and GUARD_SPEC.loader
GUARD = importlib.util.module_from_spec(GUARD_SPEC)
GUARD_SPEC.loader.exec_module(GUARD)


def check_cron_guard() -> None:
    """Spec owner-reminders: Hermes cronjob calls with an undeliverable target are blocked."""

    def call(platform: str, args: dict):
        os.environ["HERMES_SESSION_PLATFORM"] = platform
        try:
            return GUARD.pre_tool_call(tool_name="cronjob", args=args)
        finally:
            del os.environ["HERMES_SESSION_PLATFORM"]

    # Reminder from an SMS turn without deliver (box joe, 2026-09-11).
    blocked = call("api_server", {"action": "create", "schedule": "0 9 * * *", "prompt": "Remind the owner"})
    assert blocked["action"] == "block"
    assert "owner_reminder_create" in blocked["message"]
    assert call("api_server", {"action": "create", "deliver": "origin"})["action"] == "block"
    # Platforms that the Hermes gateway does not run on a box.
    assert call("telegram", {"action": "create", "deliver": "sms:+15551234567"})["action"] == "block"
    assert call("", {"action": "create", "deliver": "email:owner@example.com"})["action"] == "block"
    assert call("api_server", {"action": "create", "deliver": "origin,telegram"})["action"] == "block"
    # Not blocked: Telegram/Slack sessions, local, all, explicit telegram, other actions.
    assert call("telegram", {"action": "create"}) is None
    assert call("slack", {"action": "create", "deliver": "origin"}) is None
    assert call("api_server", {"action": "create", "deliver": "local"}) is None
    assert call("api_server", {"action": "create", "deliver": "all"}) is None
    assert call("api_server", {"action": "create", "deliver": "telegram:-1001:17"}) is None
    assert call("", {"action": "create"}) is None  # unknown session: Hermes home-channel fallback
    assert call("api_server", {"action": "update", "job_id": "j1", "prompt": "x"}) is None
    assert call("api_server", {"action": "update", "job_id": "j1", "deliver": "origin"})["action"] == "block"
    assert call("api_server", {"action": "list"}) is None
    assert GUARD.pre_tool_call(tool_name="terminal", args={"action": "create"}) is None
    # Same examples as scanCronFailures in scripts/test-instance-failures.mjs.
    assert GUARD.undeliverable_reason("origin", "api_server")
    assert GUARD.undeliverable_reason("sms:+15551234567", "")
    assert GUARD.undeliverable_reason("local", "api_server") is None
    assert GUARD.undeliverable_reason("telegram", "telegram") is None

    class Ctx:
        hooks: list[str] = []

        def register_hook(self, name, _callback):
            self.hooks.append(name)

    ctx = Ctx()
    GUARD.register(ctx)
    assert ctx.hooks == ["pre_tool_call"]


class Adapter:
    def __init__(self) -> None:
        self.sent: list[tuple[str, str, dict | None]] = []

    async def send(self, chat_id: str, text: str, metadata=None) -> None:
        self.sent.append((chat_id, text, metadata))


class Platform:
    value = "slack"


async def main() -> None:
    check_cron_guard()
    assert MODULE._origin_from_session("agent:main:email:dm:owner") is None
    assert MODULE._origin_from_session("share-chat:public") is None
    assert MODULE._origin_from_session("agent:main:slack:dm:D1")["channel"] == "slack"
    os.environ["HERMES_KANBAN_TASK"] = "t_worker"
    rejected = json.loads(
        MODULE.realtime_goal_defer(
            {"objective": "recursively queue me"},
            gateway_session_key="joshu-hermes-chat:test",
        )
    )
    assert rejected["ok"] is False
    del os.environ["HERMES_KANBAN_TASK"]

    platform = Platform()
    source = SimpleNamespace(
        platform=platform,
        user_id="U1",
        chat_id="C1",
        thread_id="123.456",
    )
    event = SimpleNamespace(source=source, text="Research this deeply", message_id="M1")
    adapter = Adapter()
    gateway = SimpleNamespace(
        adapters={platform: adapter},
        _is_user_authorized=lambda _source: True,
        _session_key_for_source=lambda _source: "agent:main:slack:channel:C1:123.456",
    )

    MODULE._post = lambda *_args, **_kwargs: {
        "action": "reply",
        "text": "Queued. Anything else?",
    }
    result = MODULE.pre_gateway_dispatch(event, gateway)
    assert result["action"] == "skip"
    await asyncio.sleep(0)
    assert adapter.sent == [
        ("C1", "Queued. Anything else?", {"thread_id": "123.456"})
    ]

    gateway._is_user_authorized = lambda _source: False
    assert MODULE.pre_gateway_dispatch(event, gateway)["action"] == "allow"

    event.text = "/status"
    gateway._is_user_authorized = lambda _source: True
    assert MODULE.pre_gateway_dispatch(event, gateway)["action"] == "allow"

    # Slack/Telegram turns get the owner's background-work snapshot (SMS and voice do).
    calls: list[tuple[str, dict]] = []

    def fake_post(path, payload, timeout=10.0):
        calls.append((path, payload))
        return {"context": "Background work context: Cancun flights (done; owner heard it by phone)"}

    MODULE._post = fake_post
    injected = MODULE.pre_llm_call(session_id="agent:main:slack:dm:D1", platform="slack")
    assert injected == {"context": "Background work context: Cancun flights (done; owner heard it by phone)"}
    assert calls[-1][0] == "/api/realtime-goals/context"
    assert calls[-1][1]["origin"]["channel"] == "slack"
    assert MODULE.pre_llm_call(session_id="sess-1", platform="api_server") is None
    assert MODULE.pre_llm_call(session_id="sess-2", platform="telegram")["context"].startswith("Background")

    def failing_post(*_args, **_kwargs):
        raise RuntimeError("broker warming")

    MODULE._post = failing_post
    assert MODULE.pre_llm_call(session_id="agent:main:slack:dm:D1", platform="slack") is None

    print("test-realtime-goals-plugin: ok")


asyncio.run(main())
